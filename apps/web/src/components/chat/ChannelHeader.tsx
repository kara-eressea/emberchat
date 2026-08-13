// ChannelHeader / DmHeader (COMPONENTS.md §5) — one compact toolbar row.
//
// Identity (glyph · name · topic) on the left, then icon-chip actions, the
// inline search field and the view toggles on the right. The row runs on the
// composer toolbar's own IconBtn + divider language (chat.module.css
// .iconBtn/.tbDivider) so the top and bottom of a conversation read as the
// same instrument — including its priority collapse (#375): the row measures
// itself and folds its lowest-priority controls into a ⋯ overflow menu, in the
// order header-toolbar.ts lays down. Search and the notification inbox are the
// two that never fold.
//
// F-Chat channels carry one CDS description — that fills the topic slot; the
// separate editable TOPIC row has no wire counterpart and is omitted. The TPN
// typing state rests on the message bar (#336), rendered by the composer's
// typingLine.

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useNavigate } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { useIsNarrow } from "../../lib/dm-sidebar.js";
import { useLayoutMode } from "../../lib/layout-mode.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useRowWidth } from "../../lib/useRowWidth.js";
import { clockTitle, localClock } from "../../lib/local-time.js";
import { presenceDot } from "../../lib/presence.js";
import { identityPath } from "../../lib/routes.js";
import { useMinuteClock } from "../../lib/clock.js";
import { decodeWireEntities } from "../../lib/wire-text.js";
import { useProfileStore, type CardAnchor } from "../../stores/profile.js";
import {
  useSessionsStore,
  useUserPrefs,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { RoomSettingsWindow } from "./RoomSettingsWindow.js";
import {
  BackGlyph,
  BanGlyph,
  BellGlyph,
  BellOffGlyph,
  ClockGlyph,
  CloseGlyph,
  GearGlyph,
  MembersGlyph,
  MoreGlyph,
  PanelRightGlyph,
  PinGlyph,
  SearchGlyph,
} from "../icons/Glyphs.js";
import { InboxChip } from "./NotificationInbox.js";
import { RichText } from "./RichText.js";
import { SearchPanel } from "./SearchPanel.js";
import { anchorOf, ToolbarPopover } from "./ToolbarPopover.js";
import {
  collapsedHeaderControls,
  type HeaderControlId,
} from "./header-toolbar.js";
import { useLogSearch } from "./log-search.js";
import { roleFor } from "./member-roles.js";
import styles from "./chat.module.css";

/**
 * Toolbar chip: the composer's IconBtn, with the toggled state spelled out.
 * `menu` is the same chip rendered as a row of the ⋯ overflow — full width,
 * label beside the glyph — so a collapsed control keeps its component, its
 * behaviour and its aria-label/title pair rather than growing a second
 * implementation.
 */
function chipClass({
  on = false,
  danger = false,
  menu = false,
}: { on?: boolean; danger?: boolean; menu?: boolean } = {}): string {
  return [
    styles.iconBtn,
    on ? styles.iconBtnOn : "",
    on && danger ? styles.iconBtnDanger : "",
    menu ? styles.hdrMenuItem : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The label a collapsed chip spells out in the ⋯ menu; nothing inline. */
function MenuLabel({ menu, children }: { menu: boolean; children: string }) {
  return menu ? <span className={styles.hdrMenuLabel}>{children}</span> : null;
}

/**
 * Which of a row's controls fold into the ⋯ overflow, measured (#375).
 *
 * `wide` never collapses: the desktop row is what it has always been, by
 * construction rather than by arithmetic that happens to agree. `phone`
 * collapses everything — MP1 spec §3 keeps exactly two chips there, the inbox
 * and search, and that is a design floor rather than a fitting result (a
 * 390px row can *hold* five 30px chips; it should not be asked to). `compact`
 * is the range where the measurement genuinely decides, and where measuring
 * beats the window width it replaced: the rail hides (#346) and both columns
 * are drag-resizable (#292), so the same window gives this row anywhere from
 * ~460 to ~760 pixels.
 */
function useHeaderCollapse(
  rowRef: RefObject<HTMLElement | null>,
  present: readonly HeaderControlId[],
): ReadonlySet<HeaderControlId> {
  const layout = useLayoutMode();
  const width = useRowWidth(rowRef);
  if (layout === "wide" || width === undefined) {
    return EMPTY_COLLAPSE;
  }
  if (layout === "phone") {
    return new Set(present);
  }
  return new Set(collapsedHeaderControls(width, present));
}

const EMPTY_COLLAPSE: ReadonlySet<HeaderControlId> = new Set();

/**
 * The ⋯ slot, holding whatever the row could not keep. The collapsed controls
 * render as themselves inside it — same buttons, same labels, same keyboard
 * path — and any click in the menu closes it, the way a menu should.
 */
function HeaderOverflow({
  items,
  render,
}: {
  items: readonly HeaderControlId[];
  render: (id: HeaderControlId, menu: boolean) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<CardAnchor>();
  const trigger = useRef<HTMLButtonElement>(null);

  /** Close, and hand focus back to the ⋯ button. A menu that lets focus fall
   * to the body strands keyboard users mid-row — and it is what makes the
   * overlays a menu row can open (the member list, the profile panel) return
   * focus here when they close: they capture the opener at mount, and the ⋯
   * button is the one element in this path that outlives the click. */
  function close() {
    setAnchor(undefined);
    trigger.current?.focus();
  }

  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={chipClass({ on: anchor !== undefined })}
        aria-label="More conversation actions"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        title="More conversation actions"
        onClick={(event) => {
          const at = anchorOf(event.currentTarget);
          setAnchor((open) => (open ? undefined : at));
        }}
      >
        ⋯
      </button>
      {anchor && (
        <ToolbarPopover
          anchor={anchor}
          label="More conversation actions"
          onClose={close}
        >
          <div className={styles.hdrMenu} onClick={close}>
            {items.map((id) => render(id, true))}
          </div>
        </ToolbarPopover>
      )}
    </>
  );
}

/** A read-out rather than an action — the topic and the clock, once they have
 * folded. Clicking inside one is not a menu choice, so it doesn't close it. */
function HeaderNote({ children }: { children: ReactNode }) {
  return (
    <div
      className={styles.hdrMenuNote}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

/**
 * The phone stack's back affordance (#375): leading chip on the conversation
 * toolbar, the one row that is always on screen while a conversation is open.
 *
 * A <Link> to the identity path, not a `history.back()`: the visible pane is a
 * function of the route, so "back to the list" genuinely IS that navigation —
 * and a link still works when the conversation was reached by a deep link or a
 * notification, where there is no history entry to pop. AppShell only supplies
 * a target while the shell is stacked, so on compact and wide this renders
 * nothing rather than a chip that would go nowhere useful.
 */
function HeaderBack({ to }: { to: string }) {
  return (
    <Link
      className={`${styles.iconBtn} ${styles.headerBack ?? ""}`}
      to={to}
      aria-label="Back to conversations"
      title="Back to conversations"
    >
      <BackGlyph />
    </Link>
  );
}

/**
 * The gateway's connection state, on the one pane that cannot see the
 * sidebar's copy of it (MP3 §5, #377).
 *
 * The sidebar head has carried "Offline / Connecting…, tap to retry" since
 * #465, and on every tier with two panes on screen that is enough. The phone
 * stack is the exception: `data-pane="conversation"` hides the sidebar
 * outright, so a conversation is exactly where the chip is not — and installed
 * to a home screen there is no address bar to reload from either, which leaves
 * a stale conversation with no way out but the OS app switcher. So the
 * conversation toolbar carries its own copy, rendered on the same condition
 * the back chip is (AppShell passes `backTo` only while stacked) and doing the
 * same thing on tap.
 *
 * Not in header-toolbar.ts's width model, deliberately and for the same reason
 * the back chip is not: both are phone-stack-only, and this one is also
 * transient — budgeting a permanent ~66px for a state that is normally absent
 * would collapse a control out of every healthy row to make room for nothing.
 * While it is up the conversation name gives way instead, which is the right
 * order of importance for a tab showing stale everything.
 */
function HeaderConnState() {
  const gatewayStatus = useUiStore((s) => s.gatewayStatus);
  if (gatewayStatus === "online") {
    return null;
  }
  return (
    <button
      type="button"
      className={`${styles.headerConn} ${
        gatewayStatus === "offline" ? (styles.headerConnOffline ?? "") : ""
      }`}
      title="Reconnect now"
      aria-label="Reconnect now"
      onClick={() => {
        gateway.reconnectNow();
      }}
    >
      {gatewayStatus === "offline" ? "Offline" : "Connecting…"}
    </button>
  );
}

/**
 * The topic slot — a channel's CDS description or a DM partner's status, set
 * inline beside the name and clipped to the row. The inline copy is inert:
 * BBCode topics carry links, `[user]` chips and eicons that are unusable at
 * one truncated line, so clicking the slot opens the same content live in a
 * popover (this replaces the old second row's Show more / Show less).
 */
function HeaderTopic({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // On the shared Escape stack as an overlay (#442), so an armed ambient
  // action — MessageLog's "mark caught up" — cannot steal the first press.
  useEscapeToClose(() => {
    setOpen(false);
  }, open);

  function activate(event: ReactKeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((value) => !value);
    }
  }

  return (
    <span className={styles.topicSlot}>
      {/* A span, not a <button>: RichText renders its own buttons (link
          chips, #channel, [user]) and nesting those is invalid HTML — the
          SearchPanel hit rows solve it the same way. */}
      <span
        role="button"
        tabIndex={0}
        className={styles.topic}
        aria-label={`${label} — show in full`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={activate}
      >
        <span className={styles.topicInline} inert>
          {children}
        </span>
      </span>
      {open && (
        <>
          <div
            className={styles.topicOverlay}
            onClick={() => {
              setOpen(false);
            }}
          />
          <div
            className={styles.topicPopover}
            data-eb-surface
            role="dialog"
            aria-label={label}
          >
            {children}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The inline search field (COMPONENTS.md §5), wearing the sidebar filter's
 * pill so the app has one search shape. One input for one search: the field
 * owns the query, the panel below it is the result list. Focusing the field
 * opens the panel; the header is keyed per conversation, so leaving one
 * closes its search.
 */
function HeaderSearch({
  identityId,
  convId,
}: {
  identityId: string;
  convId: string;
}) {
  const open = useUiStore((s) => s.searchOpen);
  const session = useSessionsStore((s) => s.sessions[identityId]);
  const [query, setQuery] = useState("");
  const search = useLogSearch(identityId, convId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      useUiStore.getState().setSearchOpen(false);
    },
    [],
  );

  return (
    <div className={styles.searchAnchor}>
      <form
        className={styles.searchField}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search.submit(query);
        }}
        // Collapsed to a magnifier on narrow windows the input has no width
        // of its own, so the pill has to hand focus over.
        onClick={() => {
          inputRef.current?.focus();
        }}
      >
        <SearchGlyph />
        <input
          ref={inputRef}
          className={styles.searchFieldInput}
          value={query}
          placeholder="Search log"
          aria-label="Search log"
          title={
            'Search this conversation — filters: from:"Name", before:/after:YYYY-MM-DD'
          }
          onFocus={() => {
            useUiStore.getState().setSearchOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </form>
      {open && session !== undefined && (
        <SearchPanel
          session={session}
          convId={convId}
          search={search}
          onClose={() => {
            useUiStore.getState().setSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * DM ignore toggle (M3). Ignoring is server-stored (IGN) and render-side
 * here: history keeps the messages, the log hides them. State follows the
 * `ignore.updated` fan-out, so no optimistic flip is needed.
 */
function IgnoreChip({
  identityId,
  character,
  menu,
}: {
  identityId: string;
  character: string;
  menu: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const ignored = useSessionsStore((s) =>
    (s.sessions[identityId]?.ignores ?? []).some(
      (name) => name.toLowerCase() === character.toLowerCase(),
    ),
  );

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: ignored ? "ignore.remove" : "ignore.add",
        d: { character },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            ack.error ?? "Could not update the ignore list",
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={chipClass({ on: ignored, danger: true, menu })}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      aria-pressed={ignored}
      aria-label={ignored ? "Unignore" : "Ignore"}
      title={
        ignored
          ? "Unignore — show their messages again"
          : "Ignore — hide their messages (history is kept)"
      }
    >
      <BanGlyph />
      <MenuLabel menu={menu}>{ignored ? "Unignore" : "Ignore"}</MenuLabel>
    </button>
  );
}

/**
 * Per-conversation mute (M5 step 8, decisions.md §10): silences the alert
 * layer — chime, title flash, desktop notifications — while badges and
 * mention tint keep accruing. Stored in the synced prefs document; the
 * Notifications pane lists and clears these.
 */
function MuteChip({
  identityId,
  convId,
  menu,
}: {
  identityId: string;
  convId: string;
  menu: boolean;
}) {
  const mutedConvIds = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs.mutedConvIds ?? EMPTY_MUTES,
  );
  const muted = mutedConvIds.includes(convId);

  return (
    <button
      type="button"
      className={chipClass({ on: muted, menu })}
      onClick={() => {
        // The prefs schema caps the list at 500; without this check the
        // patch is rejected server-side and the chip silently flips back
        // (M5 audit backlog) — say why instead.
        if (!muted && mutedConvIds.length >= 500) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              "Mute limit reached (500 conversations) — unmute some in Preferences → Notifications first.",
            );
          return;
        }
        void patchPrefs(identityId, {
          mutedConvIds: muted
            ? mutedConvIds.filter((entry) => entry !== convId)
            : [...mutedConvIds, convId],
        });
      }}
      aria-pressed={muted}
      aria-label={muted ? "Unmute conversation" : "Mute conversation"}
      title={
        muted
          ? "Unmute — sounds and notifications again"
          : "Mute — no sounds or notifications (badges still count)"
      }
    >
      {muted ? <BellOffGlyph /> : <BellGlyph />}
      <MenuLabel menu={menu}>{muted ? "Unmute" : "Mute"}</MenuLabel>
    </button>
  );
}

const EMPTY_MUTES = PREFS_DEFAULTS.mutedConvIds;

/**
 * COMPONENTS.md §5 pin chip: pinned channels are what an explicit reconnect
 * rejoins (decisions.md §9), pinned DMs surface under the sidebar's Pinned
 * section.
 */
function PinChip({
  identityId,
  convId,
  pinned,
  menu,
}: {
  identityId: string;
  convId: string;
  pinned: boolean;
  menu: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "conv.pin",
        d: { convId, pinned: !pinned },
      });
      // The update also fans out as conversation.updated; applying the ack
      // just makes this tab instant.
      if (ack.ok && ack.conversation) {
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
      } else if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(identityId, "error", ack.error ?? "Could not pin");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={chipClass({ on: pinned, menu })}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin" : "Pin"}
      title={pinned ? "Unpin — stop auto-rejoining" : "Pin — rejoin on connect"}
    >
      <PinGlyph />
      <MenuLabel menu={menu}>{pinned ? "Unpin" : "Pin"}</MenuLabel>
    </button>
  );
}

/**
 * Room management for op+ viewers. The chip opens the room-settings window
 * (RoomSettingsWindow): invites and public/private (private rooms only —
 * RST/CIU have no meaning on official channels), plus the op tooling that
 * works everywhere: room mode (RMO), description (CDS), and the banlist
 * (CBL). F-Chat reports no open/closed state, so the window offers both
 * visibility actions and echoes the server's SYS response.
 *
 * The window itself is mounted by ChannelHeader rather than by this chip: the
 * chip may be living inside the ⋯ overflow, which closes on the click that
 * opened the window and would take the window down with it.
 */
function RoomChip({ menu, onOpen }: { menu: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={chipClass({ menu })}
      onClick={onOpen}
      aria-label="Room settings"
      title="Room settings — invites, visibility, bans"
    >
      <GearGlyph />
      <MenuLabel menu={menu}>Room settings</MenuLabel>
    </button>
  );
}

/** A quiet pill on channels the running campaign posts into (M11 CM-F).
 * Subtle, never a banner; clicking opens the campaign status surface. */
function CampaignChip({
  identityId,
  channelKey,
}: {
  identityId: string;
  channelKey: string;
}) {
  const campaign = useSessionsStore(
    (s) => s.sessions[identityId]?.campaign ?? null,
  );
  // The clock ticks so the chip disappears when the hour runs out even
  // if the user never leaves the channel (audit HIGH: natural expiry
  // never sets stoppedAt).
  const [now, setNow] = useState(() => Date.now());
  const running =
    campaign !== null &&
    campaign.stoppedAt === undefined &&
    now < campaign.expiresAt;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  const posting =
    running &&
    campaign.channels.some(
      (c) =>
        c.key.toLowerCase() === channelKey.toLowerCase() &&
        c.state !== "removed",
    );
  if (!posting) {
    return null;
  }
  return (
    <button
      type="button"
      className={styles.campaignChip}
      title="A campaign posts ads here on its own — open its status"
      onClick={() => {
        useUiStore.getState().setCampaignOpen(true);
      }}
    >
      <span className={styles.campaignChipDot} aria-hidden />
      Campaign
    </button>
  );
}

export function ChannelHeader({
  identityId,
  channel,
  backTo,
}: {
  identityId: string;
  channel: ChannelView;
  /** Where the phone stack's back chip goes; absent on compact and wide. */
  backTo?: string;
}) {
  // The member-list toggle drives whichever member list this tier has: the
  // docked column's persisted preference, or — on the single-pane stack, where
  // there is no column to dock into — the transient open state of the
  // full-height overlay (#375, package D). The same split DmHeader's
  // profile-panel chip has made since #170.
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const toggleMembersDrawer = useUiStore((s) => s.toggleMembersDrawer);
  const membersOpen = useUiStore((s) => s.membersOpen);
  const membersDrawerOpen = useUiStore((s) => s.membersDrawerOpen);
  // The single-pane stack (#375) — the tier, not the route, so this is the
  // shell's shape rather than which pane is showing.
  const stacked = useLayoutMode() === "phone";
  const membersShown = stacked ? membersDrawerOpen : membersOpen;
  const ownCharacter = useSessionsStore(
    (s) => s.sessions[identityId]?.character ?? "",
  );
  const chatop = useSessionsStore(
    (s) => s.sessions[identityId]?.chatop ?? false,
  );
  const description = channel.description.trim();
  // Room management is an op+ affair (the commands are chanop-restricted
  // wire-side; the UI simply doesn't offer them to others). Chatops manage
  // any channel; the private-room actions (invite, open/close) only render
  // for ADH rooms.
  const canManageRoom =
    roleFor(ownCharacter, channel.oplist) !== null || chatop;
  const [roomOpen, setRoomOpen] = useState(false);

  // Room titles are wire text the server entity-escapes (#350); decode for the
  // plain-text header + chip tooltip. The description goes through RichText,
  // which decodes on its own path — so it is left untouched here.
  const title = decodeWireEntities(channel.title);

  const rowRef = useRef<HTMLElement>(null);
  const present: HeaderControlId[] = [
    ...(description === "" ? [] : (["topic"] as const)),
    "pin",
    "mute",
    ...(canManageRoom ? (["room"] as const) : []),
    "members",
  ];
  const collapsed = useHeaderCollapse(rowRef, present);
  const inline = (id: HeaderControlId) =>
    present.includes(id) && !collapsed.has(id);

  /** One control, rendered inline in the row or as a row of the ⋯ menu. */
  function control(id: HeaderControlId, menu: boolean): ReactNode {
    switch (id) {
      case "topic":
        return menu ? (
          <HeaderNote key={id}>
            <RichText bbcode={description} />
          </HeaderNote>
        ) : (
          <Fragment key={id}>
            <span className={styles.headerHairline} aria-hidden />
            <HeaderTopic label={`#${title} description`}>
              <RichText bbcode={description} />
            </HeaderTopic>
          </Fragment>
        );
      case "pin":
        return (
          <PinChip
            key={id}
            identityId={identityId}
            convId={channel.convId}
            pinned={channel.pinned}
            menu={menu}
          />
        );
      case "mute":
        return (
          <MuteChip
            key={id}
            identityId={identityId}
            convId={channel.convId}
            menu={menu}
          />
        );
      case "room":
        return (
          <RoomChip
            key={id}
            menu={menu}
            onOpen={() => {
              setRoomOpen(true);
            }}
          />
        );
      case "members":
        return (
          <button
            key={id}
            type="button"
            className={chipClass({ on: membersShown, menu })}
            onClick={stacked ? toggleMembersDrawer : toggleMembers}
            aria-pressed={membersShown}
            aria-label="Toggle member list"
            title="Toggle member list"
          >
            <MembersGlyph />
            <MenuLabel menu={menu}>Member list</MenuLabel>
            <span className={styles.headerCount}>{channel.members.length}</span>
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <header ref={rowRef} className={styles.header}>
      {backTo !== undefined && (
        <>
          <HeaderBack to={backTo} />
          <HeaderConnState />
        </>
      )}
      <div className={styles.headerIdentity}>
        <span className={styles.headerGlyph} aria-hidden>
          #
        </span>
        <h1 className={styles.headerTitle}>{title}</h1>
        {inline("topic") && control("topic", false)}
      </div>
      <CampaignChip identityId={identityId} channelKey={channel.key} />
      {(inline("pin") || inline("mute") || inline("room")) && (
        <div className={styles.headerCluster}>
          {inline("pin") && control("pin", false)}
          {inline("mute") && control("mute", false)}
          {inline("room") && control("room", false)}
        </div>
      )}
      {inline("members") && (
        <>
          <span className={styles.tbDivider} aria-hidden />
          {control("members", false)}
        </>
      )}
      <HeaderOverflow
        items={present.filter((id) => collapsed.has(id))}
        render={control}
      />
      {/* The notification inbox (#467) is per identity, not per conversation
          — it rides the right-hand cluster beside search because that is the
          one row always on screen while a conversation is open. Neither it nor
          search ever collapses (spec §3). */}
      <InboxChip identityId={identityId} />
      {/* Search sits last, flush to the app's right edge — the toolbar now
          spans the member column, so this is where a search box belongs. */}
      <HeaderSearch identityId={identityId} convId={channel.convId} />
      {roomOpen && (
        <RoomSettingsWindow
          identityId={identityId}
          channelKey={channel.key}
          convId={channel.convId}
          title={title}
          isPrivateRoom={channel.key.startsWith("ADH-")}
          mode={channel.mode}
          description={channel.description}
          onClose={() => {
            setRoomOpen(false);
          }}
        />
      )}
    </header>
  );
}

export function DmHeader({
  identityId,
  dm,
  backTo,
}: {
  identityId: string;
  dm: DmView;
  /** Where the phone stack's back chip goes; absent on compact and wide. */
  backTo?: string;
}) {
  const dot = presenceDot(dm.online, dm.status);
  const navigate = useNavigate();
  const ownCharacter = useSessionsStore(
    (s) => s.sessions[identityId]?.character ?? "",
  );
  // DM profile-sidebar toggle (#170): same header slot as the channel's
  // member-list button. On the wide layout it flips the persisted grid-column
  // pref; on narrow windows it opens/closes the overlay drawer.
  const narrow = useIsNarrow();
  const dmSidebarOpen = useUiStore((s) => s.dmSidebarOpen);
  const dmDrawerOpen = useUiStore((s) => s.dmDrawerOpen);
  const sidebarOn = narrow ? dmDrawerOpen : dmSidebarOpen;
  const [closing, setClosing] = useState(false);
  // The partner's identity menu (#167) — the same menu a member-list row
  // opens, anchored under the ⋮ button.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  // Their local clock rides the cached profile (user-set zone first, else the
  // profile's own UTC offset). Read-only: the DM sidebar owns the fetch, so a
  // collapsed sidebar simply means no clock rather than a background request
  // — and a profile view the user never asked for.
  const response = useProfileStore(
    (s) => s.profiles[dm.partner.toLowerCase()]?.response,
  );
  const clock = localClock(
    useMinuteClock(),
    response?.timezone,
    response?.profile.timezone,
  );

  // Close the DM window (gateway pm.close): history is kept and the
  // conversation reopens on the next pm.open or inbound message; only the
  // sidebar row and this window go away. Navigate first — the fan-out
  // removes the row from the store, which would strand this route.
  async function close() {
    if (closing) {
      return;
    }
    setClosing(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "pm.close",
        d: { convId: dm.convId },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            ack.error ?? "Could not close the conversation",
          );
        return;
      }
      void navigate(identityPath(ownCharacter));
      if (ack.conversation) {
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
      }
    } finally {
      setClosing(false);
    }
  }

  const status = dm.online ? dm.status : "offline";
  // The DM partner is never you, so `showOthersStatus` applies unconditionally
  // (#585). The presence word stays — it is not a message they wrote.
  const showStatus = useUserPrefs().showOthersStatus;
  const hasTopic = (dm.statusmsg !== "" && showStatus) || dm.status !== "";

  const rowRef = useRef<HTMLElement>(null);
  const present: HeaderControlId[] = [
    ...(hasTopic ? (["topic"] as const) : []),
    ...(clock ? (["clock"] as const) : []),
    "pin",
    "mute",
    "ignore",
    "panel",
    "actions",
    "close",
  ];
  const collapsed = useHeaderCollapse(rowRef, present);
  const inline = (id: HeaderControlId) =>
    present.includes(id) && !collapsed.has(id);

  /** One control, rendered inline in the row or as a row of the ⋯ menu. */
  function control(id: HeaderControlId, menu: boolean): ReactNode {
    switch (id) {
      case "topic": {
        const body = (
          <>
            <span className={styles.topicStatus}>{status}</span>
            {dm.online && dm.statusmsg && showStatus ? (
              <>
                {" — "}
                <RichText bbcode={dm.statusmsg} />
              </>
            ) : null}
          </>
        );
        return menu ? (
          <HeaderNote key={id}>{body}</HeaderNote>
        ) : (
          <Fragment key={id}>
            <span className={styles.headerHairline} aria-hidden />
            <HeaderTopic label={`${dm.partner} — status`}>{body}</HeaderTopic>
          </Fragment>
        );
      }
      case "clock":
        // Their local time (#439) sits outside the topic slot on purpose: it
        // is a two-glance fact, and inside the slot it would be the first
        // thing an overlong status truncated away.
        return clock ? (
          <span
            key={id}
            className={menu ? styles.hdrMenuClock : styles.headerClock}
            title={clockTitle(clock, dm.partner)}
          >
            <ClockGlyph />
            {clock.time}
            {menu && ` — ${dm.partner}'s local time`}
          </span>
        ) : null;
      case "pin":
        return (
          <PinChip
            key={id}
            identityId={identityId}
            convId={dm.convId}
            pinned={dm.pinned}
            menu={menu}
          />
        );
      case "mute":
        return (
          <MuteChip
            key={id}
            identityId={identityId}
            convId={dm.convId}
            menu={menu}
          />
        );
      case "ignore":
        return (
          <IgnoreChip
            key={id}
            identityId={identityId}
            character={dm.partner}
            menu={menu}
          />
        );
      case "panel":
        return (
          <button
            key={id}
            type="button"
            className={chipClass({ on: sidebarOn, menu })}
            title={
              sidebarOn ? "Hide the profile panel" : "Show the profile panel"
            }
            aria-label="Toggle profile panel"
            aria-pressed={sidebarOn}
            onClick={() => {
              if (narrow) {
                useUiStore.getState().toggleDmDrawer();
              } else {
                useUiStore.getState().toggleDmSidebar();
              }
            }}
          >
            <PanelRightGlyph />
            <MenuLabel menu={menu}>Profile panel</MenuLabel>
          </button>
        );
      case "actions":
        return (
          <button
            key={id}
            type="button"
            className={chipClass({ menu })}
            title={`Actions for ${dm.partner}`}
            aria-label={`Actions for ${dm.partner}`}
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreGlyph />
            <MenuLabel menu={menu}>{`Actions for ${dm.partner}`}</MenuLabel>
          </button>
        );
      case "close":
        return (
          <button
            key={id}
            type="button"
            className={chipClass({ menu })}
            title="Close this conversation — history is kept"
            aria-label={`Close conversation with ${dm.partner}`}
            disabled={closing}
            onClick={() => {
              void close();
            }}
          >
            <CloseGlyph />
            <MenuLabel menu={menu}>Close conversation</MenuLabel>
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <header ref={rowRef} className={styles.header}>
      {backTo !== undefined && (
        <>
          <HeaderBack to={backTo} />
          <HeaderConnState />
        </>
      )}
      <div className={styles.headerIdentity}>
        <span
          className={styles.headerDot}
          aria-hidden
          style={{
            background:
              dot === "ok"
                ? "var(--eb-ok)"
                : dot === "warn"
                  ? "var(--eb-warn)"
                  : "var(--eb-faint)",
          }}
        />
        <h1 className={styles.headerTitle}>{dm.partner}</h1>
        {inline("topic") && control("topic", false)}
        {inline("clock") && control("clock", false)}
      </div>
      {/* Typing status moved onto the message bar (#336) — see the composer's
          typingLine. Showing it here too would duplicate the same info. */}
      {(inline("pin") || inline("mute") || inline("ignore")) && (
        <div className={styles.headerCluster}>
          {inline("pin") && control("pin", false)}
          {inline("mute") && control("mute", false)}
          {inline("ignore") && control("ignore", false)}
        </div>
      )}
      {(inline("panel") || inline("actions") || inline("close")) && (
        <span className={styles.tbDivider} aria-hidden />
      )}
      {inline("panel") && control("panel", false)}
      {inline("actions") && control("actions", false)}
      {inline("close") && control("close", false)}
      <HeaderOverflow
        items={present.filter((id) => collapsed.has(id))}
        render={control}
      />
      <InboxChip identityId={identityId} />
      {/* Search sits last, flush to the app's right edge — the toolbar now
          spans the profile column, so this is where a search box belongs. */}
      <HeaderSearch identityId={identityId} convId={dm.convId} />
      {menuAt && (
        <MemberContextMenu
          identityId={identityId}
          ownCharacter={ownCharacter}
          channelTitle={`Conversation with ${dm.partner}`}
          member={{
            character: dm.partner,
            gender: "",
            status: dm.status,
            statusmsg: dm.statusmsg,
          }}
          position={menuAt}
          onClose={() => {
            setMenuAt(undefined);
          }}
        />
      )}
    </header>
  );
}
