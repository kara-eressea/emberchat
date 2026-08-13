// The member-row status line (#217, #494): the second line under a nick,
// rendering the restricted subset member-status.ts produces — colours and
// images, nothing interactive, since the row itself is the button.

import { memo, useEffect, useMemo, useRef } from "react";
import { avatarUrl, eiconUrl } from "../../lib/avatar.js";
import { wireToPlainText } from "../../lib/wire-text.js";
import { useUserPrefs } from "../../stores/sessions.js";
import { hasEicon } from "./eicon-lists.js";
import { statusSegments } from "./member-status.js";
import styles from "./chat.module.css";

/** Status images are pinned to the status line box, not the 60px box the
 * message log uses — a status must never be able to grow a member row (the
 * channel-header topic preview solves it the same way). Kept in sync with
 * `.memberStatusIcon` in chat.module.css: the attributes reserve the space
 * before the image loads, the class enforces it after. */
const ICON_PX = 14;

export const MemberStatus = memo(function MemberStatus({
  statusmsg,
  self = false,
}: {
  statusmsg: string;
  /** Your own row, which `showOthersStatus` never hides (#585). Defaults to
   * false so a new call site errs towards hiding rather than leaking. */
  self?: boolean;
}) {
  const hidden = !useUserPrefs().showOthersStatus && !self;
  const segments = useMemo(() => statusSegments(statusmsg), [statusmsg]);
  // The hover tooltip stays the flattened plain text — the full status, for
  // the common case where the line is clipped.
  const plain = useMemo(() => wireToPlainText(statusmsg), [statusmsg]);
  // After the memos, never between them — an early return above a hook is a
  // conditional hook call.
  if (hidden || segments.length === 0) {
    return null;
  }
  return (
    <span
      className={styles.memberStatus}
      title={plain === "" ? undefined : plain}
    >
      {segments.map((segment, index) => {
        const key = `s${String(index)}`;
        if (segment.kind === "image") {
          return <StatusIcon key={key} tag={segment.tag} name={segment.name} />;
        }
        // Uncoloured runs render as bare text on purpose: no wrapper span
        // means the status line has exactly one text-bearing element in the
        // common (tagless) case.
        return segment.color === undefined ? (
          segment.text
        ) : (
          <span key={key} className={styles[`bbc-${segment.color}`] ?? ""}>
            {segment.text}
          </span>
        );
      })}
    </span>
  );
});

/**
 * An `[icon]`/`[eicon]` inside a status. Obeys the eicon prefs the log obeys
 * (M5): a blocked eicon never renders its image anywhere, and the name-only
 * display mode has no room for its hover preview in a row, so both degrade to
 * the plain name. Deliberately without the log's right-click/long-press eicon
 * menu: in a member row that gesture already belongs to the member menu.
 */
function StatusIcon({ tag, name }: { tag: "icon" | "eicon"; name: string }) {
  const prefs = useUserPrefs();
  const src = tag === "eicon" ? eiconUrl(name) : avatarUrl(name);
  const suppressed =
    tag === "icon"
      ? // A portrait in a status is still a portrait (#585).
        !prefs.showCharacterIcons
      : hasEicon(prefs.eiconBlocked, name) ||
        // Both non-inline modes degrade to the name here: the row has no room
        // for "name" mode's hover preview, and "off" wants no image anywhere.
        prefs.eiconDisplay !== "inline";
  if (src === undefined || suppressed) {
    return <>{name}</>;
  }
  if (tag === "eicon" && !prefs.animateEicons) {
    return <FrozenIcon name={name} src={src} />;
  }
  return (
    <img
      className={styles.memberStatusIcon}
      src={src}
      alt={name}
      title={name}
      width={ICON_PX}
      height={ICON_PX}
      loading="lazy"
    />
  );
}

/** The animate-off rendering, the RichText treatment at row scale: draw the
 * image's current frame — with a GIF, its first — onto a canvas. No
 * crossOrigin on purpose (static.f-list.net serves no CORS headers); the
 * tainted canvas is fine, we display and never read pixels back. */
function FrozenIcon({ name, src }: { name: string; src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) {
        return;
      }
      canvasRef.current
        ?.getContext("2d")
        ?.drawImage(img, 0, 0, ICON_PX, ICON_PX);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return (
    <canvas
      ref={canvasRef}
      className={styles.memberStatusIcon}
      width={ICON_PX}
      height={ICON_PX}
      title={name}
      role="img"
      aria-label={name}
    />
  );
}
