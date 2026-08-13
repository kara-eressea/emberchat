# Standalone Desktop Client — Design

> **Shipped — an as-built record, not a plan.** Built as the MX track, which
> is complete. This document explains what was built and why, which is what a
> design doc is for; it is not a backlog. Open work lives on the issue board
> (`gh issue list`), never here.

*M7 step 8 (design only). Decided direction (2026-07-16, decisions.md §2): a
desktop app (Tauri/Electron) with the session engine extracted into a shared
library. Implementation is **post-v1.0**; this document exists so v1.0 code
stops accruing coupling that would make the split harder, and so M8 can plan
against settled answers instead of open questions.*

## Why a desktop client

The tenancy pivot made EmberChat self-hostable software — which serves the
tech-savvy audience. The desktop app is the eventual answer for everyone
else: no VPS, no Docker, no domain. It also structurally dissolves the two
residual concerns of the hosted model: credentials never leave the user's
machine, and the egress IP is the user's own (risk 7 never applies).

The trade is the headline feature: sessions live only while the app runs.
Close-to-tray softens this (the window closes, the bouncer keeps running);
a closed laptop is a closed session. That is the honest deal and the UI
should say so.

## Architecture: embedded bouncer (decided by this pass)

Two candidate shapes were on the table:

1. **Direct-connect** — the web app opens F-Chat's WebSocket itself, like
   the official client. Cheapest to imagine, most expensive in truth: the
   history sink, outbox/delayed send, persist-time highlight matching,
   catch-up, and multi-window sync all live server-side today and would
   need re-implementations against browser storage. It forks the product.
2. **Embedded bouncer** — the existing server runs inside the app; the
   renderer stays a gateway client, byte-for-byte the same web app. The
   bouncer just moves onto the user's machine (M8's original "fully local
   bundle" aside, now promoted).

**Decision: embedded bouncer.** Nothing forks: one session engine, one
gateway protocol, one web app. The desktop build is essentially the
docker-compose deployment folded into an app bundle. Multi-device stays
possible later (the embedded server could optionally listen beyond
loopback — out of scope for the first release).

## The shared session library

**Done at MX1 (#295, #296)** — the table below is the as-built move, not a
plan; every file landed where it says, with no logic change and no test
assertion touched.

The M7 kickoff coupling analysis found the engine already almost a library.

**Package `packages/session-engine`** (`@emberchat/session-engine`), flat
`src/` with an `index.ts` barrel:

| Moves in | From |
|---|---|
| `fchat-session.ts`, `event-bus.ts`, `rate-gate.ts`, `session-state.ts`, `registry.ts` | `apps/server/src/modules/session-engine/` |
| `api-client.ts`, `ticket-manager.ts` | `apps/server/src/modules/flist-api/` |
| `vault.ts` (CredentialVault) | `apps/server/src/modules/flist-accounts/` (misfiled there — it has zero dependency on that module) |

Dependencies after the move: `ws`, node stdlib, `@emberchat/fchat-protocol`
(plus vitest and `@emberchat/fchat-sim` for the suites that came along). zod
was provisioned here too and never imported — the manifest entry and the
boundary allow-list row were both dropped in #559, so the walk now refuses it.
No Fastify, no pino (logging is already a structural `SessionLogger`), no
Drizzle, no config module — all I/O is injected or event-bus-inverted. The
prediction held: nothing needed a new injection seam to make the move.

**Stays behind in `apps/server`:** `connect-identity.ts` — the only file in
the boundary that touches Postgres (identities.autoConnect) and the history
sink. It is app-level orchestration (decisions.md §9 scenario logic) and
already consumes the engine purely through `SessionRegistry` +
`session.events.on`. `flist-api/` keeps `with-ticket.ts` (route-level HTTP
status mapping) and `character-data-budget.ts`; `flist-accounts/` keeps the
account rows, routes and boot-resume.

**The rule is now enforced, not reviewed for (#296):**
`packages/session-engine/src/boundary.test.ts` walks every file in the
package and fails, naming the offender, on any import outside the fixed
dependency set (an allow-list, so a new dependency must be argued for in the
guard as well as in `package.json`) or on any relative path climbing out of
`src/` — which is also how a reverse import back into `apps/server` would
arrive. It runs with the package's suite in normal CI.

## Storage: pglite (decided by this pass)

The server's schema, migrations, and every query are Postgres/Drizzle.
Candidates for the embedded database:

- **SQLite** — battle-tested, but a dialect fork: every migration and any
  Postgres-ism (jsonb, partial indexes, `uuidv7()`) needs a second
  implementation. Permanent double maintenance. Rejected.
- **Embedded real Postgres** — no fork, but shipping and supervising a
  Postgres server per install is heavy machinery for one user. Rejected.
- **pglite** (Postgres compiled to WASM, in-process, drizzle-supported) —
  the same dialect, the same drizzle migrations folder, no server process.
  **Chosen.**

Consequences: `createDb` grows a driver seam (`node-postgres` | `pglite`) —
a construction-time choice, not a query-time one, since drizzle abstracts
the rest. Single-connection semantics are fine: the history sink already
serializes per identity, and it's one user. Items to verify at build time
(M8+ spike): `uuidv7()` availability in pglite's Postgres version, RE2
(native dep) under Electron, backup story (pglite file copy replaces
pg_dump; the drill in docs/self-hosting.md gets a desktop sibling).

**Spike done (#297) — the choice holds; see `design/mx2-pglite-spike.md`.**
All three deferred items came back green, with executed evidence: pglite
0.5.4 bundles PostgreSQL **18.3**, so `uuidv7()` is native and the schema
needs no shim at all; all 22 drizzle migrations apply unchanged in ~70 ms and
the real `buildApp` boots on pglite (`gateway.test.ts` passes 56/56 against
it); `re2` and `argon2` both load and run under Electron 43 after a mandatory
`@electron/rebuild` step (~73 s, one-way — a tree rebuilt for Electron can no
longer run the Node test suite). Four things the spike changes here. (1) The
`Db` alias must widen to `PgDatabase<PgQueryResultHKT, …>` — `PgliteDatabase`
is *not* assignable to `NodePgDatabase` — which, plus one `db.execute()` read
in `gateway/snapshot.ts`, is the entire type cost. (2) The backup primitive is
`dumpDataDir()` (551 ms, 39 MB → 4.85 MB tarball, restores via `loadDataDir`),
taken while running; a plain file copy is documented as **quit first**, since
`cp -R` of a live cluster has no validity guarantee even though it happened to
work every time it was tried. (3) `fsync` is **off** and cannot be enabled
(pglite pins it on the command line) — process crashes are safe, power loss can
lose the last seconds; that belongs in the desktop docs. (4) pglite takes **no
lock on its data directory** — a second instance opens it happily — so the
single-instance lock in phase 3 below is correctness, not polish.

**Seam built (#298) — as-built.** `createDb` now takes a driver tag
(`{ kind: "node-postgres", connectionString }` or `{ kind: "pglite", dataDir }`)
and returns a handle owning `db`, `raw` (the upgrade gate's query shape),
`migrate()` and `close()`, so no caller knows which driver it is on; `DB_DRIVER`
defaults to `node-postgres`, leaving every existing deployment untouched. The
desktop bundle — not the server image — owns the `@electric-sql/pglite`
dependency: it is a devDependency here, loaded through a dynamic `import()` in
the pglite arm and stripped from the production image (drizzle-orm declares it
an optional peer, so the Dockerfile removes it explicitly), and asking a server
image for `DB_DRIVER=pglite` fails with an error that says exactly that. MX3
therefore consumes a seam that already exists rather than building one.

## In-process gateway: loopback, not IPC (decided by this pass)

The renderer needs the gateway. Two options:

- Abstract `GatewayConnection`'s socket so frames ride Electron IPC — new
  transport code, new failure modes, for no user-visible gain.
- **Run the actual Fastify server on `127.0.0.1:<random port>` inside the
  app and let the renderer connect exactly as in production. Chosen.**
  Zero protocol changes; the WS origin allow-list admits the app origin via
  the existing config; the hello token comes from an auto-created local
  account (below). If profiling ever shows loopback overhead that matters,
  the IPC transport can be revisited — it is an optimization, not a design
  constraint.

Local auth: on first run the app generates `AUTH_SECRET`, creates the
single app account through the same code path as the admin CLI, and stores
what must persist via the OS keychain (Electron `safeStorage`). The user
never sees a login screen for their own machine; the F-List password prompt
(memory-only vault, unchanged) remains the only credential interaction.

## Shell: Electron (decided by this pass)

The embedded bouncer needs Node — Fastify, `ws`, and the native deps
(argon2, RE2) are Node artifacts.

- **Tauri**: small Rust webview shell (~10 MB), but no Node runtime — the
  server would ship as a sidecar binary (pkg/SEA), which reintroduces the
  size and adds a build pipeline for exactly the thing Electron ships
  natively. The webview is also platform-divergent (WebKit on Linux/macOS,
  WebView2 on Windows), which multiplies UI testing.
- **Electron**: Node built in — the server runs as a child process (or
  worker) with zero porting; Chromium everywhere (one rendering target, the
  same one the web app already targets); `electron-updater` is a mature
  auto-update story, which the update-check work (M7 step 5) plugs into.

**Decision: Electron.** Bundle size (~100 MB) is the accepted cost. Tauri
remains worth re-evaluating only if the session engine ever becomes
runnable without Node-native deps.

## Phasing (post-v1.0)

1. ~~**Extract `packages/session-engine`**~~ — **done (MX1, #295/#296)**:
   mechanical per the table above, server behavior unchanged, the full suite
   green with no assertion edited.
2. **Db driver seam + pglite spike** — `createDb(driver)`, boot the full
   server on pglite, run the integration suite against it.
3. **Electron shell** — child-process server on loopback, first-run
   provisioning, tray/close-to-tray, single-instance lock, native
   notifications (the M5 preference surfaces reused), `electron-updater`.
4. **Desktop polish** — installer targets (Windows/macOS/Linux via
   electron-builder), a desktop-flavored settings pane (start at login,
   tray behavior), the pglite backup story.

## What this rewrites in M8

M8's original scope assumed the hosted service (admin tooling for a
multi-user instance) and a thin Electron wrapper pointing at it. After the
pivot and this design:

- The **admin/moderation surface shrinks to nothing** for v1.0 — the
  operator is the user; the admin CLI (M7) is the whole admin story. The
  planned abuse-report queue, user search, and audit-log UI die with open
  registration.
- The **Electron wrapper is superseded** by the embedded-bouncer plan
  above (phases 1–4), scheduled post-v1.0 as its own effort.
- What remains for an M8-shaped milestone is **client polish** (the
  parity-audit backlog: in-log search, BBCode toolbar, slash help) — to be
  planned when v1.0 ships. *(Update 2026-07-16: M8 was subsequently specced
  as the profile-viewer/compatibility/eicon-search round —
  `milestone-8-nice-to-haves.md`; the polish pool moved to M9 and ad
  tooling/character search to M10. This section's phasing conclusion —
  desktop as MX, after those rounds — stands.)*
