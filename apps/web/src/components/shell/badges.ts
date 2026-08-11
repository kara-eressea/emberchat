// Shared presence-dot classes + badge clamp for the rail and sidebar —
// previously duplicated in both (M3 audit backlog).

import { UNREAD_DISPLAY_CAP } from "@emberchat/protocol";
import type { DotKind } from "../../lib/presence.js";
import styles from "./shell.module.css";

export const DOT_CLASS: Record<DotKind, string> = {
  ok: styles.dotOk!,
  warn: styles.dotWarn!,
  faint: styles.dotFaint!,
};

/**
 * Badge counts render at most two digits: anything past the cap → "99+".
 *
 * The threshold is the wire's own saturation point (#582), not a private
 * display choice: counts arrive already saturated at UNREAD_DISPLAY_CAP + 1,
 * so testing against anything higher gives a badge that can never say "99+".
 */
export function clampBadge(count: number): string {
  return count > UNREAD_DISPLAY_CAP
    ? `${String(UNREAD_DISPLAY_CAP)}+`
    : String(count);
}
