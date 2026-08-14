# Testing & Verification Strategy

## fchat-sim is the backbone

`packages/fchat-sim` (built in Milestone 1, step 3) is a local WebSocket server speaking the F-Chat protocol subset plus a fake `getApiTicket.php` endpoint. Everything runs against it:

- server integration tests,
- local development (`docker-compose.dev.yml` runs it alongside Postgres),
- Playwright E2E.

Scenario scripts (JSON fixtures) cover: flood ERRs, mid-session disconnects, ticket invalidation, unknown commands, out-of-order presence, PIN timeout behavior, and configurable misbehavior toggles.

## Test layers

**Unit (Vitest)**
- `fchat-protocol` codec round-trips: sample frames from the docs, bare `PIN`, UTF-8 payloads, malformed frames, unknown commands returning `{cmd, raw}` without throwing.
- TicketManager concurrency: mutex coalescing (N concurrent callers → 1 fetch), expiry refresh at ~25 min.
- Credential vault: cleared when the last session for an account stops; password never appears in logs or serialized state.
- `markdown-bbcode` property-style tests: for arbitrary input, every emitted tag ∈ the allowed chat subset; sanitizer strips everything else; AST round-trips.
- Theme derivation: `mix()` outputs match `ui/COMPONENTS.md` Dusk values exactly (`accentSoft #322c33`, `accentMed #62566f`, …).
- Highlight rule matching (M5): word boundaries, regex timeout guard.

**Integration**
- `FchatSession` vs sim: full lifecycle including backoff timing floors (≥10s), roster state correctness, rate-gate behavior under VAR limits.
- Gateway: multi-client fan-out identity, resume/catchup cursor semantics (no gaps, no duplicates), slow-consumer disconnect.
- History pagination against real Postgres (compose or testcontainers).
- Outbox (M4): release ordering, recall, restart survival.

**E2E (Playwright)** — web + server + sim + Postgres:
- M1 slice: register → login → connect identity → join → chat → PM → history scroll.
- Later: multi-tab sync, identity switch, delayed-send recall, highlight → notification.
- The stack's ports are **derived from the working copy's path** (#617), so two checkouts run the suite concurrently without either being told to pick a range; a given copy always gets the same ports, which keeps the `lsof` in global-setup's error message pasteable. `E2E_API_PORT` / `E2E_WEB_PORT` / `E2E_PREVIEW_PORT` still override, and are what a *second run of the same copy* needs. Sim and Postgres already take free ports.

## Live F-Chat testing — be a good citizen

- ~~Request **test-server access** via F-List helpdesk ticket~~ **Resolved 2026-07-13: the F-List test server is for bot development only** — client testing happens against the production server, which makes the rules below the whole story, not a fallback.
- Live-server contact limited to short, supervised manual verification passes — the developer policy discourages heavy live testing. One account, quiet channels, minimal traffic, a human watching every frame log.
- `cname`/`cversion` = `EmberChat/<semver>` from day one.
- Respect API budgets everywhere, including in scripts: ticket endpoint ≤1 req/s, character-data <200/hour.
