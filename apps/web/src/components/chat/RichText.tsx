// BBCode → styled spans (COMPONENTS.md §7): the one render path for message
// bodies, system lines, channel descriptions, statusmsg — and, in M4 step 4,
// the composer preview, so what you preview is exactly what recipients see.
// Structure comes from the shared subset AST; plain text runs get the inline
// token pass (links, @name, #channel). [icon]/[eicon] render as name chips
// until step 3 brings inline images.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { avatarUrl, eiconUrl } from "../../lib/avatar.js";
import { parseCharacterUrl } from "../../lib/character-url.js";
import { chipHost, chipLabel, resolvePreview } from "../../lib/link-preview.js";
import { useNoHover } from "../../lib/pointer.js";
import { useLongPress } from "../../lib/useLongPress.js";
import {
  openPreviewFrom,
  useLinkPreviewStore,
} from "../../stores/link-preview.js";
import { useNavigate, type NavigateFunction } from "react-router";
import { gateway } from "../../gateway/socket.js";
import { channelPath } from "../../lib/routes.js";
import { openCardFrom } from "../../stores/profile.js";
import {
  useGenderColorVar,
  useSessionsStore,
  useUserPrefs,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { openEiconMenu } from "../../stores/eicon-menu.js";
import { hasEicon } from "./eicon-lists.js";
import { spoilerSegments, textTokens } from "./rich-text.js";
import { decodeWireEntities } from "../../lib/wire-text.js";
import styles from "./chat.module.css";

/**
 * How an intercepted f-list.net/c/<name> link opens its character (#214).
 * The default matches a chat `[user]` click — the mini card anchored to the
 * link. The profile viewer overrides it (ProfileLinkProvider) to swap the
 * viewer instead, since the popover would layer below the modal.
 */
export type ProfileLinkOpener = (element: Element, name: string) => void;

const ProfileLinkContext = createContext<ProfileLinkOpener>(openCardFrom);

export const ProfileLinkProvider = ProfileLinkContext.Provider;

/**
 * How `[user]` names in this subtree render. By default a `[user]` tag is a
 * mid-sentence mention chip (the "@name" body treatment). Inside a roll line
 * the server names the roller/target in `[user]` tags, which should read as
 * plain inline sender names — no chip — carrying the member-list gender
 * colour, so the die line reads as a normal chat line (#337). The identity
 * whose roster resolves that gender rides along in the context.
 */
interface PlainNamesMode {
  plain: boolean;
  identityId: string;
}

const PlainNamesContext = createContext<PlainNamesMode>({
  plain: false,
  identityId: "",
});

export const PlainNamesProvider = PlainNamesContext.Provider;

export function RichText({
  bbcode,
  local = false,
}: {
  bbcode: string;
  /** `true` when `bbcode` is locally composed (composer / ad previews) rather
   * than inbound wire text: skip the server-entity decode, since pre-send text
   * was never server-escaped. Defaults to wire text (decode on). */
  local?: boolean;
}) {
  // Memoized: the log re-renders far more often than messages change, and
  // parsing every visible message per render is exactly the hot path a
  // hostile long message would exploit (audit). Inbound wire text is
  // entity-decoded first (#335 follow-up) so signed CDN URLs survive intact.
  const nodes = useMemo(
    () => parseBBCode(local ? bbcode : decodeWireEntities(bbcode)),
    [bbcode, local],
  );
  return <>{renderNodes(nodes, "r")}</>;
}

/** Hook for the profile renderer (M8): claim a node (profile blocks) or
 * return undefined to fall through to the shared inline rendering. */
export type ExtraNodeRenderer = (
  node: BBNode,
  key: string,
) => ReactNode | undefined;

/** Exported for the profile BBCode renderer (M8): profile blocks wrap these
 * same inline nodes so chat and profiles render text identically. */
export function renderNodes(
  nodes: readonly BBNode[],
  keyBase: string,
  extra?: ExtraNodeRenderer,
): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyBase}.${String(index)}`;
    return extra?.(node, key) ?? renderNode(node, key, extra);
  });
}

const WRAPPER_CLASS: Record<string, string | undefined> = {
  b: styles.bbB,
  i: styles.bbI,
  u: styles.bbU,
  s: styles.bbS,
  sup: styles.bbSup,
  sub: styles.bbSub,
};

function renderNode(
  node: BBNode,
  key: string,
  extra?: ExtraNodeRenderer,
): ReactNode {
  switch (node.type) {
    case "text":
      return renderText(node.text, key);
    case "wrapper":
      return (
        <span key={key} className={WRAPPER_CLASS[node.tag] ?? ""}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "color":
      return (
        <span key={key} className={styles[`bbc-${node.color}`] ?? ""}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "url":
      return (
        <LinkChip key={key} href={node.href}>
          {renderNodes(node.children, key, extra)}
        </LinkChip>
      );
    case "name":
      // [user] opens the mini profile card (M8) — the f-list.net website
      // link lives in the context menu / full viewer instead.
      return node.tag === "user" ? (
        <UserName key={key} name={node.name} />
      ) : (
        <InlineIcon key={key} tag={node.tag} name={node.name} />
      );
    case "channel":
      // [session]/[channel] invite link (#366): a channel chip that joins and
      // opens the referenced channel, shown with its human label.
      return <ChannelLink key={key} channelKey={node.key} label={node.label} />;
    case "noparse":
      return (
        <span key={key} className={styles.bodyCode}>
          {node.text}
        </span>
      );
    case "spoiler":
      // Incoming [spoiler] from other clients (#204): same covered bar as the
      // `||…||` spelling, but wrapping full markup (text, eicons, …).
      return (
        <Spoiler key={key}>{renderNodes(node.children, key, extra)}</Spoiler>
      );
    // Profile-dialect nodes never occur in chat parses; if one arrives
    // unclaimed (no `extra`), degrade to unstyled content — never crash.
    case "block":
    case "collapse":
      return <span key={key}>{renderNodes(node.children, key, extra)}</span>;
    // Profile inline images never occur in a chat parse; the profile renderer
    // claims them via `extra`. Anything reaching here degrades silently.
    case "img":
    case "hr":
      return null;
  }
}

/**
 * A `[user]` name. Both spellings open the mini profile card on click (M8).
 * By default it wears the mid-sentence mention chip; inside a roll line
 * (PlainNamesProvider) it renders as a plain inline sender name — the same
 * `.nick` treatment as a message sender, coloured by the member-list gender
 * token — so the die line reads as a normal chat line, not a badge (#337).
 */
function UserName({ name }: { name: string }) {
  const mode = useContext(PlainNamesContext);
  const genderColor = useGenderColorVar(mode.identityId, name);
  return (
    <button
      type="button"
      className={
        mode.plain
          ? `${styles.nameButton ?? ""} ${styles.nick}`
          : `${styles.nameButton ?? ""} ${styles.bodyMention}`
      }
      style={mode.plain && genderColor ? { color: genderColor } : undefined}
      onClick={(event) => {
        openCardFrom(event.currentTarget, name);
      }}
    >
      {name}
    </button>
  );
}

function renderText(text: string, keyBase: string): ReactNode[] {
  // `||…||` spoiler pass first (#205): covered segments reveal on click.
  // Wire-plain pipes, so this is purely a viewer-side treatment.
  const segments = spoilerSegments(text);
  if (segments.some((segment) => segment.spoiler)) {
    return segments.map((segment, index) => {
      const key = `${keyBase}.sp${String(index)}`;
      return segment.spoiler ? (
        <Spoiler key={key}>{renderTokens(segment.text, key)}</Spoiler>
      ) : (
        <span key={key}>{renderTokens(segment.text, key)}</span>
      );
    });
  }
  return renderTokens(text, keyBase);
}

/** A covered bar (background = text color, content transparent) until
 * clicked — Discord-style; click again re-covers. */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={revealed}
      title={revealed ? "Hide spoiler" : "Show spoiler"}
      className={`${styles.spoiler} ${revealed ? (styles.spoilerRevealed ?? "") : ""}`}
      onClick={() => {
        setRevealed((on) => !on);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRevealed((on) => !on);
        }
      }}
    >
      {children}
    </span>
  );
}

function renderTokens(text: string, keyBase: string): ReactNode[] {
  return textTokens(text).map((token, index) => {
    const key = `${keyBase}.${String(index)}`;
    switch (token.kind) {
      case "plain":
        return token.text;
      case "link":
        return <LinkChip key={key} href={token.href} />;
      case "mention":
        return (
          <span key={key} className={styles.bodyMention}>
            @{token.name}
          </span>
        );
      case "channel":
        return <ChannelChip key={key} name={token.name} />;
    }
  });
}

/**
 * LinkChip (COMPONENTS-link-preview-eicon.md §1): the one rendering for
 * URLs in message bodies — `[url]` tags (children = the label) and
 * autolinked plain text (no children → derived label + mono host suffix).
 * The ▣ glyph marks previewable media links; behavior follows the
 * linkPreviewMode pref — click mode hijacks plain clicks on *media* links
 * only (Ctrl/Cmd/middle click always navigates), hover mode opens after
 * ~250ms, off = plain links everywhere.
 */
const HOVER_DELAY_MS = 250;

/** A `#Channel` text token: click joins and navigates (the cursor promised
 * an action since M4; the M6 audit called the missing handler out). Only
 * official channels appear as #tokens, so the name doubles as the key.
 * Join-while-joined is a harmless no-op; the route canonicalizes the
 * moment the JCH echo lands. */
function ChannelChip({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={`${styles.bodyChannel} ${styles.nameButton}`}
      title={`Join #${name}`}
      onClick={() => {
        joinAndOpen(name, navigate);
      }}
    >
      #{name}
    </button>
  );
}

/**
 * A `[session]`/`[channel]` invite link (#366): the same channel chip as a
 * `#Channel` token, but joining an arbitrary channel key (an `ADH-…` private
 * id or a public name) under its human `label`. Rendered wherever RichText
 * runs — messages, status lines, profiles — so an invite resolves everywhere
 * instead of vanishing. Join-while-joined is a harmless no-op; the route
 * canonicalizes the moment the JCH echo lands.
 */
function ChannelLink({
  channelKey,
  label,
}: {
  channelKey: string;
  label: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={`${styles.bodyChannel} ${styles.nameButton}`}
      title={`Join ${label}`}
      onClick={() => {
        joinAndOpen(channelKey, navigate);
      }}
    >
      {label}
    </button>
  );
}

/** Join `channelKey` on the active identity and route to it. Shared by the
 * `#Channel` token and the `[session]`/`[channel]` invite links. No-op when no
 * identity is active or its session hasn't synced yet. */
function joinAndOpen(channelKey: string, navigate: NavigateFunction): void {
  const identityId = useUiStore.getState().activeIdentityId;
  if (identityId === undefined) {
    return;
  }
  const session = useSessionsStore.getState().sessions[identityId];
  if (!session?.synced) {
    return;
  }
  void gateway.cmd({
    identityId,
    action: "channel.join",
    d: { key: channelKey },
  });
  void navigate(channelPath(session.character, channelKey));
}

function LinkChip({ href, children }: { href: string; children?: ReactNode }) {
  const prefs = useUserPrefs();
  const mode = prefs.linkPreviewMode;
  const source = resolvePreview(href, prefs.imagePreviewHosts);
  const character = useMemo(() => parseCharacterUrl(href), [href]);
  const openProfile = useContext(ProfileLinkContext);
  const active = useLinkPreviewStore((s) => s.preview?.href === href);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => {
      clearTimeout(hoverTimer.current);
    };
  }, []);

  const previewable = source !== undefined && mode !== "off";
  const host = chipHost(href);
  return (
    <a
      className={`${styles.linkChip} ${active ? (styles.linkChipActive ?? "") : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        // A plain click on an f-list.net/c/<name> link opens the in-app
        // profile viewer (#214); modified clicks (Ctrl/Cmd/Shift, and
        // middle-click, which fires onAuxClick not onClick) follow the URL.
        if (
          character !== undefined &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          openProfile(event.currentTarget, character);
          return;
        }
        if (
          previewable &&
          mode === "click" &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          // Plain click previews; modified clicks follow the URL (§2).
          event.preventDefault();
          openPreviewFrom(event.currentTarget, source, href, "click");
        }
      }}
      onMouseEnter={(event) => {
        if (!previewable || mode !== "hover") {
          return;
        }
        const element = event.currentTarget;
        hoverTimer.current = setTimeout(() => {
          openPreviewFrom(element, source, href, "hover");
        }, HOVER_DELAY_MS);
      }}
      onMouseLeave={() => {
        if (mode !== "hover") {
          return;
        }
        clearTimeout(hoverTimer.current);
        const store = useLinkPreviewStore.getState();
        if (store.preview?.href === href) {
          store.close();
        }
      }}
    >
      <span className={styles.linkChipLabel}>
        {children ?? chipLabel(href)}
      </span>
      <span className={styles.linkChipGlyph} aria-hidden>
        {previewable ? "▣" : "↗"}
      </span>
      {host !== "" && <span className={styles.linkChipHost}>[{host}]</span>}
    </a>
  );
}

/**
 * Inline [icon]/[eicon] (decisions.md §8): fixed 60px box with explicit
 * dimensions so virtualized rows measure right before the image loads;
 * hotlinked + lazy like avatars. [icon] is the character's avatar and links
 * to their profile. A name outside the safe charset falls back to a chip.
 * Eicons obey the Appearance prefs (M5): display mode (inline vs name chip
 * with hover preview vs off — the chip with no preview, #585), the animate
 * toggle (off = frozen first frame), and the block list (chip, no preview —
 * it outranks the display mode). Right-clicking any eicon opens the
 * favourite/block menu.
 *
 * [icon] avatars used to be exempt from every preference; they now obey
 * `showCharacterIcons` (#585), degrading to the same name chip an
 * unrenderable name already falls back to. The profile link survives — the
 * preference is about not showing the portrait, not about breaking the link.
 */
function InlineIcon({ tag, name }: { tag: "icon" | "eicon"; name: string }) {
  const prefs = useUserPrefs();
  const src = tag === "eicon" ? eiconUrl(name) : avatarUrl(name);
  const hidden = tag === "icon" && !prefs.showCharacterIcons;
  if (src === undefined || hidden) {
    const chip = (
      <span className={styles.bodyCode} title={`[${tag}]`}>
        {name}
      </span>
    );
    return hidden ? (
      <a
        href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        {chip}
      </a>
    ) : (
      chip
    );
  }
  if (tag === "icon") {
    return (
      <a
        href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        <img
          className={styles.bodyEicon}
          src={src}
          alt={name}
          title={name}
          width={60}
          height={60}
          loading="lazy"
        />
      </a>
    );
  }
  // A blocked eicon never renders its image, whatever the display mode says
  // — the chip stands in, and (unlike the name-mode chip) it does not
  // preview on hover, which would defeat the block.
  if (hasEicon(prefs.eiconBlocked, name)) {
    return <EiconChip name={name} src={src} animate={false} blocked />;
  }
  // "off" is the blocked rendering without the blocked *meaning*: a plain
  // chip that never previews. The name chip below still previews on hover,
  // which is why "name" was never a way to stop seeing eicons (#585).
  if (prefs.eiconDisplay === "off") {
    return <EiconChip name={name} src={src} animate={false} preview={false} />;
  }
  if (prefs.eiconDisplay === "name") {
    return <EiconChip name={name} src={src} animate={prefs.animateEicons} />;
  }
  return <EiconImage name={name} src={src} animate={prefs.animateEicons} />;
}

function EiconImage({
  name,
  src,
  animate,
}: {
  name: string;
  src: string;
  animate: boolean;
}) {
  const press = useEiconPress(name);
  return animate ? (
    <img
      className={styles.bodyEicon}
      src={src}
      alt={name}
      title={name}
      width={60}
      height={60}
      loading="lazy"
      onContextMenu={(event) => {
        openEiconMenu(event, name);
      }}
      {...press}
    />
  ) : (
    <FrozenImage name={name} src={src} />
  );
}

/**
 * The animate-off rendering: draw the image's current frame onto a canvas
 * the moment it loads — with a GIF that is the first frame, frozen. No
 * crossOrigin attribute on purpose: static.f-list.net serves no CORS
 * headers, so requesting them would fail the load; a tainted canvas is fine
 * (we display, never read pixels back).
 */
function FrozenImage({ name, src }: { name: string; src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const press = useEiconPress(name);
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) {
        return;
      }
      canvasRef.current
        ?.getContext("2d")
        ?.drawImage(img, 0, 0, EICON_BOX, EICON_BOX);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return (
    <canvas
      ref={canvasRef}
      className={styles.bodyEicon}
      width={EICON_BOX}
      height={EICON_BOX}
      title={name}
      role="img"
      aria-label={name}
      onContextMenu={(event) => {
        openEiconMenu(event, name);
      }}
      {...press}
    />
  );
}

/**
 * The eicon menu's second opener (MP2 §1): where the primary pointer cannot
 * hover, a hold calls the same handler the right-click calls. Returns nothing
 * at all on a hover-capable pointer, so a desktop eicon is untouched — which
 * matters more here than anywhere else, since a name-only log mounts one of
 * these per eicon.
 */
function useEiconPress(name: string) {
  return useLongPress((press) => {
    openEiconMenu(press, name);
  });
}

const EICON_BOX = 60;

/**
 * Name-only display mode: a chip that previews the eicon on hover. A blocked
 * eicon reuses the same chip with the preview suppressed — right-clicking it
 * still opens the menu, which is how it gets unblocked.
 *
 * Where the pointer can't hover (MP1 §5-F) the chip is otherwise inert — the
 * whole point of the mode is the preview, and mouseenter never fires — so a
 * tap toggles it there instead. Only there: on a desktop pointer the chip
 * must not swallow clicks it never handled before.
 */
function EiconChip({
  name,
  src,
  animate,
  blocked = false,
  preview = true,
}: {
  name: string;
  src: string;
  animate: boolean;
  blocked?: boolean;
  /** Blocked chips and the "off" display mode both suppress the reveal; only
   * `blocked` also carries the blocked styling and title (#585). */
  preview?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const noHover = useNoHover();
  const revealable = preview && !blocked;
  // Either/or, never both: a tap on a touchscreen still fires the
  // compatibility mouseenter, so leaving the hover handlers wired alongside
  // the tap would have the enter open the preview and the click that follows
  // it close the preview again — one tap, no preview. A blocked chip gets
  // neither: its preview is suppressed in both directions.
  const hoverProps = {
    onMouseEnter: () => {
      setShown(revealable);
    },
    onMouseLeave: () => {
      setShown(false);
    },
  };
  const tapProps = {
    role: "button",
    tabIndex: 0,
    "aria-expanded": shown,
    "aria-label": `${name} — show eicon`,
    onClick: () => {
      setShown((value) => !value);
    },
  };
  const reveal = noHover ? (revealable ? tapProps : {}) : hoverProps;
  const press = useEiconPress(name);
  return (
    <span
      className={styles.eiconChip}
      onContextMenu={(event) => {
        openEiconMenu(event, name);
      }}
      {...reveal}
      {...press}
    >
      <span
        className={`${styles.bodyCode} ${blocked ? (styles.eiconBlockedName ?? "") : ""}`}
        title={blocked ? `${name} — blocked eicon` : "[eicon]"}
      >
        {name}
      </span>
      {shown && (
        <span className={styles.eiconPreview} data-eb-surface>
          <EiconImage name={name} src={src} animate={animate} />
        </span>
      )}
    </span>
  );
}
