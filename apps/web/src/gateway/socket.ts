// The browser side of /gateway (architecture.md §WebSocket /gateway): one
// module-singleton socket per tab. Owns the hello handshake (access token +
// per-conversation resume cursors), cmd acks by request id, read-cursor
// acks, keepalive pings, and reconnect with backoff. Frames land in
// gateway/dispatch.ts; connection state lands in the ui store.

import {
  GATEWAY_CLOSE,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ConversationDto,
  type GatewayCmd,
  type MessageDto,
  type ResumeCursors,
  type ServerFrame,
} from "@emberchat/protocol";
import { useAuthStore } from "../stores/auth.js";
import { resumeCursorsFor } from "../stores/messages.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { dispatchFrame } from "./dispatch.js";

const ACK_TIMEOUT_MS = 15_000;
/** Well under MAX_FRAMES_PER_MINUTE; detects dead sockets behind NATs. */
const PING_INTERVAL_MS = 30_000;
/**
 * A socket whose ping went unanswered for this long is dead in a way the
 * browser never reports (sleep/resume, a NAT or proxy dropping an idle
 * tunnel): it stays readyState OPEN while nothing arrives, so the tab shows
 * "online" and quietly stops updating. Close it and reconnect — the hello's
 * resume cursors replay whatever was missed (#407).
 */
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Lifecycle events that mean "this tab may have just come back": the browser
 * throttles — and around sleep/resume Firefox outright suspends — timers in a
 * hidden or frozen tab, so the keepalive above can be hours late while the
 * socket is already dead and the log silently stops updating (#432). These
 * fire on the way back regardless of what the timers did.
 */
const WAKE_WINDOW_EVENTS = ["focus", "online", "pageshow"] as const;
/** `resume` is Page Lifecycle: a frozen tab thawing. */
const WAKE_DOCUMENT_EVENTS = ["resume", "visibilitychange"] as const;
/**
 * The other half of Page Lifecycle, and the one an installed app meets far
 * more often than a browser tab does (MP3 §5, #377): the browser is about to
 * stop running this document altogether. Timers do not fire while frozen and
 * fire *late* on the way back — every deadline still armed when this lands is
 * about to measure the freeze rather than the network, so this hands them in.
 */
const FREEZE_DOCUMENT_EVENTS = ["freeze"] as const;
/** A resume fires several wake events at once; collapse them into one probe. */
const PROBE_DEBOUNCE_MS = 250;
/**
 * A socket that has heard nothing for this long when the tab wakes is
 * suspect — readyState says OPEN either way, so ask it. Well under the
 * keepalive interval, so any recently-pinged socket answers for free.
 */
const PROBE_SILENCE_MS = 5_000;
/** Pong deadline for a wake probe. Tighter than the keepalive's: the user is
 * looking at the tab right now, and reconnecting to our own bouncer is cheap
 * (the ≥10s F-List backoff binds the server's upstream socket, not this one). */
const PROBE_PONG_TIMEOUT_MS = 3_000;

export interface AckResult {
  ok: boolean;
  error?: string;
  conversation?: ConversationDto;
  /** outbox.recall: the typed source, back to the composer. */
  markdown?: string;
  /** history.page: one older page, ascending by id. */
  messages?: MessageDto[];
  /** history.page: older history still exists past this page. */
  hasMore?: boolean;
}

interface PendingAck {
  resolve: (result: AckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayClient {
  #ws: WebSocket | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingAck>();
  readonly #subs = new Set<string>();
  /** Highest read-acked messages.id per conversation (skip stale acks). */
  readonly #acked = new Map<string, number>();
  #wanted = false;
  #backoffMs = RECONNECT_MIN_MS;
  /** One token refresh per consecutive 4401 — a refused hello *after* a
   * successful rotation means the account really is signed out. Cleared by
   * the next `ready`, and by a refresh that never reached the server. */
  #authRetried = false;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Registered while connected, so the singleton owns its own listeners. */
  #onWake: ((event: Event) => void) | undefined;
  #onFreeze: (() => void) | undefined;
  /**
   * The document stopped running between now and the last probe — it was
   * frozen, or it came back out of the bfcache. Both mean the same thing to a
   * socket: nothing that happened before it is evidence about now. Consumed by
   * the next probe, which then declines to take any shortcut.
   */
  #thawing = false;
  /** Timestamp of the last inbound frame — the wake probe's staleness test. */
  #lastFrameAt = 0;
  /** Timestamp of the last #open(), so a burst of wake events can never
   * out-run the reconnect backoff it bypasses. */
  #lastOpenAt = 0;

  /** Idempotent: safe to call from every AppShell mount. */
  connect(): void {
    this.#wanted = true;
    this.#listenForWake();
    if (this.#ws || this.#reconnectTimer) {
      return;
    }
    this.#open();
  }

  /**
   * The user asked for a reconnect (the sidebar's offline chip). Overrides
   * every internal reason we might have stopped — a click has to beat a page
   * reload even for a bug we haven't found yet — and never waits out a
   * backoff.
   */
  reconnectNow(): void {
    this.#wanted = true;
    this.#authRetried = false;
    this.#backoffMs = RECONNECT_MIN_MS;
    this.#listenForWake();
    const ws = this.#ws;
    if (ws === undefined) {
      if (this.#reconnectTimer) {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
      }
      this.#open();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // Looks connected but the user says otherwise: ask, and let the pong
      // deadline hand a corpse over to the reconnect.
      this.#sendFrame({ t: "ping" });
      this.#awaitPong(ws, PROBE_PONG_TIMEOUT_MS);
    }
    // Still CONNECTING: onopen/onclose decides, seconds away.
  }

  /** Deliberate teardown (sign-out); no reconnect. */
  stop(): void {
    this.#wanted = false;
    this.#stopListeningForWake();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#ws?.close(1000, "client stopped");
    this.#ws = undefined;
  }

  sub(identityId: string): void {
    if (this.#subs.has(identityId)) {
      return;
    }
    this.#subs.add(identityId);
    this.#sendFrame({ t: "sub", d: { identityId } });
  }

  unsub(identityId: string): void {
    if (this.#subs.delete(identityId)) {
      this.#sendFrame({ t: "unsub", d: { identityId } });
    }
  }

  /**
   * Reports that the user did something here (#619). The bouncer pools these
   * across every device attached to an identity and decides auto-away from
   * the newest of them, so a device that is merely open never speaks for a
   * user who is typing on another one.
   *
   * Best-effort and unacked: a dropped report costs at most one sweep of
   * lateness, and the reporter throttles hard (see lib/activity.ts) because
   * the events behind it fire on every pointer move.
   */
  activity(): void {
    this.#sendFrame({ t: "activity" });
  }

  /** Sends a command; resolves with the server's ack. */
  cmd(command: GatewayCmd): Promise<AckResult> {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: "not connected" });
    }
    const id = this.#nextId++;
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: "timed out" });
      }, ACK_TIMEOUT_MS);
      this.#pending.set(id, { resolve, timer });
      this.#sendFrame({ t: "cmd", id, d: command });
    });
  }

  /** Advances the server read cursor; monotonic per conversation. */
  readAck(identityId: string, convId: string, messageId: number): void {
    if ((this.#acked.get(convId) ?? 0) >= messageId) {
      return;
    }
    this.#acked.set(convId, messageId);
    this.#sendFrame({ t: "ack", d: { identityId, convId, messageId } });
  }

  /**
   * Marks a conversation read up to its newest message without having that id
   * loaded (#315: "Mark as read" from a sidebar row, where the message buffer
   * may be empty). The server's markRead clamps the id to the true max, so a
   * sentinel means "everything up to now"; the resulting conversation.updated
   * fans out and sticks across devices/reattach exactly like viewing does.
   * Deliberately bypasses #acked — that map guards the live per-message
   * readAck, and a sentinel recorded there would suppress genuine acks for
   * messages that arrive later.
   */
  markReadToLatest(identityId: string, convId: string): void {
    this.#sendFrame({
      t: "ack",
      d: { identityId, convId, messageId: Number.MAX_SAFE_INTEGER },
    });
  }

  /**
   * Opens the one socket this client has. Idempotent by design, not by luck:
   * every *caller* guards against opening a second socket — `connect` on
   * `#ws || #reconnectTimer`, `#probe` on `#ws === undefined` — but
   * `#handleUnauthorized` awaits a token refresh with neither of those set, and
   * across that network round-trip (a laptop resuming is exactly when a 4401
   * refresh is in flight) any of them may open one. The refresh then opened a
   * second: the first socket's `onclose` correctly saw itself superseded, but
   * its keepalive `setInterval` lives in the shared `#pingTimer` field, which
   * the second socket's `onopen` overwrote — so it ran forever, sending on
   * whatever socket was live. The tab pinged at twice the intended rate for the
   * life of the page, against a server that enforces MAX_FRAMES_PER_MINUTE, and
   * every extra `#awaitPong` could close a healthy socket (#560).
   */
  #open(): void {
    if (this.#ws !== undefined) {
      return; // already connecting or connected — that socket is the one
    }
    useUiStore.getState().setGatewayStatus("connecting");
    this.#lastOpenAt = Date.now();
    this.#lastFrameAt = Date.now();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/gateway`);
    this.#ws = ws;

    ws.onopen = () => {
      if (this.#ws !== ws) {
        // Superseded before it finished connecting. Never arm a keepalive for
        // a socket the client has stopped tracking: the interval outlives the
        // socket and would send on its replacement (#560).
        ws.close(1000, "superseded");
        return;
      }
      const token = useAuthStore.getState().accessToken;
      if (token === undefined) {
        ws.close(1000, "no session");
        return;
      }
      this.#sendFrame({
        t: "hello",
        d: { token, protocolVersion: PROTOCOL_VERSION, resume: this.#resume() },
      });
      // The server processes frames in order, so subs may follow the hello
      // immediately; each one answers with snapshot + catchup.
      for (const identityId of this.#subs) {
        this.#sendFrame({ t: "sub", d: { identityId } });
      }
      // Opening the app is itself activity, and saying so seeds this
      // connection's report (#619). Until a browser has reported once the
      // bouncer refuses to judge its identity idle at all — so a tab opened
      // and then abandoned without a single pointer move would otherwise
      // hold the whole identity out of auto-away indefinitely.
      this.activity();
      this.#pingTimer = setInterval(() => {
        this.#sendFrame({ t: "ping" });
        // Never push out a deadline already running — a wake probe's is
        // tighter on purpose.
        if (this.#pongTimer === undefined) {
          this.#awaitPong(ws, PONG_TIMEOUT_MS);
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      this.#lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return; // the server never sends non-JSON; ignore defensively
      }
      if (frame.t === "ready") {
        this.#backoffMs = RECONNECT_MIN_MS;
        this.#authRetried = false;
        useUiStore.getState().setGatewayStatus("online");
      }
      // Any frame proves the socket is alive, not just the pong itself.
      if (this.#pongTimer) {
        clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
      }
      if (frame.t === "ack") {
        const pending = this.#pending.get(frame.id);
        if (pending) {
          this.#pending.delete(frame.id);
          clearTimeout(pending.timer);
          pending.resolve(frame.d);
        }
        return;
      }
      dispatchFrame(frame);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) {
        return; // superseded
      }
      this.#teardownSocket();
      if (!this.#wanted) {
        useUiStore.getState().setGatewayStatus("offline");
        return;
      }
      if (event.code === GATEWAY_CLOSE.unauthorized) {
        void this.#handleUnauthorized();
        return;
      }
      this.#scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    };
  }

  /**
   * Access token expired or session revoked: refresh once, then retry. Only
   * the server refusing the refresh token ends this client's career — a
   * refresh that never got an answer (the laptop woke before the Wi-Fi did)
   * says nothing about the session, and parking on it left the tab offline
   * forever with nothing but a reload to fix it.
   */
  async #handleUnauthorized(): Promise<void> {
    if (this.#authRetried) {
      // Refresh already succeeded once and the gateway still refused —
      // treat as signed out rather than hammering the server.
      this.#giveUp();
      return;
    }
    this.#authRetried = true;
    const outcome = await useAuthStore.getState().refreshSession();
    if (!this.#wanted) {
      return; // stopped under us (sign-out)
    }
    if (outcome === "rejected") {
      this.#giveUp(); // the auth store's redirect takes it from here
      return;
    }
    if (outcome === "unavailable") {
      // Transient: back to the normal backoff, and let the next attempt's
      // 4401 try the refresh again.
      this.#authRetried = false;
      this.#scheduleReconnect();
      return;
    }
    this.#open();
  }

  /** Signed out for real: nothing this client does can help until the auth
   * store has a session again. */
  #giveUp(): void {
    this.#wanted = false;
    useUiStore.getState().setGatewayStatus("offline");
  }

  // ── freezing and wake probing ──────────────────────────────────────────────

  #listenForWake(): void {
    if (this.#onWake !== undefined || typeof window === "undefined") {
      return;
    }
    const onWake = (event: Event) => {
      // visibilitychange fires in both directions; going hidden is not a wake.
      if (event.type === "visibilitychange" && document.hidden) {
        return;
      }
      // Two wakes carry their own proof that this document stopped running,
      // and both must reach the probe as such:
      //
      // - `resume`, the far side of `freeze`. The bit is normally already set
      //   by the freeze handler, but a `freeze` listener is best-effort — the
      //   browser is under no obligation to have run ours — so set it here
      //   too rather than trust the pair arrived intact.
      // - `pageshow` with `persisted`, a bfcache restore: the document was
      //   parked whole and browsers sever a parked page's WebSocket without
      //   telling it. `#lastFrameAt` was written before the page went in, so a
      //   quick out-and-back (under PROBE_SILENCE_MS) would otherwise read as
      //   "demonstrably alive" and wave a severed socket through.
      const restored =
        event.type === "pageshow" &&
        (event as PageTransitionEvent).persisted === true;
      if (restored || event.type === "resume") {
        this.#thawing = true;
      }
      this.#scheduleProbe();
    };
    this.#onWake = onWake;
    for (const type of WAKE_WINDOW_EVENTS) {
      window.addEventListener(type, onWake);
    }
    for (const type of WAKE_DOCUMENT_EVENTS) {
      document.addEventListener(type, onWake);
    }
    const onFreeze = () => {
      this.#freeze();
    };
    this.#onFreeze = onFreeze;
    for (const type of FREEZE_DOCUMENT_EVENTS) {
      document.addEventListener(type, onFreeze);
    }
  }

  /**
   * The document is about to stop running. Every timer still armed is now a
   * message from a world that will be gone by the time it is delivered, so
   * disarm the two that make decisions:
   *
   * - the **pong deadline**, which on thaw fires instantly and closes the
   *   socket without ever asking again — a full re-hello, snapshot and catchup
   *   for every subscribed identity, sometimes against a socket that was fine.
   *   Dropping it costs nothing: the probe below re-asks with a fresh 3s
   *   deadline, which is the same verdict a quarter-second later.
   * - the **probe debounce**, which would otherwise fire on thaw *and* be
   *   re-armed by the wake events the thaw itself fires — two probes, two
   *   pings, and the second one silently extending the first's deadline.
   *
   * The keepalive interval is left alone: it belongs to the socket and
   * `#teardownSocket` owns its lifetime. It fires at most once on thaw
   * (an interval has one task pending at a time), and one extra ping is a
   * rounding error against MAX_FRAMES_PER_MINUTE.
   */
  #freeze(): void {
    this.#thawing = true;
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  #stopListeningForWake(): void {
    const onWake = this.#onWake;
    const onFreeze = this.#onFreeze;
    if (onWake === undefined) {
      return;
    }
    this.#onWake = undefined;
    this.#onFreeze = undefined;
    for (const type of WAKE_WINDOW_EVENTS) {
      window.removeEventListener(type, onWake);
    }
    for (const type of WAKE_DOCUMENT_EVENTS) {
      document.removeEventListener(type, onWake);
    }
    if (onFreeze !== undefined) {
      for (const type of FREEZE_DOCUMENT_EVENTS) {
        document.removeEventListener(type, onFreeze);
      }
    }
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
    this.#thawing = false;
  }

  #scheduleProbe(): void {
    this.#probeTimer ??= setTimeout(() => {
      this.#probeTimer = undefined;
      this.#probe();
    }, PROBE_DEBOUNCE_MS);
  }

  /**
   * The tab is back. Nothing here trusts a timer: whatever the browser did to
   * them while we were away, this runs off the lifecycle event itself — and
   * when the document genuinely stopped running (`#thawing`), it declines the
   * two shortcuts that are only sound while it was running: the staleness test
   * below, and the ladder the reconnect was climbing before it went away.
   */
  #probe(): void {
    if (!this.#wanted) {
      return;
    }
    const thawed = this.#thawing;
    this.#thawing = false;
    if (thawed) {
      // A backoff ladder climbed before a freeze describes a network that no
      // longer exists — the radio was off, the Wi-Fi was another building's.
      // Waiting out the 30s cap on the strength of it leaves an installed app
      // staring at "Connecting…" with no address bar to reload from, which is
      // the failure MP3 §5 is about. A thaw is as good a reason to start the
      // ladder over as the user tapping the chip (`reconnectNow`), and the
      // `#lastOpenAt` floor below still caps this at one attempt a second.
      this.#backoffMs = RECONNECT_MIN_MS;
      if (this.#reconnectTimer !== undefined) {
        // Something already re-armed at the old, escalated delay (the timer
        // that fired on thaw, opened, and failed against a radio that was not
        // up yet). Re-arm it at the floor instead.
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
        this.#scheduleReconnect();
      }
    }
    const ws = this.#ws;
    if (ws === undefined) {
      // Parked in the reconnect backoff (up to 30s) with the user waiting.
      // The rate floor keeps a flurry of wake events to one attempt.
      if (Date.now() - this.#lastOpenAt < RECONNECT_MIN_MS) {
        return;
      }
      if (this.#reconnectTimer) {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
      }
      this.#open();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return; // still opening (or already closing) — onopen/onclose decides
    }
    if (!thawed && Date.now() - this.#lastFrameAt < PROBE_SILENCE_MS) {
      return; // demonstrably alive
    }
    this.#sendFrame({ t: "ping" });
    this.#awaitPong(ws, PROBE_PONG_TIMEOUT_MS);
  }

  /** Close `ws` unless some frame arrives within `timeoutMs` (onmessage
   * clears the deadline — a pong is only the cheapest such frame). */
  #awaitPong(ws: WebSocket, timeoutMs: number): void {
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
    }
    this.#pongTimer = setTimeout(() => {
      this.#pongTimer = undefined;
      if (this.#ws === ws) {
        ws.close(1000, "no pong");
      }
    }, timeoutMs);
  }

  #scheduleReconnect(): void {
    useUiStore.getState().setGatewayStatus("connecting");
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#wanted) {
        this.#open();
      }
    }, delay);
  }

  #teardownSocket(): void {
    this.#ws = undefined;
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
    }
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "connection lost" });
    }
    this.#pending.clear();
  }

  /** Resume cursors for every conversation we hold messages for, so the
   * reconnect's catchup replays only what this tab missed. */
  #resume(): ResumeCursors {
    const { sessions } = useSessionsStore.getState();
    const resume: ResumeCursors = {};
    for (const identityId of this.#subs) {
      const session = sessions[identityId];
      if (!session) {
        continue;
      }
      const convIds = [
        ...Object.keys(session.channelByConvId),
        ...Object.keys(session.dms),
      ];
      const convCursors = resumeCursorsFor(convIds);
      if (Object.keys(convCursors).length > 0) {
        resume[identityId] = { convCursors };
      }
    }
    return resume;
  }

  #sendFrame(frame: ClientFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }
}

export const gateway = new GatewayClient();
