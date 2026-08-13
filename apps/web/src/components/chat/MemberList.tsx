// MemberList (COMPONENTS.md §9): grouped Owner · Admins · Online · Idle,
// plus the "Seen recently" offline group (#200) — previously-seen members of
// this channel who aren't present now, last in the same scroll, collapsed by
// default. Avatars are the real F-List images, lazy-loaded with the
// initial-on-color fallback (decisions.md §6). Rows are interactive:
// left-click opens the mini profile card (M8), right-click opens the
// MemberContextMenu — the f-list.net website link lives there. One filter
// query matches every group, offline included — over the nick and the
// profile facts a row already holds (#497), never a network lookup.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { MemberDto, SeenMemberDto } from "@emberchat/protocol";
import { presenceDot } from "../../lib/presence.js";
import { loadSocial } from "../../lib/social.js";
import { useLongPress, type PressEvent } from "../../lib/useLongPress.js";
import { openCardFrom } from "../../stores/profile.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import { genderColorVar } from "../../theme/tokens.js";
import { Avatar } from "../common/Avatar.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { groupMembers, nameSet } from "./member-sort.js";
import { MemberStatus } from "./MemberStatus.js";
import {
  isOfflineExpanded,
  matchesMemberFilter,
  offlineRows,
  relativeSeen,
  setOfflineExpanded,
} from "./offline-members.js";
import { roleFor, type ChannelRole } from "./member-roles.js";
import styles from "./chat.module.css";

const DOT_COLOR = {
  ok: "var(--eb-ok)",
  warn: "var(--eb-warn)",
  faint: "var(--eb-faint)",
} as const;

/** Rough pre-clamp so the menu doesn't flash off-screen for a frame; the
 * menu itself re-clamps against its measured size once rendered. */
const MENU_WIDTH = 216;

/** Shared cadence for recomputing visible relative times — one interval for
 * the whole list, never one per row (spec §5). */
const SEEN_TICK_MS = 60_000;

interface MenuState {
  member: MemberDto;
  role: ChannelRole;
  /** False for "Seen recently" targets: admin items act on a live channel
   * role the absent member doesn't hold, so they never render. */
  present: boolean;
  position: { x: number; y: number };
}

export function MemberList({
  identityId,
  ownCharacter,
  channel,
}: {
  identityId: string;
  ownCharacter: string;
  channel: ChannelView;
}) {
  const [menu, setMenu] = useState<MenuState>();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() =>
    isOfflineExpanded(channel.key),
  );
  const viewerChatop = useSessionsStore(
    (s) => s.sessions[identityId]?.chatop ?? false,
  );
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  const viewerRole = roleFor(ownCharacter, channel.oplist);

  // Switching channels restores that channel's remembered fold and starts
  // with a clean filter — adjusted during render (the React-endorsed
  // previous-state pattern), not in an effect.
  const [prevKey, setPrevKey] = useState(channel.key);
  if (prevKey !== channel.key) {
    setPrevKey(channel.key);
    setExpanded(isOfflineExpanded(channel.key));
    setQuery("");
  }

  // Friends/bookmarks drive the sort tiers (#178); lazily loaded, so ask once.
  useEffect(() => {
    void loadSocial(identityId);
  }, [identityId]);

  const searching = query.trim() !== "";
  // The global presence stream re-renders this list ~14×/sec (#355); the
  // grouped localeCompare sort over a large roster is the single largest JS
  // cost in the profile. Recompute the name sets and the sort only when their
  // inputs actually change, not on every unrelated render.
  const friends = useMemo(() => nameSet(social?.friends), [social?.friends]);
  const bookmarks = useMemo(
    () => nameSet(social?.bookmarks),
    [social?.bookmarks],
  );
  const groups = useMemo(
    () =>
      groupMembers({
        members: searching
          ? channel.members.filter((m) => matchesMemberFilter(m, query))
          : channel.members,
        oplist: channel.oplist,
        friends,
        bookmarks,
      }),
    [searching, channel.members, channel.oplist, friends, bookmarks, query],
  );

  // While a query is active the offline group auto-expands (spec §4);
  // clearing it restores the remembered per-channel state.
  const offlineOpen = searching || expanded;
  const offline = useMemo(
    () => (offlineOpen ? offlineRows(channel.seen, query) : []),
    [offlineOpen, channel.seen, query],
  );
  const offlineTotal = channel.seen.length;
  // While searching the group is always open, so the filtered rows above
  // are exactly the matches.
  const offlineMatches = searching ? offline.length : offlineTotal;

  // Relative times are computed at render from one shared tick — no
  // per-row timers (spec §5). The interval only runs while offline rows
  // are actually on screen.
  const [now, setNow] = useState(() => Date.now());
  const ticking = offlineOpen && offline.length > 0;
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, SEEN_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);

  function toggleOffline() {
    const next = !expanded;
    setExpanded(next);
    setOfflineExpanded(channel.key, next);
    // The rows about to appear must not carry a stale clock.
    if (next) {
      setNow(Date.now());
    }
  }

  // Stable so the memoized rows below don't see a fresh handler prop on every
  // render (#355) — setMenu is referentially stable, so this has no deps.
  const openMenu = useCallback(
    (
      event: PressEvent,
      member: MemberDto,
      role: ChannelRole,
      present: boolean,
    ) => {
      event.preventDefault();
      setMenu({
        member,
        role,
        present,
        position: {
          x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
          y: Math.min(event.clientY, window.innerHeight - 160),
        },
      });
    },
    [],
  );

  // No "Members N" head of its own: the conversation toolbar now spans this
  // column and carries the count on its member-list chip, so the filter is
  // the column's first row.
  return (
    <aside className={styles.members} aria-label="Members">
      <input
        className={styles.memberFilter}
        type="search"
        aria-label="Find members"
        // The placeholder is where the fields it searches are advertised
        // (#497) — a gender filter nobody knows about is no filter.
        placeholder="Name, gender, status"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // A query auto-expands the offline group — refresh the shared
          // clock so newly revealed rows don't carry a stale time.
          setNow(Date.now());
        }}
      />
      <div className={styles.membersScroll} role="list">
        {groups.map((group) => (
          <div key={group.key}>
            <div className={styles.memberGroup}>{group.label}</div>
            {group.members.map((member) => (
              <MemberRow
                key={member.character}
                member={member}
                role={group.role}
                self={
                  member.character.toLowerCase() === ownCharacter.toLowerCase()
                }
                onOpenMenu={openMenu}
              />
            ))}
          </div>
        ))}
        {/* The group materializes the first time a member parts — an empty
            labelled fold would read as broken (spec §6). */}
        {offlineTotal > 0 && (
          <div>
            <button
              type="button"
              className={styles.offlineHeader}
              aria-expanded={offlineOpen}
              onClick={toggleOffline}
            >
              <span
                className={`${styles.offlineChevron} ${offlineOpen ? (styles.offlineChevronOpen ?? "") : ""}`}
                aria-hidden
              >
                ▸
              </span>
              <span className={styles.offlineLabel}>Seen recently</span>
              <span className={styles.offlineCount}>
                {searching
                  ? `${String(offlineMatches)} of ${String(offlineTotal)}`
                  : offlineTotal}
              </span>
            </button>
            {offlineOpen &&
              offline.map((entry) => (
                <OfflineRow
                  key={entry.character}
                  member={entry}
                  now={now}
                  onOpenMenu={openMenu}
                />
              ))}
          </div>
        )}
      </div>
      {menu && (
        <MemberContextMenu
          identityId={identityId}
          ownCharacter={ownCharacter}
          channelKey={channel.key}
          channelTitle={channel.title}
          member={menu.member}
          role={menu.role}
          viewerRole={viewerRole}
          viewerChatop={viewerChatop}
          present={menu.present}
          position={menu.position}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
    </aside>
  );
}

/** Opening the menu needs only a point and the right to claim the event, so
 * the parameter is the shape both openers satisfy: a real `contextmenu`
 * MouseEvent, and the synthetic press a long-press produces (MP2 §1). */
type OpenMenu = (
  event: PressEvent,
  member: MemberDto,
  role: ChannelRole,
  present: boolean,
) => void;

// Memoized: with a stable `onOpenMenu` and store-preserved `member` identity
// (#355), a presence event that doesn't touch this member skips the row
// entirely — no re-render, and no re-parse of the status line (MemberStatus
// is memoized on the wire string for the same reason).
const MemberRow = memo(function MemberRow({
  member,
  role,
  self,
  onOpenMenu,
}: {
  member: MemberDto;
  role: ChannelRole;
  /** Your own row — `showOthersStatus` never hides your status (#585). */
  self: boolean;
  onOpenMenu: OpenMenu;
}) {
  const dot = presenceDot(true, member.status);
  // Gender tint is supplementary (#177): the name keeps AA contrast regardless,
  // so it stays fully readable without the colour.
  const genderColor = genderColorVar(member.gender);
  const press = useLongPress((event) => {
    onOpenMenu(event, member, role, true);
  });
  return (
    // Left-click = mini profile card anchored to the row (§13); right-click,
    // or a hold on a touchscreen, = menu.
    <button
      type="button"
      className={styles.memberRow}
      role="listitem"
      onClick={(event) => {
        openCardFrom(event.currentTarget, member.character);
      }}
      onContextMenu={(event) => {
        onOpenMenu(event, member, role, true);
      }}
      {...press}
    >
      <span className={styles.memberAvatar}>
        <Avatar name={member.character} size={30} />
        <span
          className={styles.memberDot}
          style={{ background: DOT_COLOR[dot] }}
          data-dot={dot}
        />
      </span>
      <span className={styles.memberBody}>
        <span className={styles.memberNickLine}>
          {role === "owner" && (
            <span className={`${styles.roleGlyph} ${styles.roleOwner ?? ""}`}>
              ~
            </span>
          )}
          {role === "op" && (
            <span className={`${styles.roleGlyph} ${styles.roleAdmin ?? ""}`}>
              @
            </span>
          )}
          <span
            className={`${styles.memberNick} ${role === null ? "" : (styles.op ?? "")}`}
            style={genderColor ? { color: genderColor } : undefined}
          >
            {member.character}
          </span>
        </span>
        {/* Status on a second line under the name (#217), in the restricted
            BBCode subset a row can carry (#494) — colours and line-height
            images, never the full message renderer. */}
        <MemberStatus statusmsg={member.statusmsg} self={self} />
      </span>
    </button>
  );
});

/**
 * "Seen recently" row (#200): MemberRow geometry, but the name keeps its
 * gender colour at full opacity and weight 400 (no role glyph — an absent
 * member holds no live role), only the avatar fades, the dot is decorative
 * `faint`, and the right-aligned meta is the relative last-seen time — the
 * name ellipsizes before the time ever truncates.
 */
const OfflineRow = memo(function OfflineRow({
  member,
  now,
  onOpenMenu,
}: {
  member: SeenMemberDto;
  now: number;
  onOpenMenu: OpenMenu;
}) {
  const genderColor = genderColorVar(member.gender);
  // An absent member holds no live role — always the null/false form.
  const openMenu = (event: PressEvent) => {
    onOpenMenu(
      event,
      {
        character: member.character,
        gender: member.gender,
        status: "",
        statusmsg: "",
      },
      null,
      false,
    );
  };
  const press = useLongPress(openMenu);
  return (
    <button
      type="button"
      className={styles.memberRow}
      role="listitem"
      onClick={(event) => {
        openCardFrom(event.currentTarget, member.character);
      }}
      onContextMenu={openMenu}
      {...press}
    >
      <span className={`${styles.memberAvatar} ${styles.offlineAvatar ?? ""}`}>
        <Avatar name={member.character} size={30} />
        <span
          className={styles.memberDot}
          style={{ background: DOT_COLOR.faint }}
          data-dot="faint"
        />
      </span>
      <span className={styles.memberBody}>
        <span className={styles.memberNickLine}>
          <span
            className={styles.memberNick}
            style={genderColor ? { color: genderColor } : undefined}
          >
            {member.character}
          </span>
        </span>
      </span>
      <span className={styles.seenTime}>
        {relativeSeen(member.lastSeen, now)}
      </span>
    </button>
  );
});
