// GatewayHub — fan-out from server-held sessions to browser connections.
//
// Two event sources feed it (architecture.md §Resume semantics):
// - the history sink's bus for durable events (message.new carries the
//   persisted messages.id, so live fan-out is consistent with catchup), and
// - each session's bus for volatile events (presence, members, typing,
//   session status), translated here into gateway event DTOs.

import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { ServerCommand } from "@emberchat/fchat-protocol";
import { GATEWAY_CLOSE, type GatewayEvent } from "@emberchat/protocol";
import type { CampaignScheduler } from "../campaigns/scheduler.js";
import type { Db } from "../../db/index.js";
import { authSessions } from "../../db/schema.js";
import type { HighlightMatcher } from "../highlights/matcher.js";
import type { ImagePreviewHostRegistry } from "../../security/image-preview-hosts.js";
import type { HistorySink } from "../history/sink.js";
import type {
  FchatSession,
  SessionLogger,
  SessionRegistry,
} from "@emberchat/session-engine";
import {
  notificationDto,
  type NotificationStore,
} from "../notifications/store.js";
import type { Outbox } from "../outbox/outbox.js";
import type { SocialCache } from "../social/cache.js";
import {
  GatewayConnection,
  conversationDto,
  type GatewayTuning,
} from "./connection.js";
import { memberDto, messageDto } from "./snapshot.js";
import { UserPrefsCache } from "./user-prefs.js";

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface GatewayHubOptions {
  readonly history: HistorySink;
  /** Notification inbox (#467) — its writes fan out as `notification.new`. */
  readonly notifications?: NotificationStore;
  readonly logger?: SessionLogger;
}

export class GatewayHub {
  readonly #log: SessionLogger;
  readonly #subscribers = new Map<string, Set<GatewayConnection>>();
  /** Bus unsubscribers per identity — called when a session is replaced. */
  readonly #sessionDetach = new Map<string, () => void>();
  /** Fired when an identity goes from zero subscribers to one — the
   * auto-away return hook (M5). Assigned in buildApp. */
  onFirstSubscribe?: (identityId: string) => void;
  /** Fired when an attached browser reports user activity — the idle-away
   * restore hook (#619). Assigned in buildApp. */
  onActivity?: (identityId: string) => void;

  constructor(options: GatewayHubOptions) {
    this.#log = options.logger ?? NOOP_LOGGER;
    options.history.events.on("message", ({ identityId, message }) => {
      this.broadcast(identityId, {
        kind: "message.new",
        d: { convId: message.conversationId, message: messageDto(message) },
      });
    });
    options.history.events.on("messageUpdated", ({ identityId, message }) => {
      this.broadcast(identityId, {
        kind: "message.updated",
        d: { convId: message.conversationId, message: messageDto(message) },
      });
    });
    options.history.events.on(
      "conversation",
      ({ identityId, conversation }) => {
        this.broadcast(identityId, {
          kind: "conversation.updated",
          d: { conversation: conversationDto(conversation) },
        });
      },
    );
    options.history.events.on(
      "conversationRemoved",
      ({ identityId, conversationId }) => {
        this.broadcast(identityId, {
          kind: "conversation.removed",
          d: { convId: conversationId },
        });
      },
    );
    options.notifications?.events.on(
      "notification",
      ({ identityId, notification }) => {
        this.broadcast(identityId, {
          kind: "notification.new",
          d: { notification: notificationDto(notification) },
        });
      },
    );
  }

  /**
   * Called from SessionRegistry.onSessionStarted, before the session begins
   * connecting. A restarted identity gets a fresh FchatSession object, so any
   * previous session's bus subscriptions are detached first.
   */
  attachSession(identityId: string, session: FchatSession): void {
    this.#sessionDetach.get(identityId)?.();
    const offCommand = session.events.on("command", (command) => {
      const event = translateCommand(session, command);
      if (event) {
        this.broadcast(identityId, event);
      }
    });
    const offStatus = session.events.on("status", ({ status, reason }) => {
      this.broadcast(identityId, {
        kind: "session.status",
        d: { status, ...(reason !== undefined ? { reason } : {}) },
      });
      if (status === "stopped") {
        detach();
      }
    });
    const detach = () => {
      offCommand();
      offStatus();
      this.#sessionDetach.delete(identityId);
    };
    this.#sessionDetach.set(identityId, detach);
  }

  subscribe(identityId: string, connection: GatewayConnection): void {
    let set = this.#subscribers.get(identityId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(identityId, set);
    }
    const first = set.size === 0;
    set.add(connection);
    if (first) {
      this.onFirstSubscribe?.(identityId);
    }
  }

  /** How many browsers are attached to the identity (multi-device fan-out
   * width; the heartbeat must prune zombies from this count). */
  subscriberCount(identityId: string): number {
    return this.#subscribers.get(identityId)?.size ?? 0;
  }

  /** True while at least one browser is attached to the identity. */
  hasSubscribers(identityId: string): boolean {
    return (this.#subscribers.get(identityId)?.size ?? 0) > 0;
  }

  /** Relays an activity report to the away sweep (called per subscribed
   * identity by the reporting connection). */
  notifyActivity(identityId: string): void {
    this.onActivity?.(identityId);
  }

  /**
   * Pooled user activity across the identity's attached browsers (#619) —
   * the answer to "is this identity idle", which no single device can give
   * because F-Chat status is per character while activity is per device.
   *
   * - a number: every attached browser reports, and this is the newest of them
   * - `"unknown"`: at least one attached browser has never reported (a client
   *   older than the `activity` frame). The identity must not be judged idle:
   *   an unreporting browser is not evidence of an absent user, and the safe
   *   reading of "I cannot tell" is "do not touch their status"
   * - `undefined`: nothing is attached — the detached path owns this case
   */
  activityAcross(identityId: string): number | "unknown" | undefined {
    const set = this.#subscribers.get(identityId);
    if (!set || set.size === 0) {
      return undefined;
    }
    let newest = 0;
    for (const connection of set) {
      const at = connection.lastActivityAt;
      if (at === undefined) {
        return "unknown";
      }
      newest = Math.max(newest, at);
    }
    return newest;
  }

  unsubscribe(identityId: string, connection: GatewayConnection): void {
    const set = this.#subscribers.get(identityId);
    if (set) {
      set.delete(connection);
      if (set.size === 0) {
        this.#subscribers.delete(identityId);
      }
    }
  }

  dropConnection(connection: GatewayConnection): void {
    for (const identityId of [...this.#subscribers.keys()]) {
      this.unsubscribe(identityId, connection);
    }
  }

  /**
   * Called by the identities DELETE route: subscribed connections drop their
   * ownership cache and subscription so nothing acts on the dead identity.
   * (session.connect additionally re-verifies ownership uncached.)
   */
  identityDeleted(identityId: string): void {
    this.#sessionDetach.get(identityId)?.();
    for (const connection of this.#subscribers.get(identityId) ?? []) {
      connection.dropIdentity(identityId);
    }
    this.#subscribers.delete(identityId);
  }

  broadcast(identityId: string, event: GatewayEvent): void {
    const set = this.#subscribers.get(identityId);
    if (!set) {
      return;
    }
    for (const connection of [...set]) {
      try {
        connection.deliver(identityId, event);
      } catch (error) {
        this.#log.error({ err: error }, "gateway fan-out failed");
      }
    }
  }
}

/**
 * Volatile session commands → gateway events. Durable ones (MSG/PRI/channel
 * SYS) are deliberately absent: they fan out from the history sink after
 * persistence so they carry their messages.id. Presence is fanned out
 * unfiltered — per-client interest filtering is a scale concern for later
 * milestones.
 */
function translateCommand(
  session: FchatSession,
  command: ServerCommand,
): GatewayEvent | undefined {
  switch (command.cmd) {
    case "JCH":
      return {
        kind: "member.join",
        d: {
          channelKey: command.payload.channel,
          member: memberDto(session.state, command.payload.character.identity),
        },
      };
    case "LCH":
      return {
        kind: "member.leave",
        d: {
          channelKey: command.payload.channel,
          character: command.payload.character,
        },
      };
    case "ICH":
      return {
        kind: "channel.members",
        d: {
          key: command.payload.channel,
          mode: command.payload.mode,
          members: command.payload.users.map((user) =>
            memberDto(session.state, user.identity),
          ),
        },
      };
    case "CIU":
      // An invitation to a private room — actionable client-side (join /
      // dismiss). Volatile: a missed invite is joinable later via the key.
      return {
        kind: "channel.invite",
        d: {
          sender: command.payload.sender,
          title: command.payload.title,
          key: command.payload.name,
        },
      };
    case "CDS":
      return {
        kind: "channel.info",
        d: {
          key: command.payload.channel,
          description: command.payload.description,
        },
      };
    case "COL":
      return {
        kind: "channel.info",
        d: {
          key: command.payload.channel,
          oplist: [...command.payload.oplist],
        },
      };
    case "RMO":
      // Room mode changed (chat/ads/both) — gates what the composer offers.
      return {
        kind: "channel.info",
        d: {
          key: command.payload.channel,
          mode: command.payload.mode,
        },
      };
    // Kick / ban / timeout remove the member (no LCH follows); the
    // who-did-what SystemLine is persisted by the sink and arrives as
    // message.new.
    case "CKU":
    case "CBU":
    case "CTU":
      return {
        kind: "member.leave",
        d: {
          channelKey: command.payload.channel,
          character: command.payload.character,
        },
      };
    // Op roster changes: state already folded the command, so the map
    // holds the post-change oplist (same pattern as IGN).
    case "COA":
    case "COR":
    case "CSO": {
      const oplist = session.state.channels.get(
        command.payload.channel,
      )?.oplist;
      return oplist
        ? {
            kind: "channel.info",
            d: { key: command.payload.channel, oplist: [...oplist] },
          }
        : undefined;
    }
    case "IGN":
      // Any list change (init at login, add/delete acks) fans the whole
      // list out — session state already folded this command in, so the
      // map holds the post-change truth.
      return {
        kind: "ignore.updated",
        d: { characters: [...session.state.ignores.values()] },
      };
    case "LIS":
      // The already-online roster streams in batches after identify; a
      // client whose snapshot raced it would otherwise show everyone
      // offline until their next status change (found on live F-Chat —
      // the sim's world is too small to ever lose that race).
      return {
        kind: "presence.bulk",
        d: {
          characters: command.payload.characters.map(
            ([name, gender, status, statusmsg]) => [
              name,
              gender,
              status,
              statusmsg,
            ],
          ),
        },
      };
    case "NLN":
      return {
        kind: "presence",
        d: {
          character: command.payload.identity,
          online: true,
          gender: command.payload.gender,
          status: command.payload.status,
          statusmsg: "",
        },
      };
    case "FLN":
      return {
        kind: "presence",
        d: { character: command.payload.character, online: false },
      };
    case "STA":
      return {
        kind: "presence",
        d: {
          character: command.payload.character,
          online: true,
          status: command.payload.status,
          statusmsg: command.payload.statusmsg,
        },
      };
    case "TPN":
      return {
        kind: "typing",
        d: {
          character: command.payload.character,
          status: command.payload.status,
        },
      };
    case "SYS":
      // Channel-scoped SYS is persisted and fans out as message.new.
      return command.payload.channel === undefined
        ? { kind: "sys", d: { message: command.payload.message } }
        : undefined;
    case "BRO":
      // Admin broadcasts are rare and server-critical — the one frame that
      // must never be swallowed (feature-parity audit, decision 5).
      return {
        kind: "sys",
        d: {
          message: `Server broadcast${
            command.payload.character !== undefined
              ? ` from ${command.payload.character}`
              : ""
          }: ${command.payload.message}`,
        },
      };
    case "RTB": {
      // Website events (notes, friend requests…). The website stays the
      // place to read and act; the client shows a notice + notification.
      const character =
        command.payload.character ??
        command.payload.name ??
        command.payload.sender;
      return {
        kind: "rtb",
        d: {
          type: command.payload.type,
          ...(character !== undefined ? { character } : {}),
          ...(command.payload.subject !== undefined
            ? { subject: command.payload.subject }
            : {}),
        },
      };
    }
    case "ERR":
      return {
        kind: "error",
        d: {
          number: command.payload.number,
          message: command.payload.message,
        },
      };
    default:
      return undefined;
  }
}

export interface GatewayRoutesOptions {
  db: Db;
  sessions: SessionRegistry;
  history: HistorySink;
  hub: GatewayHub;
  outbox: Outbox;
  highlights: HighlightMatcher;
  /** Notification inbox (#467) — unseen counts on `ready`, mute-cache
   * invalidation on a prefs patch. */
  notifications: NotificationStore;
  /** Live union of user image-preview allowlists, refreshed on pref writes so
   * the CSP keeps up with user-added hosts (#342). */
  imagePreviewHosts: Pick<ImagePreviewHostRegistry, "refresh">;
  campaigns: CampaignScheduler;
  /** Cached social lists — served in the snapshot (#194). */
  social: SocialCache;
  /**
   * The process-wide prefs cache. Passed in so other readers — the push
   * sender (design/web-push.md §3) — share the entry this connection's prefs
   * patch invalidates; omitted, the gateway keeps its own.
   */
  userPrefs?: UserPrefsCache;
  /**
   * Origins allowed to open the gateway from a browser (M7 exposure
   * hardening). A request WITHOUT an Origin header is allowed — non-browser
   * clients (tests, tooling, the future desktop shell) don't send one, and
   * the hello token is the real gate. A browser always sends it, and a
   * cross-site page's WebSocket carries no CORS preflight — this check is
   * what stops a hostile page from riding a victim's network position.
   */
  allowedOrigins: readonly string[];
  /** Test-only connection knobs; production runs the connection.ts defaults. */
  tuning?: GatewayTuning;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function gatewayRoutes(
  instance: FastifyInstance,
  options: GatewayRoutesOptions,
): Promise<void> {
  const {
    db,
    sessions,
    history,
    hub,
    outbox,
    highlights,
    notifications,
    imagePreviewHosts,
    campaigns,
    social,
    allowedOrigins,
    tuning,
  } = options;
  // One per process, not per connection: the whole point is that a user's
  // second device (and the next msg.send) reads no row at all.
  const userPrefs = options.userPrefs ?? new UserPrefsCache(db);
  const originAllowList = new Set(
    allowedOrigins.map((origin) => origin.toLowerCase()),
  );
  const HELLO_BUDGET_PER_MINUTE = 20;

  /** True while the auth session row exists and is unexpired. */
  async function sessionAlive(sid: string): Promise<boolean> {
    const [session] = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(eq(authSessions.id, sid), gt(authSessions.expiresAt, new Date())),
      )
      .limit(1);
    return session !== undefined;
  }

  // Fixed-window hello budget per user (see GatewayConnectionContext).
  const helloWindows = new Map<string, { count: number; resetAt: number }>();
  function helloBudget(userId: string): boolean {
    const now = Date.now();
    if (helloWindows.size > 10_000) {
      for (const [key, window] of helloWindows) {
        if (now >= window.resetAt) {
          helloWindows.delete(key);
        }
      }
    }
    let window = helloWindows.get(userId);
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + 60_000 };
      helloWindows.set(userId, window);
    }
    window.count += 1;
    return window.count <= HELLO_BUDGET_PER_MINUTE;
  }

  /** Same trust chain as the REST `authenticate` guard: valid JWT whose sid
   * still maps to a live auth session. The connection re-checks the sid
   * periodically, so logout kills gateway access too — not just at connect. */
  async function verifyToken(
    token: string,
  ): Promise<{ userId: string; sid: string } | undefined> {
    let payload: { sub: string; sid: string };
    try {
      payload = instance.jwt.verify<{ sub: string; sid: string }>(token);
    } catch {
      return undefined;
    }
    return (await sessionAlive(payload.sid))
      ? { userId: payload.sub, sid: payload.sid }
      : undefined;
  }

  instance.get("/gateway", { websocket: true }, (socket: WebSocket, req) => {
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && !originAllowList.has(origin)) {
      instance.log.warn({ origin }, "gateway origin refused");
      socket.close(GATEWAY_CLOSE.badOrigin, "origin not allowed");
      return;
    }
    new GatewayConnection(socket, {
      db,
      sessions,
      history,
      hub,
      outbox,
      highlights,
      notifications,
      imagePreviewHosts,
      userPrefs,
      campaigns,
      social,
      verifyToken,
      sessionAlive,
      helloBudget,
      ...(tuning !== undefined ? { tuning } : {}),
      log: instance.log,
    });
  });
}
