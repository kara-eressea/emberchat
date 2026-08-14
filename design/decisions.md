# Architectural Decisions

Locked decisions from the planning session (2026-07-12). Revisit only with explicit agreement.

## 1. Tech stack — TypeScript monorepo

Node server + React/Vite client + shared packages, managed with **pnpm workspaces + Turborepo**. One language everywhere, protocol types shared between client and server, easiest path to an Electron wrapper later.

- Server framework: **Fastify** + `ws` (typed routes via zod type provider; the heart of the server is a hand-rolled session engine, so NestJS ceremony buys little and plain `ws` alone leaves us rebuilding an HTTP framework).
- Client: Vite + React + react-router, **Zustand** for state (WS event firehose mutating per-identity session slices outside React; selector subscriptions keep the message log cheap).
- Database: **Postgres** with **Drizzle ORM** (SQL-first typed schema, easy raw DDL for partitioning/retention, no codegen daemon).
- Virtualized message log: **@tanstack/react-virtual** (headless, dynamic row heights, reverse infinite scroll).

## 2. Tenancy — self-hostable software, admin-only instances

*Revised 2026-07-16; supersedes the original public-hosted-service decision.*

EmberChat is **self-hostable software, not a managed service**. Each instance serves one person (or one real household); others who want it run their own. The pivot's driver is structural, not effort: F-List's abuse management leans on IP/household correlation, and a multi-tenant bouncer collapses all users behind the instance's single egress IP — unrelated users would read as one household (false alt-linking, shared ban fate), and one bad actor could get the instance IP banned for everyone. Unfixable on our side (see `risks-and-open-questions.md` risk 7, now defused rather than accepted). A single-tenant instance is truthful: F-List sees one person's accounts from one stable IP.

Consequences:

- **Registration is disabled.** The instance's account(s) are bootstrapped via an admin CLI/env mechanism; password reset is an admin-CLI operation. Email verification, CAPTCHA, disposable-email heuristics, and abuse-report intake all drop out of scope (no Brevo/mailer in v1.0).
- **The app-account layer stays.** One EmberChat login owning several F-List accounts (and multi-device login) is still the model — tenancy changed, not the account architecture.
- **Public-internet exposure hardening stays v1.0 scope** (rescoped Milestone 7): the instance is still reachable from the internet even with one user — TLS/reverse-proxy guidance, login lockout/backoff, secure cookies, rate limits, security headers.
- **"Make self-hosting excellent" replaces "make registration safe"**: production docker-compose, config/deploy docs, backup/restore story.
- **SFC "Alert Staff" reporting stays** (M6 parity-audit decision) — it reports to F-List staff and is tenancy-independent.

**Eventual direction: a standalone desktop client (Tauri/Electron)** for the non-tech-savvy audience the hosted service would have served — the session/connection logic extracted into a shared library so desktop and bouncer builds share one engine. Design pass scheduled in Milestone 7; no implementation before v1.0.

## 3. Credentials — session-only, in memory ("bouncer-lite")

*Revised 2026-07-12; supersedes the original envelope-encryption-at-rest decision.*

F-List passwords are **never persisted**. On connect, the user supplies their F-List password; the server verifies it via one ticket fetch and keeps it in an **in-memory credential vault** for the lifetime of that account's sessions.

- In-memory credentials are required (not just tickets): tickets expire every 30 minutes and F-Chat connections drop on their own, so the vault is what lets the server re-ticket and auto-reconnect through blips while the browser is closed.
- **If the server process dies or restarts, sessions and credentials die with it.** App accounts, identities, conversations, history, and read cursors all persist — the user just re-enters the F-List password to reconnect.
- Consequences: no MASTER_KEY/KMS in v1, no ciphertext columns, no startup session resume (Milestone 2 loses that item), and every server deploy logs all characters out of F-Chat until passwords are re-entered. Accepted at current scale.
- Vault hygiene: passwords never logged or serialized, redacted from error paths, cleared when the last session for an account stops or the user explicitly disconnects.
- This reduces the credential-custody exposure to "passwords transit our server and live in RAM while a session runs" — the same trust level as any hosted web client, and comfortably within the developer policy's storage clause.
- **The full bouncer model (restart-surviving sessions) is a stated eventual goal**, deliberately deferred. When it comes, encrypted at-rest storage returns as an explicit per-user opt-in, and the custody question — including whether to consult F-List staff first — gets decided before building; see `risks-and-open-questions.md`. *→ Decided 2026-07-17: committed for M9, disclosure-only — see §15.*
- Clarification on tickets: an *established* F-Chat connection never needs re-ticketing — the ticket is checked only at IDN. The vault exists for the two cases that need a fresh ticket: reconnecting after a drop, and authenticated JSON API calls. This mirrors what local clients already do with saved credentials.

## 4. First milestone — thin vertical slice

App login → connect one F-List character identity → join channels, send/receive channel messages and PMs, live member list — with history persisted from day one. Always-online bouncer, multi-identity, Markdown layer, highlights, and preferences follow in later milestones, but the architecture accommodates them from the start (see `architecture.md`).

## 5. Deployment context (settled 2026-07-12)

- **Hosting: VPS with docker-compose** (Hetzner/DigitalOcean-style). Master secrets via env on the host; automated `pg_dump` backups to object storage.
- **Expected scale: realistically one or two users** (the author + a friend) — but **designed scalable from the start**, because others might adopt it as a cool toy. The operating principle: *scalability lives in the architecture, cost lives in the ops.* Architectural choices that scale come free and are kept (stateless REST, cursor-based catch-up, partition-ready message schema with the right indexes, session engine behind interfaces with a documented sharding path, per-account ticket coalescing). Operational spend that only matters at scale is deferred until real users show up (KMS, managed infra, partitioning, load testing, sharding). Milestone 7 trims to self-host essentials (exposure hardening, deploy/backup story — see §2, revised 2026-07-16); deploy-logouts are handled by telling your friend beforehand.
- **Transactional email: Brevo via SMTP** (existing account) — *mooted by the §2 tenancy revision (2026-07-16): with registration disabled there are no email flows in v1.0. Kept as the provider answer if email ever returns.*
- **Open source: public repo, MIT licensed** (LICENSE already in repo). Consequences from day one: strict secrets hygiene (env files gitignored, no real credentials in test fixtures or sim scenarios, `.env.example` instead of `.env`), and nothing sensitive ever in git history.
- **"EmberChat" is the product's name — final (revised 2026-08-06, #556).** It was a working title held as **runtime deployment config** (`APP_NAME` env, `/config.json` + a `window.__CONFIG__` bootstrap injected into `index.html`, so a rename was a restart rather than a rebuild). The name is now settled, so the knob is **deliberately removed** rather than left standing: a single exported constant (`APP_NAME` in `packages/protocol`) that the server, the web build and the install manifest all import. Two reasons it is not merely frozen-by-default. **Identity:** a product with one name is what a name is for, and a configurable one made every user-facing sentence a guess ("the ⟨whatever⟩ server database"). **Honest client identification:** the IDN `cname` is the same constant, which satisfies the F-List developer policy strictly better than a configurable default did — there is no longer a value a deployment can set to claim it is some other client. **Still config:** `APP_BASE_URL` and every other origin/domain (self-hosts genuinely differ), and the IDN `cversion`, which the release build feeds. Soft-breaking for a self-hoster who set `APP_NAME`/`CLIENT_NAME`: zod strips unknown keys, so nothing refuses to boot — the value is simply no longer honoured. The **domain** is a separate and still-open question (the `emberchat.chat` spellings in the design files remain placeholders) — it was never the same decision, and it is deployment config either way.

## 6. Avatars — real character images, not initials (2026-07-12)

Deviation from the HTML mockups (which use mono-initial-on-color avatars everywhere): every avatar surface uses the character's **real F-List profile image** — identity rail, me-bar, identity picker, member list, context menu, DM rows. Source: `https://static.f-list.net/images/avatar/<lowercased character name>.png` (verify the exact pattern against the chat3client source during M1).

- **Fallback = the designed initial-on-color avatar** while loading or on error, so the mockup design remains the skeleton state.
- Hotlink directly from `static.f-list.net` with native lazy loading (`loading="lazy"`) — same as the official web client; static images are not the rate-limited JSON API. An optional caching proxy through our server is a later nicety (single-origin CSP), not v1.
- Keep the size/radius/presence-dot specs from `ui/COMPONENTS.md` — only the fill changes from initial to image.

## 7. Development workflow (2026-07-12)

Conventions apply from the first commit; enforcement (CI, branch protection) lands with Milestone 1 step 1.

- **`main` is always shippable.** Branch protection: required CI check, no force-push. Enable as soon as the Actions workflow exists.
- **Short-lived branches** named `feat/…`, `fix/…`, `chore/…`, `docs/…`; commit messages follow **Conventional Commits** with the same prefixes.
- **Everything lands via PR, squash-merged** — even solo: PRs are where CI gates, and the PR log doubles as the changelog. One milestone step ≈ one branch ≈ one PR.
- **No standing integration/develop branches.** Milestone steps are sequenced to land green on `main` individually; if a change seems too big for one PR, slice it smaller rather than letting a long-lived branch rot. A temporary integration branch is a rare, explicit exception.
- **CI (GitHub Actions):** `pnpm build && pnpm test && pnpm lint` on push/PR (M1 step 1); Playwright E2E job joins when the web app exists (M1 step 9+); Docker image build + push to ghcr joins at M1 step 11.
- **Versioning:** git tags (`v0.1.0` at end of M1) + GitHub Releases; internal packages are never published to npm, so no changesets machinery.

## 8. Inline eicons/icons in chat (2026-07-12)

The mockups show a text-only message log, but F-Chat messages routinely contain `[eicon]` emotes (small, often animated GIFs from the global gallery: `https://static.f-list.net/images/eicon/<name>.gif`) and `[icon]` avatar embeds. Both are in our allowed BBCode subset and must render inline.

- **Fixed render size** (~60px box, official-client-like) with explicit width/height so virtualized rows measure correctly before the image loads — no scroll jank. Hotlinked with lazy loading, like avatars (§6).
- **Display mode is a user preference** (M5, Appearance): **Inline** (default — image in the message row) or **Name only** (renders the eicon's name as a small chip; hovering shows the image in a popover). Name-only keeps busy channels calm and rows uniform. Orthogonal **animation toggle**: "Animate eicons" off = frozen first frame (canvas), applies to inline rendering and hover popovers alike.
- **`icon_blacklist` VAR**: some channels disallow (e)icons (server-enforced). Render whatever the server sends; the composer warns when inserting an eicon into a blacklisted channel.
- **Input syntax**: `[eicon]name[/eicon]` typed literally always works and passes through the Markdown layer untouched (developer policy: smiley syntax must be consistent with official clients). The composer's ☺ button is an insert-by-name helper (M4); per-user favorites list joins in M5. No eicon search — F-List has no public search API for the gallery.

## 9. Channel rejoin semantics (2026-07-13)

Which channels a session joins depends on *why* it is (re)connecting. Three scenarios:

1. **In-process F-Chat drop** (network blip, F-Chat maintenance): the session auto-reconnects and rejoins **the exact same channels** (the in-memory desired-channel set). The user never perceives leaving.
2. **Server restart → unlock + auto-connect**: the user didn't choose to leave either, so restore **the exact same channels** — seeded from the persisted `joined = true` conversation rows the history sink maintains.
3. **Explicit disconnect → later connect** (intentional log-off): rejoin **pinned channels only**. On this connect, previously joined-but-unpinned rows are reconciled to `joined = false` so a later restart-recovery (scenario 2) doesn't resurrect channels the user deliberately left.

This gives pinning one crisp meaning: *"channels this character is always in when they come online."* Casually browsed channels don't stick across deliberate logoffs — unlike official-client pins, which double as "remember this at all."

**Operational rule (M2 audit refinement):** which scenario a `session.connect` is, is decided by the `autoConnect` intent flag *at the moment of connecting*. `autoConnect = true` means the user never logged this identity off — the stopped session is an outage or server restart, so the connect is a **recovery** (scenario 2, seed from `joined`, non-destructive). `autoConnect = false` means they explicitly logged off earlier and this connect is the deliberate return (scenario 3, pinned seed). The scenario-3 `joined`-flag reconcile is destructive, so it runs only once the session actually reaches *online* (a connect that dies on a locked vault or bad password leaves the recovery set intact) and is serialized through the history sink's per-identity write queue.

**Kick/ban exception:** a server-initiated removal (kick, ban, timeout) drops the channel from the desired set — the session never fights a moderator by auto-rejoining, in any scenario. Pinned channels are not exempt: F-Chat's `ERR` frames carry no channel reference, so a refused join (banned, invite-only, deleted) is detected by its missing echo, and a channel is given up after **two** unconfirmed attempts — two rather than one because a connection can die with the echo in flight, and a single network blip must not silently unsubscribe channels. The errors still surface to the user. Beyond politeness, this minimizes abuse reports against the app itself.

## 10. Preferences & highlight semantics (M5 kickoff, 2026-07-14)

Settled with the user before M5 step 1:

- **All prefs sync cross-device.** One `user_preferences.prefs` jsonb per app-account; a preference set anywhere applies everywhere. No device-local carve-outs (density/font size included) — revisit only if it proves annoying in practice. localStorage keeps a copy of paint-affecting prefs (accent) purely as a pre-hydration flash cache.
- **Base theme = dark variants only in M5** (current Dusk-dark plus a dimmer/OLED-black neutral set). A true light theme is a full token-set design pass and ships as a follow-up, not rushed into M5. *→ Shipped 2026-07-18 (M9 step 5): the Parchment light theme + a colorblind mode (Okabe–Ito status hues, shape-coded presence dots), built directly against the token architecture.*
- **Regex rules run on RE2** (linear-time guarantee, native dep accepted): a catastrophic pattern in the persist-time matcher would be a service-wide DoS, not self-harm — heuristic backtracking guards are known-incomplete, so the engine itself must be safe. Word/nick rules stay plain string/boundary matching.
- **Rule changes affect new messages only.** The stored `messages.mention` flag is immutable — written once at persist time under the rules active at that moment. No history re-flagging; old badge counts stay as they were.
- **Muting silences alerts only** (notifications, sound, title flash). Unread/mention badges still accrue and rows still tint — you stop being interrupted without losing track. Applies to both per-identity and per-conversation mutes.
- **Desktop notifications show sender + message preview by default**, with a "hide message content" privacy toggle (sender-only) for screen-sharing/shoulder-surfing situations.
- **Detached auto-away (bouncer pattern, beyond milestone scope — added):** alongside the specced browser-idle auto-away, an opt-in server-side toggle sets the away status after N minutes with zero gateway subscribers; the first device to attach clears it. Off by default — appearing online while detached is the bouncer's point for many users; this is the honest-presence option for the rest.
- **Auto-away is decided by the bouncer, from activity pooled across devices (#619, 2026-08-14).** F-Chat status is per *character*; "am I active?" is per *device*. A browser deciding alone can therefore only be wrong on a multi-device account — a phone left on a table would away a character its owner is actively typing as from a laptop, and the other device would immediately undo it. So each browser only *reports* activity (a `t: "activity"` gateway frame, leading-edge throttled), and the identity is idle when the newest report across **all** attached devices is older than the threshold. The alternative framing — per-device status, with the identity's status some function of them — was rejected: F-Chat gives one status per character, so there is nothing for a function to reduce to that isn't this. Two consequences worth stating: a device that has never reported (a client older than the frame) makes the answer `"unknown"` and the sweep declines to judge at all, because silence from a client that cannot speak is not evidence of an absent user; and with no browser sending automatic status changes any more, the client-side cooldowns and swallowed ERR 14s that multi-device auto-away used to need (#358, #433) are gone rather than merely tuned. Detached auto-away is unchanged and shares the same applied-status record, so the two can never fight over one identity.
- **Highlight sound = one bundled chime** (short, unobtrusive, license-clean) with a global on/off. Per-rule/custom sounds are a possible later extension.

## 11. In-app profile viewer — first-party, per-identity history (M8 kickoff, 2026-07-16)

Supersedes the M6 parity-audit parking ("eventually, but not v1.0" —
`feature-parity-audit.md` decision 2): the profile viewer is committed M8
scope.

- **First-party rendering, no iframe.** Rising/Horizon iframe the F-List
  profile page; the user wants ours to feel native. We pull structured JSON
  (`character-data.php` + the mapping lists) and render in our own design
  language — which means `packages/markdown-bbcode` grows a profile-flavored
  tag profile (collapse/heading/quote/…, graceful degradation) since profile
  descriptions use a wider BBCode set than chat.
- **View history is server-side, per identity** — a `profile_views` table
  that doubles as the entry point to the cache: synced across devices,
  consistent with per-identity message storage, browsable and prunable in
  the viewer. (Horizon only keeps a performance cache; the user-facing
  history is our addition.) The payload cache itself (`character_cache`) is
  global per instance so identities never double-spend the budget.
- **Self-imposed budget: 170 character-data-class requests/hour** (headroom
  under F-List's 200/hr line), enforced by one counter in front of the
  existing 1 req/s throttle; exhaustion serves stale-with-flag, never
  upstream requests. Surfaces: full viewer, Discord-style mini profile card
  on name click, compare view.
- **Private character notes** (added at spec review): per-identity notes on
  a character, stored server-side in their own table (separate from
  history, so pruning one never loses the other); F-List memo import/sync
  only if the memo endpoint verifies. Mini card and viewer also badge
  friend/bookmark status from the already-loaded social lists.
- **Relationship insights** (added post-spec, same day): an Insights tab of
  the viewing identity's own stats with a character (messages exchanged,
  last chatted, first encountered, last seen talking, shared channels,
  times viewed), computed from the message store + live session state —
  no new tables, zero budget cost. Explicitly **no presence-history
  tracking**: recording the global NLN/FLN firehose would be heavy writes
  and surveillance of characters the user never interacted with; "last
  seen" means last *observed* activity, plus live online state.

## 12. Third-party eicon search — xariah, server-local index, off by default (2026-07-16; model amended 2026-07-17)

Amends §8's "no eicon search" for the picker: F-List still has no search
API, but Horizon demonstrated the community answer — xariah.net's index.

- ~~Eicon picker (Favorites/Recents/Search) queries xariah **through a
  server proxy**~~ **Amended 2026-07-17 (M8 step-1 spike):** xariah has no
  search endpoint at all — clients download its bulk name index
  (`base.doc` + daily deltas) and search locally. So the server keeps a
  **local copy of the index** (persisted, delta-refreshed ~daily) and
  greps it in-process. Strictly better than the proxy the spec assumed:
  **user query text never leaves our server**, xariah only ever sees a
  handful of bulk fetches a day, CORS is moot, and the base URL stays a
  config knob (`EICON_INDEX_BASE_URL`) tests point at fchat-sim.
- Pref `eiconSearchEnabled` **defaults off** and is **enforced server-side**
  — making the server contact a community service is opt-in, not advisory;
  the index only ever downloads after an enabled user searches.
- Search returns **names only; rendering stays static.f-list.net** (§8
  unchanged). **External eicon hosting** (arbitrary image hosts inside
  `[eicon]`, Horizon issue #319) is rejected for now: other clients would
  render broken tags, and the abuse/privacy surface isn't worth it.

## 13. Compatibility matcher — clean-room, client-side (2026-07-16)

Rising's profile match scoring, reimplemented **clean-room from documented
behavior** (README/docs, never source — provenance note in the package):
five tiers (match/weak/neutral/weak-mismatch/mismatch), six dimensions
(orientation, gender, age, furry-vs-human, species, sub/dom) with
kink-informed fallbacks, kink alignment; **missing data scores neutral,
never mismatch**. Lives in `packages/matcher`, **runs client-side** on two
ProfileDtos (zero server cost per comparison, instant re-score on identity
switch, reusable unchanged by the desktop client). M8 surfaces: mini-card
chips, profile score strip, compare view. Ads/search integration waits for
M10 and its own budget-caution pass.

## 14. Link previews — direct images + host rules, click-to-preview default (2026-07-16)

Rising-style image-link previews: a floating preview beside the log.
Client-side only: direct image/video URLs plus a small maintained per-host
rewrite table (imgur/e621/redgifs-style page links → direct media) — no
server proxy, no arbitrary-URL resolution.

- **Pref is a mode, not a boolean**: `linkPreviewMode: off | hover |
  click`, **default `click`** (chosen at spec review over hover) — nothing
  loads until a deliberate click, which also suits touch devices; hover
  mode (Rising muscle memory, ~250 ms delay) is one pref away.
- In click mode, a plain click on a *previewable* link opens the preview
  instead of navigating; **Ctrl/Cmd+click and middle-click follow the
  link**. Only resolver-recognized media links are hijacked — ordinary web
  links keep normal navigation in every mode.
- Enabled by default (unlike §12's search, no typed text goes anywhere —
  only a standard image fetch on explicit action); the pref note discloses
  that the image host sees your IP when a preview loads.

## 15. Session lifetime & credential custody after the self-host pivot (2026-07-17)

Two user decisions that follow from §2's admin-only pivot; together they
close the loop on "the bouncer stays online" vs. "the bouncer is a good
citizen".

- **Detached-disconnect ceiling (M8, shipped as step 15).** A session with
  zero attached devices for `DETACHED_DISCONNECT_HOURS` (default **72**,
  `0` = never) is logged out of F-Chat by the detached-away sweep. Holding
  a connection nobody reads for weeks is discourteous to F-List and
  surprising to the user. Operator env knob, not a user pref (same
  reasoning as the §11 budget: the courtesy posture attaches to the
  server). `autoConnect` intent stays true and the in-memory vault keeps
  the credentials, so the next attach reconnects automatically with the
  exact channel set (§9 scenario 2) — the user only loses catch-up *while*
  disconnected. The session notice states why ("disconnected after 72h
  with no attached device").
- **Opt-in at-rest credential storage is committed for M9** — amends §3's
  "never persisted". *→ Shipped 2026-07-18 (M9 step 1) exactly per the
  constraints below; the credentials table rides the pg dumps (decided at
  build time as anticipated), and the restart resume is verified by an
  integration test that boots a second server instance (fresh buildApp —
  new vault/registry/store) over the same database, a fair restart
  equivalent.* §3 was written against the multi-tenant threat model
  (a breached managed service leaking *many users'* F-List passwords);
  after §2's pivot the deployment is the admin's own box holding their own
  credentials — the same trust model as the desktop clients
  (Rising/Horizon) that already store credentials on the machine, and as
  classic IRC bouncers. Design constraints, decided now:
  - **Unattended auto-reconnect after a server restart requires that the
    box can decrypt alone**: an env-file key encrypting a DB column.
    That protects dumps/backups from casual exposure but not a full-box
    compromise — exactly the desktop-client guarantee, and the docs say
    so plainly rather than overselling the crypto. (The "wrap with the
    app password, unlock on next login" middle option was considered and
    rejected: the goal is sessions that come back by themselves.)
  - **Opt-in per F-List account, default off** — a "remember on this
    server" affordance with disclosure; the in-memory-only model stays
    the default.
  - Boot-time reconnect only revives sessions that were connected at
    shutdown and are within the detached-disconnect window — an
    abandoned instance must not reconnect ghosts forever.
  - Whether the credentials table rides the automatic pg dumps (or is
    excluded) is decided at build time and documented either way.
  - **The F-List outreach question is resolved as disclosure-only** (the
    `risks-and-open-questions.md` gate): established third-party clients
    already store credentials without ceremony; we document the model
    honestly in the self-host docs instead of seeking prior blessing.

## Other settled points

- The server is a **bouncer**: it owns one F-Chat WebSocket per connected identity; browsers attach via our own gateway protocol and receive synchronized events. This is what makes "stay online when the app is closed", catch-up, and multi-device login possible.
- Messages are stored **per identity** (F-Chat provides no message IDs or server timestamps, so cross-identity dedupe is fragile; per-identity logs also match the UI state model and the developer policy's "your logs" framing).
- v1 session engine is **single-process** (one Node process owns all F-Chat sockets); sharding by account is a documented later path, kept behind interfaces so it's a deployment concern, not a rewrite.
- Client identification: `cname = "EmberChat"`, `cversion = <semver>` from day one.
- **Idiomatic code, recent stack**: follow each tool's own conventions (idiomatic TS/React/SQL, no bespoke house patterns), and build on current stable versions at scaffold time — e.g. TypeScript 7, Postgres 18, current Node LTS — pinning majors and preferring upgrades over staying behind.
