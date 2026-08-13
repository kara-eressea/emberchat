// Shared chrome glyphs — inline SVG at the IconBtn standard (17px in a 30px
// hit target, viewBox 0 0 24 24, 1.7 stroke in currentColor), matching the
// composer toolbar's `svg()` so magnifiers, gears and power toggles read at
// the same weight everywhere instead of relying on undersized Unicode glyphs
// (COMPONENTS.md §IconBtn; issue #232).

import type { ReactNode } from "react";

/** The IconBtn box, and the stroke that paints in it: 1.7 units of a 24-unit
 * viewBox drawn at 17px is a 1.2px line. */
const GLYPH_SIZE = 17;
const GLYPH_STROKE = 1.7;

export interface GlyphProps {
  /** Box size in px, when a surface needs the glyph smaller than the IconBtn
   * standard (the sidebar's row and heading glyphs, #490). The stroke is
   * re-derived from it so a 14px glyph still paints the same 1.2px line: a
   * stroke that scaled with the box is exactly what turned the small glyphs
   * into smudges. */
  size?: number;
}

function svg(children: ReactNode, size = GLYPH_SIZE): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(GLYPH_STROKE * GLYPH_SIZE) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Magnifier — replaces the small `⌕` glyph on search affordances. */
export function SearchGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </>,
    size,
  );
}

/**
 * SFW mode (#580) — an eye, and the same eye struck through when the mode is
 * on. One glyph in two states rather than two glyphs, so the button reads as a
 * toggle of one thing.
 */
export function SfwGlyph({
  size,
  on = false,
}: GlyphProps & { on?: boolean }): ReactNode {
  return svg(
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      {on && <path d="M4 20L20 4" />}
    </>,
    size,
  );
}

/** Settings gear — replaces the small `⚙` glyph on the preferences button. */
export function GearGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.6M12 17.9v2.6M4.7 4.7l1.85 1.85M16.45 16.45l1.85 1.85M3.5 12h2.6M17.9 12h2.6M4.7 19.3l1.85-1.85M16.45 7.55l1.85-1.85" />
    </>,
    size,
  );
}

/** Power toggle — replaces the `⏻` glyph on the connect/log-off button. */
export function PowerGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M12 3.5v8" />
      <path d="M6.8 7.2a8 8 0 1 0 10.4 0" />
    </>,
    size,
  );
}

/* The conversation toolbar (COMPONENTS.md §5) runs on the same IconBtn spec
 * as the composer toolbar, which forbids system emoji — these replace the
 * ⚲ 🔔 ⊘ ☰ ◨ ⋮ ✕ characters the header used to render. */

/** Pin — a thumbtack, for "rejoin/reopen this on connect". */
export function PinGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M9 3.6h6" />
      <path d="M10 3.6v6.2l-2.8 3v1.1h9.6v-1.1l-2.8-3V3.6" />
      <path d="M12 13.9v6.5" />
    </>,
    size,
  );
}

/** Bell — per-conversation alerts on. */
export function BellGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M6.2 10a5.8 5.8 0 0 1 11.6 0c0 3.6 1.2 5 1.9 5.8H4.3c.7-.8 1.9-2.2 1.9-5.8Z" />
      <path d="M10.1 18.6a2 2 0 0 0 3.8 0" />
    </>,
    size,
  );
}

/** Bell with a slash — muted. A distinct glyph, not just a toggled bell:
 * the off state has to read without relying on the accent fill alone. */
export function BellOffGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M6.2 10a5.8 5.8 0 0 1 11.6 0c0 3.6 1.2 5 1.9 5.8H4.3c.7-.8 1.9-2.2 1.9-5.8Z" />
      <path d="M10.1 18.6a2 2 0 0 0 3.8 0" />
      <path d="M4 4l16 16" />
    </>,
    size,
  );
}

/**
 * Paper tray — the notification inbox (#467). Deliberately not a bell: the
 * bell is the per-conversation mute toggle two chips away, and two bells in
 * one cluster meaning opposite things is the sort of thing nobody unlearns.
 * A tray reads as "things that arrived and stayed", which is what the inbox
 * is: a log, not an alert.
 */
export function InboxGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M3.6 13.2h4.1l1.3 2.2h6l1.3-2.2h4.1" />
      <path d="M6.2 4.8h11.6l2.6 8.4v4.2a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8v-4.2Z" />
    </>,
    size,
  );
}

/** Tick — accept a friend request from the notification inbox (#505). Paired
 * with CloseGlyph as its refusal, so the two read as one control's two
 * answers rather than as an action and an unrelated dismissal. */
export function CheckGlyph({ size }: GlyphProps): ReactNode {
  return svg(<path d="M5.2 12.6l4.4 4.4 9.2-10" />, size);
}

/** Waste bin — remove one entry from the notification log (#506). Lid, body
 * and two staves: at 15px the staves are what stop the body reading as a
 * plain box, and the lid overhang is what stops it reading as a cup. */
export function TrashGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M4.2 6.6h15.6" />
      <path d="M9.4 6.6V4.4h5.2v2.2" />
      <path d="M6.4 6.6l.9 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.9-12" />
      <path d="M10.4 10.2v6.2M13.6 10.2v6.2" />
    </>,
    size,
  );
}

/** Circle-slash — the ignore toggle (a danger action, tinted by CSS). */
export function BanGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M6.1 6.1l11.8 11.8" />
    </>,
    size,
  );
}

/** Two figures — the member-list toggle, paired with the mono count. */
export function MembersGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="9.6" cy="8.4" r="3.2" />
      <path d="M3.8 19v-1.2a4 4 0 0 1 4-4h3.6a4 4 0 0 1 4 4V19" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.6 13.9a4 4 0 0 1 2.6 3.7V19" />
    </>,
    size,
  );
}

/** A panel with its right column split off — the DM profile-panel toggle. */
export function PanelRightGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4" />
      <path d="M14.6 4.4v15.2" />
    </>,
    size,
  );
}

/** Vertical ellipsis — opens the conversation's context menu. */
export function MoreGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="5.6" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.4" r="1.35" fill="currentColor" stroke="none" />
    </>,
    size,
  );
}

/** Clock face — the DM partner's local time (#439). */
export function ClockGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.1 2" />
    </>,
    size,
  );
}

/** Cross — closes the conversation window. */
export function CloseGlyph({ size }: GlyphProps): ReactNode {
  return svg(<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />, size);
}

/** Left chevron — back out of the phone stack's conversation pane (#375). A
 * bare chevron, not an arrow: it is a navigation-stack affordance, and every
 * phone platform draws that one the same way. */
export function BackGlyph({ size }: GlyphProps): ReactNode {
  return svg(<path d="M14.5 5.5L8 12l6.5 6.5" />, size);
}

/* The sidebar (COMPONENTS.md §3–4) joins the same spec (#490). Its glyphs
 * were the last Unicode ones left in the shell — ▸ ▾ ⚲ ★ ⚑ set at 9–11px,
 * where a font's own hinting decides how much of a ⚲ survives, and the answer
 * was "not enough to read". */

/** Down chevron — a section heading's open state. The collapsed state is the
 * same glyph a quarter-turn anticlockwise (CSS), not a second path: one shape
 * rotating is what tells a reader the two states are the same control. */
export function ChevronGlyph({ size }: GlyphProps): ReactNode {
  return svg(<path d="M5.8 9.2L12 15.4l6.2-6.2" />, size);
}

/** Five-pointed star — a friend row (§4's `★`, and the profile badge's). */
export function StarGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <path d="M12 3.2l2.12 5.87 6.44.13-5.14 3.89 1.87 6.17L12 15.6l-5.29 3.66 1.87-6.17-5.14-3.89 6.44-.13Z" />,
    size,
  );
}

/** Pennant on a staff — a bookmark row (§4's `⚑`). */
export function FlagGlyph({ size }: GlyphProps): ReactNode {
  return svg(
    <>
      <path d="M6.4 3.4v17.2" />
      <path d="M6.4 4.8h11.4l-2.7 3.7 2.7 3.7H6.4Z" />
    </>,
    size,
  );
}
