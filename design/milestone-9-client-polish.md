# Milestone 9 — Client polish

> **Shipped — an as-built record, not a plan.** M9 shipped as **v0.8.0**
> (2026-07-18). This document explains what was built and why, which is what a
> design doc is for; it is not a backlog. Open work lives on the issue board
> (`gh issue list`), never here.

*Split out of M8 on 2026-07-16; **specced and committed 2026-07-18** at
kickoff. The user committed the full candidate pool (minus the activity
heatmap, which stays parked) and chose to build the UI work directly
against the existing design system — no Claude Design pass; CD stays
available if something looks off.*

**Goal:** the day-to-day ergonomics round — the audit-backlog sweep, at-rest
credentials so restarts stop logging everyone out, in-log search, composer
affordances, the light theme, and the small stuff that makes daily use
pleasant.

**Depends on:** M8 (shipped v0.7.0).

## Committed scope

### 0. Backlog triage + LOW sweep

The six standing audit backlogs (M3–M8 + server hardening) hold ~53 line
items. First triage, then fix:

- **Strike stale** — items later milestones already resolved (M4's outbox
  TTL sweep → M7 step 3; M5's export buffering → M7's streaming export;
  M4's `#channel` click → M6 browser; anything else the sweep finds).
  Struck items get a ~~strikethrough~~ + pointer, same convention as ever.
- **Stamp accepted** — documented-tradeoff items (array-prefs LWW,
  session-cache growth, `latest` tag mutability, streaming-export
  truncation) move to a one-line "accepted" list so they stop reading as
  open work.
- **Fix the worthwhile** — the batch worth doing now, roughly: session-cap
  eviction by `lastSeenAt`; outbox failed-row TTL keyed on a real
  failure timestamp; SFC report carrying the channel *title*; detached-away
  prefs caching (one query per tick, not per identity); `OutboxItemDto.kind`
  + Ad tag on PendingLine; member-menu clamp against actual height;
  sidebar ☆/⚑ glyphs + Friends count; away-threshold Segmented off-list
  value; muting-at-cap surfacing; eicon-index adopt fallback (malformed row
  → full refetch, not a permanent 502); guestbook `recordView: false`
  path; distinct "error" profile state (vs. "not found"); preview-overlay
  `onContextMenu` forward; `DOT_CLASS`/badge-clamp dedup; name-charset
  regex consolidation; RailMenu focus return. Exact cut finalized during
  triage — anything skipped is re-listed with a reason.
- Items needing a **user decision or live verification** (cross-device
  auto-away residue; the three M6 live-pass confirmations) are collected
  under one "needs the user" note, not silently dropped.

### 1. At-rest credential storage + boot-time session resume

Per decisions.md §15 (amending §3; custody resolved disclosure-only):

- **Schema**: `flist_credentials` (accountId PK/FK cascade, ciphertext —
  the IV and auth tag ride inside the blob as base64(iv‖tag‖ct) —
  createdAt/updatedAt) — separate table, never a column on
  `flist_accounts`, so backup/pruning stories stay independent.
- **Crypto**: AES-256-GCM with a key from new env `CREDENTIALS_KEY`
  (32-byte base64url; generated like `AUTH_SECRET`). No key = feature
  hidden and every stored row refused loudly at boot. Docs state plainly:
  the key protects DB dumps/backups, **not** a full-box compromise — the
  desktop-client guarantee, no more.
- **Opt-in**: per F-List account, default off — "Remember on this server"
  at account-add/verify plus a toggle on the account row; disabling wipes
  the row. Vault hygiene rules unchanged (never logged/serialized).
- **Boot resume**: on server start, identities with `autoConnect = true`
  whose account has stored credentials reconnect unattended — through the
  ordinary TicketManager (1 req/s, one ticket per account, staggered), with
  the standard ≥10s backoff; sessions outside the
  `DETACHED_DISCONNECT_HOURS` window stay down (an abandoned instance must
  not resurrect ghosts). Detached-disconnect keeps counting from the
  pre-restart detach where known (persisted `lastDetachedAt` on
  identities; absent = count from boot).
- **Backups**: the credentials table **rides the automatic pg dumps**
  (decided now): the key lives in `.env`, never in the dump, so a stolen
  backup alone stays ciphertext — and a restore on a box with the same
  `.env` restores the no-relogin property, which is the point. Documented
  in self-hosting.md with the restore-drill note updated.

### 2. In-log search — server

- `GET /api/identities/:identityId/search` over the `messages` table,
  per identity, `ILIKE` to start (personal-instance scale; the query
  shape leaves room to swap in FTS later), newest-first, cursor-paged.
- Discord-style filters parsed server-side from the query string:
  `from:<character>`, `before:`/`after:` dates, conversation scope
  (current vs. all conversations).
- Rate-limited like other read routes; identity-ownership check per the
  profiles-module pattern.

### 3. In-log search — web UI

- Search affordance in the channel/DM header scoped to the current
  conversation, with an "everywhere" toggle; results panel (right side,
  member-list slot pattern) showing sender/time/snippet rows.
- **Jump-to-context**: clicking a result lands the virtualized log on that
  message and backfills around it — the fiddly part; the M2 history
  pagination already fetches by cursor, this adds "page containing id X"
  + highlight-and-scroll.

### 4. Composer toolbar + /help + warn codes

- §8 toolbar grows the missing affordances (bold/italic/underline/strike/
  color/eicon/noparse insertions at caret, Markdown-aware), collapsible.
- `/help` opens a slash-command + formatting reference panel (static
  content, versioned with the client).
- Warn-code support: the remaining F-Chat ERR codes users actually hit
  get friendly SystemLine copy instead of raw code text.

### 5. Light theme + colorblind token pass

- `BASE_THEME_IDS` grows light variants; the token set (decisions.md §10)
  gets its full light-mode values — same `mix()` derivation structure,
  flipped neutrals, accents re-checked for AA contrast on light ground.
- Colorblind pass rides the open token work: alternative ok/warn/danger
  hues behind a pref, plus glyph/shape reinforcement wherever color is
  currently the only signal (the M8 TierPie already models this).
- Built against COMPONENTS.md's token architecture directly (user call,
  2026-07-18); CD consulted only if something looks off.

### 6. Quick-switcher

- Ctrl/Cmd+K palette: fuzzy jump to any joined channel, open DM, or
  identity; recent-first ordering, keyboard-only operation, ARIA combobox
  semantics. Pairs with search but ships separately (no server surface).

### 7. Status-message history

- `statusMessageRecents` pref (max ~20, most-recent-first, whole-array
  patch per the eicon-recents convention), written on every successful
  STA; offered as one-click chips in the status editor.

### 8. Verification suite + docs

- E2E: search round-trip incl. jump-to-context; quick-switcher
  navigation; light-theme toggle; toolbar insertions; status recents.
- Credential restart-resume: verified by a **two-server-process
  integration test** (credentials.test.ts boots a second `buildApp` over
  the same database and polls the resumed session online). A
  browser-level restart E2E was considered and rejected at build time:
  the E2E harness shares one spawned server across all parallel specs,
  so killing it mid-suite would destabilize every other spec for
  coverage the integration test already provides at the real process
  boundary.
- Docs: self-hosting.md (CREDENTIALS_KEY, backup/restore interaction),
  decisions.md cross-check (§10 light-theme note, §15 shipped notes),
  tracker upkeep.

## Parked (not in M9)

- ~~**Activity heatmap on Insights**~~ — user-flagged "a much later thing";
  candidate for M10 alongside the other insights-adjacent ideas.
  **Shipped 2026-08-01 (#439)**: a 7×24 weekday × hour grid over the last 90
  days, bucketed server-side in the viewer's own zone, `lrp` excluded (ads
  are posted unattended). Landed with the per-character timezone that the
  DM header and sidebar clocks read from.

## Explicitly elsewhere

- Profile viewer, compatibility, eicon search, link hover-previews → **M8**
  (shipped v0.7.0).
- Ad tooling + character search → **M10**.
- Desktop client → **MX** (`standalone-client.md`).
