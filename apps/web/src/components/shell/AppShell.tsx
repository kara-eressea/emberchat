// AppShell (COMPONENTS.md §Layout): rail · sidebar · main · members grid,
// driven by the human-readable routes /app/<Character>[/c/<channel>|/dm/
// <partner>] (lib/routes.ts — case-insensitive, @me alias, legacy UUID
// redirects). On the phone tier the same routes drive a single-pane stack
// instead of the grid (lib/pane.ts, #375). Owns the gateway lifecycle for the
// tab: connect the socket, subscribe every identity (background identities
// must stream so their rail badges stay live), connect F-Chat sessions where
// the autoConnect intent says so (sessions themselves outlive every tab — the
// bouncer property), and advance the read cursor for whatever conversation is
// on screen.

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { gateway } from "../../gateway/socket.js";
import { startActivityReporting } from "../../lib/activity.js";
import { syncPushSubscription } from "../../lib/push.js";
import {
  identityPath,
  rememberLastIdentity,
  resolveConv,
  resolveIdentity,
  type ConvRef,
} from "../../lib/routes.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useRailStore } from "../../stores/rail.js";
import { railHidden } from "../../lib/rail-visibility.js";
import { adViewFor } from "../chat/ads.js";
import { ChannelHeader, DmHeader } from "../chat/ChannelHeader.js";
import { Composer } from "../chat/Composer.js";
import { DmProfile } from "../chat/DmProfile.js";
import { MemberList } from "../chat/MemberList.js";
import { PanelOverlay } from "../chat/PanelOverlay.js";
import { useIsNarrow } from "../../lib/dm-sidebar.js";
import { usePane } from "../../lib/pane.js";
import { MessageLog } from "../chat/MessageLog.js";
import { CharacterSearch } from "../search/CharacterSearch.js";
import { AdCenter } from "../ads/AdCenter.js";
import { CampaignDialog } from "../ads/CampaignDialog.js";
import { useRatingsStore } from "../../stores/ratings.js";
import { PostAdsDialog } from "../ads/PostAdsDialog.js";
import { ChannelBrowser } from "../browser/ChannelBrowser.js";
import { PreferencesWindow } from "../prefs/PreferencesWindow.js";
import { useProfileStore } from "../../stores/profile.js";
import { LinkPreview } from "../chat/LinkPreview.js";
import { EiconContextMenu } from "../chat/EiconContextMenu.js";
import { MiniProfileCard } from "../profile/MiniProfileCard.js";
import { ProfileViewer } from "../profile/ProfileViewer.js";
import { IdentityRail } from "./IdentityRail.js";
import { QuickSwitcher } from "./QuickSwitcher.js";
import { ResizeHandle } from "./ResizeHandle.js";
import { Sidebar } from "./Sidebar.js";
import {
  LEFT_DEFAULT_WIDTH,
  RIGHT_DEFAULT_WIDTH,
  persistColumnWidth,
  savedColumnWidth,
  WIDTH_VARS,
} from "../../lib/sidebar-resize.js";
import { useUnreadIndicator } from "../../lib/use-unread-indicator.js";
import { startWindowFocusTracking } from "../../lib/window-focus.js";
import styles from "./shell.module.css";

export function AppShell() {
  const {
    identity: slug,
    channel: channelParam,
    partner: partnerParam,
    legacyConvId,
  } = useParams();
  const location = useLocation();
  const identities = useSessionsStore((s) => s.identities);
  const resolved =
    slug === undefined || identities === undefined
      ? undefined
      : resolveIdentity(identities, slug);
  const identityId = resolved?.id;
  const session = useSessionsStore((s) =>
    identityId === undefined ? undefined : s.sessions[identityId],
  );
  // Identity-rail visibility (#346): the stored hide preference, overridden to
  // visible whenever a second identity is connected so a newly-connected
  // character is never lost. Read from the store (initialized synchronously
  // from localStorage), so the shell's first render is already in final shape.
  const railPref = useRailStore((s) => s.hidden);
  const hideRail = railHidden(railPref, identities?.length ?? 0);
  const membersOpen = useUiStore((s) => s.membersOpen);
  const membersDrawerOpen = useUiStore((s) => s.membersDrawerOpen);
  const dmSidebarOpen = useUiStore((s) => s.dmSidebarOpen);
  const dmDrawerOpen = useUiStore((s) => s.dmDrawerOpen);
  const narrow = useIsNarrow();
  // Resizable docked columns (#292): the committed widths live in state and
  // are mirrored to localStorage; the grid reads them through CSS variables.
  // During a drag the ResizeHandle writes the variable imperatively (rAF), so
  // these only change on commit — no render per pixel.
  const shellRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(() => savedColumnWidth("left"));
  const [rightWidth, setRightWidth] = useState(() => savedColumnWidth("right"));
  const commitLeftWidth = (width: number) => {
    setLeftWidth(width);
    persistColumnWidth("left", width);
  };
  const commitRightWidth = (width: number) => {
    setRightWidth(width);
    persistColumnWidth("right", width);
  };
  const prefsOpen = useUiStore((s) => s.prefsOpen);
  const profileViewing = useProfileStore((s) => s.viewing);
  const profileCard = useProfileStore((s) => s.card);
  const channelBrowserOpen = useUiStore((s) => s.channelBrowserOpen);
  const switcherOpen = useUiStore((s) => s.switcherOpen);
  const adCenterOpen = useUiStore((s) => s.adCenterOpen);
  const postAdsOpen = useUiStore((s) => s.postAdsOpen);
  const campaignOpen = useUiStore((s) => s.campaignOpen);
  const characterSearchOpen = useUiStore((s) => s.characterSearchOpen);

  const ref: ConvRef | undefined =
    channelParam !== undefined
      ? { kind: "c", target: channelParam }
      : partnerParam !== undefined
        ? { kind: "dm", target: partnerParam }
        : legacyConvId !== undefined
          ? { kind: "legacy", convId: legacyConvId }
          : undefined;
  const conv =
    session?.synced && ref !== undefined
      ? resolveConv(session, ref)
      : undefined;
  const convId = conv?.convId;
  const convSuffix = conv?.suffix;
  // Which pane the phone stack is showing (#375). A function of the route
  // alone, so browser Back and the Android back gesture walk the stack; it is
  // `undefined` on compact and wide, where both columns are on screen.
  const pane = usePane(ref !== undefined);

  // Favicon badge + title count for backgrounded tabs (#390).
  useUnreadIndicator();

  useEffect(() => {
    gateway.connect();
    // Ad ratings load once per app session (M11) — every ad row and mini
    // card reads the shared map.
    void useRatingsStore.getState().load();
  }, []);

  // Activity reporting lives with the shell: it exists exactly while the user
  // is in the app, across identity/conversation navigation. The bouncer turns
  // these reports into auto-away (#619); nothing here decides a status.
  useEffect(() => startActivityReporting(), []);

  // Same lifetime for window focus (#440) — the read paths below and in
  // gateway/dispatch read it from the ui store.
  useEffect(() => startWindowFocusTracking(), []);

  // Push, for a device that opted in (design/web-push.md §4). Here rather than
  // in main.tsx because both calls it makes need an access token, and the
  // shell is the first thing that only renders once there is one. A no-op —
  // not even a fetch — for everyone else.
  useEffect(() => {
    void syncPushSubscription();
  }, []);

  // Ctrl/Cmd+K toggles the quick-switcher (M9) from anywhere in the shell.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        const ui = useUiStore.getState();
        ui.setSwitcherOpen(!ui.switcherOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // The routed identity subscribes immediately (its snapshot should win the
  // race); the rest follow once ready lists them, so background badges and
  // catch-up stream for every identity, not just the visible one.
  useEffect(() => {
    if (identityId !== undefined) {
      gateway.sub(identityId);
    }
  }, [identityId]);
  const identityIdsKey = identities?.map((i) => i.id).join(",") ?? "";
  useEffect(() => {
    for (const id of identityIdsKey.split(",")) {
      if (id !== "") {
        gateway.sub(id);
      }
    }
  }, [identityIdsKey]);

  // Release the conversation we are leaving from any search-jump view it was
  // left in (#411): a detached buffer plus a stale jumpTarget survive the
  // switch and strand the NEXT open of that conversation in old history.
  // Only a switch BETWEEN two real conversations releases — never the
  // teardown to undefined, which also runs on React's dev double-mount and
  // would undo the jump we just made.
  const prevConvIdRef = useRef<string>(undefined);
  useEffect(() => {
    const previous = prevConvIdRef.current;
    if (convId !== undefined && previous !== undefined && previous !== convId) {
      useMessagesStore.getState().leaveConversation(previous);
    }
    if (convId !== undefined) {
      prevConvIdRef.current = convId;
    }
  }, [convId]);

  useEffect(() => {
    useUiStore.getState().setActive(identityId, convId);
    if (identityId !== undefined) {
      rememberLastIdentity(identityId); // the @me alias points here
      if (convSuffix !== undefined) {
        useUiStore.getState().setLastConv(identityId, convSuffix);
      }
    }
    return () => {
      useUiStore.getState().setActive(undefined, undefined);
    };
  }, [identityId, convId, convSuffix]);

  // Start F-Chat sessions on demand — once per identity per shell visit, so
  // a stop (locked vault, auth failure) surfaces its reason instead of
  // looping. Gated on the autoConnect intent flag: an identity the user
  // explicitly disconnected stays offline until they explicitly connect it
  // again (the MeBar power control), never because a tab happened to open.
  // All identities, not just the routed one — the rail promises background
  // identities stay online. Subscribed via a derived key, never the sessions
  // map itself: every message/presence event replaces the map object, and
  // with all identities subscribed that would re-render the entire shell on
  // every event for any of them. Only the fields this loop reads take part.
  const connectKey = useSessionsStore((s) =>
    (s.identities ?? [])
      .map((i) => {
        const slice = s.sessions[i.id];
        return `${i.id}:${i.autoConnect ? 1 : 0}:${slice?.synced ? 1 : 0}:${slice?.sessionStatus ?? ""}`;
      })
      .join("|"),
  );
  const connectAttempted = useRef(new Set<string>());
  useEffect(() => {
    const state = useSessionsStore.getState();
    for (const identity of state.identities ?? []) {
      const slice = state.sessions[identity.id];
      if (
        !slice?.synced ||
        identity.autoConnect !== true ||
        connectAttempted.current.has(identity.id) ||
        (slice.sessionStatus !== "offline" && slice.sessionStatus !== "stopped")
      ) {
        continue;
      }
      connectAttempted.current.add(identity.id);
      void gateway.cmd({ identityId: identity.id, action: "session.connect" });
    }
  }, [connectKey]);

  // The phone overlays are per-visit (#375, package D): arriving at a
  // conversation takes them down — a first open, a tap back in from the list,
  // or the tier flipping under a drawer that was open on a compact window.
  // The persisted prefs (membersOpen, dmSidebarOpen) govern the docked columns
  // and must never lay a panel over the one pane a phone has; a transient flag
  // that survived the trip in would do the same thing one navigation later.
  useEffect(() => {
    if (pane === undefined) {
      return;
    }
    useUiStore.getState().setMembersDrawerOpen(false);
    useUiStore.getState().setDmDrawerOpen(false);
  }, [pane, convId]);

  // The read cursor follows the newest visible message of the active
  // conversation; the ack fans conversation.updated back to every tab.
  // Never while a search jump detached the view from the live tail — the
  // newest *buffered* id is then an old message and would drag the cursor
  // backward.
  const newestId = useMessagesStore((s) => {
    if (convId === undefined) {
      return undefined;
    }
    const buffer = s.buffers[convId];
    return buffer?.detachedTail ? undefined : buffer?.messages.at(-1)?.id;
  });
  useEffect(() => {
    // On screen is not enough — someone has to be looking (#440). Focus is read
    // imperatively and deliberately kept OUT of the deps: this effect answers
    // "a message landed while we were watching", and the mirror case (focus
    // returns to messages that landed while we were away) belongs to MessageLog,
    // which knows whether we are still parked at the tail.
    if (
      identityId !== undefined &&
      convId !== undefined &&
      useUiStore.getState().windowFocused
    ) {
      useSessionsStore.getState().clearUnread(identityId, convId);
      if (newestId !== undefined) {
        gateway.readAck(identityId, convId, newestId);
      }
    }
  }, [identityId, convId, newestId]);

  if (slug === undefined) {
    return null;
  }
  if (identities !== undefined && resolved === undefined) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        <p>This identity does not exist (anymore).</p>
        <Link to="/identities">Back to identities</Link>
      </div>
    );
  }
  if (resolved === undefined || !session?.synced) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        Connecting…
      </div>
    );
  }

  // Restore the canonical URL: @me and UUID slugs become the character name,
  // casing is fixed, and legacy conversation ids become their name path.
  // Unresolved c/dm targets keep the typed form — they canonicalize the
  // moment the conversation exists (e.g. right after joining).
  const canonical =
    identityPath(resolved.name) +
    (conv !== undefined
      ? `/${conv.suffix}`
      : ref !== undefined && ref.kind !== "legacy"
        ? `/${ref.kind}/${encodeURIComponent(ref.target)}`
        : "");
  if (canonical !== location.pathname) {
    return <Navigate to={canonical} replace />;
  }

  const activeId = resolved.id;
  // The back affordance of the phone stack. It targets `identityPath` — the
  // exact prefix the canonical URL above is built from — so following it
  // lands on a path that is already canonical and never triggers a second
  // <Navigate replace> on arrival. Undefined on compact and wide: there is
  // nothing to go back to when the list is on screen already.
  const backToList =
    pane === "conversation" ? identityPath(resolved.name) : undefined;
  const conversation =
    convId === undefined ? undefined : findConversation(session, convId);
  const channel =
    conversation?.kind === "channel" ? conversation.channel : undefined;
  // Whether the shell is stacked — the phone tier, where there is no
  // right-hand track to dock into and both panels open as overlays instead
  // (#375, package D).
  const stacked = pane !== undefined;
  // The docked member column, on the tiers that have one. `membersOpen` starts
  // open, so on a phone this pref would have every channel open on its member
  // list instead of its conversation — which is why the overlay below reads a
  // transient flag rather than this one.
  const showMembers = channel !== undefined && membersOpen && !stacked;
  const showMembersOverlay =
    channel !== undefined && stacked && membersDrawerOpen;
  // The DM sidebar shares the same 232px right-column slot as MemberList; the
  // two are mutually exclusive by conversation kind. On the wide layout it's a
  // grid column (persisted pref); below it, a transient drawer that starts
  // closed — a right-edge overlay on compact, and the same full-height panel
  // the member list gets on phone.
  const dmView = conversation?.kind === "pm" ? conversation.dm : undefined;
  const showDmGrid = dmView !== undefined && dmSidebarOpen && !narrow;
  const showDmDrawer =
    dmView !== undefined && narrow && !stacked && dmDrawerOpen;
  const showDmOverlay = dmView !== undefined && stacked && dmDrawerOpen;
  const closeDmPanel = () => {
    if (narrow) {
      useUiStore.getState().setDmDrawerOpen(false);
    } else {
      useUiStore.getState().toggleDmSidebar();
    }
  };
  const rightColumnOpen = showMembers || showDmGrid;
  const membersPanel =
    channel !== undefined && (showMembers || showMembersOverlay) ? (
      <MemberList
        identityId={activeId}
        ownCharacter={session.character}
        channel={channel}
      />
    ) : undefined;
  const dmPanel =
    dmView !== undefined && (showDmGrid || showDmDrawer || showDmOverlay) ? (
      <DmProfile
        identityId={activeId}
        ownCharacter={session.character}
        dm={dmView}
        // The drawer shim is compact's alone now: on phone the panel renders
        // in its docked form inside the overlay, which draws the label and
        // the way out that the drawer draws for itself.
        overlay={showDmDrawer}
        onCollapse={closeDmPanel}
      />
    ) : undefined;

  return (
    <div
      ref={shellRef}
      className={`${styles.shell} ${rightColumnOpen ? "" : (styles.membersClosed ?? "")} ${hideRail ? (styles.railHidden ?? "") : ""}`}
      // The stack's state, for CSS and for tests. Present only on the phone
      // tier — where the shell shows one pane — so the desktop grid keeps
      // exactly the markup it has today.
      data-pane={pane}
      data-testid="app-shell"
      style={{
        [WIDTH_VARS.left]: `${leftWidth}px`,
        [WIDTH_VARS.right]: `${rightWidth}px`,
      }}
    >
      <IdentityRail activeId={activeId} />
      <Sidebar session={session} activeConvId={convId} />
      {/* Docked-only: below the narrow breakpoint the right column is an
          overlay drawer and the columns don't resize (#292). */}
      {!narrow && (
        <ResizeHandle
          column="left"
          shellRef={shellRef}
          defaultWidth={LEFT_DEFAULT_WIDTH}
          onCommit={commitLeftWidth}
        />
      )}
      {!narrow && rightColumnOpen && (
        <ResizeHandle
          column="right"
          shellRef={shellRef}
          defaultWidth={RIGHT_DEFAULT_WIDTH}
          onCommit={commitRightWidth}
        />
      )}
      {/* The conversation toolbar is a shell row, not part of <main>: it
          spans the chat column and the right column so it rides above the
          member list / profile panel. Keyed like the log below — the toolbar
          carries per-conversation state (search query and results, the room
          window), none of which should survive a switch. */}
      {conversation !== undefined && convId !== undefined ? (
        conversation.kind === "channel" ? (
          <ChannelHeader
            key={`head:${convId}`}
            identityId={activeId}
            channel={conversation.channel}
            backTo={backToList}
          />
        ) : (
          <DmHeader
            key={`head:${convId}`}
            identityId={activeId}
            dm={conversation.dm}
            backTo={backToList}
          />
        )
      ) : null}
      <main className={styles.main}>
        {session.notice && (
          <div
            className={`${styles.notice} ${session.notice.kind === "error" ? (styles.error ?? "") : ""}`}
            role="status"
          >
            {session.notice.text}
            <button
              className={styles.noticeDismiss}
              onClick={() => {
                useSessionsStore.getState().clearNotice(activeId);
              }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {conversation === undefined || convId === undefined ? (
          <div className={styles.centerNote}>
            <p>Join a channel or open a conversation to start chatting.</p>
            {/* A conversation route that resolved to nothing (never joined,
                deleted, a stale bookmark) renders no toolbar, so the stack's
                usual back chip is not there. Installed as a PWA there is no
                browser chrome to fall back on either — so the pane carries
                its own way out. */}
            {backToList !== undefined && (
              <p>
                <Link to={backToList}>Back to conversations</Link>
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Keyed per conversation so both remount on switch — with
                distinct prefixes, since they are siblings. */}
            <MessageLog
              key={`log:${convId}`}
              identityId={activeId}
              convId={convId}
              readCursorAtAttach={
                conversation.kind === "channel"
                  ? conversation.channel.lastReadMessageId
                  : conversation.dm.lastReadMessageId
              }
            />
            <Composer
              key={`composer:${convId}`}
              session={session}
              convId={convId}
              channelKey={channel?.key}
              oplist={channel?.oplist}
              channelMode={channel?.mode}
              adView={
                channel && channel.mode === "both"
                  ? adViewFor(session.prefs, channel.key)
                  : undefined
              }
              partner={
                conversation.kind === "pm" ? conversation.dm.partner : undefined
              }
              placeholder={
                conversation.kind === "channel"
                  ? channel &&
                    channel.mode === "both" &&
                    adViewFor(session.prefs, channel.key) === "ads"
                    ? `Compose an ad for #${conversation.channel.title}`
                    : `Message #${conversation.channel.title}`
                  : `Message ${conversation.dm.partner}`
              }
              maxBytes={
                conversation.kind === "channel"
                  ? session.limits.chatMax
                  : session.limits.privMax
              }
              // A channel we hold history for but are not live in (fresh
              // session, or kicked) offers rejoin instead of a dead input.
              rejoinKey={
                channel && channel.members.length === 0
                  ? channel.key
                  : undefined
              }
            />
          </>
        )}
        {/* In-log search now hangs off the header toolbar's search field
            (ChannelHeader), which owns the query — no shell-level mount. */}
      </main>
      {/* Both right-hand panels render the same either way: docked, they are
          the grid's fourth column; on phone the same element goes inside the
          overlay, which supplies the chrome the docked column gets from the
          toolbar spanning it. */}
      {membersPanel !== undefined &&
        (showMembersOverlay ? (
          <PanelOverlay
            label="Members"
            onClose={() => {
              useUiStore.getState().setMembersDrawerOpen(false);
            }}
          >
            {membersPanel}
          </PanelOverlay>
        ) : (
          membersPanel
        ))}
      {dmPanel !== undefined &&
        dmView !== undefined &&
        (showDmOverlay ? (
          <PanelOverlay
            label={`Profile: ${dmView.partner}`}
            onClose={closeDmPanel}
          >
            {dmPanel}
          </PanelOverlay>
        ) : (
          dmPanel
        ))}
      {prefsOpen && (
        <PreferencesWindow
          identityId={activeId}
          onClose={() => {
            useUiStore.getState().setPrefsOpen(false);
          }}
        />
      )}
      {channelBrowserOpen && (
        <ChannelBrowser
          session={session}
          onClose={() => {
            useUiStore.getState().setChannelBrowserOpen(false);
          }}
        />
      )}
      {adCenterOpen && (
        <AdCenter
          session={session}
          onClose={() => {
            useUiStore.getState().setAdCenterOpen(false);
          }}
        />
      )}
      {postAdsOpen && (
        <PostAdsDialog
          session={session}
          onClose={() => {
            useUiStore.getState().setPostAdsOpen(false);
          }}
        />
      )}
      {campaignOpen && (
        <CampaignDialog
          session={session}
          onClose={() => {
            useUiStore.getState().setCampaignOpen(false);
          }}
        />
      )}
      {characterSearchOpen && (
        <CharacterSearch
          session={session}
          onClose={() => {
            useUiStore.getState().setCharacterSearchOpen(false);
          }}
        />
      )}
      {switcherOpen && identities !== undefined && (
        <QuickSwitcher
          session={session}
          identities={identities.map((identity) => ({
            id: identity.id,
            name: identity.name,
          }))}
          onClose={() => {
            useUiStore.getState().setSwitcherOpen(false);
          }}
        />
      )}
      <LinkPreview />
      <EiconContextMenu />
      {profileCard !== undefined && (
        <MiniProfileCard
          identityId={activeId}
          ownCharacter={session.character}
          name={profileCard.name}
          anchor={profileCard.anchor}
          anchorElement={profileCard.element}
          onClose={() => {
            useProfileStore.getState().closeCard();
          }}
        />
      )}
      {profileViewing !== undefined && (
        <ProfileViewer
          identityId={activeId}
          onClose={() => {
            useProfileStore.getState().close();
          }}
        />
      )}
    </div>
  );
}

type FoundConversation =
  { kind: "channel"; channel: ChannelView } | { kind: "pm"; dm: DmView };

function findConversation(
  session: IdentitySession,
  convId: string,
): FoundConversation | undefined {
  const key = session.channelByConvId[convId];
  if (key !== undefined) {
    const channel = session.channels[key];
    if (channel) {
      return { kind: "channel", channel };
    }
  }
  const dm = session.dms[convId];
  return dm ? { kind: "pm", dm } : undefined;
}
