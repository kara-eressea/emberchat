// Character avatar: real F-List profile image with the designed
// initial-on-color fallback as the loading/error state (decisions.md §6).
//
// Every portrait in the app is one of these — member list, mini card, profile
// viewer, quick switcher, character search, DM header, rate editor, guestbook,
// identity rail and picker — so the `showCharacterIcons` preference (#585) is
// enforced here once rather than at each of them. Off reuses the fallback that
// already exists: the initial on its colour, same box, same layout, no image
// request. The inline `[icon]` tag renders portraits outside this component
// (RichText, MemberStatus) and gates itself on the same preference.

import { useState } from "react";
import { avatarUrl, nameInitial } from "../../lib/avatar.js";
import { useUserPrefs } from "../../stores/sessions.js";
import { nickColor } from "../../theme/tokens.js";
import styles from "./avatar.module.css";

export interface AvatarProps {
  name: string;
  /** Box size in px; radius and dot specs follow COMPONENTS.md. */
  size: number;
  /** Rounded square (active identity) instead of a circle. */
  square?: boolean;
}

export function Avatar({ name, size, square = false }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showIcons = useUserPrefs().showCharacterIcons;
  const url = avatarUrl(name);
  const showImage = url !== undefined && !failed && showIcons;

  return (
    <span
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        borderRadius: square ? "11px" : "50%",
        backgroundColor: nickColor(name),
      }}
      aria-hidden="true"
    >
      {!(showImage && loaded) && nameInitial(name)}
      {showImage && (
        <img
          className={styles.image}
          src={url}
          alt=""
          loading="lazy"
          width={size}
          height={size}
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => {
            setLoaded(true);
          }}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
