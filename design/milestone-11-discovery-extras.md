# Milestone 11 — Discovery extras: ad rotation & ratings

> **Shipped — an as-built record, not a plan.** M11 shipped as **v0.10.0**
> (2026-07-20). This document explains what was built and why, which is what a
> design doc is for; it is not a backlog. Open work lives on the issue board
> (`gh issue list`), never here.

*Specced 2026-07-20 with the user (scope Q&A, three rounds). Ships as
**v0.10.0**. Created 2026-07-18 as the M10 deferral pool; the unpicked
candidates remain pooled at the bottom.*

**Depends on:** M10 (the ad library, manual posting path, per-channel LRP
gate, and ad-row rendering these features extend).

## Committed scope

### 1. Ad rotation (campaigns)

Timed re-posting of library ads — the M10 Post Ads dialog's reserved
**Rotate…** slot comes alive. Policy posture is deliberately conservative
(automated posting under the F-List developer policy); every figure below
was settled with the user against the M10 step-1 Horizon survey.

**Model — one campaign per character:**
- A campaign is: one or more **tags** (the M10-parked tag-union surface —
  the selected tags' union of enabled ads), a **channel set** drawn from
  joined ads/both channels, and the schedule below. At most **one active
  campaign per character**; starting a new one replaces it (with
  confirmation).
- Each tick posts **one ad to one channel** (the wire allows nothing
  else); the campaign **cycles the ad set in library order** per channel,
  so channels see variety and the library order stays meaningful.

**Schedule:**
- **Base interval 12 minutes per channel — a hard floor**, comfortably
  above the 10-minute `lfrp_flood` window. The flood VAR is the floor of
  the *wire*, never the schedule's target; the runtime VAR is still
  honored if it ever exceeds the base.
- A channel's **`[ads: N min]` description token raises that channel's
  floor to N** when N > 12 (M10 parses and displays it; M11 enforces it).
- **Horizon-style jitter**: a randomized start offset plus per-post
  variance over the base gap (Horizon's figures: ~3 min start / ~8 min
  per-post variance — net "12–22 min"); posting must never look
  metronomic.
- **App-wide spacing ≥ 7.5 s** between any two ads across all of a
  user's characters (server-side scheduler gate), and a **5 s no-ad
  window around the user's own manual posts** (both Horizon-surveyed).

**Bounds & lifecycle:**
- **Campaign expiry: 1 hour**, renewable with one click; on expiry the
  rotation stops **visibly** (status surface + a system line in the
  affected channels' logs — never a silent stop).
- **Attached-only:** rotation runs only while at least one of the user's
  devices is attached to the bouncer; detaching pauses the campaign and
  re-attaching resumes it (the expiry clock keeps running — a campaign
  never outlives its hour by being paused).
- On **ERR 56** (the channel got an ad from elsewhere inside its
  window): that channel's rotation **pauses visibly** — the reason and
  the estimated reopen time are on screen — and **resumes on its own
  once the window reopens** (decided with the user at design review,
  2026-07-20: the "never silently skip and retry" mandate is about
  silence, not about resuming; nothing here is silent). On a **kick or
  ban**: the channel stops **permanently** with the reason shown — it
  never resumes (strictly better than Horizon, which loses refused ads
  without a word).
- **Global kill switch** (one control stops every channel at once) and a
  per-channel **"next post at…"** status surface.
- Campaign state persists (DB) so a page reload or bouncer restart
  doesn't orphan a running campaign — but posting still requires
  attachment, and the absolute expiry timestamp governs regardless.

**Verification posture:** **no automated live testing** — rotation is
verified against fchat-sim's ERR 56 simulation and clock control only.
The supervised live pass may include one short manual campaign
observation at the user's discretion.

### 2. Ad ratings

Horizon-parity local ratings on other posters' ads. **Local-only: nothing
is ever sent to F-List.**

- **★ 1–5 with an optional short note**, set from an ad row affordance
  (and visible on the poster's profile card).
- **Per app user** — ratings describe the rated character, not the rating
  persona: one table keyed on (user, rated character), shared across all
  the user's identities.
- **≤ 2★ posters render dimmed/collapsed** with click-to-expand (the ad
  is never unrecoverable); 3★+ render normally with the stars visible on
  the ad block.
- REST CRUD + a client store; ratings apply to future *and* already
  rendered ads of that character.

## Step checklist (dependency-ordered)

- [x] 1. Protocol + DB groundwork (2026-07-20): `campaigns.ts` (start
  schema with the explicit `replace` confirmation, `CampaignDto` with
  per-channel `active/waiting/refused/removed` states + `nextAt/retryAt`
  timelines, `CAMPAIGN_DURATION_MS`/`MAX_CAMPAIGN_CHANNELS`,
  `campaignRunning`) + `ratings.ts` (`putRatingSchema` ★1–5 int + ≤500
  note, `RatingDto`; REST-only by design — low-churn personal
  annotations skip the gateway fan-out). Gateway: cmds
  `campaign.start/stop/renew/drop`, event `campaign.updated` (full-state
  idempotent overwrite, null = none), snapshot `self.campaign` (server
  emits null until step 3). Migration 0013: `campaigns` (unique
  `identity_id` IS the one-per-character rule; jsonb per-channel
  persisted state; absolute `expires_at`; `stopped_at` for the kill
  switch) + `ad_ratings` (pk user + character_lower — per app user,
  shared across identities). Protocol 19 tests, suites green
- [x] 2. Server ratings module (2026-07-20): `modules/ratings` at
  `/api/ad-ratings` — GET lists the user's ratings (sorted by character),
  PUT `/:character` upserts on (user, lowercased name) with display-case
  refresh + note trimming (empty → cleared), DELETE 404s when nothing
  existed. Name validated against `FLIST_NAME_RE`; schema bounds enforce
  whole stars 1–5 and the 500-char note. 3 integration tests (upsert
  round-trip + case-insensitive update, per-user isolation + validation
  refusals + 401, delete-then-404)
- [x] 3. Server campaign scheduler (2026-07-20): `modules/campaigns/`
  `CampaignScheduler` — 5 s tick over in-memory runtimes; per-channel
  timelines (base-12 floor, `[ads: N min]` cadence floor, live
  `lfrp_flood` honored if larger, jitter on top, first post never
  instant); one app-wide last-ad stamp per user covers both the 7.5 s
  spacing and the manual-post window (manual sends stamp it via the
  session "sent" hook); attached-only via `hub.hasSubscribers` per tick;
  absolute 1 h expiry with a one-shot plain sys line into each rotating
  channel's log (new `HistorySink.appendSystemLine`); refused = local
  `AdCooldownError` preempt or an attributed live ERR 56 (≤3 s window) →
  visible pause + auto-resume at reopen; kick/ban/leave → permanent
  remove; kill switch, renew (revives stopped/expired, never removed
  channels); write-through persistence with fresh staggered timelines on
  restart (no burst-posting). Gateway: `campaign.*` cmd handlers acking
  `CampaignError` in plain language, snapshot `self.campaign` live.
  7 clock-controlled tests (stubbed session/hub, real Postgres; no live
  testing per policy); server suite 260
- [x] 4. CD brief + design pass (2026-07-20, out of order — run during
  spec review): brief `design/ui/rotation-ratings-brief.md` pushed to
  the "EmberChat Design" project; delivery accepted first pass —
  `prototype/{Campaign Flow, Ad Ratings}.dc.html` +
  `design/ui/COMPONENTS-rotation-ratings.md` synced. One semantics call
  settled with the user (refused channels auto-resume visibly; removed
  channels never resume). Integration notes: tighten the duration-card
  copy ("you can't change it here" → "The length is fixed"), and the
  hover-revealed ☆ Rate pill needs a keyboard-focus-visible equivalent
- [x] 5. Web: campaign surfaces (2026-07-20, CD spec §1–§4):
  `CampaignDialog` (648×600, Post-Ads language) — setup (multi-tag chips
  with enabled-ad counts, ResolveBox numbered cycle + `↺ back to 1` loop
  marker, channel rows with honored `[ads: N min]` interval sub-lines,
  the 1-hour fact card with the tightened copy, ReplaceBanner with the
  explicit warn-toned Replace, no-ads/no-channels edge tiles) and status
  (three-tone ExpiryBar with elapsed track + `expires in MM:SS` + Renew,
  per-channel rows: live-dot active with `next ≈ HH:MM` countdowns,
  waiting-held, warn refused with the plain reason + `retry ≈`, danger
  removed with Drop ✕; detached whole-campaign hold; ended state with
  the run summary + Change tags/Renew; ■ Stop everything + "Post once
  manually →"). Entry points: the Post-Ads Rotate… slot is live (idle
  button ↔ pulsing "Campaign live · Nm" indicator), quiet channel-header
  "Campaign · posting here" chip. Data path: `campaign` on the session
  slice (snapshot + `campaign.updated` dispatch), `campaignOpen` ui
  flag. Derived setup/status mode (no state-sync effects — the React
  Compiler rule). `campaign-logic.ts` helpers unit-tested (phase order,
  countdown formats, honored intervals, cycle resolution, aggregates);
  web 215
- [x] 6. Web: ratings surfaces (2026-07-20, CD spec §5–§9): `StarRow`/
  `StarPicker` primitives (warn-token stars, ★/☆ glyph swap as the
  colorblind channel; the picker is a real radiogroup), `RateEditor`
  popover (§13 placement, PrivateNote language, star row + trimmed note,
  Saved ✓ / failure line, Clear rating, the "saved on this server only ·
  never sent to F-List" promise; HelpPanel capture-dismissal). Ad block:
  hover-revealed ☆ Rate pill with a `:focus-visible` reveal (the CD
  integration note), RatingChip with ✎ on rated posters' ads, never on
  own ads; **≤2★ collapse** to the dimmed one-line stub (nick + stars +
  note excerpt + show ▾) with in-place expand + the YOUR NOTE strip.
  Mini card gains the "Your rating" block below compatibility (stars +
  n/5 + Edit + note; a low rating never hides the card). Data:
  `/api/ad-ratings` client methods, `useRatingsStore` (one load per app
  session, lowercase-keyed, optimistic clear) loaded from AppShell.
  Store unit tests (single-flight load, save verdicts, offline-tolerant
  clear); web 218
- [x] 7. Verification suite + docs (2026-07-20): new **m11.spec E2E**
  (owns `linden@example.test` + the hidden Borealis Lounge / Polar Court
  both-mode rooms) driving the whole journey — author a tagged ad, close
  Borealis's window with a MANUAL post (the scheduler schedules around
  its own window, so a visible refusal needs the window closed from
  elsewhere), start a two-channel campaign through the live Rotate…
  slot, watch a **real rotation post** land in Polar Court while
  Borealis pauses with the plain reason + `retry ≈`, header chip,
  kill switch → run summary ("1 post" / "0 posts"), renew → live →
  stop; then rate Orsolya's ad ≤2★ (editor popover, note) and watch
  both her ads collapse to the stub with in-place expand + YOUR NOTE.
  Enabled by **test-only `CAMPAIGN_*` env knobs** (config-guarded:
  sub-policy timings refuse to boot against real F-Chat, the
  FLIST_API_MIN_INTERVAL_MS pattern) — the E2E stack shrinks the
  schedule against the sim only. 19s green; full E2E 18/18. Docs:
  parity-audit rows flipped (auto-posting caution resolved → shipped
  M11; ad ratings ✅; per-user hiding note). Noted: a ≤2★ pick collapses
  the rated ad instantly, remounting the editor (the collapse is the
  save feedback; ≥3★ keeps the Saved ✓ flag) — accepted; the M9-era STA
  reconnect test flaked ONCE on a loaded CI runner despite the #124
  deterministic fix (passes 3× locally, web-only diff) — recurrence
  logged for the standing backlog
- [ ] 8. Three-reviewer audit + fix pass, then the wrap-up ritual
  (user sign-off → main merge → v0.10.0)

## Deferred pool (not in M11 — revisit on demand)

- **Smart-filter auto-replies** — ⛔ parked: sends messages on the user's
  behalf; needs its own policy discussion before any speccing.
- **Keyword/regex ad-filter rules** — M10 judged the Chat/Ads/Both
  selector sufficient; the new ratings dimming covers part of the want.
- **Per-character "hide their ads only"** — partially covered by rating a
  poster ≤ 2★; revisit if full hiding is still wanted.
- **Hide-below-match-score filtering** — rejected while the click-only
  budget rule stands (only cached posters could be scored); needs a
  deliberate budget story.
- **Search extras** — search history beyond saved searches; more filter
  dimensions if the wire grows any.

## Explicitly elsewhere

- Ad center, manual posting, Chat/Ads/Both view, cache-only match chips,
  FKS search + saved searches → **M10**
  ([milestone-10-ads-and-search.md](milestone-10-ads-and-search.md)).
- Desktop client → **MX** (`standalone-client.md`).
