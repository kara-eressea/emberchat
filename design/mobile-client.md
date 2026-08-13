# MP — Mobile web client (responsive/PWA)

> **Shipped — an as-built record, not a plan.** The MP track is closed —
> MP1–MP4 all shipped (v0.21.0–v0.23.0). This document explains what was built
> and why, which is what a design doc is for; it is not a backlog. Open work
> lives on the issue board (`gh issue list`), never here.

**Closed track.** Planned 2026-07-23 with the user, built 2026-08-03/04:
MP1 (v0.21.0), MP2 (v0.22.0), MP3 (v0.23.0), MP4 (tests and docs — no release
of its own). The phone shell, its touch grammar, its install surface and its
test tier all shipped; what is left is a real-device confidence pass, gathered
into [mobile-device-checklist.md](mobile-device-checklist.md).

This file is the track's plan and its rationale record — why mobile, and why
not an app store. **The authoritative as-built specs are the three companion
documents**, one per implementation milestone:

| | Spec | What it holds |
|---|---|---|
| MP1 | [mp1-responsive-shell.md](mp1-responsive-shell.md) | The three zoom-corrected layout tiers, `data-layout`, the pane stack, the toolbar collapse, the phone overlays |
| MP2 | [mp2-touch.md](mp2-touch.md) | Long-press action sheets, the keyboard inset, 44px targets, the momentum finding |
| MP3 | [mp3-pwa.md](mp3-pwa.md) | Manifest and icons from config, safe areas, theme-color, the frozen-tab lifecycle fixes |

MP4 (#500) has no spec of its own — it was an audit, and its findings are written into
the three above, into `design/ui/COMPONENTS.md`, and into the checklist. Its
one durable artefact is the `mobile-webkit` Playwright project: the phone specs
on a second engine, which is as close to iOS Safari as anything automatable
gets. See the tracker's log entry for what it found.

The track was ordered ahead of the MX desktop client build (MX1's server-side
extraction could proceed in parallel — the two touch disjoint code).

## Why mobile, and why not an app store

The bouncer architecture makes mobile the highest-value missing surface: the
server holds the session and the history, so a phone check-in ("read what I
missed, fire off a reply") composes directly with the product's core features.
A desktop user already has the full experience in a browser tab; a phone user
today has almost nothing — the shell is a fixed multi-column desktop grid.

Native/store distribution was considered and rejected:

- **Apple App Store**: Guideline 1.1.4 bans overtly sexual material; a
  dedicated client for an 18+ platform has none of the "general-purpose
  platform with moderation" cover that lets Discord/Reddit pass review. Apple
  has historically rejected exactly this category. Google Play's policy is
  equivalent.
- **UGC rules**: stores require the app vendor to own filtering/reporting/
  blocking levers we don't hold as a third-party client.
- **Risk posture**: a store listing is a billboard — it invites platform and
  vendor attention the project deliberately avoids (risks-and-open-questions.md).

The path is therefore a **responsive web client installed as a PWA**
(add-to-home-screen against the user's own instance). No review, no store, no
new install target; it inherits the self-host model as-is. EU sideloading /
alternative marketplaces and Android APKs remain open later if ever wanted.

## Scope

Presentation-layer only. Stores, gateway protocol, and server are untouched.
Desktop layout is unchanged above the breakpoint.

- **MP1 — responsive shell.** One breakpoint (~768px) switches the desktop
  grid (rail / sidebar / log / members) to a single-pane navigation stack:
  conversation list ⇄ active conversation, with back navigation. The identity
  rail folds into the conversation-list header. Members/settings become
  overlays (MP2).
- **MP2 — touch-first conversation view.** Composer above the soft keyboard
  (visualViewport), 44px touch targets, member list/profiles as bottom sheets
  or full-screen overlays, context menus as long-press action sheets. The
  message log's scroll invariants (#266/#360/#372) must hold under touch
  momentum on mobile Safari/Chrome.
- **MP3 — PWA plumbing.** Manifest + icons (product name from config tokens),
  add-to-home-screen, safe-area insets, theme-color from the active theme,
  reconnect-on-visibility tightened for mobile tab freezing. **No offline
  mode** — the client is a live view onto the bouncer; scope is install,
  display, and lifecycle only.
- **MP4 — mobile e2e tier + docs.** Playwright mobile-emulation projects
  (touch, small viewports) covering the stack, keyboard, sheets, and scroll
  invariants; self-host docs gain an install-to-home-screen section. *As
  built:* the suite arrived a package at a time with the milestones that
  needed it (MP1 package G opened `mobile-chromium`, MP2 package D audited its
  own spec, MP3 package B the install docs), so MP4 was the closing sweep
  rather than the build — a second engine (`mobile-webkit`), the coverage
  audit MP2 had had and MP1/MP3 had not, and this consolidation.

MP1's "one breakpoint (~768px)" was superseded during planning by three named,
zoom-corrected tiers — see [mp1-responsive-shell.md](mp1-responsive-shell.md),
the authoritative MP1 spec, for the tier table, the package cut and the
invariants.

## Non-goals

- Native iOS/Android apps, app-store distribution, push notifications via
  store services (revisit only if the risk posture ever changes).
- Offline reading/queueing — the bouncer holds history; the client stays a
  live view.
- Tablet-specific intermediate layouts in the first pass (the desktop grid is
  acceptable on large tablets; refine later if the user wants it).

## Tracking

GitHub milestone "MP — Mobile web (PWA)": #375 (MP1), #376 (MP2), #377 (MP3),
#378 (MP4), dependency-ordered. All four closed; the milestone is complete.
