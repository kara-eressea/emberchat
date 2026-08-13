// Mini profile card (M8 step 8, Mini Profile Viewer.dc.html frames M8·B–G +
// COMPONENTS-profile-viewer.md §13): Discord-style popover opened by
// clicking any character name — member-list row, log nick, [user] mention.
// Fetch-through-cache off the same store the full viewer uses. Step 9: the
// compatibility block — overall pill + the two most notable dimension
// chips, or the calm no-own-profile prompt (frame M8·F).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { match, type MatchReport } from "@emberchat/matcher";
import { wireToPlainText } from "../../lib/wire-text.js";
import type { ProfileDto } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import type { SocialDto } from "../../lib/api.js";
import { dmPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { useNameColor } from "../../lib/name-color.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import {
  liveAnchor,
  loadOwnProfile,
  loadProfile,
  useProfileStore,
  type CardAnchor,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore, useUserPrefs } from "../../stores/sessions.js";
import { RichText } from "../chat/RichText.js";
import { Avatar } from "../common/Avatar.js";
import { RateEditor } from "../ratings/RateEditor.js";
import { StarRow } from "../ratings/StarRating.js";
import ratingsStyles from "../ratings/ratings.module.css";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { DimChip, MatchPill, TierPie } from "./MatchTier.js";
import { notableDimensions } from "./match-utils.js";
import { findStatusMessage } from "./mini-status.js";
import {
  placeCorner,
  placePopoverInWindow,
  popoverViewport,
  popoverWidthInWindow,
} from "./popover.js";
import { ago } from "./time.js";
import styles from "./profile.module.css";

const CARD_WIDTH = 300;
/** Stable resting height so the card doesn't jump as content loads (#182).
 * Yields to the computed cap on short (or zoomed) viewports — a min-height
 * that outranks maxHeight is just overflow. */
const CARD_MIN_HEIGHT = 232;

/** The key-infotag chips row, by mapping id (design: e.g. "Bisexual · 24 ·
 * Arctic fox · Switch") — orientation, age, species, sub/dom role. */
const CHIP_INFOTAG_IDS = [2, 1, 9, 15];

/** "Your rating" block (M11 §9): composes below compatibility when the
 * user has rated this person. A low rating never hides the card — only
 * the in-log ad row collapses. */
function CardRating({ name }: { name: string }) {
  const rating = useRatingsStore((s) => ratingFor(s.byName, name));
  // Rect plus trigger: the card itself follows the page (see `place` below),
  // so an editor placed once from a frozen rect would drift off the button it
  // belongs to the moment the card moved (#560).
  const [editorAnchor, setEditorAnchor] = useState<{
    rect: DOMRect;
    element: Element;
  }>();
  if (!rating) {
    return null;
  }
  return (
    <div className={ratingsStyles.cardBlock}>
      <div className={ratingsStyles.cardHead}>
        <span className={styles.groupLabel}>Your rating</span>
        <span className={ratingsStyles.cardScope}>this server only</span>
      </div>
      <div className={ratingsStyles.cardStarsRow}>
        <StarRow score={rating.score} size={15} count />
        <button
          type="button"
          className={ratingsStyles.cardEdit}
          onClick={(event) => {
            setEditorAnchor({
              rect: event.currentTarget.getBoundingClientRect(),
              element: event.currentTarget,
            });
          }}
        >
          Edit
        </button>
      </div>
      {rating.note !== undefined && (
        <div className={ratingsStyles.cardNote}>“{rating.note}”</div>
      )}
      {editorAnchor && (
        <RateEditor
          character={name}
          anchor={editorAnchor.rect}
          anchorElement={editorAnchor.element}
          onClose={() => {
            setEditorAnchor(undefined);
          }}
        />
      )}
    </div>
  );
}

export function MiniProfileCard({
  identityId,
  ownCharacter,
  name,
  anchor,
  anchorElement,
  onClose,
}: {
  identityId: string;
  ownCharacter: string;
  name: string;
  anchor: CardAnchor;
  /** The trigger itself, re-measured as the page moves under the card. */
  anchorElement?: Element;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const loaded = useProfileStore((s) => s.profiles[name.toLowerCase()]);
  const ownProfile = useProfileStore((s) => s.ownProfile?.profile);
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  // Live STA status message from whichever session source knows it (member
  // rosters, DM partner, friends/bookmarks) — the same data the member list
  // renders. Rendered through the shared chat BBCode renderer (#210).
  const statusMessage = useSessionsStore((s) =>
    findStatusMessage(s.sessions[identityId], name),
  );
  const self = name.toLowerCase() === ownCharacter.toLowerCase();
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();
  const docked =
    useSessionsStore((s) => s.sessions[identityId]?.prefs.miniCardPlacement) ===
    "corner";

  useEffect(() => {
    void loadProfile(identityId, name);
    void loadSocial(identityId);
    // Own profile for the compatibility block — memoized per identity.
    void loadOwnProfile(identityId, ownCharacter);
  }, [identityId, name, ownCharacter]);

  useEscapeToClose(onClose);

  const place = useCallback(() => {
    const element = cardRef.current;
    if (!element) {
      return;
    }
    // Measure the NATURAL content height, not the rendered one — once a
    // prior render caps the card, its own height is the clamped value and
    // the card could never re-grow as content loads (#182: it constrained
    // itself and hid the "Open profile" action). The body is the scroller,
    // so swap its visible height for its scroll height.
    const body = bodyRef.current;
    const height = body
      ? element.offsetHeight - body.clientHeight + body.scrollHeight
      : element.scrollHeight;
    // CARD_WIDTH is what the card wants; on a phone the CSS cap has already
    // drawn it narrower (MP1 §5-E), and placing at the wanted width would
    // clamp the card left of the edge it is actually flush with.
    const size = { width: popoverWidthInWindow(CARD_WIDTH), height };
    let next: { top: number; left: number; maxHeight: number };
    if (docked) {
      next = placeCorner(size, popoverViewport());
    } else {
      // Re-measure the trigger: the log auto-scrolls behind the card (#284),
      // so the rect captured at open time goes stale as messages arrive.
      const live = liveAnchor(anchorElement);
      if (anchorElement && !live) {
        // The trigger left the document (virtualized away, conversation
        // switched) — close rather than float at stale coordinates.
        onClose();
        return;
      }
      next = placePopoverInWindow(live ?? anchor, size);
    }
    // Only commit when the placement actually changed: this runs on every
    // scroll frame, and applying maxHeight must not feed back into a
    // re-measure loop.
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, [anchor, anchorElement, docked, onClose]);

  // Measure after render, place per §13. Re-runs when the content state
  // changes shape (skeleton → loaded → error) since the height changes.
  const contentState = loaded?.state ?? "loading";
  useLayoutEffect(() => {
    place();
  }, [place, contentState]);

  // Follow the trigger while the page moves under the card. Capture-phase
  // scroll catches nested scrollers (the log, the member list) too; resize
  // matters in both modes.
  useEffect(() => {
    let frame = 0;
    function schedule() {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    }
    window.addEventListener("resize", schedule);
    if (!docked) {
      window.addEventListener("scroll", schedule, true);
    }
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [place, docked]);

  // Click-away, without an overlay that swallows the click: pressing another
  // name closes this card AND opens that one in the same gesture (§13
  // "opening another popover" dismisses). Presses inside any dialog stacked
  // on the card (the rate editor, portaled to <body>) are not outside ones.
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        (cardRef.current?.contains(target) || target.closest('[role="dialog"]'))
      ) {
        return;
      }
      useProfileStore
        .getState()
        .dismissCard(target instanceof Node ? target : undefined);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  function message() {
    onClose();
    void gateway
      .cmd({ identityId, action: "pm.open", d: { character: name } })
      .then((ack) => {
        if (!ack.ok || !ack.conversation) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              ack.error ?? "Could not open the conversation",
            );
          return;
        }
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
        void navigate(
          dmPath(ownCharacter, ack.conversation.partnerCharacter ?? ""),
        );
      });
  }

  return (
    <div
      ref={cardRef}
      className={styles.card}
      data-eb-surface
      role="dialog"
      aria-label={`Profile card: ${name}`}
      style={
        pos
          ? {
              top: pos.top,
              left: pos.left,
              maxHeight: pos.maxHeight,
              // The resting min-height yields to the cap, or it would just
              // overflow the bottom edge on short/zoomed viewports.
              minHeight: Math.min(CARD_MIN_HEIGHT, pos.maxHeight),
            }
          : {
              top: anchor.bottom + 6,
              left: anchor.left,
              visibility: "hidden",
            }
      }
    >
      <CardContent
        name={name}
        identityId={identityId}
        loaded={loaded}
        social={social}
        statusMessage={statusMessage}
        ownProfile={self ? undefined : ownProfile}
        self={self}
        bodyRef={bodyRef}
        onRetry={() => {
          void loadProfile(identityId, name, true);
        }}
        onOpenProfile={() => {
          // open() clears the card in the store — the §13 hand-off.
          useProfileStore.getState().open(name);
        }}
        onMessage={self ? undefined : message}
      />
    </div>
  );
}

function CardContent({
  name,
  identityId,
  loaded,
  social,
  statusMessage,
  ownProfile,
  self,
  bodyRef,
  onRetry,
  onOpenProfile,
  onMessage,
}: {
  name: string;
  identityId: string;
  loaded: LoadedProfile | undefined;
  social: SocialDto | undefined;
  statusMessage: string | undefined;
  ownProfile: ProfileDto | undefined;
  self: boolean;
  /** The scroll region (§13: only the body scrolls when the card is capped
   * — header and actions stay pinned); measured for the natural height. */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onRetry: () => void;
  onOpenProfile: () => void;
  onMessage: (() => void) | undefined;
}) {
  const response = loaded?.response;
  // Your own status is never hidden by `showOthersStatus` (#585) — you have to
  // be able to see what you are broadcasting.
  const showStatus = useUserPrefs().showOthersStatus || self;
  const report: MatchReport | undefined = useMemo(
    () =>
      ownProfile && response ? match(ownProfile, response.profile) : undefined,
    [ownProfile, response],
  );
  // The card's name wears the chat's gender colour, not a hash of the name
  // (#493) — undefined for None/unknown, which leaves the name on the default
  // text token and the header wash on the app accent.
  const accent = useNameColor(identityId, name, response?.profile);

  if (!response && loaded && loaded.state !== "loading") {
    const budget = loaded.state === "budget";
    return (
      <div className={styles.cardBody} ref={bodyRef}>
        <div className={styles.cardError}>
          <span className={styles.emptyTile} aria-hidden>
            ?
          </span>
          <span className={styles.emptyTitle}>
            {budget
              ? "Profile budget exhausted"
              : loaded.state === "error"
                ? "Couldn't load profile"
                : "Profile not found"}
          </span>
          <span className={styles.emptyBody}>
            {loaded.error ??
              "This character may have been renamed or deleted on the server."}
          </span>
          <button type="button" className={styles.button} onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const lower = name.toLowerCase();
  const isFriend =
    social?.friends.some((row) => row.name.toLowerCase() === lower) ?? false;
  const isBookmarked =
    social?.bookmarks.some((row) => row.name.toLowerCase() === lower) ?? false;

  const chips = response
    ? CHIP_INFOTAG_IDS.flatMap((id) => {
        const tag = response.profile.infotagGroups
          .flatMap((group) => group.tags)
          .find((entry) => entry.id === id);
        return tag ? [tag.value] : [];
      })
    : [];

  return (
    <>
      <div
        className={styles.cardHeader}
        style={
          accent === undefined
            ? undefined
            : ({ "--gender-accent": accent } as React.CSSProperties)
        }
      >
        <Avatar name={name} size={64} square />
        <div className={styles.cardHeaderInfo}>
          <div className={styles.nameRow}>
            <span className={styles.cardName}>{name}</span>
            {isFriend && (
              <span
                className={`${styles.badge} ${styles.badgeFriend}`}
                title="Friend"
              >
                ★
              </span>
            )}
            {isBookmarked && (
              <span
                className={`${styles.badge} ${styles.badgeBookmarkOn}`}
                title="Bookmarked"
              >
                ⚑
              </span>
            )}
          </div>
          <div className={styles.cardChips}>
            {response ? (
              chips.map((chip) => (
                <span key={chip} className={styles.cardChip}>
                  {chip}
                </span>
              ))
            ) : (
              <>
                <span
                  className={styles.shimmer}
                  style={{ width: 54, height: 18 }}
                />
                <span
                  className={styles.shimmer}
                  style={{ width: 40, height: 18 }}
                />
                <span
                  className={styles.shimmer}
                  style={{ width: 58, height: 18 }}
                />
              </>
            )}
          </div>
        </div>
      </div>
      <div className={styles.cardBody} ref={bodyRef}>
        {statusMessage && showStatus && (
          // Render the chat BBCode subset the way the log and DM header do
          // (#210): [url], [eicon], [color] and friends must never show as raw
          // tags. The card has room for the full inline render; the title falls
          // back to the flattened plain text for the hover tooltip.
          <div
            className={styles.cardStatus}
            title={wireToPlainText(statusMessage)}
          >
            <RichText bbcode={statusMessage} />
          </div>
        )}
        {!self &&
          response &&
          (report ? (
            <div className={styles.cardMatch}>
              <span className={styles.groupLabel}>Compatibility</span>
              <div className={styles.cardMatchChips}>
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
            </div>
          ) : (
            // Frame M8·F: the viewer has no own-profile data loaded.
            <div className={styles.cardNoMatch}>
              <TierPie tier="neutral" size={13} />
              Connect your own character to compare
            </div>
          ))}
        {!self && <CardRating name={name} />}
        {response && (response.stale || response.budgetExhausted) && (
          <div className={styles.cardStale}>
            <span aria-hidden>⟲</span>
            cached {ago(response.fetchedAt)}
          </div>
        )}
      </div>
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.cardPrimary}
          onClick={onOpenProfile}
        >
          Open profile
        </button>
        {onMessage && (
          <button
            type="button"
            className={styles.cardGhost}
            onClick={onMessage}
          >
            Message
          </button>
        )}
      </div>
    </>
  );
}
