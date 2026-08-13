// Sidebar (COMPONENTS.md §2–4): ServerHead · toolbar (filter + browser
// entry points, #196) · sections (Pinned, Channels, Direct Messages,
// Friends, Bookmarks) · MeBar. Section headings collapse (#168, per-device
// localStorage); the three people sections sort on recent DM activity (#515),
// with presence grouping (#164) as the tail for rows that have no
// conversation; offline rows hide behind each section's own show-offline pref
// (#165, #329), with pinned/unread/open conversations always shown. The social
// sections load lazily (four upstream F-List calls) and stay fresh via RTB;
// incoming friend requests render as actionable rows like channel invites.

import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  CLIENT_SETTABLE_STATUSES,
  type ClientSettableStatus,
  type MemberDto,
} from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { presenceDot, type DotKind } from "../../lib/presence.js";
import { useLongPress, type PressEvent } from "../../lib/useLongPress.js";
import { clampBadge, DOT_CLASS } from "./badges.js";
import { channelPath, dmPath, identityPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { displayVersion, useServerMeta } from "../../lib/use-meta.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { decodeWireEntities } from "../../lib/wire-text.js";
import { patchPrefs } from "../prefs/patch.js";
import {
  BellOffGlyph,
  ChevronGlyph,
  CloseGlyph,
  FlagGlyph,
  GearGlyph,
  PinGlyph,
  PowerGlyph,
  SearchGlyph,
  StarGlyph,
} from "../icons/Glyphs.js";
import {
  useSessionsStore,
  type ChannelInvite,
  type ChannelView,
  type DmView,
  type IdentitySession,
  type SocialCharacter,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useRailStore } from "../../stores/rail.js";
import { railHidden } from "../../lib/rail-visibility.js";
import { Avatar } from "../common/Avatar.js";
import { Wordmark } from "../common/Wordmark.js";
import { ChannelContextMenu } from "../chat/ChannelContextMenu.js";
import { isPrivateRoom } from "../chat/invite-targets.js";
import { MemberContextMenu } from "../chat/MemberContextMenu.js";
import { SectionOfflineMenu } from "../chat/SectionOfflineMenu.js";
import { matchScore } from "./quick-switch.js";
import {
  keepRow,
  showOfflineFor,
  type OfflineSection,
} from "./offline-filter.js";
import {
  orderByActivity,
  orderRows,
  orderSocial,
  socialNameSet,
} from "./sidebar-order.js";
import {
  applyManualOrder,
  clearLegacySidebarOrders,
  legacySidebarOrders,
  moveRow,
  sectionOrder,
  withSectionOrder,
} from "./sidebar-reorder.js";
import {
  loadCollapsedSections,
  toggleCollapsedSection,
  type CollapsedSections,
  type SidebarSection,
} from "./sidebar-sections.js";
import { SfwToggle } from "./SfwToggle.js";
import styles from "./shell.module.css";

/** Bounded wait for the joined conversation row to reach the store. */
async function waitForJoin(
  identityId: string,
  key: string,
): Promise<ChannelView | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const channel =
      useSessionsStore.getState().sessions[identityId]?.channels[key];
    if (channel?.joined) {
      return channel;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/** Rough pre-clamp so the context menu doesn't flash off-screen for a
 * frame; the menu re-clamps against its measured size once rendered. */
const MENU_WIDTH = 216;

/**
 * Row and heading glyphs (#490): 14px rather than the toolbar's 17, and the
 * only size in this file. The sidebar's type is 13px, so a glyph beside it
 * wants to be about the same height — the old 9–11px Unicode markers were
 * *below* the text they annotated, which is what made them unreadable rather
 * than merely small. The stroke is re-derived from the box (Glyphs.tsx), so
 * these paint at the same weight as the conversation toolbar's.
 */
const SIDEBAR_GLYPH_SIZE = 14;

/** Friend-request reveal flash (#467) — matches the log's jump flash. */
const FLASH_MS = 2400;

/** Right-click target of a sidebar people row (DM / friend / bookmark). */
interface PersonMenuState {
  member: MemberDto;
  /** Present when the row carries an open DM (#315): lets the identity menu
   * offer "Mark as read" for that conversation. */
  markRead?: { convId: string; unread: number };
  position: { x: number; y: number };
}

/** Right-click target of a sidebar channel row (#234). */
interface ChannelMenuState {
  key: string;
  position: { x: number; y: number };
}

export interface SidebarProps {
  session: IdentitySession;
  activeConvId: string | undefined;
}

export function Sidebar({ session, activeConvId }: SidebarProps) {
  const navigate = useNavigate();
  const online = session.sessionStatus === "online";

  // Toolbar filter (#196): one query narrows every section as you type —
  // subsequence matching, same behavior as the quick switcher.
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const filtering = trimmed !== "";
  const matches = (label: string) =>
    !filtering || matchScore(trimmed, label) !== undefined;

  // Collapsed sections (#168) — per-device, survives reloads. A live
  // filter overrides collapse so matches are never invisibly hidden.
  const [collapsed, setCollapsed] = useState<CollapsedSections>(
    loadCollapsedSections,
  );
  const toggleSection = (section: SidebarSection) => {
    setCollapsed((current) => toggleCollapsedSection(current, section));
  };
  const openSection = (section: SidebarSection) =>
    filtering || collapsed[section] !== true;

  // Drag-to-reorder (#391), Channels only since #515: a per-identity manual
  // order, synced through the `sidebarOrder` pref (#412) so every attached
  // browser agrees and a drop lands live on the other clients' `prefs.updated`.
  // Reordering is disabled while the toolbar filter is active — a filtered
  // subset isn't the real section order. `drag` tracks the row being dragged
  // and the current drop target/side so a subtle indicator can render. One
  // pref write per drop.
  //
  // The people sections dropped out of this: their base sort is recent
  // activity, which moves rows on its own, so a hand-placed order was dead
  // weight that only fought the sort. A channel's position is a genuine
  // standing preference and keeps its drag. Stored orders for the people
  // sections are simply never read — the pref schema still accepts the keys,
  // so an existing order is inert rather than a migration (and stays intact
  // for a future mixed channels+people grouping, which would build on this
  // same machinery).
  const orders = session.prefs.sidebarOrder;
  // One-shot migration off the pre-#412 localStorage key: if this browser
  // still holds a drag order and the synced pref has none, push it up once
  // and drop the key. After that the pref is the only source of truth, so a
  // stale copy on another device can never resurrect an old order.
  const identityId = session.identityId;
  const hasSyncedOrder = Object.keys(orders).length > 0;
  useEffect(() => {
    const legacy = legacySidebarOrders();
    if (Object.keys(legacy).length === 0) {
      return;
    }
    if (hasSyncedOrder) {
      clearLegacySidebarOrders();
      return;
    }
    void patchPrefs(identityId, { sidebarOrder: legacy }).then((ok) => {
      if (ok) {
        clearLegacySidebarOrders();
      }
    });
  }, [identityId, hasSyncedOrder]);
  const [drag, setDrag] = useState<{
    draggedId: string;
    overId?: string;
    position?: "before" | "after";
  }>();
  const reorderable = !filtering;
  const channelDrag = (
    id: string,
    ids: readonly string[],
  ): RowDrag | undefined => {
    if (!reorderable) {
      return undefined;
    }
    return {
      onDragStart: () => {
        setDrag({ draggedId: id });
      },
      onDragOver: (event) => {
        if (!drag) {
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position =
          event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setDrag((current) =>
          current ? { ...current, overId: id, position } : current,
        );
      },
      onDrop: (event) => {
        event.preventDefault();
        if (!drag) {
          return;
        }
        const next = moveRow(
          ids,
          drag.draggedId,
          id,
          drag.position ?? "before",
        );
        void patchPrefs(session.identityId, {
          sidebarOrder: withSectionOrder(
            orders,
            session.identityId,
            "channels",
            next,
          ),
        });
        setDrag(undefined);
      },
      onDragEnd: () => {
        setDrag(undefined);
      },
      indicator:
        drag && drag.overId === id && drag.draggedId !== id
          ? drag.position
          : undefined,
    };
  };

  // Right-click identity menu on people rows (#167) — the same menu the
  // channel member list uses, minus the channel-only sections.
  const [personMenu, setPersonMenu] = useState<PersonMenuState>();
  const openPersonMenu = (
    event: PressEvent,
    character: string,
    status: string,
    statusmsg: string,
    markRead?: { convId: string; unread: number },
  ) => {
    event.preventDefault();
    setPersonMenu({
      member: { character, gender: "", status, statusmsg },
      markRead,
      position: {
        x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
        y: Math.min(event.clientY, window.innerHeight - 160),
      },
    });
  };

  // Right-click channel menu (#234) — pin/mute/show/leave moved here from
  // the channel header. Keyed by channel key so the menu tracks live store
  // updates (a pin toggle relabels in place) instead of a stale snapshot.
  const [channelMenu, setChannelMenu] = useState<ChannelMenuState>();
  const menuChannel = channelMenu
    ? session.channels[channelMenu.key]
    : undefined;

  // Right-click menu on a people-section header (#329) — a per-section
  // "Show offline" toggle for Friends / Bookmarks / Direct messages.
  const [sectionMenu, setSectionMenu] = useState<{
    section: OfflineSection;
    position: { x: number; y: number };
  }>();
  const openSectionMenu = (section: OfflineSection) => (event: PressEvent) => {
    event.preventDefault();
    setSectionMenu({
      section,
      position: {
        x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
        y: Math.min(event.clientY, window.innerHeight - 160),
      },
    });
  };

  // convId "" = volatile placeholder whose conversation row is still being
  // written; it becomes routable one event later.
  const bump = session.prefs.highlightBump;
  const allChannels = orderRows(
    Object.values(session.channels).filter(
      (channel) => channel.convId !== "" && matches(channel.title),
    ),
    (c) => c.title,
    (c) => c.highlightedAt,
    bump,
  );
  // One row per character (#290): a friend/bookmark keeps their home row in
  // Friends/Bookmarks even with an open DM — that social row carries the DM's
  // unread badge, active anchor, and open-on-click (see socialNames below).
  // So the Direct Messages section omits any partner who is a friend or
  // bookmark, listing only conversation partners who are neither. F-Chat
  // resolves names case-insensitively, so compare lowercased.
  const socialNames = socialNameSet([
    ...(session.social?.friends ?? []).map((f) => f.name),
    ...(session.social?.bookmarks ?? []).map((b) => b.name),
  ]);
  // Lowercased partner → DmView, so a social row can find and carry its DM.
  const dmByPartner = new Map<string, DmView>();
  for (const dm of Object.values(session.dms)) {
    dmByPartner.set(dm.partner.toLowerCase(), dm);
  }
  // Direct messages: partners who are neither friend nor bookmark, with
  // offline hiding applied like the social sections (#329) — an offline,
  // read, unpinned, unopened DM row hides unless the section shows offline.
  const showOfflineDms = showOfflineFor(session.prefs, "dms");
  // Recent activity first (#515), alphabetical for anything with no messages
  // yet; pinned rows ride above both, below. The highlight-bump pref is not
  // consulted here anymore: a mention IS a message in the conversation, so
  // activity already floats the row the bump used to.
  const allDms = orderByActivity(
    orderRows(
      Object.values(session.dms).filter(
        (dm) =>
          matches(dm.partner) &&
          !socialNames.has(dm.partner.toLowerCase()) &&
          keepRow({
            online: dm.online,
            showOffline: showOfflineDms,
            pinned: dm.pinned,
            unread: dm.unread,
            active: dm.convId === activeConvId,
          }),
      ),
      (d) => d.partner,
    ),
    (d) => d.lastActivityId,
  );
  // Manual reorder (#391) applies over the Channels default sort: saved rows
  // first in their dragged order, the rest stable after. Pinned rows still
  // stay locked to the top (#169) — the manual order holds within the pinned
  // and unpinned groups. applyManualOrder is stable, so the pinned filter
  // keeps it.
  const orderedChannels = applyManualOrder(
    allChannels,
    (c) => c.key,
    sectionOrder(orders, session.identityId, "channels"),
  );
  const channels = [
    ...orderedChannels.filter((c) => c.pinned),
    ...orderedChannels.filter((c) => !c.pinned),
  ];
  // Pin outranks recency (#169): the hoist runs last, and both filters are
  // stable, so activity order holds within the pinned and unpinned groups.
  const dms = [
    ...allDms.filter((d) => d.pinned),
    ...allDms.filter((d) => !d.pinned),
  ];
  const channelIds = channels.map((c) => c.key);

  // Friends/Bookmarks visibility + tail order: online first (#164) — the base
  // ordering the activity sort below then lifts conversations out of — offline
  // hidden behind that section's own synced pref (#329), then the toolbar
  // filter like everything else. Offline hiding also covers a row carrying an
  // open DM (#329) —
  // it hides like any offline friend unless one of the always-show
  // exemptions applies (pinned, unread, or the currently open conversation),
  // so an opened DM no longer pins an offline partner into the list forever.
  const socialRows = (
    rows: readonly SocialCharacter[] | undefined,
    section: OfflineSection,
  ) => {
    const showOffline = showOfflineFor(session.prefs, section);
    return orderSocial(
      (rows ?? []).filter((row) => {
        const dm = dmByPartner.get(row.name.toLowerCase());
        return (
          keepRow({
            online: row.online,
            showOffline,
            pinned: dm?.pinned,
            unread: dm?.unread,
            active: dm !== undefined && dm.convId === activeConvId,
          }) && matches(row.name)
        );
      }),
      (row) => row.name,
      (row) => row.online,
    );
  };
  // Recent DM activity is the base sort (#515): a friend or bookmark you have
  // a conversation with sits above the ones you don't, most recently active
  // first, and reading that conversation changes nothing about where the row
  // sits. Presence grouping (#164) survives as the tail order for rows with
  // no DM at all — that is the only place it still decides anything, and it
  // is where "who can I talk to right now" is the honest question.
  const withActivity = (rows: SocialCharacter[]): SocialCharacter[] =>
    orderByActivity(
      rows,
      (row) => dmByPartner.get(row.name.toLowerCase())?.lastActivityId ?? 0,
    );
  const friends = withActivity(socialRows(session.social?.friends, "friends"));
  const bookmarks = withActivity(
    socialRows(session.social?.bookmarks, "bookmarks"),
  );

  const nothingMatched =
    filtering &&
    allChannels.length + allDms.length + friends.length + bookmarks.length ===
      0;

  // Leave a channel (#291): the same action as the channel menu's Leave —
  // the server unpins on explicit leave (#223) so the pin can't drag it back.
  // Navigate away first when it's on screen: the fan-out drops the row and
  // would otherwise strand the route.
  const leaveChannel = (channel: ChannelView) => {
    if (channel.convId === activeConvId) {
      void navigate(identityPath(session.character));
    }
    void gateway
      .cmd({
        identityId: session.identityId,
        action: "channel.leave",
        d: { key: channel.key },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(
              session.identityId,
              "error",
              ack.error ?? "Could not leave",
            );
        }
      });
  };

  // Close a DM (#291): the same gateway pm.close the DM header uses — history
  // is kept, the row and window go away, and the conversation reopens on the
  // next pm.open or inbound message. Navigate away first when it's active.
  const closeDm = (dm: DmView) => {
    if (dm.convId === activeConvId) {
      void navigate(identityPath(session.character));
    }
    void gateway
      .cmd({
        identityId: session.identityId,
        action: "pm.close",
        d: { convId: dm.convId },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(
              session.identityId,
              "error",
              ack.error ?? "Could not close the conversation",
            );
          return;
        }
        if (ack.conversation) {
          useSessionsStore
            .getState()
            .applyConversation(session.identityId, ack.conversation);
        }
      });
  };

  // Sidebar avatars/tokens (#416) — on by default, off restores the denser
  // text-only rows. The row's own dot and colouring are unaffected either way.
  const avatars = session.prefs.sidebarAvatars;

  // Muted conversations (#490). The mute lives in prefs keyed by convId, and
  // until now showed only inside the conversation it silenced — so a channel
  // muted last week looked exactly like one that was simply quiet.
  const mutedConvs = new Set(session.prefs.mutedConvIds);

  const channelRow = (channel: ChannelView, pinned: boolean) => (
    <NavRow
      key={`c:${channel.key}`}
      to={channelPath(session.character, channel.key)}
      active={channel.convId === activeConvId}
      unread={channel.unread}
      mentions={channel.mentions}
      pinned={pinned}
      muted={mutedConvs.has(channel.convId)}
      glyph="#"
      avatars={avatars}
      token={isPrivateRoom(channel.key) ? "private" : "official"}
      label={decodeWireEntities(channel.title)}
      drag={channelDrag(channel.key, channelIds)}
      affordance={{
        label: `Leave ${decodeWireEntities(channel.title)}`,
        onActivate: () => {
          leaveChannel(channel);
        },
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setChannelMenu({
          key: channel.key,
          position: {
            x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
            y: Math.min(event.clientY, window.innerHeight - 160),
          },
        });
      }}
    />
  );
  const dmRow = (dm: DmView, pinned: boolean) => (
    <NavRow
      key={`d:${dm.convId}`}
      to={dmPath(session.character, dm.partner)}
      active={dm.convId === activeConvId}
      unread={dm.unread}
      pinned={pinned}
      muted={mutedConvs.has(dm.convId)}
      dot={presenceDot(dm.online, dm.status)}
      offline={!dm.online}
      avatars={avatars}
      avatarName={dm.partner}
      label={dm.partner}
      affordance={{
        label: `Close conversation with ${dm.partner}`,
        onActivate: () => {
          closeDm(dm);
        },
      }}
      onContextMenu={(event) => {
        openPersonMenu(event, dm.partner, dm.status, dm.statusmsg, {
          convId: dm.convId,
          unread: dm.unread,
        });
      }}
    />
  );

  return (
    <nav className={styles.sidebar}>
      <SidebarHead />

      <div className={styles.toolbar}>
        <input
          className={styles.toolbarSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder="Find channels and people…"
          aria-label="Find in the channel list"
        />
        <button
          type="button"
          className={styles.toolbarBtn}
          title="Browse channels"
          aria-label="Browse channels"
          onClick={() => {
            useUiStore.getState().setChannelBrowserOpen(true);
          }}
        >
          #
        </button>
        <button
          type="button"
          className={styles.toolbarBtn}
          title="Search characters"
          aria-label="Search characters"
          onClick={() => {
            useUiStore.getState().setCharacterSearchOpen(true);
          }}
        >
          <SearchGlyph />
        </button>
      </div>

      <div className={styles.navScroll}>
        <SectionHeader
          label="Channels"
          count={channels.length}
          collapsed={!openSection("channels")}
          onToggle={() => {
            toggleSection("channels");
          }}
        />
        {openSection("channels") &&
          channels.map((channel) => channelRow(channel, channel.pinned))}
        {session.invites.map((invite) => (
          <InviteRow key={invite.key} session={session} invite={invite} />
        ))}

        <SectionHeader
          label="Direct messages"
          count={dms.length}
          collapsed={!openSection("dms")}
          onToggle={() => {
            toggleSection("dms");
          }}
          onContextMenu={openSectionMenu("dms")}
        />
        {openSection("dms") && dms.map((dm) => dmRow(dm, dm.pinned))}

        <SocialSections
          session={session}
          friends={friends}
          bookmarks={bookmarks}
          filtering={filtering}
          dmByPartner={dmByPartner}
          activeConvId={activeConvId}
          openSection={openSection}
          onToggle={toggleSection}
          onRowContextMenu={openPersonMenu}
          onSectionContextMenu={openSectionMenu}
        />

        {nothingMatched && (
          <div className={styles.socialEmpty}>Nothing here matches.</div>
        )}
        {filtering && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.socialRow ?? ""}`}
            onClick={() => {
              setQuery("");
              useUiStore.getState().setChannelBrowserOpen(true);
            }}
          >
            <span className={styles.navGlyph}>#</span>
            <span className={styles.navLabel}>Browse all channels…</span>
          </button>
        )}
      </div>

      {channelMenu && menuChannel && (
        <ChannelContextMenu
          identityId={session.identityId}
          ownCharacter={session.character}
          channel={menuChannel}
          active={menuChannel.convId === activeConvId}
          position={channelMenu.position}
          onClose={() => {
            setChannelMenu(undefined);
          }}
        />
      )}

      {personMenu && (
        <MemberContextMenu
          identityId={session.identityId}
          ownCharacter={session.character}
          channelTitle={`Conversation with ${personMenu.member.character}`}
          member={personMenu.member}
          markRead={personMenu.markRead}
          position={personMenu.position}
          onClose={() => {
            setPersonMenu(undefined);
          }}
        />
      )}

      {sectionMenu && (
        <SectionOfflineMenu
          identityId={session.identityId}
          section={sectionMenu.section}
          position={sectionMenu.position}
          onClose={() => {
            setSectionMenu(undefined);
          }}
        />
      )}

      <div className={styles.meBar}>
        <MeAvatarToggle character={session.character} />
        <MeStatus session={session} online={online} />
        <PowerButton session={session} />
        <SfwToggle />
        <button
          type="button"
          className={styles.meGear}
          title="Preferences"
          aria-label="Preferences"
          onClick={() => {
            useUiStore.getState().setPrefsOpen(true);
          }}
        >
          <GearGlyph />
        </button>
      </div>
    </nav>
  );
}

/**
 * Sidebar head: the product name and the running version, nothing else —
 * presence lives on the identity rail and the MeBar, and repeating it here
 * only added noise. When the server's daily update check has seen a newer
 * release, the version itself becomes the link to the releases page; that
 * accent tint is the whole announcement (no banner, no nag).
 *
 * The one exception is a gateway that is not connected: the tab is showing
 * stale everything, so it says so — and the chip retries on click.
 */
function SidebarHead() {
  const meta = useServerMeta();
  const gatewayStatus = useUiStore((s) => s.gatewayStatus);
  const update =
    meta?.updateAvailable && meta.latestVersion !== undefined
      ? meta.latestVersion
      : undefined;

  return (
    <div className={styles.serverHead}>
      <Wordmark />
      {gatewayStatus !== "online" && (
        <button
          type="button"
          className={`${styles.connState} ${
            gatewayStatus === "offline" ? styles.connStateOffline : ""
          }`}
          title="Reconnect now"
          aria-label="Reconnect now"
          onClick={() => {
            gateway.reconnectNow();
          }}
        >
          {gatewayStatus === "offline" ? "Offline" : "Connecting…"}
        </button>
      )}
      {meta &&
        (update === undefined ? (
          <span className={styles.serverVersion}>
            {displayVersion(meta.version)}
          </span>
        ) : (
          <a
            className={`${styles.serverVersion} ${styles.serverVersionUpdate}`}
            href={meta.releasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`${displayVersion(update)} available`}
            // The tint carries the news visually; the label carries it aloud.
            aria-label={`Version ${displayVersion(meta.version)} — ${displayVersion(update)} available`}
          >
            {displayVersion(meta.version)}
          </a>
        ))}
    </div>
  );
}

/**
 * Collapsible section heading (#168). The whole row is the toggle (#496): it
 * used to be a button hugging the label, so the chevron worked, the word
 * worked, and the other two thirds of the band — including the count at the
 * far right — were dead pixels that looked exactly as clickable as the rest.
 *
 * One element rather than a button stretched inside a wrapper, because the
 * long-press that opens the section menu (#329) has to be on the same element:
 * a wrapper claiming the press while its child claims the click is two targets
 * over one row of pixels, and MP2's ghost-click swallow is what keeps the hold
 * from also collapsing the section. Any *interactive* trailing control added
 * here later stays outside this button — the count is text, and rides inside.
 */
function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  onContextMenu,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Right-click, or hold on a touchscreen, to open the header's menu (the
   * people sections use it for the per-section "Show offline" toggle, #329). */
  onContextMenu?: (event: PressEvent) => void;
}) {
  const press = useLongPress(onContextMenu);
  return (
    <button
      type="button"
      className={styles.sectionHeader}
      aria-expanded={!collapsed}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      {...press}
    >
      <span
        className={`${styles.sectionChevron} ${
          collapsed ? (styles.sectionChevronCollapsed ?? "") : ""
        }`}
      >
        <ChevronGlyph size={SIDEBAR_GLYPH_SIZE} />
      </span>
      <span className={styles.sectionLabel}>{label}</span>
      {/* Hidden from the accessible name so the button stays "Channels" and
          not "Channels 7" — the number duplicates the rows underneath it,
          which a screen reader is already walking. */}
      <span className={styles.sectionMeta} aria-hidden>
        {count || ""}
      </span>
    </button>
  );
}

/**
 * Your own avatar in the MeBar, doubling as the identity-rail toggle (#346):
 * clicking it hides or shows the rail, a per-device choice. The label/pressed
 * state reflect the effective visibility, so with a second identity connected
 * (rail forced visible) the button honestly reads "Hide identity rail".
 */
function MeAvatarToggle({ character }: { character: string }) {
  const railPref = useRailStore((s) => s.hidden);
  const identityCount = useSessionsStore((s) => s.identities?.length ?? 0);
  const hidden = railHidden(railPref, identityCount);
  const label = hidden ? "Show identity rail" : "Hide identity rail";
  return (
    <button
      type="button"
      className={styles.meAvatar}
      title={label}
      aria-label={label}
      aria-pressed={hidden}
      onClick={() => {
        useRailStore.getState().toggle();
      }}
    >
      <Avatar name={character || "?"} size={30} />
    </button>
  );
}

/**
 * Nick + status row of the MeBar. While the session is online it doubles as
 * the status control (F-Chat STA): clicking it opens a small editor above
 * the bar — status select, optional message, one Set button. The session
 * remembers the choice across reconnects; the fan-out converges every tab.
 */
function MeStatus({
  session,
  online,
}: {
  session: IdentitySession;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClientSettableStatus>("online");
  const [statusmsg, setStatusmsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const containerRef = useRef<HTMLSpanElement>(null);

  // Escape / click-outside close the editor, like every other popover — the
  // key via the shared stack (#442) so it beats any armed ambient action.
  useEscapeToClose(() => {
    setOpen(false);
  }, open);
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const statusLine = online
    ? session.ownStatus +
      (session.ownStatusmsg ? ` — ${session.ownStatusmsg}` : "")
    : sessionStatusLabel(session);
  const dot: DotKind = online ? presenceDot(true, session.ownStatus) : "faint";

  function toggle() {
    if (!open) {
      // Seed the editor with the current choice, not the last edit.
      const current = CLIENT_SETTABLE_STATUSES.find(
        (s) => s === session.ownStatus,
      );
      setStatus(current ?? "online");
      setStatusmsg(session.ownStatusmsg);
      setError(undefined);
    }
    setOpen(!open);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "status.set",
        d: { status, statusmsg: statusmsg.trim() },
      });
      if (!ack.ok) {
        setError(ack.error ?? "Could not set status");
        return;
      }
      // Fold a non-empty message into the recents chips (M9) — dedupe,
      // most-recent-first, whole-array patch per the recents convention.
      const message = statusmsg.trim();
      if (message !== "") {
        const recents = [
          message,
          ...session.prefs.statusMessageRecents.filter(
            (entry) => entry !== message,
          ),
        ].slice(0, 20);
        void patchPrefs(session.identityId, {
          statusMessageRecents: recents,
        });
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.meMeta} ref={containerRef} data-testid="me-bar">
      <div className={styles.meNick}>{session.character || "—"}</div>
      <button
        className={styles.meStatusButton}
        onClick={toggle}
        disabled={!online}
        title={online ? "Set status" : undefined}
        aria-label="Set status"
      >
        <span className={`${styles.serverDot} ${DOT_CLASS[dot]}`} />
        <span className={styles.meStatusText}>{statusLine}</span>
      </button>
      {open && online && (
        <form
          className={styles.statusEditor}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <select
            className={styles.miniInput}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ClientSettableStatus);
            }}
            aria-label="Status"
          >
            {CLIENT_SETTABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className={styles.miniInput}
            value={statusmsg}
            onChange={(e) => {
              setStatusmsg(e.target.value);
            }}
            maxLength={255}
            placeholder="Status message…"
            aria-label="Status message"
          />
          <button className={styles.miniButton} type="submit" disabled={busy}>
            Set
          </button>
          {session.prefs.statusMessageRecents.length > 0 && (
            <div className={styles.statusRecents}>
              {session.prefs.statusMessageRecents.slice(0, 5).map((recent) => (
                <button
                  key={recent}
                  type="button"
                  className={styles.statusRecentChip}
                  title={recent}
                  onClick={() => {
                    setStatusmsg(recent);
                  }}
                >
                  {recent}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className={styles.miniError} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </span>
  );
}

/**
 * Explicit connect/disconnect (M2: closing the tab never disconnects — this
 * is the one deliberate way to log a character off the bouncer). The local
 * autoConnect mirror keeps the shell from silently reconnecting an identity
 * the user just logged off.
 */
function PowerButton({ session }: { session: IdentitySession }) {
  const [busy, setBusy] = useState(false);
  const connected =
    session.sessionStatus !== "offline" && session.sessionStatus !== "stopped";

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const action = connected ? "session.disconnect" : "session.connect";
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action,
      });
      if (ack.ok) {
        useSessionsStore
          .getState()
          .setAutoConnect(session.identityId, !connected);
      } else {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            ack.error ??
              (connected ? "Could not log off" : "Could not connect"),
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={styles.meGear}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      title={connected ? "Log off F-Chat" : "Connect to F-Chat"}
      aria-label={connected ? "Log off F-Chat" : "Connect to F-Chat"}
    >
      <PowerGlyph />
    </button>
  );
}

function sessionStatusLabel(session: IdentitySession): string {
  if (session.sessionStatus === "stopped" && session.statusReason) {
    return `stopped — ${session.statusReason}`;
  }
  return session.sessionStatus.replace("_", " ");
}

/** Hover/focus affordance on the right of a row (#291): closes a DM or
 * leaves a channel. The counter badge swaps for this X on hover (CSS), and
 * it stays keyboard-reachable (focusable, aria-labelled). */
interface RowAffordance {
  label: string;
  onActivate: () => void;
}

/** Which relationship a people row is showing — the leading §4 glyph. Named
 * rather than passed as the character itself (#490): the glyphs are SVG now,
 * and a row shouldn't be handing another component a drawing. */
type SocialGlyph = "friend" | "bookmark";

/** Drag-to-reorder wiring for a sidebar row (#391). `indicator` renders the
 * drop bar above/below the row when it is the current drop target. */
export interface RowDrag {
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: (event: ReactDragEvent<HTMLElement>) => void;
  indicator?: "before" | "after";
}

/** DOM props of a draggable row wrapper (the NavRow div), carrying the drag
 * affordance and the drop indicator. Channels only since #515 — the people
 * sections sort themselves by activity and have no manual order to drag. */
function dragWrapProps(drag: RowDrag | undefined) {
  if (!drag) {
    return {};
  }
  const indicatorClass =
    drag.indicator === "before"
      ? styles.dropBefore
      : drag.indicator === "after"
        ? styles.dropAfter
        : undefined;
  return {
    draggable: true,
    onDragStart: drag.onDragStart,
    onDragOver: drag.onDragOver,
    onDrop: drag.onDrop,
    onDragEnd: drag.onDragEnd,
    indicatorClass,
  };
}

/** Sidebar row avatar (#416): the same F-List image the member list uses, at
 * 20px, with the member-list status dot overlaid bottom-right. Decorative —
 * the row's own dot, colouring and label carry the meaning. */
const SIDEBAR_AVATAR_SIZE = 20;

function RowAvatar({ name, dot }: { name: string; dot?: DotKind }) {
  return (
    <span className={styles.navAvatar} data-testid="sidebar-avatar">
      <Avatar name={name} size={SIDEBAR_AVATAR_SIZE} />
      {dot !== undefined && (
        <span className={`${styles.navAvatarDot} ${DOT_CLASS[dot]}`} />
      )}
    </span>
  );
}

/** Channel counterpart of the row avatar: a round accent-tinted token with a
 * # glyph, a lighter tint for private (ADH-) rooms than official channels. */
function ChannelToken({ kind }: { kind: "official" | "private" }) {
  const classes = [styles.navToken];
  if (kind === "private") {
    classes.push(styles.navTokenPrivate ?? "");
  }
  return (
    <span
      className={classes.join(" ")}
      data-testid="sidebar-token"
      data-kind={kind}
      aria-hidden
    >
      #
    </span>
  );
}

/**
 * The state glyphs of a row, right-aligned in one column (#490).
 *
 * Order is fixed and the same on every row — muted, pinned, then the counter —
 * so a reader scanning the column down the sidebar finds each fact in the same
 * place. Before this the pin sat immediately after the label, i.e. at a
 * different horizontal position on every row, and mute did not show at all.
 */
function RowTrail({
  muted = false,
  pinned = false,
  unread,
  mentions = 0,
}: {
  muted?: boolean;
  pinned?: boolean;
  unread: number;
  mentions?: number;
}) {
  return (
    <span className={styles.navTrail}>
      {muted && (
        <span
          className={styles.navMute}
          role="img"
          aria-label="Muted"
          title="Muted — no sounds or notifications"
        >
          <BellOffGlyph size={SIDEBAR_GLYPH_SIZE} />
        </span>
      )}
      {pinned && (
        <span
          className={styles.navPin}
          role="img"
          aria-label="Pinned"
          title="Pinned — reopens when you reconnect"
        >
          <PinGlyph size={SIDEBAR_GLYPH_SIZE} />
        </span>
      )}
      {mentions > 0 ? (
        <span
          className={`${styles.navBadge} ${styles.navBadgeMention ?? ""}`}
          data-testid="nav-badge"
        >
          @{clampBadge(mentions)}
        </span>
      ) : (
        unread > 0 && (
          <span className={styles.navBadge} data-testid="nav-badge">
            {clampBadge(unread)}
          </span>
        )
      )}
    </span>
  );
}

interface NavRowProps {
  to: string;
  active: boolean;
  unread: number;
  label: string;
  mentions?: number;
  pinned?: boolean;
  /** In `prefs.mutedConvIds` (#490): the row says so, and reads back a step
   * — muting was invisible everywhere except inside the conversation. */
  muted?: boolean;
  glyph?: string;
  dot?: DotKind;
  offline?: boolean;
  /** Sidebar avatars/tokens pref (#416). Off = the text-only row. */
  avatars?: boolean;
  /** Character whose avatar leads the row (DM rows). */
  avatarName?: string;
  /** Channel rows get a round # token instead of the bare glyph, tinted by
   * room kind: official public channels vs private (ADH-) rooms. */
  token?: "official" | "private";
  affordance?: RowAffordance;
  drag?: RowDrag;
  /** Opens the row's menu. Typed on what opening it needs rather than on
   * MouseEvent, so the same handler serves the right-click and the
   * long-press (MP2 §1). */
  onContextMenu?: (event: PressEvent) => void;
}

function NavRow({
  to,
  active,
  unread,
  label,
  mentions = 0,
  pinned = false,
  muted = false,
  glyph,
  dot,
  offline,
  avatars = false,
  avatarName,
  token,
  affordance,
  drag,
  onContextMenu,
}: NavRowProps) {
  const press = useLongPress(onContextMenu);
  const classes = [styles.navItem];
  if (muted) {
    classes.push(styles.mutedRow ?? "");
  }
  if (active) {
    classes.push(styles.active);
  }
  if (unread > 0) {
    classes.push(styles.unread);
  }
  if (offline) {
    classes.push(styles.offlineRow);
  }
  const { indicatorClass, ...dragProps } = dragWrapProps(drag);
  const wrapClasses = [styles.navRowWrap];
  if (indicatorClass) {
    wrapClasses.push(indicatorClass);
  }
  // The close/leave button (#291) is a sibling of the Link, not a child:
  // nesting interactive controls inside an <a> is invalid HTML and would fold
  // the X's label into the link's accessible name. A relatively-positioned
  // wrapper lets the X overlay the row's right edge on hover instead.
  // The wrapper is the drag source (#391); the inner Link's own default anchor
  // drag is turned off so it doesn't hijack the reorder gesture.
  return (
    <div className={wrapClasses.join(" ")} {...dragProps}>
      <Link
        className={classes.join(" ")}
        to={to}
        draggable={false}
        onContextMenu={onContextMenu}
        {...press}
      >
        {avatars && token !== undefined ? (
          <ChannelToken kind={token} />
        ) : (
          glyph !== undefined && (
            <span className={styles.navGlyph}>{glyph}</span>
          )
        )}
        {avatars && avatarName !== undefined && (
          <RowAvatar name={avatarName} dot={dot} />
        )}
        {dot !== undefined && (
          <span className={`${styles.navDot} ${DOT_CLASS[dot]}`} />
        )}
        <span className={styles.navLabel}>{label}</span>
        <RowTrail
          muted={muted}
          pinned={pinned}
          unread={unread}
          mentions={mentions}
        />
      </Link>
      {affordance && (
        <button
          type="button"
          className={styles.navClose}
          // Revealed by row hover; permanently drawn where nothing can hover
          // (base.css §5-F), which is also why the trailing column stops
          // yielding to it there — see .navTrail below.
          data-eb-hover-reveal
          aria-label={affordance.label}
          title={affordance.label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            affordance.onActivate();
          }}
        >
          <CloseGlyph size={SIDEBAR_GLYPH_SIZE} />
        </button>
      )}
    </div>
  );
}

/**
 * An inbound channel invitation (CIU) as an actionable row: join or
 * dismiss. Volatile by design — a dismissed or missed invite stays joinable
 * later through the channel browser's hidden-by-name footer.
 */
function InviteRow({
  session,
  invite,
}: {
  session: IdentitySession;
  invite: ChannelInvite;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function join() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.join",
        d: { key: invite.key },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            ack.error ?? "Could not join",
          );
        return;
      }
      const channel = await waitForJoin(session.identityId, invite.key);
      if (!channel) {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            "No response from the channel — the invite may have expired",
          );
        return;
      }
      useSessionsStore.getState().dismissInvite(session.identityId, invite.key);
      void navigate(channelPath(session.character, channel.key));
    } finally {
      setBusy(false);
    }
  }

  // Invite room titles are wire text the server entity-escapes (#350).
  const inviteTitle = decodeWireEntities(invite.title);
  return (
    <div className={styles.inviteRow}>
      <span
        className={styles.inviteText}
        title={`${inviteTitle} (${invite.key})`}
      >
        ✉ <strong>{invite.sender}</strong> invited you to{" "}
        <strong>{inviteTitle}</strong>
      </span>
      <button
        type="button"
        className={styles.miniButton}
        aria-label={`Join ${invite.title}`}
        disabled={busy || session.sessionStatus !== "online"}
        onClick={() => {
          void join();
        }}
      >
        Join
      </button>
      <button
        type="button"
        className={styles.inviteDismiss}
        aria-label={`Dismiss invite to ${invite.title}`}
        onClick={() => {
          useSessionsStore
            .getState()
            .dismissInvite(session.identityId, invite.key);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Friends and Bookmarks (M6 step 7): loaded once per identity through the
 * social REST endpoint, which is served from the server's cache (#194) — the
 * four upstream F-List calls behind the shared 1 req/s budget only run on a
 * cold cache or a forced refetch. Staying current is the server's job, not a
 * button's: it refetches the lists and fans them out on the RTB friend and
 * bookmark events (#431), which is why the explicit ↻ that used to live here
 * is gone (#367). Rows open a DM; incoming friend requests are actionable
 * like channel invites. The parent hands in the already sorted/filtered row
 * lists so the toolbar filter and the offline pref apply uniformly.
 */
function SocialSections({
  session,
  friends,
  bookmarks,
  filtering,
  dmByPartner,
  activeConvId,
  openSection,
  onToggle,
  onRowContextMenu,
  onSectionContextMenu,
}: {
  session: IdentitySession;
  friends: SocialCharacter[];
  bookmarks: SocialCharacter[];
  filtering: boolean;
  dmByPartner: Map<string, DmView>;
  activeConvId: string | undefined;
  openSection: (section: SidebarSection) => boolean;
  onToggle: (section: SidebarSection) => void;
  onRowContextMenu: (
    event: PressEvent,
    character: string,
    status: string,
    statusmsg: string,
    markRead?: { convId: string; unread: number },
  ) => void;
  onSectionContextMenu: (
    section: OfflineSection,
  ) => (event: PressEvent) => void;
}) {
  const identityId = session.identityId;
  const social = session.social;
  const mutedConvs = new Set(session.prefs.mutedConvIds);
  const [loadError, setLoadError] = useState<string>();
  // The notification inbox sends the user here when they click a friend
  // request (#467). The rows already render regardless of the section's
  // collapsed state, so revealing them is scroll + a one-shot flash.
  const requestsNonce = useUiStore((s) => s.friendRequestsNonce);
  const requestsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = requestsRef.current;
    // Nonce 0 = nobody has asked; a flash on mount would be a lie.
    if (requestsNonce === 0 || element === null) {
      return;
    }
    element.scrollIntoView({ block: "nearest" });
    // A class on the DOM node rather than React state: the flash is a
    // one-shot animation with no bearing on what renders, and setState in an
    // effect body is exactly the cascading render the lint forbids.
    const flash = styles.requestsFlash ?? "";
    element.classList.add(flash);
    const timer = setTimeout(() => {
      element.classList.remove(flash);
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
      element.classList.remove(flash);
    };
  }, [requestsNonce]);

  useEffect(() => {
    // No synchronous state write here (lint): the load either resolves
    // (social data replaces any stale error implicitly on render) or
    // rejects and sets a fresh error.
    loadSocial(identityId).then(
      () => {
        setLoadError(undefined);
      },
      (error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Couldn't load");
      },
    );
  }, [identityId]);

  async function respond(requestId: number, action: "accept" | "deny") {
    try {
      await api.postFriendRequest(identityId, { action, requestId });
      await loadSocial(identityId, true);
    } catch (error) {
      useSessionsStore
        .getState()
        .applyNotice(
          identityId,
          "error",
          error instanceof Error ? error.message : "Request failed",
        );
    }
  }

  const row = (character: SocialCharacter, glyph: SocialGlyph) => {
    // #290: a friend/bookmark with an open DM carries the DM's unread badge
    // and active anchor onto its own row.
    const dm = dmByPartner.get(character.name.toLowerCase());
    return (
      <SocialRow
        key={character.name}
        session={session}
        character={character}
        glyph={glyph}
        unread={dm?.unread ?? 0}
        pinned={dm?.pinned ?? false}
        muted={dm !== undefined && mutedConvs.has(dm.convId)}
        active={dm !== undefined && dm.convId === activeConvId}
        onContextMenu={(event) => {
          onRowContextMenu(
            event,
            character.name,
            character.status,
            character.statusmsg,
            dm ? { convId: dm.convId, unread: dm.unread } : undefined,
          );
        }}
      />
    );
  };

  return (
    <>
      <SectionHeader
        label="Friends"
        count={friends.length}
        collapsed={!openSection("friends")}
        onToggle={() => {
          onToggle("friends");
        }}
        onContextMenu={onSectionContextMenu("friends")}
      />
      {loadError !== undefined && (
        <div className={styles.socialEmpty} role="alert">
          Couldn't load — {loadError}.
        </div>
      )}
      <div ref={requestsRef}>
        {social?.incoming.map((request) => (
          <div className={styles.inviteRow} key={`fr:${String(request.id)}`}>
            <span className={styles.inviteText}>
              ♥ <strong>{request.name}</strong> sent a friend request
            </span>
            <button
              type="button"
              className={styles.miniButton}
              aria-label={`Accept friend request from ${request.name}`}
              onClick={() => {
                void respond(request.id, "accept");
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className={styles.inviteDismiss}
              aria-label={`Deny friend request from ${request.name}`}
              onClick={() => {
                void respond(request.id, "deny");
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {openSection("friends") && friends.map((friend) => row(friend, "friend"))}
      {openSection("friends") &&
        !filtering &&
        social !== undefined &&
        social.friends.length === 0 && (
          <div className={styles.socialEmpty}>No friends yet.</div>
        )}

      <SectionHeader
        label="Bookmarks"
        count={bookmarks.length}
        collapsed={!openSection("bookmarks")}
        onToggle={() => {
          onToggle("bookmarks");
        }}
        onContextMenu={onSectionContextMenu("bookmarks")}
      />
      {openSection("bookmarks") &&
        bookmarks.map((bookmark) => row(bookmark, "bookmark"))}
      {openSection("bookmarks") &&
        !filtering &&
        social !== undefined &&
        social.bookmarks.length === 0 && (
          <div className={styles.socialEmpty}>No bookmarks yet.</div>
        )}
    </>
  );
}

/** One friend/bookmark: presence dot + relationship glyph (§4: ★ friend,
 * ⚑ bookmark — same vocabulary as the profile badges, drawn as SVG since
 * #490) + name; clicking opens the DM, right-clicking the identity menu
 * (#167). */
function SocialRow({
  session,
  character,
  glyph,
  unread,
  pinned = false,
  muted = false,
  active,
  onContextMenu,
}: {
  session: IdentitySession;
  character: SocialCharacter;
  glyph: SocialGlyph;
  unread: number;
  /** The partner's DM pin (#290): the row moved out of Direct messages, so
   * this is the only place the pin — and its offline keep-alive — shows. */
  pinned?: boolean;
  /** Likewise the partner's DM mute (#490). */
  muted?: boolean;
  active: boolean;
  onContextMenu: (event: PressEvent) => void;
}) {
  const navigate = useNavigate();
  const press = useLongPress(onContextMenu);

  async function open() {
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "pm.open",
      d: { character: character.name },
    });
    if (!ack.ok || !ack.conversation) {
      useSessionsStore
        .getState()
        .applyNotice(
          session.identityId,
          "error",
          ack.error ?? "Could not open the conversation",
        );
      return;
    }
    useSessionsStore
      .getState()
      .applyConversation(session.identityId, ack.conversation);
    void navigate(
      dmPath(session.character, ack.conversation.partnerCharacter ?? ""),
    );
  }

  const classes = [styles.navItem, styles.socialRow ?? ""];
  if (muted) {
    classes.push(styles.mutedRow ?? "");
  }
  if (active) {
    classes.push(styles.active ?? "");
  }
  if (unread > 0) {
    classes.push(styles.unread ?? "");
  }
  if (!character.online) {
    classes.push(styles.offlineRow ?? "");
  }
  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={() => {
        void open();
      }}
      onContextMenu={onContextMenu}
      {...press}
      title={
        character.online
          ? // The hover tooltip is a status message like any other, so
            // `showOthersStatus` hides it too — a friends row is never you
            // (#585). The presence word stays.
            `${character.status}${character.statusmsg && session.prefs.showOthersStatus ? ` — ${decodeWireEntities(character.statusmsg)}` : ""}`
          : "offline"
      }
    >
      {session.prefs.sidebarAvatars && (
        <RowAvatar
          name={character.name}
          dot={presenceDot(character.online, character.status)}
        />
      )}
      <span
        className={`${styles.navDot} ${DOT_CLASS[presenceDot(character.online, character.status)]}`}
      />
      <span className={styles.socialGlyph}>
        {glyph === "friend" ? (
          <StarGlyph size={SIDEBAR_GLYPH_SIZE} />
        ) : (
          <FlagGlyph size={SIDEBAR_GLYPH_SIZE} />
        )}
      </span>
      <span className={styles.navLabel}>{character.name}</span>
      <RowTrail muted={muted} pinned={pinned} unread={unread} />
    </button>
  );
}
