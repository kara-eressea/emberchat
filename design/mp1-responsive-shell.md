# MP1 — Responsive shell (implementation spec)

> **Shipped — an as-built record, not a plan.** MP1 shipped as **v0.21.0**.
> This document explains what was built and why, which is what a design doc is
> for; it is not a backlog. Open work lives on the issue board (`gh issue
> list`), never here.

Companion to [mobile-client.md](mobile-client.md) §MP1 and issue #375. Decided
with the user 2026-08-02, work started 2026-08-03.

Presentation layer only: no store shapes, no gateway frames, no server code.
The desktop layout above the widest breakpoint must be byte-for-byte the same
experience it is today — every change below is additive and gated on a layout
mode.

## 1. Three named layout tiers

The shell has exactly three tiers. They are named once, in one module, and
never re-derived by eyeballing a pixel count at a call site.

| Tier | Effective width | Shell shape |
|---|---|---|
| `phone` | `< 768` | One pane at a time: conversation list ⇄ conversation. Rail folds into the list header. Members / DM profile are full-height overlays. |
| `compact` | `768 – 940` | Today's grid minus the right column by default; sidebar narrows; toolbar collapses to overflow. |
| `wide` | `> 940` | Today's desktop grid, unchanged. |

`compact` already half-exists as the ad-hoc `(max-width: 899px)` /
`(max-width: 940px)` / `(max-width: 820px)` queries scattered across
`dm-sidebar.ts` and `chat.module.css`. MP1 folds all of them into the tier
model; no new one-off breakpoints may be introduced. Those three had drifted
apart from each other — the DM sidebar and the conversation header disagreed
about when a window was cramped — which is the concrete reason the tiers exist
rather than being tidied in place.

**One survivor, named and provisional — now retired** (package A, deleted by
package C). `899` and `940` folded onto the tier edges cleanly; `820` did not
— it was the width at which the conversation header dropped its topic slot and
clock, and it sat *inside* `compact` rather than on either edge. Package A gave
it a name in `layout-mode.ts` (`HEADER_DENSE_MAX_WIDTH`) and a root attribute
(`data-header`) rather than leaving a pixel literal loose in a stylesheet, on
the understanding that package C would replace it with a measurement.

It did. `layout-mode.ts` now carries the tier model and nothing else, and the
header decides what it can hold from its own measured width
(`components/chat/header-toolbar.ts`). Measuring turned out to be the honest
answer rather than a tidier one: the row is not the window — it is the window
minus the identity rail (hideable, #346) and the sidebar (drag-resizable
between 180 and 400, #292), so `820` meant anywhere from ~330 to ~610 pixels
of actual row. And one number had to serve two different rows: a DM header
carries three more chips and a clock, so `820` was tuned to the busier of
them. Measured in Chromium, a channel now keeps its description through the
whole `compact` tier while a DM sheds its status and clock at ~845 — each row
shedding what it actually cannot carry, within ~25px of where the eyeballed
threshold put it.

## 2. Breakpoints are zoom-corrected — CSS media queries alone are wrong

The interface-scale preference sets `zoom` on `:root` (`theme.ts`). Media
queries and `getBoundingClientRect` are blind to it: at 125% scale a 1000px
window lays out as if it were 800px, but `@media (max-width: 940px)` still
sees 1000 and keeps the wide grid — the columns then overflow. This is the
same class of bug `popover.ts` already works around by dividing by
`--eb-ui-zoom`.

Therefore the **effective width** is `window.innerWidth / uiZoom()`, computed
in JS, and the resulting tier is stamped on the document element as
`data-layout="phone" | "compact" | "wide"`. CSS keys off the attribute
(`:root[data-layout="phone"] …`), never off a raw `@media (max-width: …)` for
shell geometry. Media queries remain fine for things genuinely about the
device rather than the layout box — `prefers-reduced-motion`, `hover: none`,
`pointer: coarse`.

Because a scale change fires no `resize` event of its own, recomputation is
driven by two signals: the window's `resize`, and a `MutationObserver` on the
root's `style` attribute (`applyInterface` is its only writer). Both are
coalesced into one animation frame. The attributes are stamped from boot
(`main.tsx`, right after `applyInterface`) rather than from a React effect, so
nothing paints untiered and the login / identity-picker screens — which live
outside `AppShell` — are covered too.

## 3. Phone toolbar keeps exactly two chips

The conversation toolbar has grown to ~8 controls. On `phone` only two
survive as always-visible chips: **search** and the **notification inbox**.
Everything else goes to the `⋯` overflow menu, reusing `ComposerToolbar`'s
existing ResizeObserver + `COLLAPSE_STEPS` mechanism rather than a second,
parallel one. Search stays the right-most element (matching the full-width
toolbar decision from v0.20.0).

As built (package C): the measurement is shared (`lib/useRowWidth.ts`) and so
is the popover the menu hangs in (`ToolbarPopover.tsx`); the priority table and
width model are a port, because the two rows differ in kind — six fixed
clusters with dividers versus a control set that changes per conversation
(channel vs DM, op-only room chip, a clock only for a partner whose timezone is
known). The collapse order is topic + clock, then pin + mute, then ignore /
room settings / close, then the partner actions menu, then the member-list and
profile-panel toggles. On `phone` the two-chip floor is applied directly rather
than inferred from the arithmetic: a 390px row *can* hold four 30px chips, and
should not be asked to. Above `wide` the row never collapses at all, so the
desktop toolbar is unchanged by construction rather than by arithmetic that
happens to agree.

## 4. Preferences on phone: the cheap stopgap

`PreferencesWindow` is a two-column section-rail-plus-pane dialog and does not
fit a phone. MP1 does **not** rebuild it. The stopgap: below `phone`, stack
the section rail above the pane and let the whole dialog go full-screen. A
proper mobile prefs flow is MP2 scope at the earliest, and only if the user
wants it after soaking.

## 5. Package breakdown

Packages are cut so that A blocks the rest and the others are conflict-free
against each other.

- **A — layout-mode foundation.** `lib/layout-mode.ts`: the tier type, the
  thresholds, `effectiveWidth()`, `useLayoutMode()`, and the effect that
  stamps `data-layout` on `<html>`. Recomputes on resize *and* on
  interface-scale change. `useIsNarrow()` becomes a derivation of the tier
  (`phone | compact`) so there is one source of truth; its ad-hoc query
  constant goes away. Unit tests cover the zoom correction at each boundary.
  **Blocks B, C, D.**
- **B — route-driven pane stack (phone).** The list ⇄ conversation stack,
  driven by the existing routes: an identity route with no conversation shows
  the list; a conversation route shows the conversation with a back affordance
  to the list. No new router state — back is a route change, so the browser
  and Android back gesture work for free. The identity rail folds into the
  list header.
- **C — toolbar collapse.** §3, by porting `COLLAPSE_STEPS`. Also carries one
  to-do handed over from E: the eicon picker's grid is `repeat(5, 60px)` =
  324px of fixed tracks, so under E's viewport cap it scrolls sideways inside
  the panel instead of reflowing. The fix is `repeat(auto-fill, 60px)` in
  `chat.module.css`, which E could not touch — that file belonged to package A
  while E was in flight. C owns the composer/toolbar chrome the picker hangs
  off, so it lands here. *Done:* `auto-fill`, plus 10px on the panel's own
  width — five 60px tiles and their gaps are 324px against 314px of content
  box, so the tab body had in fact been scrolling sideways on a desktop since
  the picker was built. Five tiles fit exactly now, and reflow below that.
- **D — members + DM profile overlay (phone).** The right column becomes a
  full-height overlay on `phone`, extending the drawer shim `DmProfile`
  already has for `narrow`. Member list gets the same treatment. *Done:* one
  shell for both (`components/chat/PanelOverlay.tsx`) — the DM drawer's
  geometry, plus what a surface covering the only pane on screen has to have
  and an ambient drawer beside a two-column layout does not: `aria-modal` with
  a focus trap, and a place on the shared Escape stack as an `overlay` rather
  than the drawer's `ambient`. The panels themselves needed no phone mode at
  all; their docked form is a full-height flex column, which is exactly what
  belongs inside, so the overlay renders them as they are and supplies the
  title and the way out that the docked column gets from the toolbar spanning
  it. Open state is transient (`ui.membersDrawerOpen`, and the existing
  `dmDrawerOpen`) and never the persisted docked prefs, and AppShell closes
  both on every arrival at a conversation: `membersOpen` defaults to *open*,
  which is precisely what made package B pull the list off this tier. The
  compact drawer keeps its own shim rather than being folded in — making it
  modal would change how `compact` behaves, and only `phone` may move. The
  panel's one width is zoom-corrected the way §2 and package E's caps are
  (`min(320px, calc(88vw / var(--eb-ui-zoom, 1)))`): `vw` is a visual length,
  so at 125% on a 390px screen the uncorrected form painted 400px, ran off the
  left edge and took the tap-to-close sliver with it. `data-eb-surface` would
  have capped it too, but that cap means "a floating surface clamped to
  POPOVER_MARGIN on both sides", where this panel is anchored to one edge and
  the space beside it is a tap target rather than a margin. The
  member-list chip is back on the phone toolbar with its count, in the ⋯ menu
  (spec §3 leaves it nowhere else), reading and driving the overlay's state
  the way the DM header's profile-panel chip has driven the drawer since #170.
- **E — popover width caps.** Mini profile cards, eicon previews, topic
  popovers and context menus must cap at the viewport with a margin and never
  induce horizontal page scroll on a 360px screen. Builds on `popover.ts`'s
  existing zoom-corrected clamps.
- **F — hover-affordance fallbacks.** Every control that only appears on
  `:hover` (sidebar row buttons, the unrated ad's rating pill, the eicon
  picker's ☆, close affordances) needs a coarse-pointer path via
  `@media (hover: none)`. Hover-only previews (eicon, link) degrade to tap or
  to nothing — never to an unreachable action. *(This clause originally cited
  "message row actions"; the package's sweep established there are none — a
  message row's only reveal-on-hover control is the ad rating pill. The list
  above is the swept inventory, not a guess.)*
- **G — docs + mobile e2e project.** A scoped Playwright project on a phone
  viewport covering the pane stack, the overflow toolbar and the overlays,
  plus the tier model written into `design/ui/COMPONENTS.md`. *Done:*
  `mobile-chromium`, a Pixel-class device context (393×727, `isMobile`,
  `hasTouch`, coarse pointer, no hover), scoped by filename the way the
  Firefox projects are — `mobile-*.spec.ts` runs there and is excluded from
  the Chromium project, so the two partition the suite rather than overlap
  it. The pane-stack and overlay specs B and D wrote **stay** in the desktop
  project: `setViewportSize` does work inside a mobile context, but it leaves
  `isMobile`/`hasTouch` as the context was built, so their "back on a desktop
  viewport" halves would be asserting about a 1280px touchscreen with a
  phone's user agent. Those specs are about *crossing* the boundary; this
  project is for the paths that are phone from boot to teardown. What it adds
  over them is what a resized desktop cannot reach — `hover: none` (the
  package-F fallbacks and the eicon chip's tap-to-preview), real touch taps —
  plus the daily-driver path nothing exercised at this width: type, send,
  read it back, still at the tail. Two specs, ~6s of wall clock on top of a
  2m29 suite.

PR order, as planned: **A + E + F** (foundation and the two independent polish
packages), then **C**, then **B**, then **D**, then **G**. As shipped: **A**
(#475), **E + F** (#476), **B** (#478), **C** (#479), **D** (#480), **G**
(this one), plus a tracker/spec pass in between (#477). B and C swapped —
they turned out to be conflict-free against each other (B owns the shell grid
and the routes, C owns the header row), so neither had to wait.

## 6. Invariants every package must hold

- Above `wide`, no visual or behavioural change. Existing desktop E2E and unit
  suites pass untouched; a diff that has to edit a desktop assertion is a bug
  in the change, not in the test.
- The message log's scroll invariants (#266 / #360 / #372 / #454 / #464)
  survive every layout switch — a tier flip must not strand the log off-tail.
- Tokens only, per `design/ui/COMPONENTS.md`. No hard-coded hex, no literal
  pixel breakpoint outside `layout-mode.ts`.
- Touch targets are MP2 scope; MP1 must not *reduce* any target below its
  current size.
