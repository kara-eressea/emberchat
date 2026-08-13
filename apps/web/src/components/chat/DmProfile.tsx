// DmProfile (COMPONENTS-dm-sidebar.md): the persistent right-hand DM sidebar.
// Occupies the same shell slot as the channel MemberList — while a DM is open,
// the partner's identity (avatar, presence, BBCode status), the private note,
// quick actions, and a compact compatibility summary live beside the
// conversation instead of only behind a click.
//
// Every piece reuses an existing primitive verbatim: Avatar, RichText, the
// shared PrivateNote, and the MatchTier pill/chip/pie. This component only
// places them; it forks nothing.

import { useEffect, useMemo } from "react";
import { match, type MatchReport } from "@emberchat/matcher";
import { wireToPlainText } from "../../lib/wire-text.js";
import { api } from "../../lib/api.js";
import { presenceDot, type DotKind } from "../../lib/presence.js";
import { clockTitle, localClock } from "../../lib/local-time.js";
import { loadSocial } from "../../lib/social.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useMinuteClock } from "../../lib/clock.js";
import { useNameColor } from "../../lib/name-color.js";
import {
  loadOwnProfile,
  loadProfile,
  useProfileStore,
} from "../../stores/profile.js";
import {
  useSessionsStore,
  useUserPrefs,
  type DmView,
} from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { PrivateNote } from "../profile/PrivateNote.js";
import { DimChip, MatchPill, TierPie } from "../profile/MatchTier.js";
import { notableDimensions } from "../profile/match-utils.js";
import { RichText } from "./RichText.js";
import styles from "./dm-sidebar.module.css";
import profileStyles from "../profile/profile.module.css";

const DOT_CLASS: Record<DotKind, string> = {
  ok: styles.dotOk ?? "",
  warn: styles.dotWarn ?? "",
  faint: styles.dotFaint ?? "",
};
const MINI_DOT_CLASS: Record<DotKind, string> = {
  ok: styles.presenceOk ?? "",
  warn: styles.presenceWarn ?? "",
  faint: styles.presenceFaint ?? "",
};
const PRESENCE_LABEL: Record<DotKind, string> = {
  ok: "Online",
  warn: "Idle",
  faint: "Offline",
};

export function DmProfile({
  identityId,
  ownCharacter,
  dm,
  overlay = false,
  onCollapse,
}: {
  identityId: string;
  ownCharacter: string;
  dm: DmView;
  /** Rendered as a right-edge overlay drawer (narrow windows) rather than a
   * grid column. */
  overlay?: boolean;
  onCollapse: () => void;
}) {
  const partner = dm.partner;
  const loaded = useProfileStore((s) => s.profiles[partner.toLowerCase()]);
  const ownProfile = useProfileStore((s) => s.ownProfile?.profile);
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);

  useEffect(() => {
    void loadProfile(identityId, partner);
    void loadSocial(identityId);
    void loadOwnProfile(identityId, ownCharacter);
  }, [identityId, partner, ownCharacter]);

  // Dismiss the overlay drawer on Escape (click-away is the backdrop). Only
  // the overlay drawer claims Escape; the docked panel leaves it alone.
  // "ambient": the drawer is part of the layout rather than something the
  // user just opened, and its gating flips with the viewport — a popover on
  // top of it must still get Escape first.
  useEscapeToClose(onCollapse, overlay, "ambient");

  const response = loaded?.response;
  const note = response?.note ?? null;
  const lower = partner.toLowerCase();
  const isFriend =
    social?.friends.some((row) => row.name.toLowerCase() === lower) ?? false;
  const isBookmarked =
    social?.bookmarks.some((row) => row.name.toLowerCase() === lower) ?? false;

  const dot = presenceDot(dm.online, dm.status);
  // The partner's name wears the chat's gender colour (#493), so the sidebar
  // head and their nick in the log beside it always agree.
  const accent = useNameColor(identityId, partner, response?.profile);
  // The DM partner is never you, so `showOthersStatus` applies
  // unconditionally here (#585).
  const showStatus = useUserPrefs().showOthersStatus;
  const status = dm.online && showStatus ? dm.statusmsg : "";
  // Their wall clock, from the zone the user set for them or F-List's offset
  // (see lib/local-time.ts). Ticks off the one shared minute timer.
  const clock = localClock(
    useMinuteClock(),
    response?.timezone,
    response?.profile.timezone,
  );

  const report: MatchReport | undefined = useMemo(
    () =>
      ownProfile && response ? match(ownProfile, response.profile) : undefined,
    [ownProfile, response],
  );

  const aside = (
    <aside
      className={`${styles.dmProfile} ${overlay ? (styles.overlay ?? "") : ""}`}
      aria-label={`Profile: ${partner}`}
      style={
        accent === undefined
          ? undefined
          : ({ "--gender-accent": accent } as React.CSSProperties)
      }
    >
      {/* Docked, the conversation toolbar spans this column and carries the
          panel toggle — a "Profile »" head under it would just repeat both.
          The narrow drawer is a fixed overlay *over* that toolbar, so it
          keeps its own label and its own way out. */}
      {overlay && (
        <div className={styles.header}>
          <span className={profileStyles.groupLabel}>Profile</span>
          <button
            type="button"
            className={styles.collapse}
            title="Hide the profile panel"
            aria-label="Hide the profile panel"
            onClick={onCollapse}
          >
            »
          </button>
        </div>
      )}

      <div className={styles.body}>
        {/* ── Hero ── */}
        <div className={styles.hero}>
          <span className={styles.avatarWrap}>
            <Avatar name={partner} size={76} square />
            <span
              className={`${styles.heroDot} ${DOT_CLASS[dot]}`}
              aria-hidden
            />
          </span>
          <span className={styles.nameRow}>
            <span className={styles.heroName}>{partner}</span>
            {isFriend && (
              <span
                className={`${profileStyles.badge} ${profileStyles.badgeFriend}`}
                title="Friend"
              >
                ★
              </span>
            )}
            {isBookmarked && (
              <span
                className={`${profileStyles.badge} ${profileStyles.badgeBookmarkOn}`}
                title="Bookmarked"
              >
                ⚑
              </span>
            )}
          </span>
          <span className={`${styles.presenceLine} ${MINI_DOT_CLASS[dot]}`}>
            <span
              className={styles.presenceMini}
              style={{ background: "currentColor" }}
              aria-hidden
            />
            {PRESENCE_LABEL[dot]}
          </span>
          {clock && (
            // Its own line: the column is narrow enough that appending to the
            // presence line wraps mid-clock.
            <span
              className={styles.localTime}
              title={clockTitle(clock, partner)}
            >
              Local time {clock.time}
            </span>
          )}
          {status && (
            <div className={styles.heroStatus} title={wireToPlainText(status)}>
              <RichText bbcode={status} />
            </div>
          )}
        </div>

        {/* ── Actions ── */}
        <div className={styles.section}>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                useProfileStore.getState().open(partner);
              }}
            >
              Open full profile
            </button>
            <div className={styles.btnRow}>
              <BookmarkButton
                identityId={identityId}
                name={partner}
                bookmarked={isBookmarked}
              />
              <a
                className={styles.ghost}
                href={`https://www.f-list.net/c/${encodeURIComponent(partner)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                F-List page ↗
              </a>
            </div>
          </div>
        </div>

        {/* ── PrivateNote ── */}
        <div className={styles.section}>
          <div className={styles.noteHead}>
            <span className={profileStyles.groupLabel}>Private note</span>
          </div>
          {response ? (
            <PrivateNote
              identityId={identityId}
              name={partner}
              initial={note}
              fullWidth
              escapeCollapses
            />
          ) : (
            <span className={styles.noMatch}>Loading…</span>
          )}
        </div>

        {/* ── MatchSummary ── */}
        <div className={styles.section}>
          <div className={styles.matchHead}>
            <span className={profileStyles.groupLabel}>
              Compatibility with you
            </span>
            {report && (
              <button
                type="button"
                className={profileStyles.fullCompare}
                onClick={() => {
                  useProfileStore.getState().open(partner);
                  useProfileStore.getState().setTab("compare");
                }}
              >
                Full compare →
              </button>
            )}
          </div>
          {report ? (
            <div className={styles.matchRow}>
              <MatchPill tier={report.overall} />
              {notableDimensions(report, 2).map((dimension) => (
                <DimChip
                  key={dimension.label}
                  label={dimension.label}
                  tier={dimension.tier}
                  title={dimension.reason}
                />
              ))}
            </div>
          ) : (
            <div className={styles.noMatch}>
              <TierPie tier="neutral" size={13} />
              Connect your own character to see how you two line up.
            </div>
          )}
        </div>
      </div>
    </aside>
  );

  if (overlay) {
    return (
      <>
        <div className={styles.backdrop} onClick={onCollapse} aria-hidden />
        {aside}
      </>
    );
  }
  return aside;
}

/** Bookmark toggle ghost — optimistic flip, then refresh the social lists as
 * the source of truth (the same pathway the profile viewer header uses). */
function BookmarkButton({
  identityId,
  name,
  bookmarked,
}: {
  identityId: string;
  name: string;
  bookmarked: boolean;
}) {
  function toggle() {
    const next = !bookmarked;
    void api
      .postBookmark(identityId, next ? "add" : "remove", name)
      .then(() => loadSocial(identityId, true))
      .catch((error: unknown) => {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            error instanceof Error ? error.message : "Couldn't update bookmark",
          );
      });
  }

  return (
    <button
      type="button"
      className={`${styles.ghost} ${bookmarked ? (styles.ghostOn ?? "") : ""}`}
      aria-pressed={bookmarked}
      title={bookmarked ? "Remove bookmark" : "Bookmark this character"}
      onClick={toggle}
    >
      ⚑ {bookmarked ? "Bookmarked" : "Bookmark"}
    </button>
  );
}
