# Milestone 10 — Ads & character search

> **Shipped — an as-built record, not a plan.** M10 shipped as **v0.9.0**
> (2026-07-20). This document explains what was built and why, which is what a
> design doc is for; it is not a backlog. Open work lives on the issue board
> (`gh issue list`), never here.

*Created 2026-07-16 during the M8 scope session; **specced 2026-07-18** with
the user. Ships as **v0.9.0**. Auto-posting/rotation and the remaining
discovery extras are deferred to the [M11 candidate pool](milestone-11-discovery-extras.md).*

**Goal:** the discovery round — authoring and manually posting roleplay ads
from a per-character ad library, a Rising-style Chat/Ads/Both channel view,
cache-only match chips on ads, and in-app FKS character search with saved
searches. Leans on M8's profile service and `@emberchat/matcher`; **no
automation** — every ad post is a user action.

**Depends on:** M8 (reuses `ProfileDto`, the profile cache/budget,
`@emberchat/matcher`, the mini card / profile viewer) and M6 (LRP send path
on the `lfrp_flood` pace, RMO mode gating, the `hideAds` prefs this
milestone evolves).

## Decisions (2026-07-18 scope session)

- **Scope:** ad center (manual posting only), Chat/Ads/Both channel view,
  cache-only match scores on ads, FKS search with full filters + saved
  searches. **Deferred to M11:** auto-posting/rotation, ad ratings,
  smart-filter auto-replies, keyword ad-filter rules, per-character ad
  hiding, hide-below-score. Rotation posture was pre-decided and is
  recorded in the M11 file so it survives until then.
- **Ads are per-character** (per identity), not per app account — an ad
  rarely fits several characters.
- **Ad bodies are Markdown** through the M4 pipeline, translated to BBCode
  at post time. New: a **lossiness check** — Markdown constructs that can't
  translate into the supported BBCode subset get a visible warning before
  send (shared machinery in `markdown-bbcode`, surfaced in the ad editor
  and the main composer).
- **Length is hard-capped in the editor** against the channel max-length
  VAR at runtime, with a live counter that turns amber then red — never a
  post-hoc refusal for something the editor let you type.
- **Multiple ads may target the same channel** (Horizon-style library);
  with rotation deferred, M10 posting is always an explicit "post this ad
  now". **Post-time targeting** (settled by the step-1 survey — Horizon
  stores no channels on the ad): the posting flow selects ads by tag and
  channels from the joined ads/both-mode set; nothing channel-shaped is
  stored on the ad itself.
- **UI shape:** an ad scratchpad/manager opened from a button in the
  composer formatting toolbar — write, preview (M4 tokenizer), pick
  channels, post. UI-heavy steps go through a **Claude Design pass** first
  (M8 pattern).
- **Chat/Ads/Both** per-channel view selector (F-Chat Rising's "Show"
  control) **replaces** M6's boolean hide-ads override; the M6 semantics
  stay: a filtered ad is not rendered, doesn't count unread, history keeps
  it — silent, no "N hidden" indicator. The global `hideAds` default
  becomes the global default view; existing prefs migrate (`hideAds: true`
  → Chat, `false` → Both).
- **Match scores never trigger a fetch** (click-only budget rule): ad rows
  show a score chip only when the poster's profile is already in the M8
  cache; otherwise nothing until the user opens the profile themselves.
  No hide-below-score filtering (inconsistent by construction — M11 pool).
- **FKS search** lives next to the M6 channel browser. Full filter set
  (kinks via the mapping list, genders / orientations / languages /
  furryprefs / roles). The wire supports **no free text** — FKS returns
  bare character names — so the free-text box filters result names
  client-side only. Result rows: avatar + name + cached match chip (same
  cache-only rule), mini card / profile viewer on click. Obey server
  throttling and surface "too many results" refinement errors; no
  client-side cleverness beyond a cooldown UI.
- **Saved searches** (per app account): store the filter set and the last
  run's result name-set; rerunning diffs the sets and badges "N new since
  last run". Deliberately simple — no background re-running.
- **Open protocol questions → step 0 investigation** (the user is unsure,
  official-client behavior is the reference): whether ads carry any
  tagging/targeting conventions worth imitating from Horizon's ad center,
  and how F-Chat 3 / Horizon shape ad→channel targeting. Findings recorded
  here before the ad-center steps build.
- **Live verification posture:** **no automated live testing of ad
  posting.** Manual posting is verified against fchat-sim; any live
  confirmation is a single supervised manual post in a room the user
  controls, at their discretion.

## Step 1 findings (2026-07-18 — Horizon/Rising survey + protocol review)

Behavioral survey of `Fchat-Horizon/Horizon` (MPL-2.0 — file-level
copyleft; **behavior imitated, no code copied**) plus a pass over our own
protocol docs and M6 implementation. What it settled:

- **Ad shape:** Horizon's Ad Center stores per-character ads as exactly
  `{ disabled, tags[], content }` — no title, no per-ad channel list, no
  weights. Empty-content ads are dropped on save; a tagless ad gets the
  tag `default`. Adopted for our step 3 (plus our explicit `sortOrder`,
  which Horizon keeps as array order for its "ad-center order" mode).
- **Tags are purely local** campaign selectors — the posting flow picks
  tags, and matching enabled ads are included. Nothing beyond the plain
  LRP body ever touches the wire. Adopted: free-form strings.
- **Targeting is chosen at post time**: eligible channels = joined
  channels whose mode is `ads`/`both`; Horizon has **no cap** on selected
  channels — its conservatism lever is a hard campaign expiry instead
  (rotation runs max 3 h, then silently stops; renewable). Noted for the
  M11 posture discussion: expiry may be the better lever than a channel
  cap.
- **Pacing corroboration:** Horizon tracks the `lfrp_flood` window
  per-channel (`nextAd` per conversation), matching our per-channel
  rate-gate read of ERR 56's "to a channel" wording. Its rotation adds
  jitter (3 min start / 8 min per-post variance over a 1.5 min base gap,
  net "12–22 minutes"), enforces a 5 s gap from the user's own manual
  posts, and spaces any two ads app-wide ≥ 7.5 s across characters.
  Recorded for M11; M10's manual posting needs none of it beyond the
  existing per-channel gate.
- **`[ads: N min]` channel-description convention:** Horizon parses this
  token out of channel descriptions and honors it as that channel's
  requested ad cadence. Adopted for M10 as **display** (show the parsed
  cadence in the posting flow so the user can honor it); enforcement
  belongs to M11 rotation.
- **ERR 56 handling:** Horizon has none — a flood-refused automated ad is
  simply lost. We already do better (per-channel gate + friendly ERR
  copy); M10 keeps that bar for manual posting.
- **Show selector:** per-channel view persisted only when it differs from
  the channel's native mode; the composer flips MSG↔LRP (and length VAR
  `chat_max`↔`lfrp_max`) with the view, keeping **separate drafts** per
  view. Horizon never counts ads toward unread at all — corroborates our
  chosen semantics. Adopted for step 7, including the separate-drafts
  detail.
- **Protocol notes** (our docs): the ad length VAR is **`lfrp_max`**
  (50000), not `chat_max`; FKS has a 5 s pace (ERR 50), plus ERR 18 (no
  results), 61 (too many terms — live threshold unknown), 72 (too many
  results — live ceiling unknown). fchat-sim already shipped per-channel
  ERR 56, ERR 59/60 mode refusals, and `lfrp_max` length checks with M6;
  step 2 added FKS (kink fave/yes + gender matching; other filter arrays
  accepted but unmatched — documented sim leniency).

## Steps (dependency order)

1. **Kickoff investigation:** survey F-Chat Horizon / Rising's ad tooling
   (ad library fields, tags, channel targeting, the Show selector, any
   caps) + confirm LRP/ERR 56 edge behavior against the protocol docs;
   record findings and settle the step-3/4 data model here.
2. **fchat-sim:** FKS request/response (fixture-backed results honoring
   the filter params) + ERR 56 ad-flood refusals on LRP pacing violations
   (LRP fan-out itself shipped with M6).
3. **Server ad library:** `ads` table (per identity: Markdown body, tags,
   disabled flag, sort order — the Horizon-faithful shape; no title, no
   stored channels), CRUD REST + gateway events keeping devices in sync.
4. **`markdown-bbcode` lossiness report:** `mdToBBCode` (or a sibling)
   returns structured diagnostics for constructs that don't survive
   translation; unit-tested against the subset invariant.
5. **Ad manager UI** (Claude Design pass first): composer-toolbar entry,
   library list (tags, disable toggle, reorder), editor with live preview,
   VAR-driven amber/red hard-cap counter, lossiness warnings; posting flow
   = pick tags → pick channels (joined, ads/both mode) → post.
6. **Manual posting:** post-now to selected channels through the existing
   LRP rate-gated send path; RMO gating (ads/both channels only, chat-only
   channels excluded with the reason shown); per-channel "last posted /
   next allowed" from the `lfrp_flood` VAR; composer lossiness warning
   wired for ordinary sends too.
7. **Chat/Ads/Both view selector:** tri-state pref replacing the M6
   boolean (global default + per-channel override in the channel header),
   pref migration, M6 filter semantics preserved.
8. **Match chips on ads:** cache-only score chip on ad rows (M8 chip
   styling); no fetches, no score filtering.
9. **FKS end-to-end:** `fchat-protocol` schemas, session command +
   response correlation, gateway cmd/event, search panel next to the
   channel browser (Claude Design pass first) with the full filter set,
   client-side name filter, avatar + cached-chip result rows opening the
   mini card / profile viewer, saved searches with the "N new" diff badge,
   throttle-obedient UX.
10. **Milestone verification suite + docs:** E2E — author → preview →
    post → distinct ad render; view-selector filtering (unread counts
    unaffected by hidden ads); FKS search → results → mini card → saved
    search rerun diff. Integration — ERR 56 refusal surfaces + pacing
    respected; ad CRUD multi-device sync. Units — lossiness diagnostics,
    saved-search diff. Docs sweep (feature-parity-audit rows, decisions
    if any harden here).

## Explicitly elsewhere

- Auto-posting/rotation, ad ratings, auto-replies, ad-filter rules,
  per-character ad hiding, hide-below-score → **M11**
  ([milestone-11-discovery-extras.md](milestone-11-discovery-extras.md)).
- Profile viewer, matcher, eicon search → **M8** (shipped v0.7.0).
- Desktop client → **MX** (`standalone-client.md`).
