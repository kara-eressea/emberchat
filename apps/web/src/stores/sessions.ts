// Per-identity live session state (architecture.md §Client, COMPONENTS.md
// state model): channels with member lists, DM rows with presence, session
// status. Mutated only by gateway/dispatch.ts applying server frames — the
// gateway protocol documents volatile events as at-least-once idempotent
// state operations, so every mutation here is an overwrite or a set
// add/remove, never a counter increment keyed to event arrival.

import { create } from "zustand";
import { PREFS_DEFAULTS, UNREAD_DISPLAY_CAP } from "@emberchat/protocol";
import { genderColorVar } from "../theme/tokens.js";
import type {
  CampaignDto,
  OutboxItemDto,
  ConversationDto,
  GatewaySessionStatus,
  MemberDto,
  SeenMemberDto,
  SnapshotChannel,
  SnapshotDm,
  UserPrefs,
} from "@emberchat/protocol";

export interface ChannelView {
  convId: string;
  key: string;
  title: string;
  description: string;
  mode: string;
  /** First entry is the owner (may be ""). */
  oplist: string[];
  /** Set semantics — empty while we are not live in the channel. */
  members: MemberDto[];
  /** Previously-seen members not present now (#200), newest lastSeen
   * first. Server-persisted; retention/cap pruning is server-owned — the
   * client only mirrors live moves (part adds, rejoin removes). */
  seen: SeenMemberDto[];
  joined: boolean;
  pinned: boolean;
  unread: number;
  /** Unread messages naming this identity (server-counted at snapshot,
   * bumped client-side for live messages). */
  mentions: number;
  /** Last live mention (epoch ms, 0 = none) — the "bump to top" sort key
   * when the highlightBump pref is on. Volatile: cleared on visit, never
   * persisted or restored by snapshots. */
  highlightedAt: number;
  lastReadMessageId: number | null;
  /** Highest message id this client has seen live for the conversation
   * (#264). An advancing read cursor only clears the badges once it reaches
   * this — a slow read-ack echo (cursor below a live message that already
   * bumped unread) must not wipe a genuinely-unread newer message. Null
   * until the first live message is tracked. */
  newestMessageId: number | null;
}

export interface DmView {
  convId: string;
  partner: string;
  title: string;
  online: boolean;
  status: string;
  statusmsg: string;
  pinned: boolean;
  /** TPN state: "typing" | "paused" | "clear". */
  typing: string;
  unread: number;
  /** Same bump sort key as ChannelView.highlightedAt. */
  highlightedAt: number;
  lastReadMessageId: number | null;
  /** Highest live message id seen for this DM (#264) — see ChannelView. */
  newestMessageId: number | null;
  /**
   * Newest message id in this conversation, either direction; 0 for a
   * conversation with none. The sidebar's people sections sort on it (#515):
   * ids are one global server-assigned sequence, so it is a monotonic
   * activity clock — no wall clocks, and every attached device derives the
   * same order.
   *
   * Deliberately NOT `newestMessageId`: that one is the #264 read-cursor
   * guard and must count only messages that raised unread, so it skips own
   * sends and messages arriving in the attended conversation. Activity counts
   * both — the person you just answered is the most recently active by
   * definition, and the conversation you are reading must not sink while you
   * read it. The snapshot seeds this from the DB (SnapshotDm.lastActivityId),
   * so it survives a reload rather than resetting to "alphabetical".
   */
  lastActivityId: number;
}

export interface IdentitySession {
  identityId: string;
  character: string;
  sessionStatus: GatewaySessionStatus;
  statusReason?: string;
  /** Our own F-Chat status (STA) — distinct from the session lifecycle. */
  ownStatus: string;
  ownStatusmsg: string;
  /** Ignore list (canonical casing). Messages from these characters stay
   * persisted but are hidden from render. */
  ignores: string[];
  /** Live server VARs (bytes) from the snapshot — composer limits. */
  limits: {
    chatMax: number;
    privMax: number;
    lfrpMax: number;
    lfrpFlood: number;
  };
  /** Channels where the server disallows [icon]/[eicon] (icon_blacklist). */
  iconBlacklist: string[];
  /** Own character is a chatop (global moderator) — unlocks the admin UI. */
  chatop: boolean;
  /** The user's delayed-send window (per-user; mirrored per slice). */
  sendDelaySeconds: number;
  /** The user's resolved preferences (per-user; mirrored per slice). */
  prefs: UserPrefs;
  /** Messages waiting in the server-side outbox for this identity. */
  outbox: OutboxItemDto[];
  /** The identity's ad-rotation campaign (M11); null = none exists. */
  campaign: CampaignDto | null;
  /** Keyed by channel key (events address channels by key). */
  channels: Record<string, ChannelView>;
  /** Keyed by conversation id. */
  dms: Record<string, DmView>;
  /** convId → channel key, for events keyed the other way around. */
  channelByConvId: Record<string, string>;
  /** Snapshot received — the sidebar can render. */
  synced: boolean;
  /** Latest transient global SYS / ERR, surfaced as a dismissable strip. */
  notice?: { kind: "sys" | "error"; text: string };
  /** Pending channel invitations (inbound CIU) — volatile, actionable rows
   * in the sidebar. A missed invite stays joinable via its key anyway. */
  invites: ChannelInvite[];
  /** Bookmarks/friends/requests (M6 step 7), lazily loaded through the
   * social REST endpoint (loadSocial). Absent until first fetched. */
  social?: SocialData;
}

/** One friend or bookmark row, presence-enriched by the server. */
export interface SocialCharacter {
  name: string;
  online: boolean;
  status: string;
  statusmsg: string;
}

export interface SocialData {
  bookmarks: SocialCharacter[];
  friends: SocialCharacter[];
  incoming: { id: number; name: string }[];
  outgoing: { id: number; name: string }[];
  fetchedAt: number;
}

export interface ChannelInvite {
  sender: string;
  title: string;
  key: string;
}

export interface IdentitySummary {
  id: string;
  name: string;
  /** Connect intent — gates the shell's connect-on-visit. The server
   * maintains it (connect sets, disconnect clears); mirrored locally when
   * this tab issues the cmd, and re-synced by the next ready frame. */
  autoConnect: boolean;
  /** Ready-time badge totals across the identity's conversations. Initial
   * paint only — once a slice is synced, the rail aggregates its live
   * per-conversation counters instead. */
  unread: number;
  mentions: number;
}

interface SessionsState {
  /** From the ready frame — everything the app account owns. */
  identities: IdentitySummary[] | undefined;
  sessions: Record<string, IdentitySession>;

  applyReady(identities: IdentitySummary[]): void;
  /** Local mirror maintenance for REST-driven identity CRUD (the picker):
   * `ready` is the authority but arrives only at socket connect, so an
   * identity created after the hello would otherwise not exist for this tab
   * until a reconnect. */
  upsertIdentity(identity: IdentitySummary): void;
  removeIdentity(identityId: string): void;
  setAutoConnect(identityId: string, value: boolean): void;
  /** Re-sorts the rail; ids missing from `order` keep their relative place
   * at the end (a create racing the reorder must not vanish). */
  applyIdentityOrder(order: string[]): void;
  applySnapshot(d: {
    identityId: string;
    self: {
      character: string;
      sessionStatus: GatewaySessionStatus;
      status: string;
      statusmsg: string;
      ignores: string[];
      limits: {
        chatMax: number;
        privMax: number;
        lfrpMax: number;
        lfrpFlood: number;
      };
      iconBlacklist: string[];
      chatop: boolean;
      sendDelaySeconds: number;
      prefs: UserPrefs;
      outbox: OutboxItemDto[];
      campaign: CampaignDto | null;
      social: {
        bookmarks: SocialCharacter[];
        friends: SocialCharacter[];
        incoming: { id: number; name: string }[];
        outgoing: { id: number; name: string }[];
      } | null;
    };
    channels: SnapshotChannel[];
    dms: SnapshotDm[];
  }): void;
  /** Full pending-outbox overwrite (outbox.updated / snapshot). */
  applyOutbox(identityId: string, items: OutboxItemDto[]): void;
  /** Full campaign overwrite (campaign.updated / snapshot). */
  applyCampaign(identityId: string, campaign: CampaignDto | null): void;
  applySendDelay(identityId: string, sendDelaySeconds: number): void;
  applySocial(identityId: string, social: SocialData): void;
  /** Full resolved-prefs overwrite (prefs.updated). */
  applyPrefs(
    identityId: string,
    d: { sendDelaySeconds: number; prefs: UserPrefs },
  ): void;
  /** Optimistic local prefs overwrite across every slice — prefs are per
   * user, so a pane edit must not wait for the per-identity fan-out. */
  applyPrefsLocal(prefs: UserPrefs): void;
  /** Full ignore-list overwrite (ignore.updated / snapshot). */
  applyIgnores(identityId: string, characters: string[]): void;
  applySessionStatus(
    identityId: string,
    status: GatewaySessionStatus,
    reason?: string,
  ): void;
  applyConversation(identityId: string, conversation: ConversationDto): void;
  removeConversation(identityId: string, convId: string): void;
  applyMemberJoin(
    identityId: string,
    channelKey: string,
    member: MemberDto,
  ): void;
  applyMemberLeave(
    identityId: string,
    channelKey: string,
    character: string,
  ): void;
  applyChannelMembers(
    identityId: string,
    d: { key: string; mode: string; members: MemberDto[] },
  ): void;
  applyChannelInfo(
    identityId: string,
    d: {
      key: string;
      title?: string;
      description?: string;
      mode?: string;
      oplist?: string[];
    },
  ): void;
  applyPresence(
    identityId: string,
    d: {
      character: string;
      online: boolean;
      gender?: string;
      status?: string;
      statusmsg?: string;
    },
  ): void;
  /** One LIS roster batch — [name, gender, status, statusmsg]. */
  applyPresenceBulk(
    identityId: string,
    characters: [string, string, string, string][],
  ): void;
  applyTyping(identityId: string, character: string, status: string): void;
  applyNotice(identityId: string, kind: "sys" | "error", text: string): void;
  clearNotice(identityId: string): void;
  addInvite(identityId: string, invite: ChannelInvite): void;
  dismissInvite(identityId: string, key: string): void;
  bumpUnread(
    identityId: string,
    convId: string,
    messageId: number,
    mention?: boolean,
  ): void;
  /** Stamp the conversation's bump sort key (highlightBump pref). */
  bumpHighlight(identityId: string, convId: string): void;
  /**
   * Record DM activity (#515): a message in this conversation, either
   * direction. DMs only — the people sections are the only surface that
   * sorts on activity, and stamping every channel message would patch the
   * session store (and re-render the sidebar) once per line of a busy room
   * for an order nobody reads.
   */
  noteDmActivity(identityId: string, convId: string, messageId: number): void;
  clearUnread(identityId: string, convId: string): void;
  reset(): void;
}

/**
 * The user's prefs from any synced slice — they are per app account and
 * identical across slices, so render code without an identity context
 * (RichText, previews) reads them here.
 */
export function useUserPrefs(): UserPrefs {
  return useSessionsStore((s) => {
    for (const session of Object.values(s.sessions)) {
      if (session.synced) {
        return session.prefs;
      }
    }
    return PREFS_DEFAULTS;
  });
}

/**
 * An identity to write prefs through from render code that has no identity
 * context of its own (the eicon right-click menu in RichText). Prefs are per
 * app account, so any synced slice persists for all of them; the active
 * identity is preferred purely so the optimistic apply lands on the slice
 * that is on screen. Undefined before anything has synced — callers no-op.
 */
export function prefsIdentityId(activeIdentityId?: string): string | undefined {
  const { sessions } = useSessionsStore.getState();
  if (activeIdentityId !== undefined && sessions[activeIdentityId]?.synced) {
    return activeIdentityId;
  }
  return Object.entries(sessions).find(([, session]) => session.synced)?.[0];
}

/**
 * A character's gender as this session currently knows it — present channel
 * members first, then the "seen recently" roster. Undefined when no channel
 * holds the character, so a sender name without a known gender falls back to
 * the default text colour, exactly like a member-list row does. This is the
 * one source the member list and the message log share: both colour a name
 * by feeding this gender to `genderColorVar`, so the same character always
 * carries the same colour in both places (#338).
 */
export function genderOf(
  session: IdentitySession | undefined,
  character: string,
): string | undefined {
  if (!session) {
    return undefined;
  }
  const lower = character.toLowerCase();
  const channels = Object.values(session.channels);
  // Present members across every channel first, then the seen rosters —
  // the same two passes the linear scan made, one Map lookup each (#560).
  // `has`, not a truthy `get`: a member the roster holds ends the search even
  // if their gender is blank, exactly as the `find()` this replaced did — a
  // stale seen-roster entry must never outrank someone who is present.
  for (const channel of channels) {
    const members = rosterIndex(channel.members);
    if (members.has(lower)) {
      return members.get(lower);
    }
  }
  for (const channel of channels) {
    const seen = rosterIndex(channel.seen);
    if (seen.has(lower)) {
      return seen.get(lower);
    }
  }
  return undefined;
}

/**
 * Lowercased name → gender for one roster array, cached against the array's
 * own identity (#560).
 *
 * `genderOf` used to walk every member of every channel, allocating two
 * lowercased strings per comparison — and zustand runs every subscriber's
 * selector on every write, with one `useGenderColorVar` subscriber per
 * message row, per ad row and per `[user]` tag. A 200-member room and forty
 * visible rows made a single presence event tens of thousands of string
 * allocations.
 *
 * A WeakMap on the array is the whole cache-invalidation story: every write
 * path here builds member/seen arrays with `mapPreserving` or a fresh array,
 * so a roster that changed is a new object (miss, rebuilt once) and one that
 * did not is the same object (hit). Nothing has to remember to invalidate,
 * and a dropped channel takes its index with it.
 */
const rosterIndexes = new WeakMap<object, Map<string, string>>();

function rosterIndex(
  roster: readonly { character: string; gender: string }[],
): Map<string, string> {
  const cached = rosterIndexes.get(roster);
  if (cached !== undefined) {
    return cached;
  }
  const index = new Map<string, string>();
  for (const entry of roster) {
    // First entry wins, matching the `find()` this replaced.
    const key = entry.character.toLowerCase();
    if (!index.has(key)) {
      index.set(key, entry.gender);
    }
  }
  rosterIndexes.set(roster, index);
  return index;
}

/**
 * The gender-based name colour for a character in one identity's session, as
 * a `var(--eb-gender-…)` token — or undefined when the gender is unknown
 * (name renders in the default text colour). The member list and the message
 * log both colour names through this, so a character reads the same in both
 * (#338).
 */
export function useGenderColorVar(
  identityId: string,
  character: string,
): string | undefined {
  return useSessionsStore((s) =>
    genderColorVar(genderOf(s.sessions[identityId], character)),
  );
}

function emptySession(identityId: string): IdentitySession {
  return {
    identityId,
    character: "",
    sessionStatus: "offline",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    // Placeholder until the snapshot delivers the live VARs.
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    invites: [],
    synced: false,
  };
}

/**
 * Map a record's values, preserving identity: the returned object is the
 * exact same reference when `fn` left every value untouched, and each value
 * keeps its reference unless `fn` replaced it. F-Chat's global presence stream
 * fires ~14×/sec; rebuilding every channel/DM on each event makes every
 * subscriber re-render forever (#355), so untouched entries must stay `===`.
 */
function mapValues<T>(
  record: Record<string, T>,
  fn: (value: T, key: string) => T,
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = fn(value, key);
    next[key] = mapped;
    if (mapped !== value) {
      changed = true;
    }
  }
  return changed ? next : record;
}

/** Array counterpart of `mapValues`: same reference when nothing changed. */
function mapPreserving<T>(array: T[], fn: (value: T) => T): T[] {
  let changed = false;
  const next = array.map((value) => {
    const mapped = fn(value);
    if (mapped !== value) {
      changed = true;
    }
    return mapped;
  });
  return changed ? next : array;
}

/** Applies one presence delta to social rows, case-insensitively (#218).
 * Identity-preserving: unchanged when no friend/bookmark row matched (#355). */
function patchSocialPresence(
  social: SocialData,
  d: {
    character: string;
    online: boolean;
    status?: string;
    statusmsg?: string;
  },
): SocialData {
  const apply = (row: SocialCharacter): SocialCharacter =>
    sameCharacter(row.name, d.character)
      ? {
          ...row,
          online: d.online,
          status: d.online ? (d.status ?? row.status) : "offline",
          statusmsg: d.online ? (d.statusmsg ?? row.statusmsg) : "",
        }
      : row;
  const bookmarks = mapPreserving(social.bookmarks, apply);
  const friends = mapPreserving(social.friends, apply);
  return bookmarks === social.bookmarks && friends === social.friends
    ? social
    : { ...social, bookmarks, friends };
}

/** LIS batches are partial: presence in the batch marks a row online;
 * absence proves nothing. */
function bulkRow(
  row: SocialCharacter,
  byLower: Map<string, { status: string; statusmsg: string }>,
): SocialCharacter {
  const presence = byLower.get(row.name.toLowerCase());
  return presence
    ? {
        ...row,
        online: true,
        status: presence.status,
        statusmsg: presence.statusmsg,
      }
    : row;
}

/** F-Chat resolves character names case-insensitively (PM merge semantics) —
 * every member-set / roster comparison must fold case, or diverging frame vs
 * roster casing leaves ghost members and unpopulated seen rosters (#265). */
export function sameCharacter(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Hold a live badge counter at the wire's own saturation point (#582).
 *
 * The server's snapshot counts stop one past UNREAD_DISPLAY_CAP; a client that
 * stayed attached through the same traffic would otherwise climb past that and
 * disagree with its own next snapshot. Both now mean "at least this many", and
 * `clampBadge` renders either as "99+".
 */
function saturate(count: number): number {
  return Math.min(count, UNREAD_DISPLAY_CAP + 1);
}

/**
 * Whether an advancing read cursor should clear the unread badges (#264).
 * True only when the cursor moved forward AND it has caught up to the newest
 * message this client has seen live — so a slow read-ack echo (cursor still
 * below a live message that already bumped unread) leaves the genuinely
 * newer message counted. When nothing live is tracked (`newest` null), an
 * advance clears as before: the counters came from the server's own cursor
 * (e.g. another device read everything). */
function cursorClearsBadges(
  prevCursor: number | null,
  nextCursor: number | null,
  newest: number | null,
): boolean {
  const next = nextCursor ?? 0;
  if (next <= (prevCursor ?? 0)) {
    return false;
  }
  return newest === null || next >= newest;
}

/**
 * Canonicalize a private-room id's prefix (mirrors the server's
 * canonicalChannelKey). The server now normalizes keys at ingest, so live
 * events already agree; this lets a reattach snapshot collapse a stray
 * "adh-"-prefixed row left behind by a pre-fix session (issue #311).
 */
function canonicalChannelKey(key: string): string {
  return /^adh-/i.test(key) ? `ADH-${key.slice(4)}` : key;
}

/** The seen roster without one nick (case-insensitive; unchanged input when
 * absent, so untouched channels keep their array identity). */
function withoutSeen(
  seen: SeenMemberDto[],
  character: string,
): SeenMemberDto[] {
  return seen.some((entry) => sameCharacter(entry.character, character))
    ? seen.filter((entry) => !sameCharacter(entry.character, character))
    : seen;
}

/** On part: drop the nick from members and upsert it into seen (newest
 * first) with the gender the roster knew — a nick is never in both. */
function moveMemberToSeen(
  channel: ChannelView,
  character: string,
): ChannelView {
  const member = channel.members.find((m) =>
    sameCharacter(m.character, character),
  );
  return {
    ...channel,
    members: channel.members.filter(
      (m) => !sameCharacter(m.character, character),
    ),
    seen: [
      {
        character: member?.character ?? character,
        gender: member?.gender ?? "",
        lastSeen: Date.now(),
      },
      ...withoutSeen(channel.seen, character),
    ],
  };
}

export const useSessionsStore = create<SessionsState>()((set, get) => {
  /**
   * Immutable single-session update; creates the session if unknown.
   *
   * An update that returns the session it was handed is a no-op, and the store
   * says so by returning the state object itself: zustand skips the whole
   * notification when `setState` produces the current state (`Object.is`), so
   * not one subscriber's selector runs. That is the other half of #355 (#560).
   * Reference-preservation alone spares the *re-render*; it does not spare the
   * selector, and the global presence stream — ~14 events/sec, almost all of
   * them for characters this identity shares no channel, DM or bookmark with —
   * was still paying for one run of every mounted selector on every event.
   */
  function patch(
    identityId: string,
    update: (session: IdentitySession) => IdentitySession,
  ): void {
    set((state) => {
      const current = state.sessions[identityId];
      const next = update(current ?? emptySession(identityId));
      // Only a session that already existed can bail: the first event for an
      // identity has to create its slice even when it changes nothing in it.
      if (next === current) {
        return state;
      }
      return { sessions: { ...state.sessions, [identityId]: next } };
    });
  }

  /**
   * Volatile channel events (JCH/ICH/CDS/COL) fan out straight off the
   * session bus, while the conversation row that names the channel goes
   * through the sink's write queue — so they routinely arrive first. Create
   * the entry on miss (convId "" until conversation.updated fills it in)
   * rather than dropping the event.
   */
  function patchChannel(
    identityId: string,
    key: string,
    update: (channel: ChannelView) => ChannelView,
  ): void {
    patch(identityId, (session) => {
      const channel = session.channels[key] ?? {
        convId: "",
        key,
        title: key,
        description: "",
        mode: "both",
        oplist: [],
        members: [],
        seen: [],
        joined: false,
        pinned: false,
        unread: 0,
        mentions: 0,
        highlightedAt: 0,
        lastReadMessageId: null,
        newestMessageId: null,
      };
      return {
        ...session,
        channels: { ...session.channels, [key]: update(channel) },
      };
    });
  }

  return {
    identities: undefined,
    sessions: {},

    applyReady(identities) {
      set({ identities });
    },

    upsertIdentity(identity) {
      set((state) => {
        const identities = state.identities ?? [];
        const existing = identities.findIndex((i) => i.id === identity.id);
        return {
          identities:
            existing === -1
              ? [...identities, identity]
              : identities.map((i, index) =>
                  index === existing ? { ...i, ...identity } : i,
                ),
        };
      });
    },

    removeIdentity(identityId) {
      set((state) => {
        // The session slice goes with the identity — a ghost slice would
        // resurface stale state if the id were ever reused via upsert.
        const sessions = { ...state.sessions };
        delete sessions[identityId];
        return {
          identities: state.identities?.filter((i) => i.id !== identityId),
          sessions,
        };
      });
    },

    setAutoConnect(identityId, value) {
      set((state) => ({
        identities: state.identities?.map((identity) =>
          identity.id === identityId
            ? { ...identity, autoConnect: value }
            : identity,
        ),
      }));
    },

    applyIdentityOrder(order) {
      set((state) => {
        if (!state.identities) {
          return {};
        }
        const rank = new Map(order.map((id, index) => [id, index]));
        const identities = [...state.identities].sort(
          (a, b) =>
            (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
        );
        return { identities };
      });
    },

    applySnapshot(d) {
      // A snapshot replaces all volatile state for the identity (§Resume
      // semantics: it is never patched, always rebuilt).
      const channels: Record<string, ChannelView> = {};
      const channelByConvId: Record<string, string> = {};
      for (const ch of d.channels) {
        const key = canonicalChannelKey(ch.key);
        // A pre-fix session may carry both the real room and a stray
        // raw-keyed duplicate that canonicalize to one key; the joined
        // entry is the real room, so let it win the collision.
        const existing = channels[key];
        if (existing && existing.joined && !ch.joined) {
          continue;
        }
        channels[key] = {
          ...ch,
          key,
          oplist: [...ch.oplist],
          members: [...ch.members],
          seen: [...ch.seen],
          highlightedAt: 0,
          newestMessageId: null,
        };
        channelByConvId[ch.convId] = key;
      }
      const dms: Record<string, DmView> = {};
      for (const dm of d.dms) {
        dms[dm.convId] = {
          ...dm,
          typing: "clear",
          highlightedAt: 0,
          newestMessageId: null,
        };
      }
      patch(d.identityId, (session) => ({
        ...session,
        character: d.self.character,
        sessionStatus: d.self.sessionStatus,
        ownStatus: d.self.status,
        ownStatusmsg: d.self.statusmsg,
        ignores: [...d.self.ignores],
        limits: d.self.limits,
        iconBlacklist: [...d.self.iconBlacklist],
        chatop: d.self.chatop,
        sendDelaySeconds: d.self.sendDelaySeconds,
        prefs: d.self.prefs,
        outbox: [...d.self.outbox],
        campaign: d.self.campaign,
        channels,
        dms,
        channelByConvId,
        synced: true,
        // Server-cached social lists ride the snapshot (#194) — a fresh
        // device renders bookmarks/friends without any REST fetch. No
        // cache yet server-side keeps whatever this tab already had.
        ...(d.self.social
          ? { social: { ...d.self.social, fetchedAt: Date.now() } }
          : {}),
      }));
    },

    applyOutbox(identityId, items) {
      patch(identityId, (session) => ({ ...session, outbox: [...items] }));
    },

    applyCampaign(identityId, campaign) {
      patch(identityId, (session) => ({ ...session, campaign }));
    },

    applySocial(identityId, social) {
      patch(identityId, (session) => ({ ...session, social }));
    },

    applySendDelay(identityId, sendDelaySeconds) {
      patch(identityId, (session) => ({ ...session, sendDelaySeconds }));
    },

    applyPrefs(identityId, { sendDelaySeconds, prefs }) {
      patch(identityId, (session) => ({
        ...session,
        sendDelaySeconds,
        prefs,
      }));
    },

    applyPrefsLocal(prefs) {
      set((state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([id, session]) => [
            id,
            { ...session, prefs },
          ]),
        ),
      }));
    },

    applyIgnores(identityId, characters) {
      patch(identityId, (session) => ({
        ...session,
        ignores: [...characters],
      }));
    },

    applySessionStatus(identityId, status, reason) {
      patch(identityId, (session) => ({
        ...session,
        sessionStatus: status,
        statusReason: reason,
        // A session that went away has no live channel state; member lists
        // rebuild from ICH after the next connect + join.
        ...(status === "stopped" || status === "offline"
          ? {
              channels: Object.fromEntries(
                Object.entries(session.channels).map(([key, ch]) => [
                  key,
                  { ...ch, members: [] },
                ]),
              ),
            }
          : {}),
      }));
    },

    applyConversation(identityId, conversation) {
      patch(identityId, (session) => {
        if (conversation.kind === "channel") {
          const key = conversation.channelKey ?? "";
          const existing = session.channels[key];
          const channel: ChannelView = existing
            ? {
                ...existing,
                convId: conversation.id,
                title: conversation.title,
                joined: conversation.joined,
                pinned: conversation.pinned,
                lastReadMessageId: conversation.lastReadMessageId,
              }
            : {
                convId: conversation.id,
                key,
                title: conversation.title,
                description: "",
                mode: "both",
                oplist: [],
                members: [],
                seen: [],
                joined: conversation.joined,
                pinned: conversation.pinned,
                unread: 0,
                mentions: 0,
                highlightedAt: 0,
                lastReadMessageId: conversation.lastReadMessageId,
                newestMessageId: null,
              };
          // The read cursor moved (this tab's ack or another's): drop the
          // badges — but only once the cursor has caught up to the newest
          // live message. A slow read-ack echo below a message that already
          // bumped unread must not wipe that genuinely-unread line (#264).
          if (
            existing &&
            cursorClearsBadges(
              existing.lastReadMessageId,
              conversation.lastReadMessageId,
              existing.newestMessageId,
            )
          ) {
            channel.unread = 0;
            channel.mentions = 0;
            channel.highlightedAt = 0;
          }
          return {
            ...session,
            channels: { ...session.channels, [key]: channel },
            channelByConvId: {
              ...session.channelByConvId,
              [conversation.id]: key,
            },
          };
        }
        // For PMs the joined flag is the "window open" bit: pm.close drops
        // it (fan-out and ack both land here), removing the DM everywhere.
        if (!conversation.joined) {
          if (!(conversation.id in session.dms)) {
            return session;
          }
          const dms = { ...session.dms };
          delete dms[conversation.id];
          return { ...session, dms };
        }
        const existing = session.dms[conversation.id];
        // Serve-time presence (pm.open) seeds a fresh row's dot immediately
        // (#229); live NLN/STA keep folding through applyPresence afterwards.
        const presence = conversation.presence;
        const dm: DmView = existing
          ? {
              ...existing,
              title: conversation.title,
              pinned: conversation.pinned,
              lastReadMessageId: conversation.lastReadMessageId,
              ...(presence
                ? {
                    online: presence.online,
                    status: presence.status,
                    statusmsg: presence.statusmsg,
                  }
                : {}),
              ...(cursorClearsBadges(
                existing.lastReadMessageId,
                conversation.lastReadMessageId,
                existing.newestMessageId,
              )
                ? { unread: 0, highlightedAt: 0 }
                : {}),
            }
          : {
              convId: conversation.id,
              partner: conversation.partnerCharacter ?? "",
              title: conversation.title,
              online: presence?.online ?? false,
              status: presence?.status ?? "",
              statusmsg: presence?.statusmsg ?? "",
              pinned: conversation.pinned,
              typing: "clear",
              unread: 0,
              highlightedAt: 0,
              lastReadMessageId: conversation.lastReadMessageId,
              newestMessageId: null,
              // A conversation row created outside a snapshot (pm.open, an
              // inbound PM's upsert) has no history worth sorting on yet —
              // the message that created it stamps this a beat later, and an
              // existing row keeps the value it already holds (spread above).
              lastActivityId: 0,
            };
        return { ...session, dms: { ...session.dms, [conversation.id]: dm } };
      });
    },

    removeConversation(identityId, convId) {
      // A channel leave/close removes the row outright (#327). Channels are
      // keyed by their channel key, so resolve convId → key first; DMs are
      // keyed by convId directly. Idempotent: a row already gone is a no-op.
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channels = { ...session.channels };
          delete channels[key];
          const channelByConvId = { ...session.channelByConvId };
          delete channelByConvId[convId];
          return { ...session, channels, channelByConvId };
        }
        if (convId in session.dms) {
          const dms = { ...session.dms };
          delete dms[convId];
          return { ...session, dms };
        }
        return session;
      });
    },

    applyMemberJoin(identityId, channelKey, member) {
      patchChannel(identityId, channelKey, (channel) => ({
        ...channel,
        // Set add: at-least-once delivery means a duplicate join must be a
        // no-op (gateway.ts contract).
        members: channel.members.some((m) =>
          sameCharacter(m.character, member.character),
        )
          ? channel.members
          : [...channel.members, member],
        // A rejoin moves the nick out of "Seen recently" — never in both.
        seen: withoutSeen(channel.seen, member.character),
      }));
    },

    applyMemberLeave(identityId, channelKey, character) {
      const self = get().sessions[identityId]?.character ?? "";
      patchChannel(identityId, channelKey, (channel) =>
        sameCharacter(character, self)
          ? { ...channel, members: [] } // our own leave — the live list is gone
          : moveMemberToSeen(channel, character),
      );
    },

    applyChannelMembers(identityId, d) {
      patchChannel(identityId, d.key, (channel) => {
        // Present members leave the seen roster (never in both) — covers
        // rejoins folded into a full-state ICH overwrite.
        const present = new Set(
          d.members.map((m) => m.character.toLowerCase()),
        );
        return {
          ...channel,
          mode: d.mode,
          members: [...d.members],
          seen: channel.seen.filter(
            (entry) => !present.has(entry.character.toLowerCase()),
          ),
        };
      });
    },

    applyChannelInfo(identityId, d) {
      patchChannel(identityId, d.key, (channel) => ({
        ...channel,
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.mode !== undefined ? { mode: d.mode } : {}),
        ...(d.oplist !== undefined ? { oplist: [...d.oplist] } : {}),
      }));
    },

    applyPresence(identityId, d) {
      patch(identityId, (session) => {
        // Presence is a global stream; a character sits in only a handful of
        // the viewer's channels/DMs. Touch only those, leaving every other
        // channel/DM/member object at its old reference so subscribers of an
        // unaffected view don't re-render (#355).
        const channels = mapValues(session.channels, (ch) => {
          if (
            !ch.members.some((m) => sameCharacter(m.character, d.character))
          ) {
            return ch;
          }
          if (!d.online) {
            // FLN is a global leave: the character drops out of the channel.
            return moveMemberToSeen(ch, d.character);
          }
          return {
            ...ch,
            members: ch.members.map((m) =>
              sameCharacter(m.character, d.character)
                ? {
                    ...m,
                    gender: d.gender ?? m.gender,
                    status: d.status ?? m.status,
                    statusmsg: d.statusmsg ?? m.statusmsg,
                  }
                : m,
            ),
          };
        });
        const dms = mapValues(session.dms, (dm) =>
          sameCharacter(dm.partner, d.character)
            ? {
                ...dm,
                online: d.online,
                status: d.online ? (d.status ?? dm.status) : "",
                statusmsg: d.online ? (d.statusmsg ?? dm.statusmsg) : "",
              }
            : dm,
        );
        // Our own STA (set from any tab, or restored after a reconnect)
        // converges the MeBar/rail status everywhere.
        const mine = d.online && sameCharacter(d.character, session.character);
        const ownStatus = mine
          ? (d.status ?? session.ownStatus)
          : session.ownStatus;
        const ownStatusmsg = mine
          ? (d.statusmsg ?? session.ownStatusmsg)
          : session.ownStatusmsg;
        // Bookmark/friend rows track the same global NLN/FLN/STA stream —
        // presence there must never freeze at fetch time (#218).
        const social = session.social
          ? patchSocialPresence(session.social, d)
          : undefined;
        // Nothing here holds this character: keep the session reference, so
        // `patch` skips the write entirely (#560). This is the common case —
        // the stream is global and carries every character on F-List, while
        // the four collections above are one viewer's.
        if (
          channels === session.channels &&
          dms === session.dms &&
          social === session.social &&
          ownStatus === session.ownStatus &&
          ownStatusmsg === session.ownStatusmsg
        ) {
          return session;
        }
        return {
          ...session,
          channels,
          dms,
          ownStatus,
          ownStatusmsg,
          ...(social ? { social } : {}),
        };
      });
    },

    applyPresenceBulk(identityId, characters) {
      patch(identityId, (session) => {
        const byLower = new Map(
          characters.map(([name, gender, status, statusmsg]) => [
            name.toLowerCase(),
            { gender, status, statusmsg },
          ]),
        );
        const dms = mapValues(session.dms, (dm) => {
          const presence = byLower.get(dm.partner.toLowerCase());
          return presence
            ? {
                ...dm,
                online: true,
                status: presence.status,
                statusmsg: presence.statusmsg,
              }
            : dm;
        });
        let social = session.social;
        if (social) {
          const bookmarks = mapPreserving(social.bookmarks, (row) =>
            bulkRow(row, byLower),
          );
          const friends = mapPreserving(social.friends, (row) =>
            bulkRow(row, byLower),
          );
          social =
            bookmarks === social.bookmarks && friends === social.friends
              ? social
              : { ...social, bookmarks, friends };
        }
        // Same bail as applyPresence: an LIS batch that touched no DM and no
        // social row must not replace the session object (#560).
        if (dms === session.dms && social === session.social) {
          return session;
        }
        return { ...session, dms, ...(social ? { social } : {}) };
      });
    },

    applyTyping(identityId, character, status) {
      patch(identityId, (session) => ({
        ...session,
        dms: Object.fromEntries(
          Object.entries(session.dms).map(([convId, dm]) => [
            convId,
            sameCharacter(dm.partner, character)
              ? { ...dm, typing: status }
              : dm,
          ]),
        ),
      }));
    },

    applyNotice(identityId, kind, text) {
      patch(identityId, (session) => ({
        ...session,
        notice: { kind, text },
      }));
    },

    addInvite(identityId, invite) {
      patch(identityId, (session) => ({
        ...session,
        // Re-invites to the same room replace instead of stacking.
        invites: [
          ...session.invites.filter((entry) => entry.key !== invite.key),
          invite,
        ],
      }));
    },
    dismissInvite(identityId, key) {
      patch(identityId, (session) => ({
        ...session,
        invites: session.invites.filter((entry) => entry.key !== key),
      }));
    },
    clearNotice(identityId) {
      patch(identityId, (session) => ({ ...session, notice: undefined }));
    },

    bumpUnread(identityId, convId, messageId, mention = false) {
      patch(identityId, (session) => {
        // KNOWN LIMITATION (pre-existing, #269 item 5): a message.new whose
        // convId has no channelByConvId mapping and no dms[] row yet is
        // dropped by the final `return session` below. The mapping is only
        // registered by the conversation.upsert action, which rides a
        // separate gateway event; if a message.new for a conversation is
        // dispatched before its upsert lands, this bump has nowhere to go.
        // In practice the server orders the upsert (channel JCH / pm.open)
        // ahead of any message, so the window is not observed. A real fix is
        // structural — it needs a per-session buffer of pending (convId →
        // {unread, mentions, newestMessageId}) bumps, flushed into the
        // channel/DM row inside conversation.upsert when the mapping first
        // registers — not a guard we can add here, since the target row does
        // not exist. Deferred deliberately; captured so it is not rediscovered
        // as a new bug.
        //
        // Live bumps saturate exactly where the server's counts do (#582), so
        // a long-attached session and a fresh snapshot of the same
        // conversation report the same number rather than drifting apart —
        // both mean "at least this many" past the cap.
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: {
                ...channel,
                unread: saturate(channel.unread + 1),
                mentions: saturate(channel.mentions + (mention ? 1 : 0)),
                // Track the newest live id so a later read-ack echo below it
                // cannot wipe this still-unread message (#264).
                newestMessageId: Math.max(
                  channel.newestMessageId ?? 0,
                  messageId,
                ),
              },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm) {
          return {
            ...session,
            dms: {
              ...session.dms,
              [convId]: {
                ...dm,
                unread: saturate(dm.unread + 1),
                newestMessageId: Math.max(dm.newestMessageId ?? 0, messageId),
              },
            },
          };
        }
        return session;
      });
    },

    bumpHighlight(identityId, convId) {
      const stamp = Date.now();
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...session.channels[key], highlightedAt: stamp },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm) {
          return {
            ...session,
            dms: { ...session.dms, [convId]: { ...dm, highlightedAt: stamp } },
          };
        }
        return session;
      });
    },

    noteDmActivity(identityId, convId, messageId) {
      patch(identityId, (session) => {
        const dm = session.dms[convId];
        if (!dm || messageId <= dm.lastActivityId) {
          return session;
        }
        return {
          ...session,
          dms: {
            ...session.dms,
            [convId]: { ...dm, lastActivityId: messageId },
          },
        };
      });
    },

    clearUnread(identityId, convId) {
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          if (
            channel.unread === 0 &&
            channel.mentions === 0 &&
            channel.highlightedAt === 0
          ) {
            return session;
          }
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...channel, unread: 0, mentions: 0, highlightedAt: 0 },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm && (dm.unread > 0 || dm.highlightedAt > 0)) {
          return {
            ...session,
            dms: {
              ...session.dms,
              [convId]: { ...dm, unread: 0, highlightedAt: 0 },
            },
          };
        }
        return session;
      });
    },

    reset() {
      set({ identities: undefined, sessions: {} });
    },
  };
});
