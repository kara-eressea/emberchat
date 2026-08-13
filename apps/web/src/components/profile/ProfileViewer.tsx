// Full profile viewer (M8, COMPONENTS-profile-viewer.md §1–§8): 900×640
// modal — HistoryRail + header/tabs/content column. Step 7 ships Overview /
// Details / Kinks / Insights; Compare arrives with the matcher surfaces
// (step 9), Images/Guestbook with step 10.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { match } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { useNameColor } from "../../lib/name-color.js";
import { wireToPlainText } from "../../lib/wire-text.js";
import { loadSocial } from "../../lib/social.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useFocusTrap } from "../../lib/useFocusTrap.js";
import { useRailCollapsed } from "../../lib/rail-collapse.js";
import { api } from "../../lib/api.js";
import {
  persistViewerFullscreen,
  savedViewerFullscreen,
} from "../../lib/viewer-size.js";
import {
  loadActivity,
  loadHistory,
  loadInsights,
  loadOwnProfile,
  loadProfile,
  removeHistoryEntry,
  resetActivity,
  resetInsights,
  useProfileStore,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore, useUserPrefs } from "../../stores/sessions.js";
import { RichText } from "../chat/RichText.js";
import { Avatar } from "../common/Avatar.js";
import { CHOICES } from "./choices.js";
import {
  groupedChildren,
  kinkNameCatalog,
  type GroupedKink,
} from "./kink-groups.js";
import { ActivityHeatmap } from "./ActivityHeatmap.js";
import { CompareTab } from "./CompareTab.js";
import { PrivateNote } from "./PrivateNote.js";
import { TimezonePicker } from "./TimezonePicker.js";
import { GuestbookTab } from "./GuestbookTab.js";
import { ImagesTab } from "./ImagesTab.js";
import { DimChip, MatchPill } from "./MatchTier.js";
import { matchedKinkIds, notableDimensions } from "./match-utils.js";
import { findStatusMessage } from "./mini-status.js";
import { ProfileBBCode } from "./ProfileBBCode.js";
import { ago, dateLabel } from "./time.js";
import styles from "./profile.module.css";

// Insights sits last (#282); the guestbook slot is gated per-profile (#280).
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "details", label: "Details" },
  { id: "kinks", label: "Kinks" },
  { id: "compare", label: "Compare" },
  { id: "images", label: "Images" },
  { id: "guestbook", label: "Guestbook" },
  { id: "insights", label: "Insights" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Tabs actually shown for a profile: the Guestbook tab drops out entirely
 * when the character has their guestbook turned off (#280). */
function visibleTabs(profile: ProfileDto): readonly (typeof TABS)[number][] {
  if (profile.settings.guestbook) {
    return TABS;
  }
  return TABS.filter((tab) => tab.id !== "guestbook");
}

export function ProfileViewer({
  identityId,
  onClose,
}: {
  identityId: string;
  onClose: () => void;
}) {
  const viewing = useProfileStore((s) => s.viewing);
  const activeTab = useProfileStore((s) => s.activeTab);
  const loaded = useProfileStore((s) =>
    viewing ? s.profiles[viewing.toLowerCase()] : undefined,
  );
  const ownCharacter = useSessionsStore(
    (s) => s.identities?.find((entry) => entry.id === identityId)?.name,
  );
  const windowRef = useRef<HTMLDivElement>(null);
  // Window size is a device-level UI pref (#276): the viewer opens in whatever
  // mode the user last left it in, so a full-screen session carries to the
  // next profile they open. Persisted to localStorage on every toggle.
  const [fullscreen, setFullscreen] = useState(savedViewerFullscreen);

  useFocusTrap(windowRef);
  useEscapeToClose(onClose);

  useEffect(() => {
    void loadHistory(identityId);
    void loadSocial(identityId);
    if (ownCharacter) {
      void loadOwnProfile(identityId, ownCharacter);
    }
  }, [identityId, ownCharacter]);

  useEffect(() => {
    if (viewing) {
      void loadProfile(identityId, viewing);
    }
  }, [identityId, viewing]);

  if (!viewing) {
    return null;
  }

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`${styles.window} ${fullscreen ? styles.windowFull : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Profile: ${viewing}`}
        tabIndex={-1}
        ref={windowRef}
      >
        <div className={styles.windowControls}>
          <FetchedControl
            identityId={identityId}
            name={viewing}
            loaded={loaded}
          />
          <button
            type="button"
            className={styles.windowControl}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            onClick={() => {
              setFullscreen((value) => {
                const next = !value;
                persistViewerFullscreen(next);
                return next;
              });
            }}
          >
            {/* Arrow-family glyphs, not ⛶ (#413): the geometric-shapes box
                renders a step larger than the ✕ beside it in every UI face. */}
            {fullscreen ? "⤡" : "⤢"}
          </button>
          <button
            type="button"
            className={styles.windowControl}
            aria-label="Close profile"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <HistoryRail identityId={identityId} viewing={viewing} />
        <div className={styles.main}>
          <ViewerBody
            key={viewing.toLowerCase()}
            identityId={identityId}
            name={viewing}
            loaded={loaded}
            activeTab={activeTab}
            ownCharacter={ownCharacter}
            fullscreen={fullscreen}
          />
        </div>
      </div>
    </div>
  );
}

// ── History rail (§2) ────────────────────────────────────────────────────────

function HistoryRail({
  identityId,
  viewing,
}: {
  identityId: string;
  viewing: string;
}) {
  const history = useProfileStore((s) => s.history);
  const open = useProfileStore((s) => s.open);
  // Collapsed = avatars only, no names (#279). Defaults on the narrow layout;
  // the toggle records an explicit, persisted preference.
  const [collapsed, toggleCollapsed] = useRailCollapsed();
  return (
    <nav
      className={`${styles.rail} ${collapsed ? styles.railCollapsed : ""}`}
      aria-label="Recently viewed profiles"
    >
      <div className={styles.railHead}>
        {!collapsed && <span>Recently viewed</span>}
        <button
          type="button"
          className={styles.railCollapseBtn}
          aria-pressed={collapsed}
          aria-label={
            collapsed
              ? "Expand recently viewed to show names"
              : "Collapse recently viewed to avatars only"
          }
          title={collapsed ? "Show names" : "Avatars only"}
          onClick={toggleCollapsed}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {history.length === 0 ? (
        collapsed ? null : (
          <div className={styles.railEmpty}>
            <span className={styles.railEmptyTile} aria-hidden>
              ◌
            </span>
            Profiles you view will appear here.
          </div>
        )
      ) : (
        <div className={styles.railList}>
          {history.map((entry) => {
            const active = entry.name.toLowerCase() === viewing.toLowerCase();
            // Two sibling buttons, not a control nested in a control — the
            // remove affordance must be valid ARIA and keyboard-reachable
            // (M8 audit M3).
            return (
              <div
                key={entry.name.toLowerCase()}
                className={`${styles.histRow} ${active ? styles.histRowActive : ""}`}
              >
                <button
                  type="button"
                  className={styles.histOpen}
                  // In collapsed mode the name only survives as the tooltip.
                  title={collapsed ? entry.name : undefined}
                  onClick={() => {
                    open(entry.name);
                  }}
                >
                  <Avatar name={entry.name} size={28} square />
                  {!collapsed && (
                    <span className={styles.histMeta}>
                      <span className={styles.histName}>{entry.name}</span>
                      <span className={styles.histAgo}>
                        {ago(entry.lastViewedAt)}
                      </span>
                    </span>
                  )}
                </button>
                {!collapsed && (
                  <button
                    type="button"
                    className={styles.histRemove}
                    aria-label={`Remove ${entry.name} from history`}
                    onClick={() => {
                      void removeHistoryEntry(identityId, entry.name);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

// ── Main column ──────────────────────────────────────────────────────────────

function ViewerBody({
  identityId,
  name,
  loaded,
  activeTab,
  ownCharacter,
  fullscreen,
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile | undefined;
  activeTab: TabId;
  ownCharacter: string | undefined;
  fullscreen: boolean;
}) {
  const setTab = useProfileStore((s) => s.setTab);
  const response = loaded?.response;
  const profile = response?.profile;
  const tabs = profile ? visibleTabs(profile) : TABS;

  // If the guestbook tab was active but this character has it turned off
  // (#280), fall back to the first tab so the content region isn't blank.
  useEffect(() => {
    const fallback = tabs[0];
    if (profile && fallback && !tabs.some((tab) => tab.id === activeTab)) {
      setTab(fallback.id);
    }
  }, [profile, tabs, activeTab, setTab]);

  if (!response || !profile) {
    if (loaded && loaded.state !== "loading") {
      return <ErrorState identityId={identityId} name={name} loaded={loaded} />;
    }
    return <LoadingState name={name} />;
  }

  return (
    <>
      <Header identityId={identityId} profile={profile} />
      {(response.stale || response.budgetExhausted) && (
        <div className={styles.staleBanner} role="status">
          <span aria-hidden>⚠</span>
          {response.budgetExhausted
            ? "Hourly profile budget exhausted — showing the cached copy."
            : "Couldn't refresh — showing the cached copy."}
        </div>
      )}
      <div className={styles.tabs} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={`${styles.tab} ${tab.id === activeTab ? styles.tabActive : ""}`}
            onClick={() => {
              setTab(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
        {/* Right-aligned action, NOT a tab (#282): a plain anchor so it opens
            the real F-List site — deliberately exempt from the in-app
            /c/ interception (#252), and middle/ctrl-click stay native. */}
        <a
          className={styles.flistLink}
          href={`https://www.f-list.net/c/${encodeURIComponent(profile.name)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          F-List <span aria-hidden>↗</span>
        </a>
      </div>
      {/* Scroll container spans the full main region so the scrollbar anchors
          to the viewport edge (#331); the reading column is capped and centered
          inside it. The inner wrapper is a stable, always-present element, so it
          never remounts the tab content beneath it (#283/#289). */}
      <div className={styles.content} data-testid="profile-content">
        <div className={styles.contentColumn} data-testid="profile-column">
          <TabContent
            identityId={identityId}
            profile={profile}
            activeTab={activeTab}
            ownCharacter={ownCharacter}
            fullscreen={fullscreen}
          />
        </div>
      </div>
    </>
  );
}

function TabContent({
  identityId,
  profile,
  activeTab,
  ownCharacter,
  fullscreen,
}: {
  identityId: string;
  profile: ProfileDto;
  activeTab: TabId;
  ownCharacter: string | undefined;
  fullscreen: boolean;
}) {
  const ownProfile = useProfileStore((s) => s.ownProfile?.profile);
  switch (activeTab) {
    case "overview":
      return (
        <>
          <MatchStrip
            profile={profile}
            ownProfile={ownProfile}
            ownCharacter={ownCharacter}
          />
          <ProfileBBCode
            bbcode={profile.description}
            inlines={profile.inlines}
            fullscreen={fullscreen}
          />
        </>
      );
    case "details":
      return <DetailsTab profile={profile} />;
    case "kinks":
      return (
        <KinksTab
          profile={profile}
          ownProfile={ownProfile}
          ownCharacter={ownCharacter}
        />
      );
    case "compare":
      return (
        <CompareTab
          identityId={identityId}
          profile={profile}
          ownProfile={ownProfile}
          ownCharacter={ownCharacter}
        />
      );
    case "insights":
      return (
        <InsightsTab
          identityId={identityId}
          name={profile.name}
          ownCharacter={ownCharacter}
        />
      );
    case "images":
      return <ImagesTab profile={profile} fullscreen={fullscreen} />;
    case "guestbook":
      return <GuestbookTab identityId={identityId} profile={profile} />;
  }
}

// ── MatchStrip (§6) ──────────────────────────────────────────────────────────

/** Overview's compatibility card — only when own-profile data exists and
 * this isn't your own profile (mirrors the mini card's no-match case). */
function MatchStrip({
  profile,
  ownProfile,
  ownCharacter,
}: {
  profile: ProfileDto;
  ownProfile: ProfileDto | undefined;
  ownCharacter: string | undefined;
}) {
  const setTab = useProfileStore((s) => s.setTab);
  const self =
    ownCharacter !== undefined &&
    profile.name.toLowerCase() === ownCharacter.toLowerCase();
  const report = useMemo(
    () => (ownProfile && !self ? match(ownProfile, profile) : undefined),
    [ownProfile, profile, self],
  );
  if (!report || ownCharacter === undefined) {
    return null;
  }
  return (
    <section className={styles.matchStrip}>
      <div className={styles.matchStripHead}>
        <span className={styles.groupLabel}>
          Compatibility with {ownCharacter}
        </span>
        <button
          type="button"
          className={styles.fullCompare}
          onClick={() => {
            setTab("compare");
          }}
        >
          Full compare →
        </button>
      </div>
      <div className={styles.matchStripChips}>
        <MatchPill tier={report.overall} />
        {notableDimensions(report, 4).map((dimension) => (
          <DimChip
            key={dimension.label}
            label={dimension.label}
            tier={dimension.tier}
            title={dimension.reason}
          />
        ))}
      </div>
    </section>
  );
}

// ── Header (§3) + PrivateNote (§4) ───────────────────────────────────────────

export function Header({
  identityId,
  profile,
}: {
  identityId: string;
  profile: ProfileDto;
}) {
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  // Live STA status message from whichever session source knows it — the same
  // data the mini card and member list render (#365). Rendered through the
  // shared chat BBCode renderer, which owns its wire-text decode (decode
  // exactly once, #348/#353); no line when nothing is set.
  const statusMessage = useSessionsStore((s) =>
    findStatusMessage(s.sessions[identityId], profile.name),
  );
  // `showOthersStatus` never hides your own status (#585) — you have to be
  // able to see what you are broadcasting.
  const ownCharacter = useSessionsStore(
    (s) => s.identities?.find((entry) => entry.id === identityId)?.name,
  );
  const showStatus =
    useUserPrefs().showOthersStatus ||
    profile.name.toLowerCase() === ownCharacter?.toLowerCase();
  const isFriend = social?.friends.some(
    (row) => row.name.toLowerCase() === profile.name.toLowerCase(),
  );
  const isBookmarked =
    social?.bookmarks.some(
      (row) => row.name.toLowerCase() === profile.name.toLowerCase(),
    ) ?? false;
  // Optimistic bookmark state (#185): show the intended state instantly while
  // the request is in flight; clear the override afterwards so the refreshed
  // social lists (the same pathway the member menu uses) become the source of
  // truth — on failure the server list is unchanged, so clearing reverts.
  const [optimisticBookmark, setOptimisticBookmark] = useState<boolean>();
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const bookmarked = optimisticBookmark ?? isBookmarked;
  // The name takes the chat's gender colour, never a hash of the name (#493):
  // the roster's gender where a channel knows this character, this profile's
  // own Gender infotag otherwise, and no colour at all for None/unknown.
  const accent = useNameColor(identityId, profile.name, profile);

  function toggleBookmark() {
    const next = !bookmarked;
    setOptimisticBookmark(next);
    setBookmarkPending(true);
    void api
      .postBookmark(identityId, next ? "add" : "remove", profile.name)
      .then(() => loadSocial(identityId, true))
      .catch((error: unknown) => {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            error instanceof Error ? error.message : "Couldn't update bookmark",
          );
      })
      .finally(() => {
        setOptimisticBookmark(undefined);
        setBookmarkPending(false);
      });
  }

  return (
    <header
      className={styles.header}
      style={
        accent === undefined
          ? undefined
          : ({ "--gender-accent": accent } as React.CSSProperties)
      }
    >
      <Avatar name={profile.name} size={56} square />
      <div className={styles.headerInfo}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{profile.name}</span>
          {isFriend && (
            <span
              className={`${styles.badge} ${styles.badgeFriend}`}
              title="Friend"
            >
              ★
            </span>
          )}
          <button
            type="button"
            className={`${styles.badge} ${styles.bookmarkBtn} ${
              bookmarked ? styles.badgeBookmarkOn : styles.badgeBookmark
            }`}
            aria-pressed={bookmarked}
            disabled={bookmarkPending}
            title={bookmarked ? "Remove bookmark" : "Bookmark this character"}
            onClick={toggleBookmark}
          >
            ⚑
          </button>
        </div>
        {statusMessage && showStatus && (
          // Render the chat BBCode subset the way the mini card does (#210):
          // [url], [eicon], [color] must never show as raw tags. The title
          // falls back to flattened plain text for the hover tooltip —
          // through wireToPlainText, which also decodes the server's entities
          // (#512). The tooltip is an attribute, so it never reaches RichText
          // and this is its single decode; the visible line below owns its own
          // (wire-text.ts, DECODE-EXACTLY-ONCE CONTRACT).
          <div
            className={styles.headerStatus}
            title={wireToPlainText(statusMessage)}
          >
            <RichText bbcode={statusMessage} />
          </div>
        )}
      </div>
    </header>
  );
}

// ── FetchedControl (§3, #382) ────────────────────────────────────────────────

/** The "fetched X ago" stamp + refresh button. Lives inline in the window's
 * top-right control cluster, to the LEFT of the full-size/close buttons, so it
 * no longer costs the header a whole row (#382). Renders nothing until a
 * profile response exists (the loading/error chrome carries its own copy). */
function FetchedControl({
  identityId,
  name,
  loaded,
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile | undefined;
}) {
  const [tooltip, setTooltip] = useState(false);
  const response = loaded?.response;
  if (!response) {
    return null;
  }
  const loading = loaded?.state === "loading";
  return (
    <div className={styles.fetchedControl}>
      <span className={styles.fetchedLabel}>
        fetched {ago(response.fetchedAt)}
      </span>
      <span
        onMouseEnter={() => {
          setTooltip(true);
        }}
        onMouseLeave={() => {
          setTooltip(false);
        }}
      >
        <button
          type="button"
          className={styles.windowControl}
          aria-label="Refresh profile"
          disabled={response.budgetExhausted || loading}
          onClick={() => {
            void loadProfile(identityId, name, true);
          }}
        >
          {/* ↻ (arrows block) matches the close/fullscreen glyph size (#413);
              ⟳ from supplemental-arrows-A renders oversized. */}
          ↻
          {tooltip && response.budgetExhausted && (
            <span className={styles.tooltip} role="tooltip">
              Hourly profile budget exhausted — showing cached copy.
            </span>
          )}
        </button>
      </span>
    </div>
  );
}

// ── Details (§7) ─────────────────────────────────────────────────────────────

function DetailsTab({ profile }: { profile: ProfileDto }) {
  if (profile.infotagGroups.length === 0) {
    return (
      <EmptyState glyph="≡" title="No details">
        {profile.name} hasn't filled in any profile fields.
      </EmptyState>
    );
  }
  return (
    <div className={styles.columns}>
      {profile.infotagGroups.map((group) => (
        <section key={group.group} className={styles.group}>
          <div className={styles.groupLabel}>{group.group}</div>
          {group.tags.map((tag) => (
            <div key={tag.id} className={styles.detailRow}>
              <span className={styles.detailLabel}>{tag.label}</span>
              <span className={styles.detailValue}>{tag.value}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ── Kinks (§8) ───────────────────────────────────────────────────────────────

function KinksTab({
  profile,
  ownProfile,
  ownCharacter,
}: {
  profile: ProfileDto;
  ownProfile: ProfileDto | undefined;
  ownCharacter: string | undefined;
}) {
  // Overlap with your own connected character drives the colour scope (#293):
  // only kinks you both list get the coloured stance label + glyph, computed
  // from the same matcher the Compare tab uses. Viewing yourself, or with no
  // own-character/match data, leaves the whole list neutral.
  const self =
    ownCharacter !== undefined &&
    profile.name.toLowerCase() === ownCharacter.toLowerCase();
  const report = useMemo(
    () => (ownProfile && !self ? match(ownProfile, profile) : undefined),
    [ownProfile, profile, self],
  );
  const matchIds = useMemo(() => matchedKinkIds(report), [report]);
  const hasMatches = matchIds.size > 0;
  const ownChoice = new Map(
    (ownProfile?.kinks ?? []).map((kink) => [kink.id, kink.choice]),
  );
  if (profile.kinks.length === 0 && profile.customKinks.length === 0) {
    return (
      <EmptyState glyph="♥" title="No kinks listed">
        {profile.name} hasn't filled in a kink list.
      </EmptyState>
    );
  }
  // id → name for resolving a custom group's `children` back to display rows
  // (#275 flattens grouped standard kinks into `profile.kinks`, names intact).
  const catalog = kinkNameCatalog(profile.kinks);
  return (
    <>
      <div className={styles.kinkLegend}>
        {hasMatches ? (
          <>
            <span className={styles.kinkLegendLabel}>Shared with you:</span>
            {CHOICES.map((choice) => (
              <span
                key={choice.id}
                className={styles.kinkLegendChip}
                style={{ "--kink-col": choice.color } as React.CSSProperties}
              >
                <span className={styles.kinkLegendGlyph} aria-hidden>
                  {choice.glyph}
                </span>
                {choice.label}
              </span>
            ))}
            <span className={styles.kinkLegendNote}>
              Colours mark kinks you also list — the colour is {profile.name}'s
              choice; the trailing badge is yours. The rest are shown plainly.
            </span>
          </>
        ) : (
          <span className={styles.kinkLegendNote}>
            {profile.name}'s kink list. Colours would mark the ones you also
            list, once your own character's profile is loaded to compare.
          </span>
        )}
      </div>
      {/* Fixed-width columns that scroll horizontally inside this pane on the
          narrow layout (#281) — the page/modal body never scrolls sideways. */}
      <div className={styles.kinkPane}>
        <div className={styles.kinkGrid}>
          {CHOICES.map((column) => {
            const rows = profile.kinks.filter(
              (kink) => kink.choice === column.id,
            );
            const customs = profile.customKinks.filter(
              (custom) => custom.choice === column.id,
            );
            // The stance colour only keys the column when there is overlap to
            // mark (#293); otherwise the header reads as a neutral category.
            return (
              <section
                key={column.id}
                className={styles.kinkCol}
                style={
                  hasMatches
                    ? ({ "--kink-col": column.color } as React.CSSProperties)
                    : undefined
                }
              >
                <header className={styles.kinkColHead}>
                  <span
                    className={`${styles.kinkColLabel} ${hasMatches ? styles.kinkColLabelMatch : ""}`}
                  >
                    <span className={styles.kinkLegendGlyph} aria-hidden>
                      {column.glyph}
                    </span>
                    {column.label}
                  </span>
                  <span className={styles.kinkColCount}>
                    {rows.length + customs.length}
                  </span>
                </header>
                <div className={styles.kinkList}>
                  {customs.map((custom) => (
                    <CustomKinkRow
                      key={custom.name}
                      custom={custom}
                      grouped={groupedChildren(custom.children, catalog)}
                      matchIds={matchIds}
                    />
                  ))}
                  {rows.map((kink) => {
                    // Coloured stance label + your-choice glyph appear only on
                    // kinks you both list (#293); the rest stay neutral.
                    const isMatch = matchIds.has(kink.id);
                    const mine = ownChoice.get(kink.id);
                    const mineChoice = CHOICES.find(
                      (choice) => choice.id === mine,
                    );
                    return (
                      <div
                        key={kink.id}
                        className={`${styles.kinkRow} ${isMatch ? styles.kinkRowMatch : ""}`}
                        title={kink.description}
                      >
                        <span className={styles.kinkName}>{kink.name}</span>
                        {isMatch && mineChoice && (
                          <span
                            className={styles.choiceMark}
                            style={
                              {
                                "--mine-col": mineChoice.color,
                              } as React.CSSProperties
                            }
                            title={`Your choice: ${mineChoice.label}`}
                            aria-label={`your ${mineChoice.label.toLowerCase()}`}
                          >
                            {mineChoice.glyph}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

function CustomKinkRow({
  custom,
  grouped,
  matchIds,
}: {
  custom: ProfileDto["customKinks"][number];
  grouped: GroupedKink[];
  matchIds: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const expandable = custom.description !== "" || grouped.length > 0;
  return (
    <div>
      <div className={styles.kinkRow}>
        <span className={styles.customTag}>CUSTOM</span>
        <span className={styles.kinkName}>{custom.name}</span>
        {grouped.length > 0 && (
          <span className={styles.kinkGroupCount}>{grouped.length}</span>
        )}
        {expandable && (
          <button
            type="button"
            className={styles.kinkExpand}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${custom.name}`}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {open ? "−" : "+"}
          </button>
        )}
      </div>
      {open && custom.description !== "" && (
        <div className={styles.kinkDesc}>{custom.description}</div>
      )}
      {open && grouped.length > 0 && (
        <ul className={styles.kinkGroupChildren}>
          {grouped.map((child) => (
            <li
              key={child.id}
              className={`${styles.kinkGroupChild} ${matchIds.has(child.id) ? styles.kinkGroupChildMatch : ""}`}
            >
              {child.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Insights (§7b) ───────────────────────────────────────────────────────────

function InsightsTab({
  identityId,
  name,
  ownCharacter,
}: {
  identityId: string;
  name: string;
  ownCharacter: string | undefined;
}) {
  const insights = useProfileStore((s) => s.insights[name.toLowerCase()]);
  // The private note lives here now (#211) — the header corner is reserved for
  // window controls (close + fullscreen). The saved note rides the cached
  // profile response, and so does the timezone beside it.
  const cached = useProfileStore((s) => s.profiles[name.toLowerCase()]);
  const note = cached?.response?.note ?? null;
  const timezone = cached?.response?.timezone ?? null;
  const flistOffset = cached?.response?.profile.timezone ?? null;
  useEffect(() => {
    void loadInsights(identityId, name);
  }, [identityId, name]);

  // The note editor's open/draft state lives inside PrivateNote's local state,
  // so it only survives a re-render if React keeps the same instance. The
  // insights content below swaps between branches (shimmer while the fetch is
  // in flight → the loaded panel ~1s later), so the note is rendered *outside*
  // that swap: it always occupies the same, keyed position after `content`.
  // Without this, the branch flip that lands when the insights load resolves
  // would remount PrivateNote and slam the editor shut mid-write (#283). The
  // timezone field carries a draft too, so it shares the pinned block.
  const noteBlock = (
    <div key="private-note" className={styles.insightsNote}>
      <TimezonePicker
        identityId={identityId}
        name={name}
        initial={timezone}
        flistOffset={flistOffset}
      />
      <PrivateNote identityId={identityId} name={name} initial={note} />
    </div>
  );

  const crossed =
    insights !== undefined &&
    insights !== "error" &&
    (insights.messagesSent + insights.messagesReceived > 0 ||
      insights.lastSeenTalkingAt !== null ||
      insights.sharedChannels.length > 0);

  let content: ReactNode;
  if (!insights) {
    content = <div className={styles.shimmer} style={{ height: 120 }} />;
  } else if (insights === "error") {
    content = (
      <EmptyState glyph="?" title="Couldn't load insights">
        Reading your local history with {name} failed.
        <span className={styles.emptyActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              resetInsights(name);
              void loadInsights(identityId, name);
            }}
          >
            Retry
          </button>
        </span>
      </EmptyState>
    );
  } else if (!crossed) {
    content = (
      <EmptyState glyph="⇄" title="You haven't crossed paths yet">
        Once you share a channel or exchange messages with {name}, your history
        together will show up here.
      </EmptyState>
    );
  } else {
    content = (
      <>
        <div className={styles.insightsEyebrow}>
          <span className={styles.noteDot} aria-hidden />
          YOU × {name}
        </div>
        <div className={styles.insightsSub}>
          from your local history, never fetched from F-List
        </div>
        <div className={styles.columns}>
          <InsightGroup
            label="Conversation"
            rows={[
              [
                "Messages exchanged",
                String(insights.messagesSent + insights.messagesReceived),
                true,
              ],
              [
                "First encountered",
                insights.firstEncountered
                  ? `${dateLabel(insights.firstEncountered.at)} · ${insights.firstEncountered.conversation}`
                  : "—",
              ],
              [
                "Last chatted",
                insights.lastChattedAt ? ago(insights.lastChattedAt) : "never",
              ],
              [
                "Last seen talking",
                insights.lastSeenTalkingAt
                  ? ago(insights.lastSeenTalkingAt)
                  : "—",
              ],
            ]}
          />
          <InsightGroup
            label="Right now"
            rows={[
              [
                "Currently online",
                insights.online
                  ? `yes${insights.status ? ` · ${insights.status}` : ""}`
                  : ownCharacter
                    ? "no"
                    : "unknown (disconnected)",
                insights.online,
              ],
              [
                "Shared channels",
                insights.sharedChannels.length > 0
                  ? insights.sharedChannels.join(", ")
                  : "none right now",
              ],
            ]}
          />
          <InsightGroup
            label="This profile"
            rows={[
              ["Times you've viewed", String(insights.timesViewed)],
              [
                "First viewed",
                insights.firstViewedAt
                  ? dateLabel(insights.firstViewedAt)
                  : "—",
              ],
            ]}
          />
        </div>
        <ActivitySection identityId={identityId} name={name} />
      </>
    );
  }

  // Note last (below the insights content, #283) and pinned to a stable key so
  // it is never remounted by a content branch swap.
  return (
    <>
      {content}
      {noteBlock}
    </>
  );
}

/** The heatmap loads on its own (a second query, its own failure mode), so it
 * carries its own shimmer/error branch under the insight columns. */
function ActivitySection({
  identityId,
  name,
}: {
  identityId: string;
  name: string;
}) {
  const activity = useProfileStore((s) => s.activity[name.toLowerCase()]);
  useEffect(() => {
    void loadActivity(identityId, name);
  }, [identityId, name]);

  if (!activity) {
    return <div className={styles.shimmer} style={{ height: 96 }} />;
  }
  if (activity === "error") {
    return (
      <section className={styles.group}>
        <div className={styles.groupLabel}>Active hours</div>
        <div className={styles.heatEmpty}>
          Couldn&apos;t read when {name} is around.{" "}
          <button
            type="button"
            className={styles.noteImport}
            onClick={() => {
              resetActivity(name);
              void loadActivity(identityId, name);
            }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }
  return <ActivityHeatmap activity={activity} />;
}

function InsightGroup({
  label,
  rows,
}: {
  label: string;
  rows: [string, string, boolean?][];
}) {
  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      {rows.map(([rowLabel, value, headline]) => (
        <div
          key={rowLabel}
          className={`${styles.detailRow} ${styles.insightRow}`}
        >
          <span className={styles.detailLabel}>{rowLabel}</span>
          <span
            className={`${styles.detailValue} ${headline ? styles.insightHeadline : ""}`}
          >
            {value}
          </span>
        </div>
      ))}
    </section>
  );
}

// ── Loading / error states ───────────────────────────────────────────────────

function LoadingState({ name }: { name: string }) {
  return (
    <>
      <header className={styles.header}>
        <Avatar name={name} size={56} square />
        <div className={styles.headerInfo}>
          <div className={styles.nameRow}>
            <span className={styles.name}>{name}</span>
          </div>
          <div className={styles.metaRow}>fetching…</div>
        </div>
      </header>
      <div className={styles.tabs} aria-hidden>
        {TABS.map((tab) => (
          <span key={tab.id} className={styles.tab}>
            {tab.label}
          </span>
        ))}
      </div>
      <div className={styles.content}>
        <div
          className={styles.shimmer}
          style={{ height: 14, width: "70%", marginBottom: 10 }}
        />
        <div
          className={styles.shimmer}
          style={{ height: 14, width: "90%", marginBottom: 10 }}
        />
        <div className={styles.shimmer} style={{ height: 14, width: "55%" }} />
      </div>
    </>
  );
}

function ErrorState({
  identityId,
  name,
  loaded,
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile;
}) {
  const budget = loaded.state === "budget";
  return (
    <div className={styles.content}>
      <EmptyState
        glyph="?"
        title={
          budget
            ? "Profile budget exhausted"
            : loaded.state === "error"
              ? "Couldn't load profile"
              : "Profile not found"
        }
      >
        {loaded.error ??
          (budget
            ? "The hourly F-List budget is used up and there is no cached copy yet."
            : `F-List doesn't know a character named “${name}”.`)}
        <span className={styles.emptyActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void loadProfile(identityId, name, true);
            }}
          >
            Retry
          </button>
          <a
            className={styles.button}
            href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open on f-list.net ↗
          </a>
        </span>
      </EmptyState>
    </div>
  );
}

function EmptyState({
  glyph,
  title,
  children,
}: {
  glyph: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyTile} aria-hidden>
        {glyph}
      </span>
      <span className={styles.emptyTitle}>{title}</span>
      <span className={styles.emptyBody}>{children}</span>
    </div>
  );
}
