// Auto-away (M5 + #619, decisions.md §10): the bouncer is the single owner of
// "is this user idle", for both shapes of the question.
//
// - **Idle while attached** (`autoAway*`) — every browser reports user activity
//   as it happens; the identity is idle when the newest report across *all* of
//   them is older than the threshold. That framing is the point of #619: F-Chat
//   status is per character while activity is per device, so a phone left on a
//   table must not away a character its owner is actively typing as from a
//   laptop. Only the bouncer sees every device, so only the bouncer can answer.
// - **Detached** (`detachedAway*`, opt-in) — no browser at all has been
//   attached for N minutes.
//
// Both share one applied-status record and one restore path, which is what
// keeps them from fighting: an identity can only be awayed by our hand once,
// and the first return undoes it. The sweep only ever moves a status *from
// "online"*, and a restore only ever undoes an away whose message is still the
// one we sent — a chosen away/busy/looking/dnd is the user's, and the bouncer
// never clobbers it.
//
// The same sweep enforces the detached-disconnect ceiling (M8, decisions.md
// §15): a session nobody has attached to for DETACHED_DISCONNECT_HOURS is
// stopped outright — holding an F-Chat connection no one reads for days is
// discourteous to F-List. autoConnect intent stays true and the vault keeps
// the credentials, so the next attach reconnects automatically with the
// exact channel set (§9 scenario 2).
//
// Going away is decided on the sweep (up to a minute late, which nobody
// notices); coming back is event-driven off the activity report, because that
// is the half the user watches.

import { eq, inArray } from "drizzle-orm";
import { resolvePrefs } from "@emberchat/protocol";
import type { ClientSettableStatus, UserPrefs } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities, userPreferences } from "../../db/schema.js";
import type { GatewayHub } from "../gateway/gateway.js";
import type {
  FchatSession,
  SessionLogger,
  SessionRegistry,
} from "@emberchat/session-engine";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface AutoAwayOptions {
  db: Db;
  sessions: SessionRegistry;
  hub: GatewayHub;
  logger: SessionLogger;
  sweepIntervalMs?: number;
  /** Stop a session after this long with zero subscribers; 0 = never. */
  disconnectAfterMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface RememberedStatus {
  status: ClientSettableStatus;
  statusmsg: string;
}

/** An away this module put on, held until the user comes back. */
interface AppliedAway {
  /** The status we replaced, to hand back. */
  previous: RememberedStatus;
  /**
   * The away message we actually sent. The restore matches on it so that
   * editing `autoAwayMessage` while away cannot orphan the restore, and so a
   * status the user changed underneath us is left alone.
   */
  awayMsg: string;
  /**
   * False when the user turned "clear on return" off: returning then forgets
   * the record rather than restoring, which is what that preference means —
   * the away becomes theirs to clear.
   */
  restoreOnReturn: boolean;
}

/** Which question put an identity on the candidate list this sweep. */
type AwayReason = "idle" | "detached";

interface Candidate {
  identityId: string;
  session: FchatSession;
  reason: AwayReason;
  /** The instant the threshold counts from: newest pooled activity for
   * "idle", the first subscriber-less sweep for "detached". */
  since: number;
}

export class AutoAway {
  readonly #options: Required<
    Pick<AutoAwayOptions, "db" | "sessions" | "hub" | "logger">
  > &
    AutoAwayOptions;
  readonly #now: () => number;
  /** First sweep that saw the identity subscriber-less (epoch ms). */
  readonly #detachedSince = new Map<string, number>();
  /** Statuses we replaced, awaiting the user's return. */
  readonly #applied = new Map<string, AppliedAway>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #sweeping = false;

  constructor(options: AutoAwayOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Seed the detachment clock from persisted state (boot resume,
   * decisions.md §15): the ceiling counts from the pre-restart detach
   * where known, not from the restart.
   */
  seedDetachment(identityId: string, sinceMs: number): void {
    if (!this.#detachedSince.has(identityId)) {
      this.#detachedSince.set(identityId, sinceMs);
    }
  }

  /**
   * The attach hook (hub.onFirstSubscribe): the user is looking again — the
   * detachment clock resets, and the return path runs.
   */
  onAttach(identityId: string): void {
    if (this.#detachedSince.delete(identityId)) {
      this.#persistDetachedAt(identityId, null);
    }
    this.noteActivity(identityId);
  }

  /**
   * The return hook (hub.onActivity, and attaching): an away we applied hands
   * back what it replaced. Synchronous and free of database reads, because it
   * runs off every activity report — everything it needs was recorded when the
   * away went on.
   *
   * Restore only overwrites our own work: if the status moved since (another
   * client, a manual STA racing the report), it stays.
   */
  noteActivity(identityId: string): void {
    const remembered = this.#applied.get(identityId);
    if (!remembered) {
      return;
    }
    this.#applied.delete(identityId);
    if (!remembered.restoreOnReturn) {
      return;
    }
    const session = this.#options.sessions.get(identityId);
    if (!session || session.status !== "online") {
      return;
    }
    const current = session.ownStatus;
    if (current.status !== "away" || current.statusmsg !== remembered.awayMsg) {
      return;
    }
    session
      .setStatus(remembered.previous.status, remembered.previous.statusmsg)
      .catch((error: unknown) => {
        this.#options.logger.warn(
          { err: error, identityId },
          "auto-away restore failed",
        );
      });
  }

  /**
   * One pass over the running sessions. Detachment is observed here rather
   * than event-driven so sessions that were never attached (a reconnect
   * after a server restart, say) still count from their first
   * subscriber-less sweep.
   */
  async sweep(): Promise<void> {
    if (this.#sweeping) {
      return;
    }
    this.#sweeping = true;
    try {
      await this.#sweep();
    } catch (error) {
      // The interval calls this with no rejection handler, and an unhandled
      // rejection ends the process — which, with the vault being memory-only,
      // logs everyone out of F-Chat. A blip on the prefs query is not worth
      // that; the next tick retries. Same shape as RetentionJob.sweepOnce.
      this.#options.logger.error({ err: error }, "auto-away sweep failed");
    } finally {
      this.#sweeping = false;
    }
  }

  async #sweep(): Promise<void> {
    const now = this.#now();
    const entries = this.#options.sessions.entries();
    // Prune state for sessions that no longer run (explicit disconnect,
    // identity delete): a stale #applied entry would block re-applying
    // away after a reconnect — the fresh session starts plain "online",
    // there is nothing left to restore.
    const live = new Set(entries.map(([identityId]) => identityId));
    for (const identityId of [...this.#applied.keys()]) {
      if (!live.has(identityId)) {
        this.#applied.delete(identityId);
      }
    }
    for (const identityId of [...this.#detachedSince.keys()]) {
      if (!live.has(identityId)) {
        this.#detachedSince.delete(identityId);
      }
    }
    const candidates: Candidate[] = [];
    for (const [identityId, session] of entries) {
      let candidate: Candidate | undefined;
      if (this.#options.hub.hasSubscribers(identityId)) {
        // Belt and braces with onAttach, which is what normally clears this:
        // an attached identity must never accumulate detached time, or the
        // disconnect ceiling would eventually stop a session someone is
        // watching.
        this.#detachedSince.delete(identityId);
        candidate = this.#idleCandidate(identityId, session);
      } else {
        candidate = this.#detachedCandidate(identityId, session, now);
      }
      if (candidate) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) {
      return;
    }
    // One prefs query per sweep, not one per candidate identity (M5
    // audit backlog) — a bouncer with many idle identities was paying
    // N queries a minute for a feature most users leave off.
    const prefsById = await this.#userPrefsBatch(
      candidates.map((candidate) => candidate.identityId),
    );
    for (const candidate of candidates) {
      const prefs = prefsById.get(candidate.identityId);
      if (!prefs || !this.#overThreshold(candidate, prefs, now)) {
        continue;
      }
      try {
        await this.#applyAway(candidate, prefs);
      } catch (error) {
        this.#options.logger.warn(
          { err: error, identityId: candidate.identityId },
          "auto-away sweep failed for identity",
        );
      }
    }
  }

  /**
   * An attached identity whose devices have all gone quiet. Returns undefined
   * when the pooled activity cannot be read — either nothing has attached
   * since (a race with unsubscribe) or some attached browser predates the
   * `activity` frame, and an unreporting browser is not evidence of an absent
   * user.
   */
  #idleCandidate(
    identityId: string,
    session: FchatSession,
  ): Candidate | undefined {
    const activity = this.#options.hub.activityAcross(identityId);
    if (typeof activity !== "number") {
      return undefined;
    }
    if (!this.#awayable(identityId, session)) {
      return undefined;
    }
    return { identityId, session, reason: "idle", since: activity };
  }

  /** A subscriber-less identity: the detachment clock, then the ceiling. */
  #detachedCandidate(
    identityId: string,
    session: FchatSession,
    now: number,
  ): Candidate | undefined {
    // The stamp tracks detachment, not connectivity: it is set on the
    // first subscriber-less sweep even while the session is between
    // F-Chat connections, so both thresholds count from the detach.
    const since = this.#detachedSince.get(identityId);
    if (since === undefined) {
      this.#detachedSince.set(identityId, now);
      // Persisted so the ceiling and boot resume survive restarts
      // (§15) — one write per detachment, not per sweep.
      this.#persistDetachedAt(identityId, new Date(now));
      return undefined;
    }
    // Detached-disconnect ceiling (decisions.md §15): a session in
    // reconnect-backoff counts too — stopping it also ends the retries.
    const disconnectAfterMs = this.#options.disconnectAfterMs ?? 0;
    if (disconnectAfterMs > 0 && now - since >= disconnectAfterMs) {
      this.#detachedSince.delete(identityId);
      this.#applied.delete(identityId);
      const hours = Math.round(disconnectAfterMs / 3_600_000);
      this.#options.sessions.stop(
        identityId,
        `disconnected after ${String(hours)}h with no attached device`,
      );
      this.#options.logger.info(
        { identityId },
        "detached session disconnected",
      );
      return undefined;
    }
    if (!this.#awayable(identityId, session)) {
      return undefined;
    }
    return { identityId, session, reason: "detached", since };
  }

  /** Shared eligibility: connected, not already ours, not a chosen status. */
  #awayable(identityId: string, session: FchatSession): boolean {
    if (session.status !== "online") {
      // Not connected to F-Chat — no status to set; the detachment clock
      // keeps counting from the detach, not the reconnect.
      return false;
    }
    if (this.#applied.has(identityId)) {
      return false; // already away by our hand
    }
    return session.ownStatus.status === "online"; // a chosen status is theirs
  }

  #overThreshold(candidate: Candidate, prefs: UserPrefs, now: number): boolean {
    const [enabled, minutes] =
      candidate.reason === "idle"
        ? [prefs.autoAwayEnabled, prefs.autoAwayMinutes]
        : [prefs.detachedAwayEnabled, prefs.detachedAwayMinutes];
    return enabled && now - candidate.since >= minutes * 60_000;
  }

  /**
   * True once the user is demonstrably back — checked both after the prefs
   * await and after the STA, since both yield to the event loop and the whole
   * point of the feature is that a returning user does not sit there away.
   */
  #returned(candidate: Candidate): boolean {
    if (candidate.reason === "detached") {
      // onAttach clears #detachedSince, so a vanished stamp (or a live
      // subscriber) means the user is looking again.
      return (
        this.#options.hub.hasSubscribers(candidate.identityId) ||
        this.#detachedSince.get(candidate.identityId) === undefined
      );
    }
    // Any movement in the pooled activity — a newer report, or a browser
    // attaching that cannot report at all — retires the decision we made.
    return (
      this.#options.hub.activityAcross(candidate.identityId) !== candidate.since
    );
  }

  async #applyAway(candidate: Candidate, prefs: UserPrefs): Promise<void> {
    const { identityId, session, reason } = candidate;
    if (this.#returned(candidate)) {
      return;
    }
    const previous = session.ownStatus;
    const awayMsg = prefs.autoAwayMessage;
    await session.setStatus("away", awayMsg);
    if (this.#returned(candidate)) {
      // Came back while the STA was in flight (the send is flood- and
      // status-gated); the return hook found nothing to restore, so hand back
      // here instead of leaving an active user sitting away. A hand-back
      // inside the status gate supersedes the away rather than queueing
      // behind it — the session keeps only the newest desire.
      await session.setStatus(previous.status, previous.statusmsg);
      return;
    }
    this.#applied.set(identityId, {
      previous,
      awayMsg,
      // The detached away has always handed back on attach regardless of the
      // preference: "clear on return" is about returning to a browser that
      // was already there, and re-opening the app is a stronger signal.
      restoreOnReturn: reason === "detached" || prefs.autoAwayClearOnReturn,
    });
    this.#options.logger.info({ identityId, reason }, "auto-away applied");
  }

  /** Fire-and-forget lastDetachedAt write; a miss self-heals next sweep. */
  #persistDetachedAt(identityId: string, value: Date | null): void {
    this.#options.db
      .update(identities)
      .set({ lastDetachedAt: value })
      .where(eq(identities.id, identityId))
      .catch((error: unknown) => {
        this.#options.logger.warn(
          { err: error, identityId },
          "lastDetachedAt persist failed",
        );
      });
  }

  /** Owning users' resolved prefs for a batch of identities, one query. */
  async #userPrefsBatch(identityIds: string[]) {
    const rows = await this.#options.db
      .select({ identityId: identities.id, prefs: userPreferences.prefs })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .leftJoin(
        userPreferences,
        eq(userPreferences.userId, flistAccounts.userId),
      )
      .where(inArray(identities.id, identityIds));
    const resolved = new Map<string, UserPrefs>();
    for (const row of rows) {
      resolved.set(row.identityId, resolvePrefs(row.prefs ?? undefined));
    }
    return resolved;
  }
}
