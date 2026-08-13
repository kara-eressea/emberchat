# MP2 — Touch-first conversation view (implementation spec)

> **Shipped — an as-built record, not a plan.** MP2 shipped as **v0.22.0**.
> This document explains what was built and why, which is what a design doc is
> for; it is not a backlog. Open work lives on the issue board (`gh issue
> list`), never here.

Companion to [mobile-client.md](mobile-client.md) §MP2 and issue #376. MP1
([mp1-responsive-shell.md](mp1-responsive-shell.md)) shipped in v0.21.0;
this round makes the phone shell it built pleasant to *use*. Decided with the
user 2026-08-04: MP2 → MP3 → MP4 proceed in order, no soak gate between them.

Presentation layer only, same as MP1, and the same standing invariant: above
the `phone` tier, zero visual or behavioural change unless a line here says
otherwise (the one exception is §1's action sheets, which serve every
coarse-pointer device). Tokens per `design/ui/COMPONENTS.md`; the tier and
pointer questions are already answered by `lib/layout-mode.ts` and
`lib/pointer.ts` — no new breakpoints, no new capability probes.

## 1. Long-press action sheets (the context-menu gap)

The one genuine functional hole on touch: every context menu in the app hangs
off `onContextMenu`. Android synthesizes `contextmenu` from a long-press; iOS
Safari never fires it. MP1's stance was "every action has an alternate path";
MP2's is that the menus themselves work.

- **One recognizer, `lib/useLongPress.ts`** (or a non-hook attachment helper
  where menus are opened imperatively): pointer-events based, ~450ms hold,
  cancelled by movement past a slop radius (~10px — a drag is a scroll, not a
  press), by `pointercancel`, and by a second touch. Fires at most once per
  press, and suppresses the click that follows a recognized press.
- **Where the pointer can't hover** (`useNoHover()`), a recognized long-press
  opens the same menu the right-click opens. On hover-capable devices nothing
  changes — right-click already works, and a long left-press on a desktop
  means text selection.
- **The browser's own long-press behaviours must lose** on the elements we
  claim: `-webkit-touch-callout: none` and `user-select: none` on the press
  targets (message rows keep text selection — see below), and the synthetic
  `contextmenu` Android fires must be deduplicated against the recognizer so
  one hold opens one menu, not two.
- **Presentation: a bottom action sheet** on `phone` — full-width, slide-up,
  one action per 44px row, labelled by the target ("Sparkle — eicon"), with
  the same items in the same order as the right-click menu it mirrors, Escape/
  backdrop/swipe-down-free close (swipe gestures are out of scope; backdrop
  tap and ✕ suffice). On `compact`/`wide` coarse-pointer devices the existing
  anchored menu at the press point is fine — the sheet is a phone idiom.
  Whether sheet vs anchored is keyed on tier alone or tier+pointer is the
  implementer's call to argue in the PR.
- **Targets**: everything with an `onContextMenu` menu today — eicons
  (rendered and name-chip), member rows, channel rows in sidebar/browser,
  sidebar conversation rows, and the message-sender name if it has one. Sweep
  `onContextMenu` for the authoritative list rather than trusting this
  sentence.
- **Message body text is exempt**: a long-press on prose must keep native
  text selection. Only discrete interactive elements get the recognizer.

## 2. Composer above the soft keyboard

On-screen keyboards resize the *visual* viewport, not (reliably) the layout
viewport, and the three mobile engines disagree about which. The composer must
sit above the keyboard and the log must stay readable while typing.

- Track `window.visualViewport` (`resize` + `scroll`) in one module —
  `lib/visual-viewport.ts`, same one-subscription shape as `layout-mode.ts` —
  and expose the keyboard inset (layout height − visual height − offsetTop).
- On `phone`, the shell's second row gets `height: <visual viewport height>`
  (or the inset as padding-bottom — implementer's choice, argued in the PR)
  so the composer lands above the keyboard and the toolbar stays visible.
- **Keyboard-open must not strand the log off-tail**: if the log was at the
  tail when the keyboard opens, it is at the tail after the resize settles.
  This is the #372 invariant under a new trigger; test it explicitly.
- Focus scrolling: browsers auto-scroll the focused element into view, which
  can fight the inset math and double-scroll. Verify against real Chromium
  mobile emulation (CDP can resize the visual viewport) and guard with
  `interactive-widget=resizes-content` in the viewport meta **only if
  measurement shows it helps** — it is Chromium-only and changes the default
  behaviour; document what was chosen and why.

## 3. 44px touch targets

On `phone` (plus `hover: none` where that reads better), every interactive
control reaches a ≥44×44 CSS-pixel hit area. Two rules:

- **Hit area, not glyph**: grow padding or use an `::after` overlay to expand
  the target; the visual density of rows should change as little as possible.
  A 30px IconBtn with 7px of added hit padding is compliant; a row of 44px
  buttons that used to be 30px is a redesign nobody asked for.
- **Adjacent targets may not overlap** once expanded — expanding two 30px
  chips 8px each in a 4px-gap row creates ghost presses. Where a row is too
  dense to expand (the toolbar chip cluster), the row itself must change on
  phone (more gap) rather than shipping overlapping targets.
- Audit list: toolbar chips (inline and in `⋯`), sidebar row buttons and
  rows, rail items, member rows, composer toolbar, message-row inline
  elements (eicon chips, name buttons), overlay/sheet close buttons, prefs
  controls on the phone stopgap. Measure with a script, not by eye; report
  the before/after inventory in the PR.

## 4. Scroll invariants under touch momentum

The #372/#374 bottom-stick and #360 anchor invariants were built against
wheel/keyboard scrolling. Touch adds momentum (scroll events keep arriving
after the finger lifts) and overscroll (rubber-banding past the edge).

- `MessageLog`'s stick-release gate (#454) treats `touchstart`/`pointerdown`
  as user intent; verify the *momentum tail* after a fling still counts as
  user-driven (the intent window is 500ms — a long fling outlives it) and fix
  the gate if a fling's tail re-sticks the log mid-scroll.
- `overscroll-behavior: contain` on the log and the sheets, so rubber-banding
  inside them doesn't chain into the page (or trigger pull-to-refresh in an
  installed PWA — MP3 cares).
- E2E: a CDP-driven fling on the mobile project — release mid-momentum,
  assert the log neither jumps to the tail nor lands off-tail afterwards when
  it was at the tail to begin with.

## 5. Package breakdown

- **A — long-press + action sheets** (§1). Owns the menus, `RichText`,
  sidebar/member/channel row press wiring, the sheet component. *Done:*
  `lib/useLongPress.ts` is a React-free state machine behind a hook, so every
  browser quirk it exists for is driven directly by a test — 450ms hold, 10px
  slop, cancelled by `pointercancel` (the compositor announcing a scroll, and
  the most reliable "this was a drag" signal there is) or by a second finger.
  Pointer events rather than touch events, because a touch pointer is
  implicitly captured to the element that got `pointerdown` — no
  document-level listener — and it deliberately does **not** set
  `touch-action: none`: every claimed target sits inside something scrollable,
  and cleaner `pointermove` data is not worth the scroll it would cost. The
  compatibility ("ghost") click is swallowed on `window` in the capture phase
  and told apart from a real tap by its *lack of a `pointerdown`* rather than
  by where it landed — measured in Chromium emulation, the click after a hold
  on an eicon was dispatched to the **sheet's own backdrop**, closing the sheet
  in the frame it appeared in, so a swallow scoped to the pressed subtree would
  have missed it entirely. `MenuSurface` is keyed on the **tier alone** (§1
  left this to the implementer): the sheet answers a geometric question — is
  there room beside the finger — and that is what the tier already is, so
  keying on the pointer too would hand a mouse user in a 390px window the
  cramped popover and a tablet with a paired mouse a sheet it has the width to
  avoid. The five menus render their items unchanged into it; the sheet sizes
  its rows off `[role^="menuitem"]`, the one selector that crosses a CSS-module
  boundary honestly. `data-eb-press` scopes the callout/selection suppression
  to claimed elements, which is how §7's prose exemption is enforced rather
  than merely intended.

  **Outstanding, and it needs hardware:** Android's synthetic `contextmenu` is
  deduplicated in both directions, and that path is covered by unit tests only
  — Chromium's mobile emulation never synthesizes `contextmenu` from a
  dispatched touch hold, so no E2E can reach it. "One hold opens one menu, not
  two" is a real-Android check (see §6).
- **B — keyboard + momentum** (§2 + §4). Owns `Composer` integration,
  `MessageLog`, `lib/visual-viewport.ts`, the shell row height on phone.
  §2 and §4 share MessageLog and the same test fixtures, so they ship
  together. *Done:* the inset is published as a CSS custom property written
  imperatively on `:root`, not as React state — a keyboard animates open over
  ~250ms and routing that through `useSyncExternalStore` would re-render the
  virtualized log and every visible row ~15 times per keypress on the devices
  with the least CPU to spare. **The shell shrinks** rather than the composer's
  row gaining padding (§2 left this to the implementer): the shell is the one
  element the phone layout hangs off, so `height: calc(100% - var(…))`
  shortens the log's track and carries composer and toolbar up in one reflow,
  and every fixed/absolute child positioned against it stays correct — padding
  the row would leave the shell overlapping the keyboard and need a correction
  per floating surface. The arithmetic divides by the interface scale for the
  same reason `layout-mode.ts` does, which measurement showed is not optional:
  at 125% both viewport heights keep reporting viewport pixels while a `100px`
  term inside `calc()` on the zoomed root paints as 125 of them, so the raw
  difference would shrink the shell by 1.25× the keyboard. A 120px floor keeps
  a retracting Android address bar from ever being read as a keyboard.
  `interactive-widget=resizes-content` was **not** added: it works, and it is
  Chromium-only, so the module has to exist for iOS and Firefox regardless —
  adding it would take the one engine most of our phone testing runs on out of
  the code path.

  **MessageLog is unchanged, and that is the finding.** The §4 suspicion was
  measured rather than assumed: instrumenting synthesized flings shows
  Chromium's deceleration is heavily front-loaded, and every gesture that
  crosses the 120px stick-release hysteresis at all crosses it 21ms, 35ms and
  145ms after `touchend` — far inside the 500ms intent window — while an upward
  fling only ever grows the distance from the bottom, so the ungated re-stick
  branch never sees `bottom`. The momentum-continuation fix drafted for this
  would have widened the #411 stranding window from 500ms to 2500ms to fix a
  bug that is not there, so it was dropped and the spec is the guard instead.

  **Outstanding, and it needs hardware:** that fling table is *Chromium's*
  deceleration curve. iOS's is a different curve on a different compositor, and
  it is the engine the module exists for. If "flick, then the log is glued
  again" ever shows up on an iPhone, the table above is where the investigation
  starts — the question is whether Safari's tail crosses the hysteresis later
  than 500ms after the finger lifts.
- **C — touch targets** (§3). A CSS-heavy sweep; runs after A so it measures
  the sheets too. *Done:* `--eb-touch-target` in `base.css` names the floor
  once, and which of the two mechanisms a control gets is decided by what sits
  next to it — a stacked row grows (sidebar 28→44, member rows 38→44, menu
  rows 34→44), everything else keeps its box and gains a centred `::after`
  sized `max(100%, 44px)`. Where two expanded neighbours would then contest the
  same pixels the **row** opens up instead (the toolbars and the MeBar to a
  16px gap, the swatch row to 22), which is §3's adjacency rule taken
  literally rather than shipped as overlapping targets. Two consequences worth
  recording: the composer toolbar's width model had to learn about the phone
  gap (a row that never wraps and never scrolls would otherwise push chips off
  the screen — one more chip folds into `⋯` on a phone, which is what buys the
  rest a thumb-sized target), and **the MP1 §4 preferences stopgap finally
  landed here**. MP1 specified stacking the rail above a full-screen pane and
  shipped without it, leaving a 204px rail beside a 157px pane and the
  highlight-rule form's segmented switch clipped off the edge of the window —
  which is not something a hit area can fix, so the stopgap had to precede the
  floor it is measured against. Message-log prose is the documented shortfall,
  and the argument is in the exclusion list rather than in a commit message: a
  21px line box whose neighbours above and below are the same kind of target
  cannot carry 44px without handing the press to the wrong line. Everything
  measured by hit-testing (`e2e/touch-targets.ts`), because an `::after` has no
  node for a rect API to report.
- **D — mobile E2E additions + docs** (MP4's MP2 slice). New mobile specs for
  the sheets, the keyboard, and the fling; `COMPONENTS.md` gains the sheet
  and target conventions; tracker updates. Runs last. *Done:* A, B and C each
  shipped their own spec, so this package was an **audit** rather than the
  suite — §1–§4 walked clause by clause against what already existed, and only
  the genuine holes filled. Two, both of them wiring rather than behaviour.
  `mobile-sheets.spec.ts` is a census: `useLongPress` is spread onto ten
  elements across five files and a row that forgets `{...press}` fails
  *silently* — it keeps its `onContextMenu`, so every desktop and unit test
  still passes and the menu is simply gone on an iPhone, which is the bug §1
  exists to fix re-introduced one surface at a time. One hold on each claimed
  class, and on the two surfaces with a competing gesture (a picker tile
  inserts, a member row opens the profile card) the hold also has to leave the
  ghost click on the floor. §7's prose exemption is read off the rendered
  document in the same file — no element from a message's words up to the log
  carries `data-eb-press`, which is the whole enforcement — and a stylesheet
  guard in `base.test.ts` closes §7's `dvh`/`svh` clause, which nothing else
  could have noticed. `mobile-prefs.spec.ts` guards C's stopgap the only
  way that works: **geometrically**, because a tap alone passes on the broken
  layout — Playwright scrolls an element into view before clicking it, so the
  clipped switch was reachable by a test and by nothing a user has. The CDP
  hold moved to `e2e/long-press.ts` on its third copy, and learned to settle
  the shell's animations before measuring: a row in the member overlay
  measured mid-slide reported `x: 326` on a 393px screen, so the gesture went
  to the backdrop and *nothing happened* — a press that never lands looks
  exactly like a row that never claimed one, which is the failure this file is
  supposed to catch. What was deliberately *not* re-tested is listed with the
  audit in the PR: everything §7 states that a unit test already pins exactly.

  **Two findings, neither fixed here.** The sheet is `position: fixed; bottom:
  0` — pinned to the *layout* viewport, which no keyboard shrinks on iOS or
  Chrome Android, and it does not read `--eb-keyboard-inset`. Under B's shim it
  sits entirely behind the keyboard line. What saves it on a device is that it
  is modal: opening it blurs the composer, and a blurred field is what retracts
  the keyboard. That is an inference about engine behaviour, so the E2E pins
  the half it can — the sheet takes focus off the composer — and §6 checks the
  other half by hand. And the member menu's **"Invite to" submenu opens on
  `onMouseEnter`**, which the engine's compatibility mouse events fire as the
  sheet rises under the finger: a sheet raised from a DM row arrives with the
  submenu already expanded, and since a touchscreen never sends the matching
  `mouseleave` and the trigger is open-only by design, there is no gesture on a
  phone that collapses it again — only Escape, which a phone does not have.
  MP1 package F swept `:hover` *styles* for this; a hover-driven *behaviour*
  inside the surface built for touch is the same bug one layer up.

PR order, as planned: **A + B** in parallel (disjoint files), then **C**, then
**D**. As shipped: **A** (#484), **B** (#485), **C** (#486), **D** (this one).
A and B did run in parallel; C waited for A as designed, and picked up MP1's
unbuilt §4 on the way.

## 6. What only real hardware can answer

Everything MP2 built was verified against Chromium's mobile emulation, which is
a real Blink with a phone's viewport, touch pointer and `hover: none` — and is
*not* a phone. Three engine behaviours it does not reproduce at all, and one it
reproduces with its own numbers: Android's synthetic `contextmenu`, iOS's
callout and compatibility-click timing, iOS's keyboard, and WebKit's
deceleration curve. MP4 put the layout half of that on a real WebKit (the
`mobile-webkit` Playwright project); the rest still needs a phone.

The checks themselves now live in
**[mobile-device-checklist.md](mobile-device-checklist.md)**, merged with
MP3 §8's into one list ordered as one sitting — an Android pass, then an iOS
pass. This section is the pointer; the list is there.

## 7. Invariants

- Above `phone`, no change on hover-capable devices. Coarse-pointer `compact`/
  `wide` may gain long-press menus (§1) — that is the only exception.
- The log's scroll invariants hold under every new input mode this round adds.
- No new breakpoints, no capability probes outside `lib/pointer.ts` /
  `lib/layout-mode.ts`; no `dvh`/`svh` units without a written argument (the
  visual-viewport module is the one source of keyboard truth).
- Native text selection on message prose survives package A.
