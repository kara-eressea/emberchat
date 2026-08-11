// Favicon unread indicator (#390): overlay the tab icon so a backgrounded
// tab still signals waiting traffic. Two tiers, the Discord model — a
// numbered disc for things aimed at you (unread DMs, highlight mentions),
// a plain dot for ordinary channel chatter. Muted conversations and muted
// identities feed neither tier: the favicon is an alert surface, and mutes
// silence alerts (decisions.md §10). Sidebar badges and tint are unchanged
// and keep accruing for muted conversations.

import { PREFS_DEFAULTS, UNREAD_DISPLAY_CAP } from "@emberchat/protocol";
import type { IdentitySession, IdentitySummary } from "../stores/sessions.js";

export interface UnreadIndicator {
  /** Directed attention: unmuted DM unreads plus unmuted channel mentions. */
  count: number;
  /** Ordinary unmuted unread with nothing directed at you (count is 0). */
  dot: boolean;
}

const CLEAR: UnreadIndicator = { count: 0, dot: false };

/**
 * The two-tier attention state across every identity. A synced slice has live
 * per-conversation counters (DM unreads on `dms`, mention + unread counters on
 * `channels`); an unsynced identity only knows the ready-frame totals, which
 * is all we can attribute to it until it subscribes.
 */
export function unreadIndicator(
  identities: IdentitySummary[] | undefined,
  sessions: Record<string, IdentitySession | undefined>,
): UnreadIndicator {
  if (!identities) {
    return CLEAR;
  }
  const prefs = userPrefs(sessions);
  const mutedIdentities = new Set(prefs.mutedIdentityIds);
  const mutedConvs = new Set(prefs.mutedConvIds);

  let count = 0;
  let activity = false;
  for (const identity of identities) {
    if (mutedIdentities.has(identity.id)) {
      continue;
    }
    const slice = sessions[identity.id];
    if (!slice?.synced) {
      // Ready-frame totals are pre-aggregated server-side and cannot be
      // decomposed per conversation here — so the server applies the mute
      // lists before aggregating (identityBadgeTotals): a muted conversation
      // is already out of these numbers, and a muted identity contributes
      // zero. Nothing left to leak while a slice is unsynced.
      count += identity.mentions;
      activity ||= identity.unread > 0;
      continue;
    }
    for (const channel of Object.values(slice.channels)) {
      if (mutedConvs.has(channel.convId)) {
        continue;
      }
      count += channel.mentions;
      activity ||= channel.unread > 0;
    }
    for (const dm of Object.values(slice.dms)) {
      if (mutedConvs.has(dm.convId)) {
        continue;
      }
      count += dm.unread;
    }
  }
  // The dot is the lesser tier — a number already says everything it would.
  return { count, dot: count === 0 && activity };
}

/**
 * Prefs are per app account and identical across slices (see useUserPrefs),
 * so any synced slice answers for all of them. Before the first sync nobody
 * knows the mute lists yet and the defaults (no mutes) stand.
 */
function userPrefs(sessions: Record<string, IdentitySession | undefined>) {
  for (const session of Object.values(sessions)) {
    if (session?.synced) {
      return session.prefs;
    }
  }
  return PREFS_DEFAULTS;
}

const BASE_ICON_HREF = "/favicon.svg";
const CANVAS_SIZE = 32;
/**
 * The one deliberate exception to the token rule (COMPONENTS.md). Canvas can
 * read a resolved token off the root element, and `--eb-danger` (#e08a6a) is
 * the obvious candidate — but it lands within a hair of the flame mark's own
 * amber and the badge vanishes into the icon at 16px. The favicon also lives
 * in browser chrome rather than on a themed surface, so it has no palette to
 * agree with and no business changing when the user swaps accents. Alert red,
 * fixed.
 */
const DISC_COLOR = "#e5484d";

let current: UnreadIndicator | null = null;
let baseImage: HTMLImageElement | undefined;
let canvas: HTMLCanvasElement | undefined;

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

function restorePlainIcon(): void {
  const link = iconLink();
  link.type = "image/svg+xml";
  link.href = BASE_ICON_HREF;
}

function draw(indicator: UnreadIndicator): void {
  if (!baseImage?.complete || baseImage.naturalWidth === 0) {
    return;
  }
  canvas ??= document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(baseImage, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // A filled disc in the top-right corner. The dot tier gets a visibly
  // smaller one: at a 16px favicon a bare disc the width of the numbered
  // badge reads as "the number failed to render", while 0.22 still carries
  // a clear pixel or two of red.
  const label =
    indicator.count > UNREAD_DISPLAY_CAP
      ? `${String(UNREAD_DISPLAY_CAP)}+`
      : String(indicator.count);
  const radius =
    CANVAS_SIZE *
    (indicator.count === 0 ? 0.22 : label.length > 2 ? 0.34 : 0.3);
  const cx = CANVAS_SIZE - radius;
  const cy = radius;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = DISC_COLOR;
  ctx.fill();

  if (indicator.count > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${String(Math.round(radius * 1.3))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + radius * 0.05);
  }

  const link = iconLink();
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}

/**
 * Point the dynamic favicon at a badged render of `indicator`, or restore the
 * plain icon when nothing is waiting. Cheap by construction: a no-op when the
 * tier is unchanged, and the base SVG is rasterised once then reused.
 */
export function applyFaviconBadge(indicator: UnreadIndicator): void {
  if (current?.count === indicator.count && current.dot === indicator.dot) {
    return;
  }
  current = indicator;

  if (indicator.count <= 0 && !indicator.dot) {
    restorePlainIcon();
    return;
  }

  if (!baseImage) {
    baseImage = new Image();
    baseImage.src = BASE_ICON_HREF;
    baseImage.onload = () => {
      // The tier may have changed while the image loaded; render the latest.
      if (current && (current.count > 0 || current.dot)) {
        draw(current);
      }
    };
  }
  draw(indicator);
}
