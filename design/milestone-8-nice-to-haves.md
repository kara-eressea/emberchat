# Milestone 8 — Nice-to-haves: profiles, compatibility, eicon search

> **Shipped — an as-built record, not a plan.** M8 shipped as **v0.7.0**
> (2026-07-17). This document explains what was built and why, which is what a
> design doc is for; it is not a backlog. Open work lives on the issue board
> (`gh issue list`), never here.

*Specced 2026-07-16 with the user. History: originally "service admin tooling
+ Electron" (managed-service era); rewritten to "client polish" by the M7
standalone design pass; reshaped to the nice-to-haves slot at M7 close; now
committed after a Horizon feature survey and scope session. The carried-over
client-polish pool moved to **M9** (`milestone-9-client-polish.md`); ad
tooling and character search moved to **M10**
(`milestone-10-ads-and-search.md`); the desktop client remains **MX**.*

**Goal:** the features that make EmberChat pleasant to *live in* — an
in-app character profile viewer with per-identity view history, private
notes, and relationship insights from our own stored history, Discord-style
mini profile cards, Rising-style compatibility scoring, link previews, and
an eicon picker with opt-in third-party search.

**Depends on:** M7.

## Background: the Horizon survey (2026-07-16)

[Horizon](https://horizn.moe/) (successor to F-Chat Rising) was surveyed with
the user. Adopted, translated to our architecture: in-app profiles (Rising
iframes the F-List page; **we render natively** — the user wants the viewer
to feel first-party), the compatibility matcher (five-tier scoring), eicon
search (Horizon uses xariah.net's community index; F-List has no search API),
and link hover-previews. Explicitly rejected for now: external eicon
*hosting* (Horizon issue #319 — non-Horizon clients would see broken tags).
Deferred to M10: the Ad Center (authoring, auto-posting, rotation), smart
ad/post filters, match scores on ads, FKS character search. Horizon's
profile cache is performance-only; our **user-facing view history** is our
own addition.

## Scope

### Server profile service

New `apps/server/src/modules/profiles/` module. **REST, not gateway
commands** — the codebase precedent (social, directory, history modules) is
that request/response features backed by the F-List JSON API are Fastify
routes under `/api/identities/:identityId/...`, cloning the social module's
`ownedIdentity` + `withTicket` + `upstreamStatus` scaffolding; the gateway
stays chat-wire commands and fan-out. Profile payloads are large (multi-KB
descriptions, hundreds of kinks), concern one device, and map cleanly onto
HTTP error semantics (409 locked vault / 429 budget / 502 upstream).

Routes:

- `GET .../profile/:name?refresh=1` → `{ profile, fetchedAt, stale, budgetExhausted? }`
  — fetch-through-cache; upserts the cache row and bumps the history row.
  `refresh=1` bypasses the cache TTL but never the budget.
- `GET .../profile-history?limit&before` → recently-viewed list (name,
  lastViewedAt, viewCount, cached flag), newest first.
- `DELETE .../profile-history/:name` — prune one history entry.
- `GET .../profile/:name/guestbook?page=` — thin passthrough to
  `character-guestbook.php` (verified 2026-07-17: params `id` + 0-based
  `page`, pages of 10, `{nextPage, posts[]}`), served only when the cached
  profile's `settings.guestbook` is true (character-data tells us for free —
  no wasted budget on disabled guestbooks). No separate `.../images` route:
  the spike showed `character-images.php` is redundant with the `images`
  array already inside character-data (assemble
  `static.f-list.net/images/charimage/{image_id}.{extension}`), so the
  Images tab costs zero extra requests.
- `GET .../profile/:name/insights` — relationship stats derived from data
  the bouncer already holds (added 2026-07-16, after the initial spec):
  SQL aggregates over the per-identity `messages` table (DMs exchanged
  sent/received, last chatted, first encountered, last message observed
  from them in any shared channel or DM) plus live session state
  (currently online + status, channels currently shared) and the
  `profile_views` row (times viewed, first viewed). **No new tables, no
  F-List traffic, zero budget cost.** Deliberately *not* presence
  history: true last-seen-online would mean persisting the global NLN/FLN
  firehose — heavy writes and surveillance of characters the user never
  interacted with. "Last seen talking" + live online state is what we can
  compute honestly; presence tracking stays out (future opt-in at most).

Four new tables (`apps/server/src/db/schema.ts`):

- **`character_cache`** — global payload cache, one row per character
  (`character_lower` PK, canonical name, raw `character-data.php` payload
  jsonb, `fetched_at`). Shared across identities so two identities viewing
  the same character never double-spend the budget. Cache semantics:
  serve when `fetched_at` < 24 h (`PROFILE_CACHE_TTL_MS`), else refetch
  through the budget, always falling back to stale-with-flag.
- **`profile_views`** — per-identity history. PK (identity_id,
  character_lower), `first_viewed_at`, `last_viewed_at`, `view_count`,
  index on (identity_id, last_viewed_at desc). **History = row existence**:
  never TTL'd, user-prunable, synced across devices by construction.
- **`flist_mappings`** — the global mapping payloads (`mapping-list.php`,
  `kink-list.php`, `info-list.php`; all ticketless), one row per source,
  refreshed when older than ~7 days.
- **`character_notes`** — private per-identity notes on a character
  ("what we RP'd last time"): PK (identity_id, character_lower), `note`
  text, `updated_at`. Deliberately separate from `profile_views` so pruning
  history never deletes a note. Routes: `GET`/`PUT
  .../profile/:name/note` (the GET rides along in the profile response).
  Step 1 verified the memo endpoints (2026-07-17:
  `character-memo-get2.php` with `target` = character *name* →
  `{note, id}`; save via `character-memo-save.php` with `target` = that
  memo id), so one-way **memo import** ships: an "Import F-List memo"
  affordance on an empty note (memo reads count as budget-free — they're
  not character-data-class). Ours works regardless — unlike Rising's memo
  surface, notes don't depend on the API.

The server resolves raw character-data (numeric infotag/kink ids) against
`flist_mappings` into a **`ProfileDto`** (`packages/protocol/src/profile.ts`)
before it goes on the wire — ids kept alongside resolved names so the
matcher can key on ids; the mapping bulk (hundreds of KB) never ships to
clients. Guestbook/images pages are not cached in Postgres (paginated, low
reuse) — in-memory LRU with a short TTL if at all.

**Budget enforcement** — the load-bearing policy piece. New
`CharacterDataBudget` (`apps/server/src/modules/flist-api/character-data-budget.ts`):
an in-memory sliding one-hour window, soft cap **170** (headroom under
F-List's 200/hour character-data limit; guestbook/images/character-data all
count against it, tickets and mappings don't). Global per instance — the
policy risk attaches to the egress IP, and the instance is single-user. Sits
*in front of* the existing 1 req/s `FlistApiClient` throttle (which stays as
the second, orthogonal gate). The cap is operator-tunable via
`CHARACTER_DATA_BUDGET_PER_HOUR` (default 170; wired in step 5 with the other
config) — env-var only, deliberately **not** a UI preference: the 200/hour
figure is policy prose, not runtime-discoverable, so if F-List changes it a
self-hoster adjusts config without a release; but the risk attaches to the
server's IP and account, so the decision belongs to the operator reading the
deploy docs, not a prefs toggle (decided with the user 2026-07-17). No upper
clamp in code; `.env.example` documents the derivation. On exhaustion: serve
the stale cached payload
with `budgetExhausted: true`, or 429 + `retryAfterSeconds` when there is no
cache. The counter resets on restart — accepted LOW (interactive browsing
can't realistically hit 170/hr twice around a restart); noted in the module
comment, not persisted.

New upstream pieces in `packages/fchat-protocol/src/flist-api.ts` +
`api-client.ts`: `CHARACTER_API_PATHS`, lenient zod schemas
(`characterDataResponseSchema` etc. — F-List payloads are under-documented,
`.passthrough()`/optionals per the existing convention), client methods
`characterData(auth, name)` and ticketless `mappingList/kinkList/infoList`.
Delete the stale "arrives with M6" comment in `api-client.ts`.

### Compatibility matcher

New **`packages/matcher`** (`@emberchat/matcher`) — pure scoring logic with
its own test surface; imports only the `ProfileDto` type from
`@emberchat/protocol`. **Clean-room reimplementation** of Rising's
*documented* behavior (README/docs, not source) — a provenance note in the
package header records that stance.

- Five tiers: MATCH 1 · WEAK_MATCH 0.5 · NEUTRAL 0 · WEAK_MISMATCH −0.5 ·
  MISMATCH −1.
- Six dimensions: orientation, gender, age, furry-vs-human preference,
  species, sub/dom role. Inputs come from infotags with kink-informed
  fallbacks where an infotag is blank (e.g. gender-preference kinks refining
  orientation). Kink-id constant tables live in
  `packages/matcher/src/kink-ids.ts`, commented with their kink-list source.
- `scoreMatch(you, them): MatchReport` — overall score (hard-mismatch
  dominated: any MISMATCH caps it), per-dimension results with
  human-readable reasons, and a kink alignment list (fave×fave > yes×yes;
  no×fave hard-negative) with an aggregate. **Missing data scores NEUTRAL
  with "not specified" — never MISMATCH.**
- **Runs client-side**: both inputs are ProfileDtos the client already
  holds; the own-character profile is fetched once per session through the
  same cache path (one budgeted request, 24 h cache like any other). Zero
  server cost per comparison, instant re-score on identity switch, and the
  package works unchanged in the eventual desktop client.

### Web UI — profile surfaces

New `apps/web/src/components/profile/`; ui-store flags + AppShell
conditional render per the existing modal pattern (`prefsOpen` /
`channelBrowserOpen`). Data layer `apps/web/src/lib/profile.ts` (pattern:
`lib/social.ts`): in-memory client cache keyed by lowercased name with
in-flight dedup; `loadProfile(identityId, name, {refresh})`;
`loadOwnProfile(identityId)` memoized for the matcher. Visual design comes
from the CD brief (`design/ui/profile-viewer-brief.md`) — build to the specs
it returns.

- **Mini profile card** (`MiniProfileCard.tsx`) — Discord-style popover at
  the click anchor (viewport-clamped, Escape/outside-click closes, the
  member-menu overlay pattern). **Fetch-through-cache on open**: avatar +
  name render instantly from what we have, the rest fills in (a server cache
  hit costs nothing upstream; a miss is one budgeted request). Content:
  avatar, name, 3–4 key infotags (orientation/age/species/role), overall
  match chip + the two most notable dimension chips, **★ friend / ⚑
  bookmark badges** (the social lists are already client-side — zero new
  fetches), actions **Open profile** and **Message** (reuses the `pm.open`
  flow). Stale data shows a "cached Xh ago" line.
- **Full profile viewer** (`ProfileViewer.tsx`) — modal in the
  Preferences/ChannelBrowser shell style. Left rail = the **history list**
  (recently viewed, relative times, per-row prune — this is where history
  lives; no separate surface). Header: avatar, name, friend/bookmark
  badges, fetched-ago + refresh button (disabled with a tooltip when the
  server reports `budgetExhausted`), and a **private note** affordance
  (inline edit, autosaved via the note route, visible only to the viewing
  identity). Tabs:
  1. **Overview** — description rendered natively (see profile BBCode
     below), match summary strip.
  2. **Details** — infotags grouped as F-List groups them.
  3. **Kinks** — four choice columns (Fave/Yes/Maybe/No), custom kinks with
     subkink children, each kink tinted by the *viewer's own* matching
     choice.
  4. **Compare** — side-by-side vs. the active identity: per-dimension
     score table with reasons, two-column kink alignment sorted
     worst-conflicts-first. Pure `@emberchat/matcher` output.
  5. **Insights** — dense label/value rows of the viewing identity's own
     relationship stats with this character, from the insights route:
     messages exchanged, last chatted, first encountered, last seen
     talking, currently-online + shared channels, times viewed. Empty
     state: "You haven't crossed paths yet." Per-identity by
     construction — it's a read over the user's own stored history, the
     same privacy model as notes.
  6. **Images** / **Guestbook** — both endpoints verified 2026-07-17.
     Images renders the `images` array already inside character-data (no
     extra requests); Guestbook shows only when the profile's
     `settings.guestbook` is true, with a "this character has no
     guestbook" empty state otherwise.
- **Entry points**: MemberContextMenu "View profile" opens the viewer (keep
  "Open on f-list.net ↗" as a secondary item); `[user]` tags in RichText,
  member-list rows (left-click; right-click keeps the menu), and message-log
  sender nicks open the mini card.

### Profile BBCode

Profile descriptions use a wider BBCode set than the chat subset
(`collapse`, `heading`, `quote`, `big`, `left/center/right/justify`, inline
image references…). First-party rendering means extending
`packages/markdown-bbcode` with a **profile-flavored tag profile** rendered
in EmberChat's design language (our own collapse/heading/quote treatments —
explicitly not mimicking F-List's site look); unsupported tags degrade
gracefully to readable text, never raw markup.

### Link previews

Rising-style: an image link in the log → large floating preview beside the
log (see the CD brief). Client-only track:

- `LinkPreview` component wired into `RichText.tsx` URL rendering (`[url]`
  tags + autolinked URLs); resolver in `apps/web/src/lib/link-preview.ts` —
  direct image/video extension test (.jpg/.png/.gif/.webp/.webm) **plus a
  small maintained per-host rewrite table** (imgur page → i.imgur.com
  direct, e621, redgifs, …; the table is data, easy to extend). No server
  proxy.
- Pref `linkPreviewMode: off | hover | click` — **default `click`**: a
  plain click on a *previewable* link opens the preview instead of
  navigating; **Ctrl/Cmd+click and middle-click follow the link** as
  normal. Only links the resolver recognizes as media are hijacked —
  ordinary web links keep click-to-navigate everywhere. Click is also the
  touch behavior (hover mode falls back to click on touch devices). Hover
  mode uses a ~250 ms delay so casual mouse travel doesn't hotlink.
- Failure = silent no-preview (no broken-image flash); viewport-
  constrained; Escape/click-away dismisses. AppearancePane control with an
  IP-disclosure note (the image host sees your IP when a preview loads).

### Eicon picker + third-party search

- **`EiconPicker`** (`apps/web/src/components/chat/EiconPicker.tsx`)
  replaces the inline composer eicon panel: popover anchored above the
  composer button, tabs **Favorites** (existing `eiconFavorites` pref) /
  **Recents** (new `eiconRecents` pref, max 50, client-maintained
  whole-array patch per the existing convention) / **Search**. 60 px
  preview grid via the existing `eiconUrl`; click inserts
  `[eicon]name[/eicon]` at the caret; star toggles favorite. The Search tab,
  when disabled, shows a one-line explainer + a link to the prefs pane.
- **xariah-backed search via a server-local index** (model corrected by the
  2026-07-17 spike: **xariah has no search endpoint** — Horizon and XarChat
  download the full index and search locally; see
  `chat-json-endpoints.md`). New `apps/server/src/modules/eicons/`:
  on first enabled use the server fetches
  `https://xariah.net/eicons/Home/EiconsDataBase/base.doc` (one
  `name\thash` line per eicon, `# As Of: <ts>` comment), keeps the name
  list in memory (persisted row in `flist_mappings` alongside the other
  bulk payloads so restarts don't re-download), and refreshes via
  `EiconsDataDeltaSince/<ts>` (+/- delta lines) on a ~daily cadence.
  `GET /api/eicons/search?q=` greps that local index in-process. Strictly
  better than the per-query proxy the spec first assumed: the user's
  query text **never leaves our server at all** — xariah only ever sees
  periodic bulk fetches; plus trivially fast, CORS-irrelevant, and a
  good citizen (a handful of requests per day total). Base URL stays a
  config knob (`EICON_INDEX_BASE_URL`, default xariah) that tests point
  at fchat-sim. Response `{ results: string[] }` — **names only;
  rendering stays static.f-list.net**.
- Pref `eiconSearchEnabled` — **default false**, toggle in AppearancePane
  labeled explicitly ("Search uses an eicon index downloaded from
  xariah.net, a third-party service" — the index-download model means
  query text never leaves the server, but enabling does make the server
  contact xariah), and **enforced server-side** (403 when off) so the
  gate is real, not advisory. The CD picker's search-disabled explainer
  copy should be adjusted to match at build time.

## Post-spec addendum — detached-disconnect ceiling (step 15, 2026-07-17)

User decision at step-14 review (decisions.md §15): the bouncer should not
hold an F-Chat connection forever when nobody is reading. The detached-away
sweep (M5) gains an operator ceiling — `DETACHED_DISCONNECT_HOURS`
(default 72, `0` = never): a session with zero gateway subscribers past the
ceiling is stopped with an explanatory reason ("disconnected after 72h with
no attached device"). `autoConnect` intent stays true and the vault keeps
the credentials, so the next attach reconnects automatically with the exact
channel set (§9 scenario 2). Env knob, not a user pref — the courtesy
posture attaches to the server, like the §11 budget. Sessions stuck in
reconnect-backoff count from the detach too (stopping them also ends the
retries).

## Verification

- fchat-sim grows the character API (`character-data.php` ticketed;
  mapping-list ticketless; guestbook + memo endpoints; an eicon **index**
  stub serving a small `base.doc`-format file + delta endpoint) with
  `setCharacterProfile()` fixtures — the sim's existing HTTP side is the
  attachment point. Fixture shapes copy the verified ones in
  `chat-json-endpoints.md` (string-typed numbers and all).
- Server integration (`profiles.test.ts`, pattern `social.test.ts`): cache
  hit / miss / TTL-expired / force-refresh; history upsert, bump, list,
  delete; note put/get round-trip + survives history prune; budget
  exhaustion → stale-with-flag and 429-no-cache; locked-vault 409; ticket
  retry; insights aggregates over seeded messages (counts, last-chatted,
  never-crossed-paths empty shape) scoped to the requesting identity.
- Matcher unit tests: golden profile pairs per dimension, missing-data →
  NEUTRAL, hard-mismatch domination, kink alignment weighting.
- Web unit: profile lib cache/dedup; picker recents behavior; link-preview
  resolver table.
- Playwright (`profile.spec.ts` + extended compose spec): context menu →
  viewer renders a sim profile; nick click → mini card with match chip;
  Compare tab shows dimension rows; history persists across reload; eicon
  Search tab hidden until the pref is enabled, then returns sim-stubbed
  results and inserts on click; clicking a fixture image link opens the
  preview while Ctrl-click navigates; a saved character note survives
  reload.

## Risks & policy notes

- **Character-data budget (handle with care):** the 170/hr soft cap +
  stale-serving makes suspension structurally unlikely; every
  character-data-class request goes through the one counter. In-memory
  reset on restart is an accepted LOW.
- **~~Unverified endpoints~~ — resolved 2026-07-17:** the step-1 spike
  (three short supervised passes, ~20 requests total, per
  testing-strategy.md) live-verified every endpoint: character-data +
  all three mapping lists (shapes captured), guestbook (0-based paging,
  disabled-case error, and a real posts payload), memo (param corrected:
  `target` = name; get/save id round-trip understood), and the xariah
  model (no search API — bulk index + deltas, searched server-locally).
  Full shapes in `design/chat-json-endpoints.md`.
- **xariah availability/ToS:** community service, no SLA — the proxy
  degrades to an in-picker "search unavailable" error, never breaks the
  picker. Off-by-default + server-enforced pref covers the privacy posture.
- **Matcher provenance:** clean-room from documented behavior; header note
  in `packages/matcher`.
- **Payload drift:** all new F-List schemas lenient, per the `flist-api.ts`
  convention.

## Explicitly elsewhere

- **Client polish** (in-log search, composer toolbar, light theme, audit
  LOWs) → **M9** (`milestone-9-client-polish.md`).
- **Ad Center, smart filters, match scores on ads, FKS character search** →
  **M10** (`milestone-10-ads-and-search.md`).
- **Desktop client** → **MX** (undated), per `standalone-client.md`. The
  session-engine extraction (phase 1) remains available anytime as an
  ordinary refactor.
- **External eicon hosting** (arbitrary third-party image hosts inside
  `[eicon]`) — rejected for now: non-EmberChat clients would render broken
  tags, and the abuse/privacy surface isn't worth it (decisions.md §12).
