// Snapshot + catchup queries (architecture.md §Resume semantics). Volatile
// state (members, presence, modes) comes fresh from session-state on every
// sub; durable state (messages) resumes via per-conversation messages.id
// cursors read straight from the messages table — it *is* the resume log.

import { and, asc, desc, eq, getTableColumns, gt, lt, sql } from "drizzle-orm";
import {
  UNREAD_DISPLAY_CAP,
  type MemberDto,
  type MessageDto,
  type SnapshotChannel,
  type SnapshotDm,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { conversations, messages } from "../../db/schema.js";
import type { MessageRow } from "../history/sink.js";
import { seenByChannel } from "../seen-members/store.js";
import type { FchatSession, SessionState } from "@emberchat/session-engine";

/**
 * How many unread rows a conversation's count may scan — one PAST the largest
 * number a badge shows exactly, so a saturated count is distinguishable from a
 * conversation that happens to hold exactly that many (#582).
 *
 * Scanning to the cap itself was the original bug: the count topped out at 99,
 * `clampBadge` only says "99+" above 99, so the badge sat at a flat 99 while
 * the log's own uncapped count climbed past it. Reporting 100 costs one extra
 * row and makes the saturated case say what it means.
 */
const UNREAD_SCAN = UNREAD_DISPLAY_CAP + 1;

/**
 * Per-conversation unread + mention counts past the read cursor, computed in
 * one pass. The inner ORDER BY + LIMIT caps the rows *scanned* per
 * conversation at UNREAD_SCAN, newest first (a deterministic window walking
 * the (conversation_id, id desc) index and stopping early) — a busy channel
 * with 40k unread costs the same as one with 100. Own sends never count as
 * unread (matching the client's live bump), and neither do roleplay ads —
 * ads never affect unread in any view (M10). Mentions read the stored
 * `messages.mention` flag the sink stamped at persist time (M5) — no
 * matching happens here anymore.
 *
 * Ignored senders are excluded (audit backlog): the client hides their rows
 * from the log, so a badge they raised would point at something invisible
 * and could never be cleared by reading it. The exclusion sits INSIDE the
 * capped window, so the cap now bounds counted rows rather than scanned ones
 * — an identity that ignores a firehose pays a longer index walk. The
 * alternative (filter after the cap) would silently report zero unread
 * whenever the newest 100 rows all came from ignored characters.
 */
async function conversationCounts(
  db: Db,
  identityId: string,
): Promise<Map<string, { unread: number; mentions: number }>> {
  // The row type is declared here rather than inferred: `Db` is driver-
  // agnostic (db/index.ts), so its query-result HKT is generic and
  // `db.execute()` hands back `unknown`. Both drivers return `{ rows }`.
  const result = (await db.execute(sql`
    select c.id as conv_id,
           u.unread::int as unread,
           u.mentions::int as mentions
    from conversations c
    cross join lateral (
      select count(*) as unread,
             count(*) filter (where t.mention) as mentions
      from (
        select m.mention
        from messages m
        where m.conversation_id = c.id
          and m.id > coalesce(c.last_read_message_id, 0)
          and not m.sent_by_us
          and m.kind <> 'lrp'
          and not exists (
            select 1
            from ignores ig
            where ig.identity_id = c.identity_id
              and lower(ig.character) = lower(m.sender_character)
          )
        order by m.id desc
        limit ${UNREAD_SCAN}
      ) t
    ) u
    where c.identity_id = ${identityId}
  `)) as {
    rows: { conv_id: string; unread: number; mentions: number }[];
  };
  const rows = result.rows;
  return new Map(
    rows.map((row) => [
      row.conv_id,
      { unread: row.unread, mentions: row.mentions },
    ]),
  );
}

export interface SnapshotData {
  channels: SnapshotChannel[];
  dms: SnapshotDm[];
}

/**
 * Identity-level badge totals for the `ready` frame (rail badges paint before
 * any sub). Sums the same capped per-conversation windows the snapshot uses,
 * so a busy identity costs the same as a quiet one; the sum can exceed the
 * per-conversation cap and the client clamps display.
 *
 * `mutedConvIds` drops muted conversations from the totals (#430 follow-up).
 * The favicon indicator falls back to these totals for an identity whose
 * slice has not synced, and a pre-aggregated total cannot be decomposed per
 * conversation client-side — so a mute had to hold HERE or leak into the
 * alert surface. Per-conversation snapshot counts stay mute-blind on purpose:
 * sidebar badges and tint keep accruing for muted rooms (decisions.md §10 —
 * mutes silence alerts, they do not hide traffic).
 */
export async function identityBadgeTotals(
  db: Db,
  identityId: string,
  mutedConvIds: ReadonlySet<string> = new Set(),
): Promise<{ unread: number; mentions: number }> {
  const counts = await conversationCounts(db, identityId);
  let unread = 0;
  let mentions = 0;
  for (const [convId, count] of counts) {
    if (mutedConvIds.has(convId)) {
      continue;
    }
    unread += count.unread;
    mentions += count.mentions;
  }
  return { unread, mentions };
}

/**
 * A PM partner's presence from the live roster, resolved case-insensitively
 * (a DM row keeps the casing of whoever created it — a typed lowercase
 * partner must still find its presence entry). Absence from the roster means
 * offline. Shared by the snapshot and the pm.open ack so a freshly opened DM
 * row seeds the right dot immediately (#229).
 */
export function pmPresence(
  state: SessionState | undefined,
  partner: string,
): { online: boolean; status: string; statusmsg: string } {
  if (!state) {
    return { online: false, status: "", statusmsg: "" };
  }
  const lower = partner.toLowerCase();
  for (const [name, presence] of state.characters) {
    if (name.toLowerCase() === lower) {
      return {
        online: true,
        status: presence.status,
        statusmsg: presence.statusmsg,
      };
    }
  }
  return { online: false, status: "", statusmsg: "" };
}

export function memberDto(state: SessionState, character: string): MemberDto {
  const presence = state.characters.get(character);
  return {
    character,
    gender: presence?.gender ?? "",
    status: presence?.status ?? "",
    statusmsg: presence?.statusmsg ?? "",
  };
}

export function messageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    senderCharacter: row.senderCharacter,
    kind: row.kind,
    bbcode: row.bbcode,
    sentByUs: row.sentByUs,
    mention: row.mention,
    createdAt: row.createdAt.toISOString(),
    // Refused sends carry their cause everywhere the row goes — live
    // fan-out, snapshot, scroll-back, catch-up — so no reader ever paints a
    // message F-Chat rejected as delivered (#491).
    ...(row.failureReason !== null ? { failureReason: row.failureReason } : {}),
  };
}

export async function buildSnapshot(
  db: Db,
  identityId: string,
  session: FchatSession | undefined,
): Promise<SnapshotData> {
  const rows = await db
    .select({
      ...getTableColumns(conversations),
      // Newest message either direction, 0 for a conversation with none: the
      // sidebar's activity sort key for DM rows (#515). A correlated max, not
      // a join+groupBy — O(1) per conversation on the (conversation_id, id
      // desc) index, the same shape catchupPlan uses. Static identifiers on
      // purpose: drizzle renders interpolated columns in selected fields
      // unqualified, which mis-scopes the correlated outer reference.
      lastActivityId:
        sql<number>`(select coalesce(max(m.id), 0) from messages m where m.conversation_id = conversations.id)`.mapWith(
          Number,
        ),
    })
    .from(conversations)
    // Hidden rows (a left/closed channel, #327) stay in the DB for their kept
    // history and log export, but never seed the sidebar. PMs are never
    // hidden, so this only ever drops explicitly-left channels.
    .where(
      and(
        eq(conversations.identityId, identityId),
        eq(conversations.hidden, false),
      ),
    )
    .orderBy(conversations.createdAt);

  const counts = await conversationCounts(db, identityId);
  // Persisted "seen recently" rosters (#200), newest lastSeen first.
  const seen = await seenByChannel(db, identityId);

  // F-Chat resolves names case-insensitively, and a DM row keeps the casing
  // of whoever created it — a typed lowercase partner must still find its
  // presence entry.
  const presenceByLower = new Map<
    string,
    { gender: string; status: string; statusmsg: string }
  >();
  if (session) {
    for (const [name, presence] of session.state.characters) {
      presenceByLower.set(name.toLowerCase(), presence);
    }
  }

  const channels: SnapshotChannel[] = [];
  const dms: SnapshotDm[] = [];
  for (const row of rows) {
    if (row.kind === "channel") {
      const key = row.channelKey ?? "";
      const state = session?.state;
      const live = state?.channels.get(key);
      // A nick must never be both present and seen: a part→rejoin whose
      // delete is still queued behind the write queue may leave a stale
      // seen row for a beat, so filter against the live roster at serve.
      const liveLower = new Set(
        [...(live?.members ?? [])].map((name) => name.toLowerCase()),
      );
      channels.push({
        convId: row.id,
        key,
        title: live?.title ?? row.title,
        description: live?.description ?? "",
        mode: live?.mode ?? "both",
        oplist: live ? [...live.oplist] : [],
        members:
          live && state
            ? [...live.members].map((name) => memberDto(state, name))
            : [],
        seen: (seen.get(key) ?? []).filter(
          (member) => !liveLower.has(member.character.toLowerCase()),
        ),
        joined: row.joined,
        pinned: row.pinned,
        unread: counts.get(row.id)?.unread ?? 0,
        mentions: counts.get(row.id)?.mentions ?? 0,
        lastReadMessageId: row.lastReadMessageId,
      });
    } else {
      // For PMs the joined flag means "window open" (pm.close clears it):
      // closed conversations keep their history but leave the sidebar.
      if (!row.joined) {
        continue;
      }
      const partner = row.partnerCharacter ?? "";
      const presence = presenceByLower.get(partner.toLowerCase());
      dms.push({
        convId: row.id,
        partner,
        title: row.title,
        online: presence !== undefined,
        status: presence?.status ?? "",
        statusmsg: presence?.statusmsg ?? "",
        pinned: row.pinned,
        unread: counts.get(row.id)?.unread ?? 0,
        lastReadMessageId: row.lastReadMessageId,
        lastActivityId: row.lastActivityId,
      });
    }
  }
  return { channels, dms };
}

export interface CatchupPlanEntry {
  convId: string;
  /** Replay strictly-after this messages.id. */
  afterId: number;
  /**
   * True when the resume cursor was clamped by the replay budget — the
   * replay starts ABOVE the client's cursor, so its buffer prefix is no
   * longer contiguous with what we send. The client must reset that
   * conversation to the replayed window (older history stays reachable via
   * REST backfill) rather than merging into an unreachable interior gap.
   */
  gap: boolean;
}

/**
 * Ceiling on how much one conversation replays for a resuming cursor (M7):
 * a row count on the cursor path (see `budgetFloor`), an id-space bound on
 * the eager no-cursor path. Big enough that any realistic overnight gap
 * replays in full.
 */
export const CATCHUP_REPLAY_BUDGET = 2_000;

/**
 * Eager attach catch-up reaches back at most this far (#254): a fresh
 * attach replays the unread backlog since the persisted read cursor, but
 * never eagerly streams more than roughly a day of it — anything older
 * stays one scroll-back page away (`history.page`, uncapped).
 */
const CATCHUP_EAGER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Which conversations to replay on sub, and from where. Two regimes:
 *
 * - The client sent a cursor: it holds a contiguous buffer up to that id, so
 *   replay everything past it — this is the headline catch-up path, capped
 *   at CATCHUP_REPLAY_BUDGET *rows* of this conversation. Cursors for
 *   foreign or deleted conversations are silently dropped (the plan is
 *   built from the identity's own rows).
 * - No cursor (conversation created or first seen while this client was
 *   detached, or a fresh device, or a browser reload): replay the unread
 *   backlog "since you were last here" — from the persisted
 *   lastReadMessageId, floored by the eager caps: at most
 *   CATCHUP_EAGER_WINDOW_MS of history and at most a
 *   CATCHUP_REPLAY_BUDGET id-span (ids are global, so both are upper
 *   bounds — usually fewer rows). When the caps would replay LESS than a
 *   plain `batchSize` tail, the tail wins, so short absences and old
 *   quiet channels still get their context lines. A fully-read
 *   conversation replays nothing; deeper history stays reachable through
 *   scroll-back paging, which is uncapped. Replaying from id 0 would
 *   stream entire histories to every new device.
 */
export async function catchupPlan(
  db: Db,
  identityId: string,
  cursors: Record<string, number>,
  batchSize: number,
): Promise<CatchupPlanEntry[]> {
  // Correlated max, not a join+groupBy: O(1) per conversation via the
  // (conversation_id, id desc) index instead of aggregating every message
  // row the identity owns on each sub. Static identifiers on purpose —
  // drizzle renders interpolated columns in selected fields unqualified,
  // which mis-scopes the correlated outer reference. mapWith(Number)
  // because max(bigint) comes back from node-postgres as a string.
  const eagerCutoff = new Date(Date.now() - CATCHUP_EAGER_WINDOW_MS);
  const rows = await db
    .select({
      id: conversations.id,
      lastRead: conversations.lastReadMessageId,
      maxId:
        sql<number>`(select coalesce(max(m.id), 0) from messages m where m.conversation_id = conversations.id)`.mapWith(
          Number,
        ),
      // Oldest message still inside the eager window — the day cap in
      // id-space. Walks the (conversation_id, id desc) index backwards.
      oldestRecentId: sql<
        number | null
      >`(select min(m.id) from messages m where m.conversation_id = conversations.id and m.created_at >= ${eagerCutoff})`.mapWith(
        (value: unknown) => (value === null ? null : Number(value)),
      ),
    })
    .from(conversations)
    .where(eq(conversations.identityId, identityId));

  const plan: CatchupPlanEntry[] = [];
  /** Cursors the id-space pre-filter flagged, pending the exact row check. */
  const overBudget: { convId: string; cursor: number }[] = [];
  for (const row of rows) {
    const cursor = cursors[row.id];
    if (cursor !== undefined) {
      // Replay budget (M2 audit backlog): a cursor from a device that was
      // detached for weeks would otherwise replay everything since. Clamp
      // only, never drop — an up-to-date cursor still gets its empty done
      // frame (the client's per-conversation sync marker) — and when the
      // clamp really moves the start above the cursor, flag it so the client
      // resets rather than merging into an interior hole.
      //
      // Ids are global, so `maxId - BUDGET` is only a cheap PRE-filter here
      // (#432): on a busy bouncer a long sleep pushes every conversation past
      // it, including one that received five messages, and a spurious gap
      // costs that conversation its whole client buffer. Only the conversations
      // it flags pay for the exact row-count check.
      if (row.maxId - CATCHUP_REPLAY_BUDGET <= cursor) {
        plan.push({ convId: row.id, afterId: cursor, gap: false });
        continue;
      }
      overBudget.push({ convId: row.id, cursor });
      continue;
    }
    // Eager floor: nothing older than the day window, and never more than
    // the replay budget's id-span — but at least the plain batch tail, so
    // the caps only ever ADD context relative to the pre-#254 behavior.
    const dayFloor =
      row.oldestRecentId === null ? row.maxId : row.oldestRecentId - 1;
    const eagerFloor = Math.max(dayFloor, row.maxId - CATCHUP_REPLAY_BUDGET);
    const afterId = Math.max(
      row.lastRead ?? 0,
      Math.min(eagerFloor, row.maxId - batchSize),
    );
    if (afterId < row.maxId) {
      plan.push({ convId: row.id, afterId, gap: false });
    }
  }
  for (const { convId, cursor } of overBudget) {
    const floor = await budgetFloor(db, convId, cursor);
    plan.push({ convId, afterId: floor ?? cursor, gap: floor !== null });
  }
  return plan;
}

/**
 * The id to replay strictly-after so a conversation sends at most
 * CATCHUP_REPLAY_BUDGET rows — i.e. the id of the (budget + 1)-th newest
 * message past `cursor`. `null` when the conversation holds no more than the
 * budget since the cursor, which is the whole point: the client's buffer
 * stays contiguous and no gap is flagged. Walks the
 * (conversation_id, id desc) index and stops at the offset.
 */
async function budgetFloor(
  db: Db,
  convId: string,
  cursor: number,
): Promise<number | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), gt(messages.id, cursor)))
    .orderBy(desc(messages.id))
    .limit(1)
    .offset(CATCHUP_REPLAY_BUDGET);
  return row?.id ?? null;
}

/**
 * One scroll-back page (#254): up to `limit` messages strictly before the
 * cursor, returned ascending for the wire; `hasMore` says whether older
 * history still exists past this page. No age cap — paging walks the full
 * stored history.
 */
export async function fetchMessagesBefore(
  db: Db,
  conversationId: string,
  beforeId: number,
  limit: number,
): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        lt(messages.id, beforeId),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), hasMore };
}

/** One ascending catchup batch: messages strictly after the cursor. */
export async function fetchMessagesAfter(
  db: Db,
  conversationId: string,
  afterId: number,
  limit: number,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.id, afterId),
      ),
    )
    .orderBy(asc(messages.id))
    .limit(limit);
}
