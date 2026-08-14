// One GatewayConnection per browser WebSocket. Owns the connection-level
// protocol: hello handshake (token auth, protocol version), sub → snapshot →
// catchup → live, cmd dispatch with acks, read-cursor acks, ping/pong.
//
// Inbound frames are processed strictly in order through a serial queue —
// except msg.send, whose flood-gate wait must not stall the connection; its
// ack fires when the gate resolves. Outbound frames go through send(), which
// disconnects slow consumers instead of buffering without bound.

import { Buffer } from "node:buffer";
import type WebSocket from "ws";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_SERVER_VARS } from "@emberchat/fchat-protocol";
import {
  clientFrameSchema,
  GATEWAY_CLOSE,
  PROTOCOL_VERSION,
  resolvePrefs,
  type ClientFrame,
  type ConversationDto,
  type GatewayCmd,
  type GatewayEvent,
  type MessageDto,
  type ResumeCursors,
  type ServerFrame,
  type UserPrefsPatch,
} from "@emberchat/protocol";
import {
  CampaignError,
  type CampaignScheduler,
} from "../campaigns/scheduler.js";
import type { Db } from "../../db/index.js";
import {
  conversations,
  flistAccounts,
  identities,
  messages,
  userPreferences,
} from "../../db/schema.js";
import type { HighlightMatcher } from "../highlights/matcher.js";
import type { ImagePreviewHostRegistry } from "../../security/image-preview-hosts.js";
import {
  ConversationLimitError,
  type ConversationRow,
  type HistorySink,
} from "../history/sink.js";
import type { NotificationStore } from "../notifications/store.js";
import { connectIdentity } from "../session-engine/connect-identity.js";
import type {
  FchatSession,
  SessionLogger,
  SessionRegistry,
} from "@emberchat/session-engine";
import type { Outbox } from "../outbox/outbox.js";
import { enrichSocial, type SocialCache } from "../social/cache.js";
import type { GatewayHub } from "./gateway.js";
import {
  buildSnapshot,
  catchupPlan,
  fetchMessagesAfter,
  fetchMessagesBefore,
  identityBadgeTotals,
  messageDto,
  pmPresence,
} from "./snapshot.js";
import type { ResolvedUserPrefs, UserPrefsCache } from "./user-prefs.js";

/** Close the socket if no hello arrived within this window. */
const HELLO_TIMEOUT_MS = 10_000;
/** Outbound backlog beyond this is a slow consumer — disconnect, don't buffer. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Messages per catchup frame. */
const CATCHUP_BATCH_SIZE = 200;
/**
 * Idle re-verification interval: a read-only listener sends no frames, so
 * without this a revoked session would keep receiving fan-out forever.
 * (Frames re-verify on every sub/cmd/ack, like REST does per request.)
 */
const AUTH_RECHECK_MS = 30_000;
/** Inbound frame quota — generous for humans, a wall for loops. */
export const MAX_FRAMES_PER_MINUTE = 600;
/**
 * WebSocket-level heartbeat. A browser that vanished without a close frame
 * (laptop asleep, NAT/proxy dropping an idle tunnel) leaves a socket that
 * still looks OPEN: the hub keeps fanning out into it and nothing ever
 * arrives, so the device sits there "attached" and silently stale — the
 * multi-device promise broken for every browser but the newest. Each tick
 * pings; a tick that finds the previous ping unanswered terminates the
 * socket, which unsubscribes it and lets the client reconnect and catch up.
 */
const HEARTBEAT_MS = 30_000;

/**
 * Test-only connection knobs (an integration test can neither wait out a 10s
 * handshake window nor push a megabyte into a stalled socket). Never wired to
 * config — production always runs the constants above.
 */
export interface GatewayTuning {
  /** Handshake window; defaults to HELLO_TIMEOUT_MS. */
  readonly helloTimeoutMs?: number;
  /** Slow-consumer backlog cap; defaults to MAX_BUFFERED_BYTES. */
  readonly maxBufferedBytes?: number;
  /** Heartbeat period; defaults to HEARTBEAT_MS. */
  readonly heartbeatMs?: number;
}

export interface GatewayConnectionContext {
  readonly db: Db;
  readonly sessions: SessionRegistry;
  readonly history: HistorySink;
  readonly hub: GatewayHub;
  readonly outbox: Outbox;
  readonly highlights: Pick<HighlightMatcher, "invalidate">;
  /** Notification inbox (#467): unseen counts ride `ready` so the bell
   * badges before any sub, and a prefs patch drops its mute cache. */
  readonly notifications: Pick<
    NotificationStore,
    "unseenCount" | "invalidatePrefs"
  >;
  /** Live union of user image-preview allowlists; refreshed when a user's
   * imagePreviewHosts pref changes so the CSP admits the new host (#342). */
  readonly imagePreviewHosts: Pick<ImagePreviewHostRegistry, "refresh">;
  /** Per-user prefs, cached across this user's connections — msg.send used to
   * re-read the row for its send delay on every message (audit backlog). */
  readonly userPrefs: Pick<UserPrefsCache, "get" | "invalidate">;
  readonly campaigns: CampaignScheduler;
  /** Cached social lists — served in the snapshot when present (#194). */
  readonly social: SocialCache;
  readonly verifyToken: (
    token: string,
  ) => Promise<{ userId: string; sid: string } | undefined>;
  /** True while the auth session row exists and is unexpired. */
  readonly sessionAlive: (sid: string) => Promise<boolean>;
  /**
   * Per-user hello budget (M3 audit backlog): every hello runs one capped
   * count query per identity, so a scripted connect→hello→disconnect loop
   * multiplies them unmetered. False = over budget, close the connection.
   */
  readonly helloBudget: (userId: string) => boolean;
  readonly tuning?: GatewayTuning;
  readonly log: SessionLogger;
}

interface OwnedIdentity {
  readonly id: string;
  readonly character: string;
  readonly accountId: string;
  readonly accountName: string;
}

interface Subscription {
  /** Live events buffered while snapshot + catchup are streaming; undefined
   * once the subscription is live and events flow straight through. */
  pending:
    { t: "event"; d: { identityId: string } & GatewayEvent }[] | undefined;
  /** Highest messages.id already delivered per conversation (resume cursor,
   * advanced by catchup) — used to drop duplicates when pending is flushed. */
  readonly delivered: Map<string, number>;
}

export class GatewayConnection {
  readonly #socket: WebSocket;
  readonly #ctx: GatewayConnectionContext;
  readonly #log: SessionLogger;

  #userId: string | undefined;
  #sid: string | undefined;
  #resume: ResumeCursors = {};
  /** Ownership cache — positive entries only; misses always re-query. */
  readonly #owned = new Map<string, OwnedIdentity>();
  readonly #subscriptions = new Map<string, Subscription>();
  /** Serial inbound queue — frames are handled in arrival order. */
  #inbound: Promise<void> = Promise.resolve();
  #helloTimer: NodeJS.Timeout | undefined;
  #authTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  /** True while a heartbeat ping is out with no answer (of any kind) yet. */
  #awaitingPong = false;
  #frameWindowStart = 0;
  #framesInWindow = 0;
  readonly #maxBufferedBytes: number;
  /**
   * When this browser last reported user activity, or undefined if it never
   * has (#619). The `undefined` state is load-bearing rather than a missing
   * zero: a client too old to send the `activity` frame must not be read as
   * "idle since it connected" and drag its identity away while its user is
   * demonstrably typing. Nothing attached that has never reported means the
   * idle sweep declines to judge at all — see GatewayHub.activityAcross.
   */
  #lastActivityAt: number | undefined;

  constructor(socket: WebSocket, ctx: GatewayConnectionContext) {
    this.#socket = socket;
    this.#ctx = ctx;
    this.#log = ctx.log;
    const tuning = ctx.tuning ?? {};
    this.#maxBufferedBytes = tuning.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

    this.#helloTimer = setTimeout(() => {
      this.#close(GATEWAY_CLOSE.helloTimeout, "no hello");
    }, tuning.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    socket.on("message", (data: WebSocket.RawData) => {
      this.#awaitingPong = false; // any traffic proves the peer is alive
      this.#enqueue(() => this.#handleRaw(data));
    });
    socket.on("pong", () => {
      this.#awaitingPong = false;
    });
    this.#heartbeatTimer = setInterval(() => {
      if (this.#awaitingPong) {
        // The peer went away without a close frame: drop it now rather than
        // fanning out into a socket nobody reads (multi-device, #407).
        this.#log.info({}, "gateway heartbeat timed out — dropping socket");
        this.#teardown();
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      try {
        socket.ping();
      } catch {
        this.#teardown();
        socket.terminate();
      }
    }, tuning.heartbeatMs ?? HEARTBEAT_MS);
    socket.on("error", (error) => {
      this.#log.warn({ err: error }, "gateway socket error");
    });
    socket.on("close", () => {
      this.#teardown();
    });
  }

  /** True while this connection wants events for the identity. */
  isSubscribed(identityId: string): boolean {
    return this.#subscriptions.has(identityId);
  }

  /** Newest reported user activity, or undefined if this browser has never
   * reported any (see #lastActivityAt). */
  get lastActivityAt(): number | undefined {
    return this.#lastActivityAt;
  }

  /** Hub fan-out entry point: buffers during snapshot/catchup, dedupes
   * against the delivered cursor, then streams. */
  deliver(identityId: string, event: GatewayEvent): void {
    const sub = this.#subscriptions.get(identityId);
    if (!sub) {
      return;
    }
    const frame = { t: "event" as const, d: { identityId, ...event } };
    if (sub.pending) {
      sub.pending.push(frame);
      return;
    }
    if (this.#isDuplicate(sub, event)) {
      return;
    }
    this.#send(frame);
  }

  #isDuplicate(sub: Subscription, event: GatewayEvent): boolean {
    if (event.kind !== "message.new") {
      return false;
    }
    const seen = sub.delivered.get(event.d.convId);
    if (seen !== undefined && event.d.message.id <= seen) {
      return true;
    }
    sub.delivered.set(event.d.convId, event.d.message.id);
    return false;
  }

  #enqueue(task: () => Promise<void>): void {
    this.#inbound = this.#inbound.then(task).catch((error: unknown) => {
      this.#log.error({ err: error }, "gateway frame handling failed");
    });
  }

  /** Sliding one-minute frame quota; loops get cut, humans never notice. */
  #withinFrameQuota(): boolean {
    const now = Date.now();
    if (now - this.#frameWindowStart >= 60_000) {
      this.#frameWindowStart = now;
      this.#framesInWindow = 0;
    }
    this.#framesInWindow += 1;
    return this.#framesInWindow <= MAX_FRAMES_PER_MINUTE;
  }

  async #handleRaw(data: WebSocket.RawData): Promise<void> {
    if (!this.#withinFrameQuota()) {
      this.#close(GATEWAY_CLOSE.rateLimited, "frame quota exceeded");
      return;
    }
    let json: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ws RawData is Buffer/ArrayBuffer, toString is the decode
      json = JSON.parse(data.toString()) as unknown;
    } catch {
      this.#protocolError("frame is not valid JSON");
      return;
    }
    const parsed = clientFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.#protocolError("malformed frame");
      return;
    }
    await this.#handleFrame(parsed.data);
  }

  #protocolError(message: string): void {
    if (this.#userId === undefined) {
      // Before hello there is no session to preserve — just drop it.
      this.#close(GATEWAY_CLOSE.badRequest, message);
      return;
    }
    this.#send({ t: "error", d: { message } });
  }

  async #handleFrame(frame: ClientFrame): Promise<void> {
    if (frame.t === "hello") {
      await this.#handleHello(frame.d);
      return;
    }
    if (frame.t === "ping") {
      this.#send({ t: "pong" });
      return;
    }
    if (this.#userId === undefined) {
      this.#close(GATEWAY_CLOSE.unauthorized, "hello first");
      return;
    }
    if (!(await this.#authStillValid())) {
      return; // #authStillValid already closed the socket
    }
    switch (frame.t) {
      case "sub":
        await this.#handleSub(frame.d.identityId);
        return;
      case "unsub":
        this.#subscriptions.delete(frame.d.identityId);
        this.#ctx.hub.unsubscribe(frame.d.identityId, this);
        return;
      case "cmd":
        try {
          await this.#handleCmd(frame.d, frame.id);
        } catch (error) {
          this.#log.error({ err: error }, "gateway cmd failed");
          this.#ack(frame.id, { ok: false, error: "internal error" });
        }
        return;
      case "ack":
        await this.#handleReadAck(frame.d);
        return;
      case "activity":
        this.#lastActivityAt = Date.now();
        // Tell the away sweep at once rather than letting it notice on its
        // next pass: coming back from an automatic away is the half of the
        // feature the user actually watches, and a minute of lag there is
        // the difference between "it works" and "it is broken" (#619).
        for (const identityId of this.#subscriptions.keys()) {
          this.#ctx.hub.notifyActivity(identityId);
        }
        return;
    }
  }

  async #handleHello(d: {
    token: string;
    protocolVersion: number;
    resume?: ResumeCursors;
  }): Promise<void> {
    if (this.#userId !== undefined) {
      this.#send({ t: "error", d: { message: "already identified" } });
      return;
    }
    if (d.protocolVersion !== PROTOCOL_VERSION) {
      this.#close(
        GATEWAY_CLOSE.versionMismatch,
        `server speaks protocol ${String(PROTOCOL_VERSION)}`,
      );
      return;
    }
    const auth = await this.#ctx.verifyToken(d.token);
    if (!auth) {
      this.#close(GATEWAY_CLOSE.unauthorized, "invalid token");
      return;
    }
    // Post-verify on purpose: only authenticated hellos spend the budget, so
    // a third party can't exhaust someone's budget with garbage tokens.
    if (!this.#ctx.helloBudget(auth.userId)) {
      this.#close(GATEWAY_CLOSE.rateLimited, "hello rate limit");
      return;
    }
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
    this.#userId = auth.userId;
    this.#sid = auth.sid;
    // A read-only listener never sends frames, so the per-frame recheck
    // alone would let a revoked session keep receiving fan-out forever.
    this.#authTimer = setInterval(() => {
      void this.#authStillValid();
    }, AUTH_RECHECK_MS);
    this.#resume = d.resume ?? {};

    const rows = await this.#ctx.db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
        autoConnect: identities.autoConnect,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(flistAccounts.userId, auth.userId))
      .orderBy(identities.sortOrder, identities.createdAt);
    for (const row of rows) {
      this.#owned.set(row.id, {
        id: row.id,
        character: row.character,
        accountId: row.accountId,
        accountName: row.accountName,
      });
    }
    // Rail badges must paint from ready alone — a background identity may
    // never be subscribed by this client. Each total walks capped
    // per-conversation windows, so the cost is bounded per identity.
    //
    // Mute-aware at the source (#430 follow-up): the favicon indicator falls
    // back to these totals for an identity whose slice hasn't synced, and a
    // pre-aggregated total can't be decomposed per conversation in the
    // browser — so a muted room (or a muted identity, which contributes
    // nothing at all) would leak into the alert tiers until that identity
    // subscribed. Prefs come from the shared cache, so this is free.
    const { prefs } = await this.#userPrefs();
    const mutedIdentityIds = new Set(prefs.mutedIdentityIds);
    const mutedConvIds = new Set(prefs.mutedConvIds);
    const totals = new Map(
      await Promise.all(
        rows
          .filter((row) => !mutedIdentityIds.has(row.id))
          .map(
            async (row) =>
              [
                row.id,
                await identityBadgeTotals(this.#ctx.db, row.id, mutedConvIds),
              ] as const,
          ),
      ),
    );
    // Same reasoning for the inbox bell: a cold load must badge without an
    // inbox fetch. One capped count per identity.
    const unseen = await Promise.all(
      rows.map((row) => this.#ctx.notifications.unseenCount(row.id)),
    );
    this.#send({
      t: "ready",
      d: {
        userId: auth.userId,
        identities: rows.map((row, index) => ({
          id: row.id,
          name: row.character,
          sessionStatus:
            this.#ctx.sessions.get(row.id)?.status ?? ("offline" as const),
          autoConnect: row.autoConnect,
          // Absent = muted identity: it contributes nothing at all.
          unread: totals.get(row.id)?.unread ?? 0,
          mentions: totals.get(row.id)?.mentions ?? 0,
          notificationsUnseen: unseen[index] ?? 0,
        })),
      },
    });
  }

  /**
   * Re-verifies the auth session (one indexed query — the same cost REST
   * pays per request, bounded here by the frame quota). Returns false after
   * closing the socket when the session has been revoked — logout must cut
   * gateway access, not just REST.
   */
  async #authStillValid(): Promise<boolean> {
    if (this.#sid === undefined) {
      return false;
    }
    if (await this.#ctx.sessionAlive(this.#sid)) {
      return true;
    }
    this.#close(GATEWAY_CLOSE.unauthorized, "session revoked");
    return false;
  }

  /**
   * The identity row, only if it belongs to this connection's user. Only
   * positive results are cached (a stream of random ids must not grow the
   * map); pass `fresh` for mutating commands where a stale row would act on
   * a deleted identity.
   */
  async #ownedIdentity(
    identityId: string,
    { fresh = false } = {},
  ): Promise<OwnedIdentity | undefined> {
    if (!fresh) {
      const cached = this.#owned.get(identityId);
      if (cached !== undefined) {
        return cached;
      }
    }
    const [row] = await this.#ctx.db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(
          eq(identities.id, identityId),
          eq(flistAccounts.userId, this.#userId ?? ""),
        ),
      )
      .limit(1);
    if (row) {
      this.#owned.set(identityId, row);
    } else {
      this.#owned.delete(identityId);
    }
    return row;
  }

  /** Hub callback when an identity is deleted: drop cache + subscription. */
  dropIdentity(identityId: string): void {
    this.#owned.delete(identityId);
    this.#subscriptions.delete(identityId);
  }

  // ── sub: snapshot → catchup → live ─────────────────────────────────────────

  async #handleSub(identityId: string): Promise<void> {
    const identity = await this.#ownedIdentity(identityId);
    if (!identity) {
      this.#send({ t: "error", d: { message: "identity not found" } });
      return;
    }
    // Re-sub is a resync: start buffering again from a clean slate.
    const sub: Subscription = { pending: [], delivered: new Map() };
    this.#subscriptions.set(identityId, sub);
    this.#ctx.hub.subscribe(identityId, this);

    try {
      await this.#syncSubscription(identityId, identity, sub);
    } finally {
      // Whatever happened above (a failed snapshot query, a mid-catchup
      // resync), the buffer must be released: a subscription left in
      // "pending" swallows every event from then on, and the browser sits
      // connected but permanently stale (#407).
      const pending = sub.pending ?? [];
      sub.pending = undefined;
      for (const frame of pending) {
        if (
          this.#subscriptions.get(identityId) === sub &&
          !this.#isDuplicate(sub, frame.d)
        ) {
          this.#send(frame);
        }
      }
    }
  }

  /** snapshot → catchup for one freshly created subscription. */
  async #syncSubscription(
    identityId: string,
    identity: OwnedIdentity,
    sub: Subscription,
  ): Promise<void> {
    const session = this.#ctx.sessions.get(identityId);
    const snapshot = await buildSnapshot(this.#ctx.db, identityId, session);
    const vars = session?.state.vars ?? DEFAULT_SERVER_VARS;
    const ownStatus = session?.ownStatus ?? { status: "online", statusmsg: "" };
    // Live session state once this connection's IGN init has seeded it —
    // the DB mirror trails it by the sink's queue. The mirror covers the
    // rest: no session, or a session still mid-handshake.
    const ignores = session?.state.ignoresSeeded
      ? [...session.state.ignores.values()].sort((a, b) => a.localeCompare(b))
      : await this.#ctx.history.listIgnores(identityId);
    const { sendDelaySeconds, prefs } = await this.#userPrefs();
    // Cached social lists served on attach — a second device gets them
    // instantly, no F-List API calls (#194). Enriched with live presence
    // at serve time (case-insensitive, #218).
    const socialLists = this.#ctx.social.get(identityId);
    this.#send({
      t: "snapshot",
      d: {
        identityId,
        self: {
          character: identity.character,
          sessionStatus: session?.status ?? "offline",
          status: ownStatus.status,
          statusmsg: ownStatus.statusmsg,
          ignores,
          limits: {
            chatMax: vars.chat_max,
            privMax: vars.priv_max,
            lfrpMax: vars.lfrp_max,
            lfrpFlood: vars.lfrp_flood,
          },
          iconBlacklist: [...(session?.state.vars.icon_blacklist ?? [])],
          chatop: session?.state.ownIsChatop ?? false,
          sendDelaySeconds,
          prefs,
          outbox: await this.#ctx.outbox.list(identityId),
          campaign: this.#ctx.campaigns.dtoFor(identityId),
          social: socialLists
            ? enrichSocial(socialLists, session?.state.characters)
            : null,
        },
        channels: snapshot.channels,
        dms: snapshot.dms,
      },
    });

    await this.#sendCatchup(identityId, sub);
  }

  async #sendCatchup(identityId: string, sub: Subscription): Promise<void> {
    const cursors = this.#resume[identityId]?.convCursors ?? {};
    const plan = await catchupPlan(
      this.#ctx.db,
      identityId,
      cursors,
      CATCHUP_BATCH_SIZE,
    );
    for (const { convId, afterId: planStart, gap } of plan) {
      let afterId = planStart;
      sub.delivered.set(convId, afterId);
      // The gap flag (budget clamped the cursor) rides only the FIRST frame
      // of this conversation: it tells the client to reset the buffer once,
      // then the remaining batches append onto the reset window.
      let firstFrame = true;
      for (;;) {
        if (this.#subscriptions.get(identityId) !== sub) {
          return; // unsubscribed (or resynced) mid-catchup
        }
        const rows = await fetchMessagesAfter(
          this.#ctx.db,
          convId,
          afterId,
          CATCHUP_BATCH_SIZE,
        );
        const done = rows.length < CATCHUP_BATCH_SIZE;
        this.#send({
          t: "catchup",
          d: {
            identityId,
            convId,
            messages: rows.map(messageDto),
            done,
            ...(gap && firstFrame ? { gap: true } : {}),
          },
        });
        firstFrame = false;
        const last = rows.at(-1);
        if (last) {
          afterId = last.id;
          sub.delivered.set(convId, last.id);
        }
        if (done) {
          break;
        }
      }
    }
  }

  // ── cmd dispatch ───────────────────────────────────────────────────────────

  async #handleCmd(cmd: GatewayCmd, id: number | undefined): Promise<void> {
    // session.connect bypasses the ownership cache: acting on a stale row
    // would resurrect a just-deleted identity as an orphaned F-Chat session
    // no client could ever see or stop.
    const identity = await this.#ownedIdentity(cmd.identityId, {
      fresh: cmd.action === "session.connect",
    });
    if (!identity) {
      this.#ack(id, { ok: false, error: "identity not found" });
      return;
    }
    switch (cmd.action) {
      case "session.connect":
        // Scenario selection, seeding and the deferred reconcile live in
        // connectIdentity (shared with the REST connect route).
        await connectIdentity(this.#ctx, {
          identityId: identity.id,
          character: identity.character,
          accountId: identity.accountId,
          accountName: identity.accountName,
        });
        this.#ctx.hub.broadcast(identity.id, {
          kind: "identity.updated",
          d: { autoConnect: true },
        });
        this.#ack(id, { ok: true });
        return;
      case "session.disconnect":
        // Flag first, stop second: clients react to the stopped status
        // event, and a tab whose autoConnect mirror still says true would
        // auto-resurrect the session the user just logged off.
        await this.#setAutoConnect(identity.id, false);
        this.#ctx.sessions.stop(identity.id, "disconnected by user");
        this.#ack(id, { ok: true });
        return;
      case "channel.join": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.joinChannel(cmd.d.key);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "channel.leave": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // Leave the wire channel when we're a live member (leaveChannel
          // skips the LCH for a dead/desynced key on its own). Then hide the
          // conversation row so the sidebar loses it everywhere — the kept
          // message history stays in the DB (reachable via log export) and a
          // later rejoin un-hides it in place. Hiding also drops it from the
          // resume set, so no auto-rejoin can drag it back, subsuming the old
          // unpin-on-leave (#169). Works for a live channel, a kicked ghost,
          // and a private room destroyed while detached alike (#327).
          session.leaveChannel(cmd.d.key);
          this.#ctx.history.closeChannelConversation(identity.id, cmd.d.key);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "channel.create": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // The ack confirms the CCR went out; the JCH echo into the new
          // ADH- room flows through the ordinary join/persist fan-out and
          // carries the minted key. Not awaited: the ROOM gate must not
          // stall the serial inbound queue (M6 audit).
          session.createRoom(cmd.d.title).then(
            () => {
              this.#ack(id, { ok: true });
            },
            (error: unknown) => {
              this.#ack(id, {
                ok: false,
                error:
                  error instanceof Error ? error.message : "room create failed",
              });
            },
          );
        }
        return;
      }
      case "channel.invite": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // Not awaited: the ROOM gate can hold a frame and must not stall
          // the serial inbound queue (M6 audit) — the promise's outcome
          // becomes the ack, like msg.send.
          session.inviteToChannel(cmd.d.key, cmd.d.character).then(
            () => {
              this.#ack(id, { ok: true });
            },
            (error: unknown) => {
              this.#ack(id, {
                ok: false,
                error: error instanceof Error ? error.message : "invite failed",
              });
            },
          );
        }
        return;
      }
      case "channel.status": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // Same non-awaiting pattern as channel.create (M6 audit).
          session.setRoomStatus(cmd.d.key, cmd.d.status).then(
            () => {
              this.#ack(id, { ok: true });
            },
            (error: unknown) => {
              this.#ack(id, {
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "room status change failed",
              });
            },
          );
        }
        return;
      }
      case "pm.open": {
        try {
          const row = await this.#ctx.history.ensurePmConversation(
            identity.id,
            cmd.d.character,
          );
          // Seed the new DM row with the partner's live presence (#229) so it
          // shows the right dot at once instead of defaulting to offline.
          const state = this.#ctx.sessions.get(identity.id)?.state;
          const presence = pmPresence(state, row.partnerCharacter ?? "");
          this.#ack(id, {
            ok: true,
            conversation: { ...conversationDto(row), presence },
          });
        } catch (error) {
          if (error instanceof ConversationLimitError) {
            this.#ack(id, { ok: false, error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      case "pm.close": {
        // History stays; only the "window open" flag drops. The updated row
        // also fans out as conversation.updated, converging every tab.
        const row = await this.#ctx.history.closePmConversation(
          identity.id,
          cmd.d.convId,
        );
        if (row) {
          this.#ack(id, { ok: true, conversation: conversationDto(row) });
        } else {
          this.#ack(id, { ok: false, error: "Conversation not found" });
        }
        return;
      }
      case "status.set": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          try {
            // "ok" means accepted, not necessarily already on the wire: the
            // session drops a no-op and paces a real change past F-Chat's
            // five-second status gate (ERR 14) — see FchatSession.setStatus.
            await session.setStatus(cmd.d.status, cmd.d.statusmsg);
            this.#ack(id, { ok: true });
          } catch (error) {
            this.#ack(id, {
              ok: false,
              error:
                error instanceof Error ? error.message : "status set failed",
            });
          }
        }
        return;
      }
      case "ignore.add":
      case "ignore.remove": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          try {
            // State, persistence and fan-out all follow the server's IGN
            // acknowledgement — the cmd only puts the request on the wire.
            if (cmd.action === "ignore.add") {
              await session.ignore(cmd.d.character);
            } else {
              await session.unignore(cmd.d.character);
            }
            this.#ack(id, { ok: true });
          } catch (error) {
            this.#ack(id, {
              ok: false,
              error:
                error instanceof Error ? error.message : "ignore change failed",
            });
          }
        }
        return;
      }
      case "conv.pin": {
        const row = await this.#ctx.history.setPinned(
          identity.id,
          cmd.d.convId,
          cmd.d.pinned,
        );
        if (row) {
          this.#ack(id, { ok: true, conversation: conversationDto(row) });
        } else {
          this.#ack(id, { ok: false, error: "conversation not found" });
        }
        return;
      }
      case "history.page": {
        // Scroll-back paging (#254): one older page from the message store.
        // Ownership check first — conversation ids are guessable UUIDs and
        // the messages table itself has no identity column.
        const [conv] = await this.#ctx.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, cmd.d.convId),
              eq(conversations.identityId, identity.id),
            ),
          );
        if (!conv) {
          this.#ack(id, { ok: false, error: "conversation not found" });
          return;
        }
        const page = await fetchMessagesBefore(
          this.#ctx.db,
          cmd.d.convId,
          cmd.d.beforeId,
          cmd.d.limit,
        );
        this.#ack(id, {
          ok: true,
          messages: page.rows.map(messageDto),
          hasMore: page.hasMore,
        });
        return;
      }
      case "msg.send":
        await this.#handleMsgSend(identity.id, cmd.d, id);
        return;
      case "msg.retry":
        await this.#handleMsgRetry(identity.id, cmd.d, id);
        return;
      case "character.search": {
        // FKS bridge (M10): the session fires the query on the server's
        // 5s pace and correlates the reply; the outcome goes back to the
        // asking connection only (other devices didn't ask).
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // Not awaited past the ack: the pace gate can hold the frame for
          // seconds, and the outcome arrives as its own event.
          session.searchCharacters(cmd.d).then(
            (outcome) => {
              this.deliver(identity.id, {
                kind: "character.search",
                d: outcome,
              });
            },
            (error: unknown) => {
              this.deliver(identity.id, {
                kind: "character.search",
                d: {
                  ok: false,
                  code: 0,
                  message:
                    error instanceof Error ? error.message : "Search failed",
                },
              });
            },
          );
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "campaign.start":
      case "campaign.stop":
      case "campaign.renew":
      case "campaign.drop": {
        // M11 rotation campaigns. State fans out as campaign.updated on
        // the identity; the ack only carries success or a plain-language
        // refusal (CampaignError).
        try {
          if (cmd.action === "campaign.start") {
            await this.#ctx.campaigns.startCampaign(
              identity.id,
              this.#userId!,
              cmd.d,
            );
          } else if (cmd.action === "campaign.stop") {
            await this.#ctx.campaigns.stopCampaign(identity.id);
          } else if (cmd.action === "campaign.renew") {
            await this.#ctx.campaigns.renewCampaign(identity.id);
          } else {
            await this.#ctx.campaigns.dropChannel(identity.id, cmd.d.key);
          }
          this.#ack(id, { ok: true });
        } catch (error) {
          if (error instanceof CampaignError) {
            this.#ack(id, { ok: false, error: error.message });
          } else {
            throw error;
          }
        }
        return;
      }
      case "ads.cooldowns": {
        // Per-channel ad-cooldown query (M10 post flow). The waits are this
        // session's volatile rate-gate state, so the reply goes to the
        // asking connection only — not a hub fan-out.
        const session = this.#requireSession(identity.id, id);
        if (session) {
          const waits: Record<string, number> = {};
          for (const key of cmd.d.keys) {
            waits[key] = session.adWaitMs(key);
          }
          this.deliver(identity.id, { kind: "ads.cooldowns", d: { waits } });
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "channel.roll": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          // Like msg.send: the flood-gate wait must not stall the inbound
          // queue, so the promise's outcome becomes the ack instead.
          session.rollDice(cmd.d.key, cmd.d.dice).then(
            () => {
              this.#ack(id, { ok: true });
            },
            (error: unknown) => {
              this.#ack(id, {
                ok: false,
                error: error instanceof Error ? error.message : "roll failed",
              });
            },
          );
        }
        return;
      }
      // Alert Staff (M7): same non-stalling ack shape as channel.roll.
      case "user.report": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.reportToStaff(cmd.d.character, cmd.d.report).then(
            () => {
              this.#ack(id, { ok: true });
            },
            (error: unknown) => {
              this.#ack(id, {
                ok: false,
                error: error instanceof Error ? error.message : "report failed",
              });
            },
          );
        }
        return;
      }
      // Channel moderation (M6): one shared shape — put the frame on the
      // wire behind the ROOM gate, ack the send. Refusals (not an op, ERR
      // 21/41/42…) come back as ERR frames and fan out as error events.
      case "channel.kick":
      case "channel.ban":
      case "channel.unban":
      case "channel.timeout":
      case "channel.promote":
      case "channel.demote":
      case "channel.owner":
      case "channel.describe":
      case "channel.mode":
      case "channel.banlist": {
        const session = this.#requireSession(identity.id, id);
        if (!session) {
          return;
        }
        const send =
          cmd.action === "channel.kick"
            ? session.kickFromChannel(cmd.d.key, cmd.d.character)
            : cmd.action === "channel.ban"
              ? session.banFromChannel(cmd.d.key, cmd.d.character)
              : cmd.action === "channel.unban"
                ? session.unbanFromChannel(cmd.d.key, cmd.d.character)
                : cmd.action === "channel.timeout"
                  ? session.timeoutFromChannel(
                      cmd.d.key,
                      cmd.d.character,
                      cmd.d.minutes,
                    )
                  : cmd.action === "channel.promote"
                    ? session.promoteOp(cmd.d.key, cmd.d.character)
                    : cmd.action === "channel.demote"
                      ? session.demoteOp(cmd.d.key, cmd.d.character)
                      : cmd.action === "channel.owner"
                        ? session.setRoomOwner(cmd.d.key, cmd.d.character)
                        : cmd.action === "channel.describe"
                          ? session.setRoomDescription(
                              cmd.d.key,
                              cmd.d.description,
                            )
                          : cmd.action === "channel.mode"
                            ? session.setRoomMode(cmd.d.key, cmd.d.mode)
                            : session.requestBanlist(cmd.d.key);
        send.then(
          () => {
            this.#ack(id, { ok: true });
          },
          (error: unknown) => {
            this.#ack(id, {
              ok: false,
              error: error instanceof Error ? error.message : "send failed",
            });
          },
        );
        return;
      }
      case "typing.set": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.sendTyping(cmd.d.character, cmd.d.status);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "outbox.recall": {
        const recalled = await this.#ctx.outbox.recall(
          identity.id,
          cmd.d.outboxId,
        );
        if (recalled) {
          this.#ack(id, { ok: true, markdown: recalled.markdown });
        } else {
          // Released, already recalled, or never this identity's row.
          this.#ack(id, { ok: false, error: "outbox item not found" });
        }
        return;
      }
      case "prefs.set": {
        await this.#patchPrefs(cmd.d);
        this.#ack(id, { ok: true });
        return;
      }
    }
  }

  /** The user's preferences; absent row = all defaults. Served from the
   * shared per-user cache, which the prefs patch below drops. */
  async #userPrefs(): Promise<ResolvedUserPrefs> {
    return this.#userId === undefined
      ? { sendDelaySeconds: 0, prefs: resolvePrefs({}) }
      : this.#ctx.userPrefs.get(this.#userId);
  }

  /**
   * Applies a prefs patch and converges every identity's tabs. The jsonb
   * merge happens in SQL (`prefs || patch`) so two devices patching
   * different keys concurrently both land — no read-modify-write race.
   */
  async #patchPrefs(d: {
    sendDelaySeconds?: number;
    prefs?: UserPrefsPatch;
  }): Promise<void> {
    if (this.#userId === undefined) {
      return;
    }
    const patch = d.prefs ?? {};
    // RETURNING makes the broadcast atomic with the merge: a separate
    // re-read could resolve after a concurrent patch's UPDATE but broadcast
    // before (or after) its fan-out, regressing the other device's key on
    // every tab with nothing to correct it until the next write.
    const [merged] = await this.#ctx.db
      .insert(userPreferences)
      .values({
        userId: this.#userId,
        sendDelaySeconds: d.sendDelaySeconds ?? 0,
        prefs: patch,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(d.sendDelaySeconds === undefined
            ? {}
            : { sendDelaySeconds: d.sendDelaySeconds }),
          prefs: sql`${userPreferences.prefs} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        },
      })
      .returning({
        sendDelaySeconds: userPreferences.sendDelaySeconds,
        prefs: userPreferences.prefs,
      });
    // The highlight matcher caches highlightOwnNick per user (M5); the
    // notification store caches the mute lists it stamps rows with (#467);
    // the gateway caches the whole resolved document (audit backlog). All
    // three are dropped here — this is the only writer.
    this.#ctx.highlights.invalidate(this.#userId);
    this.#ctx.notifications.invalidatePrefs(this.#userId);
    this.#ctx.userPrefs.invalidate(this.#userId);
    // The CSP folds in every user's image-preview allowlist (#342); rebuild
    // the cached union when this patch touched it so the next response admits
    // (or drops) the host. Cheap and rare — a full recompute is fine.
    if (Object.prototype.hasOwnProperty.call(patch, "imagePreviewHosts")) {
      await this.#ctx.imagePreviewHosts.refresh();
    }
    // Broadcast the full resolved state, not the patch — every tab applies
    // it as an idempotent overwrite regardless of what it missed.
    const state = {
      sendDelaySeconds: merged?.sendDelaySeconds ?? 0,
      prefs: resolvePrefs(merged?.prefs),
    };
    const rows = await this.#ctx.db
      .select({ id: identities.id })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(flistAccounts.userId, this.#userId));
    for (const row of rows) {
      this.#ctx.hub.broadcast(row.id, {
        kind: "prefs.updated",
        d: state,
      });
    }
  }

  async #handleMsgSend(
    identityId: string,
    d: {
      convId: string;
      bbcode: string;
      markdown?: string;
      kind?: "lrp" | "msg";
      immediate?: boolean;
    },
    id: number | undefined,
  ): Promise<void> {
    const session = this.#requireSession(identityId, id);
    if (!session) {
      return;
    }
    const [conversation] = await this.#ctx.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, d.convId),
          eq(conversations.identityId, identityId),
        ),
      )
      .limit(1);
    if (!conversation) {
      this.#ack(id, { ok: false, error: "conversation not found" });
      return;
    }
    const ad = d.kind === "lrp";
    if (ad && conversation.kind !== "channel") {
      this.#ack(id, { ok: false, error: "ads can only go to channels" });
      return;
    }
    // A non-zero send delay parks the message in the server-side outbox —
    // the release worker puts it on the wire when due, tab or no tab.
    // `immediate` (M10 post flow) opts a send out of the delay: the dialog
    // reports per-channel outcomes, and a parked ad has none to report.
    const { sendDelaySeconds: delaySeconds } = await this.#userPrefs();
    if (delaySeconds > 0 && d.immediate !== true) {
      // Validate against the live VAR limit NOW, like the immediate path —
      // deferring the check to release time would fail silently long after
      // the user could react (audit).
      const limit = ad
        ? session.state.vars.lfrp_max
        : conversation.kind === "channel"
          ? session.state.vars.chat_max
          : session.state.vars.priv_max;
      if (Buffer.byteLength(d.bbcode, "utf8") > limit) {
        this.#ack(id, {
          ok: false,
          error: `Message exceeds the server's ${String(limit)}-byte limit`,
        });
        return;
      }
      await this.#ctx.outbox.schedule({
        identityId,
        conversationId: conversation.id,
        // Recall restores what the user typed; raw-BBCode sends have no
        // separate source form.
        markdown: d.markdown ?? d.bbcode,
        bbcode: d.bbcode,
        kind: ad ? "lrp" : "msg",
        releaseAt: new Date(Date.now() + delaySeconds * 1000),
      });
      this.#ack(id, { ok: true });
      return;
    }
    const send = ad
      ? session.sendChannelAd(conversation.channelKey ?? "", d.bbcode)
      : conversation.kind === "channel"
        ? session.sendChannelMessage(conversation.channelKey ?? "", d.bbcode)
        : session.sendPrivateMessage(
            conversation.partnerCharacter ?? "",
            d.bbcode,
          );
    // Deliberately not awaited: the flood gate can hold a frame for seconds
    // and must not stall the inbound queue. The promise is always handled —
    // its outcome becomes the ack.
    send.then(
      () => {
        this.#ack(id, { ok: true });
      },
      (error: unknown) => {
        this.#ack(id, {
          ok: false,
          error: error instanceof Error ? error.message : "send failed",
        });
      },
    );
  }

  /**
   * Re-sends a DM the server refused (#491). The stored BBCode is what went
   * on the wire the first time, so it is exactly what goes back — no
   * re-translation, no composer round trip — and the send is tagged with the
   * row it belongs to, so the history sink clears that row's failure instead
   * of writing a second line. Never delayed: retrying is a present-tense
   * gesture, and the outbox would hide it for the length of the send delay.
   */
  async #handleMsgRetry(
    identityId: string,
    d: { convId: string; messageId: number },
    id: number | undefined,
  ): Promise<void> {
    const session = this.#requireSession(identityId, id);
    if (!session) {
      return;
    }
    const [found] = await this.#ctx.db
      .select({ message: messages, conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(messages.id, d.messageId),
          eq(messages.conversationId, d.convId),
          eq(conversations.identityId, identityId),
        ),
      )
      .limit(1);
    if (!found) {
      this.#ack(id, { ok: false, error: "message not found" });
      return;
    }
    // Only a refused own DM may be retried: anything else would put a
    // message back on the wire that already reached its reader.
    if (
      found.message.failureReason === null ||
      !found.message.sentByUs ||
      found.conversation.kind !== "pm"
    ) {
      this.#ack(id, { ok: false, error: "message is not a failed send" });
      return;
    }
    // Not awaited past the ack, like msg.send: the flood gate can hold the
    // frame for seconds and must not stall the inbound queue.
    session
      .sendPrivateMessage(
        found.conversation.partnerCharacter ?? "",
        found.message.bbcode,
        { retryOf: found.message.id },
      )
      .then(
        () => {
          this.#ack(id, { ok: true });
        },
        (error: unknown) => {
          this.#ack(id, {
            ok: false,
            error: error instanceof Error ? error.message : "retry failed",
          });
        },
      );
  }

  /**
   * autoConnect mirrors the user's connect intent: an explicit connect sets
   * it, an explicit disconnect clears it — so after a restart, "identities
   * that need re-auth" is exactly the autoConnect set, and one unlock brings
   * them all back (milestone-2 §Scope). Fanned out so every tab's mirror
   * converges — a stale mirror could silently reconnect an identity the
   * user just logged off elsewhere.
   */
  async #setAutoConnect(identityId: string, value: boolean): Promise<void> {
    await this.#ctx.db
      .update(identities)
      .set({ autoConnect: value })
      .where(eq(identities.id, identityId));
    this.#ctx.hub.broadcast(identityId, {
      kind: "identity.updated",
      d: { autoConnect: value },
    });
  }

  #requireSession(
    identityId: string,
    ackId: number | undefined,
  ): FchatSession | undefined {
    const session = this.#ctx.sessions.get(identityId);
    if (!session || session.status === "stopped") {
      this.#ack(ackId, { ok: false, error: "session not connected" });
      return undefined;
    }
    return session;
  }

  async #handleReadAck(d: {
    identityId: string;
    convId: string;
    messageId: number;
  }): Promise<void> {
    const identity = await this.#ownedIdentity(d.identityId);
    if (!identity) {
      return;
    }
    // markRead emits conversation.updated through the history bus, which the
    // hub fans out — every tab's unread counters converge.
    await this.#ctx.history.markRead(identity.id, d.convId, d.messageId);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  #ack(
    id: number | undefined,
    d: {
      ok: boolean;
      error?: string;
      conversation?: ConversationDto;
      markdown?: string;
      messages?: MessageDto[];
      hasMore?: boolean;
    },
  ): void {
    if (id !== undefined) {
      this.#send({ t: "ack", id, d });
    }
  }

  #send(frame: ServerFrame): void {
    if (this.#socket.readyState !== this.#socket.OPEN) {
      return;
    }
    if (this.#socket.bufferedAmount > this.#maxBufferedBytes) {
      this.#close(GATEWAY_CLOSE.slowConsumer, "send buffer overflow");
      return;
    }
    this.#socket.send(JSON.stringify(frame));
  }

  #close(code: number, reason: string): void {
    this.#teardown();
    try {
      this.#socket.close(code, reason);
    } catch {
      this.#socket.terminate();
    }
  }

  #teardown(): void {
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
    if (this.#authTimer) {
      clearInterval(this.#authTimer);
      this.#authTimer = undefined;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#subscriptions.clear();
    this.#ctx.hub.dropConnection(this);
  }
}

export function conversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    kind: row.kind,
    channelKey: row.channelKey,
    partnerCharacter: row.partnerCharacter,
    title: row.title,
    pinned: row.pinned,
    joined: row.joined,
    lastReadMessageId: row.lastReadMessageId,
  };
}
