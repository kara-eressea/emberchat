// Notification-inbox buffers (#467), one per identity. Same conventions as
// the message buffers: a bounded window, dedupe by id, older pages loaded on
// demand — only the axis is flipped. The inbox is newest-first (a dropdown
// reads top-down from the latest entry) so live rows PREPEND and `loadOlder`
// appends, which is why "scroll down for older" is the paging direction here.
//
// The badge counts what the server would count: entries past the seen
// watermark whose `muted` is false. Muted rows are still logged — the inbox
// is a log — they simply never alert (decisions.md §10).

import { create } from "zustand";
import { UNREAD_DISPLAY_CAP, type NotificationDto } from "@emberchat/protocol";
import { api } from "../lib/api.js";

/** Rows kept per identity; older ones re-load through the API. */
export const INBOX_WINDOW = 200;
/** Rows per API page. */
export const INBOX_PAGE_SIZE = 50;
/**
 * Display ceiling for the bell badge (rendered "99+" past it). The same number
 * the conversation badges use, and deliberately the same definition: the
 * server's unseen count saturates one past it, so a bell that tested against
 * its own private constant could drift out of step with the wire and lose its
 * "+" the way the channel badge did (#582).
 */
export const UNSEEN_DISPLAY_CAP = UNREAD_DISPLAY_CAP;

/** What became of a friend request this client acted on (#505). */
export type FriendRequestVerdict = "accepted" | "declined";

export interface InboxState {
  /** Newest first. */
  items: NotificationDto[];
  /** Entries past the watermark that may badge. */
  unseen: number;
  /** The server's seen watermark — rows above it render as unseen. */
  lastSeenId: number;
  /** Older entries exist past the buffer's tail. */
  hasMore: boolean;
  /** The first page has landed (so "nothing here yet" is truthful). */
  loaded: boolean;
  loading: boolean;
  /**
   * Friend-request verdicts this client just handed down, by notification id
   * (#505). NOT the source of truth — the live request list is (see
   * NotificationInbox's friendRequestState) — only what covers the seconds
   * between the click and the refreshed lists landing, during which the
   * request is out of `incoming` and not yet in `friends`, i.e. exactly the
   * window where derivation alone would flash the wrong verdict. Session
   * memory: cleared on reset like everything else here.
   */
  actioned: Record<number, FriendRequestVerdict>;
}

export const EMPTY_INBOX: InboxState = {
  items: [],
  unseen: 0,
  lastSeenId: 0,
  hasMore: false,
  loaded: false,
  loading: false,
  actioned: {},
};

interface NotificationsState {
  byIdentity: Record<string, InboxState>;
  /** Ready-frame unseen totals — the badge before any inbox fetch. */
  applyUnseen(identityId: string, unseen: number): void;
  /** A live `notification.new` event. */
  applyLive(identityId: string, notification: NotificationDto): void;
  /** A `notification.seen` event — another device opened the inbox. */
  applySeen(identityId: string, lastSeenId: number, unseen: number): void;
  /** A `notification.removed` event, or this tab's own delete (#506): drop
   * the row and take the server's recounted badge. */
  applyRemoved(identityId: string, id: number, unseen: number): void;
  /** Delete one entry from the log (#506). */
  remove(identityId: string, id: number): Promise<void>;
  /** Remember what this client did with a friend request (#505). */
  markActioned(
    identityId: string,
    id: number,
    verdict: FriendRequestVerdict,
  ): void;
  /** Undo a remembered verdict — the accept/deny call failed. */
  clearActioned(identityId: string, id: number): void;
  /** First (or refreshed) page. */
  load(identityId: string): Promise<void>;
  /** One older page, appended below the current tail. */
  loadOlder(identityId: string): Promise<void>;
  /** Opening the inbox marks everything seen (the Discord model). */
  markSeen(identityId: string): Promise<void>;
  reset(): void;
}

/** Merge newest-first, dedupe by id, and trim the oldest past the window. */
export function mergeNewestFirst(
  existing: NotificationDto[],
  incoming: NotificationDto[],
  window = INBOX_WINDOW,
): NotificationDto[] {
  const byId = new Map<number, NotificationDto>();
  for (const entry of existing) {
    byId.set(entry.id, entry);
  }
  for (const entry of incoming) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, window);
}

/** The verdict map minus one entry, identity-stable when there was none. */
function withoutVerdict(
  actioned: Record<number, FriendRequestVerdict>,
  id: number,
): Record<number, FriendRequestVerdict> {
  if (!(id in actioned)) {
    return actioned;
  }
  const next = { ...actioned };
  delete next[id];
  return next;
}

export const useNotificationsStore = create<NotificationsState>()((
  set,
  get,
) => {
  function patch(
    identityId: string,
    update: (inbox: InboxState) => InboxState,
  ): void {
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: update(state.byIdentity[identityId] ?? EMPTY_INBOX),
      },
    }));
  }

  return {
    byIdentity: {},

    applyUnseen(identityId, unseen) {
      patch(identityId, (inbox) => ({ ...inbox, unseen }));
    },

    applyLive(identityId, notification) {
      patch(identityId, (inbox) => ({
        ...inbox,
        // Only merge into a loaded buffer: prepending onto an empty one
        // would look like a complete inbox with exactly one entry, and the
        // first open would then never fetch the rest.
        items: inbox.loaded
          ? mergeNewestFirst(inbox.items, [notification])
          : inbox.items,
        // A duplicate must not double-count. Live delivery is exactly-once
        // per the gateway contract, but a resubscribe could replay one.
        unseen:
          inbox.items.some((entry) => entry.id === notification.id) ||
          notification.muted ||
          notification.id <= inbox.lastSeenId
            ? inbox.unseen
            : inbox.unseen + 1,
      }));
    },

    applySeen(identityId, lastSeenId, unseen) {
      // The watermark only ever moves forward server-side, so this is an
      // idempotent overwrite — including the echo of this tab's own PUT.
      patch(identityId, (inbox) => ({
        ...inbox,
        lastSeenId: Math.max(inbox.lastSeenId, lastSeenId),
        unseen,
      }));
    },

    applyRemoved(identityId, id, unseen) {
      patch(identityId, (inbox) => ({
        ...inbox,
        items: inbox.items.filter((entry) => entry.id !== id),
        unseen,
        // The verdict memory is keyed by notification id, and the row it
        // annotated is gone — keeping it would leak one entry per delete for
        // the life of the tab.
        actioned: withoutVerdict(inbox.actioned, id),
      }));
    },

    async remove(identityId, id) {
      // No optimistic removal: the row is the user's own log line and the
      // recounted badge comes back with the response, so a failed delete
      // should leave the panel exactly as it was rather than restore a row
      // that briefly vanished.
      const result = await api.deleteNotification(identityId, id);
      get().applyRemoved(identityId, id, result.unseen);
    },

    markActioned(identityId, id, verdict) {
      patch(identityId, (inbox) => ({
        ...inbox,
        actioned: { ...inbox.actioned, [id]: verdict },
      }));
    },

    clearActioned(identityId, id) {
      patch(identityId, (inbox) => ({
        ...inbox,
        actioned: withoutVerdict(inbox.actioned, id),
      }));
    },

    async load(identityId) {
      if (get().byIdentity[identityId]?.loading === true) {
        return;
      }
      patch(identityId, (inbox) => ({ ...inbox, loading: true }));
      try {
        const page = await api.listNotifications(identityId, {
          limit: INBOX_PAGE_SIZE,
        });
        patch(identityId, (inbox) => ({
          ...inbox,
          // Live events may have raced the fetch — merge, don't replace.
          items: mergeNewestFirst(inbox.items, page.notifications),
          hasMore: page.hasMore,
          lastSeenId: page.lastSeenId,
          unseen: page.unseen,
          loaded: true,
        }));
      } finally {
        patch(identityId, (inbox) => ({ ...inbox, loading: false }));
      }
    },

    async loadOlder(identityId) {
      const inbox = get().byIdentity[identityId] ?? EMPTY_INBOX;
      const oldest = inbox.items.at(-1);
      if (!inbox.hasMore || inbox.loading || !oldest) {
        return;
      }
      patch(identityId, (current) => ({ ...current, loading: true }));
      try {
        const page = await api.listNotifications(identityId, {
          before: oldest.id,
          limit: INBOX_PAGE_SIZE,
        });
        patch(identityId, (current) => ({
          ...current,
          // The window trims from the OLD end, so a deep scroll can't grow
          // the buffer without bound; the dropped rows re-page on demand.
          items: mergeNewestFirst(current.items, page.notifications),
          hasMore: page.hasMore,
        }));
      } finally {
        patch(identityId, (current) => ({ ...current, loading: false }));
      }
    },

    async markSeen(identityId) {
      const inbox = get().byIdentity[identityId] ?? EMPTY_INBOX;
      const newest = inbox.items[0]?.id ?? 0;
      // Nothing buffered yet (an unloaded inbox, or a failed first page):
      // marking 0 would be a no-op server-side but would wrongly clear the
      // ready-frame badge here.
      if (newest === 0 || (newest <= inbox.lastSeenId && inbox.unseen === 0)) {
        return;
      }
      // Optimistic: the bell clears the moment the panel opens. The server
      // watermark is monotonic, so a lost response only means the next open
      // re-sends the same mark.
      patch(identityId, (current) => ({
        ...current,
        unseen: 0,
        lastSeenId: Math.max(current.lastSeenId, newest),
      }));
      const result = await api.putNotificationsSeen(identityId, newest);
      patch(identityId, (current) => ({
        ...current,
        lastSeenId: Math.max(current.lastSeenId, result.lastSeenId),
        unseen: result.unseen,
      }));
    },

    reset() {
      set({ byIdentity: {} });
    },
  };
});
