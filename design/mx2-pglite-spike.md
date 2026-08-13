# MX2 spike — pglite feasibility (#297)

> **Shipped — an as-built record, not a plan.** MX2 is done; its findings were
> built out in #298. This document explains what was built and why, which is
> what a design doc is for; it is not a backlog. Open work lives on the issue
> board (`gh issue list`), never here.

Investigation only. Every verdict below cites a command that was run and what
it printed; anything not executed is labelled **(not executed)**. The harnesses
live in `design/spikes/mx2-pglite/` (see its README to reproduce).

Environment: macOS (darwin 27), Node v24.18.1, `@electric-sql/pglite@0.5.4`,
`drizzle-orm@0.45.2` (the workspace's own version), `electron@43.3.0`,
`re2@1.26.1`, `@electron/rebuild@4.2.0`, `postgres:18-alpine` in Docker for the
baseline. Repo at `origin/staging` (`1962a9a`).

---

## Verdict

**#298 can proceed as designed. pglite is confirmed as the embedded database
and nothing in `design/standalone-client.md` §Storage needs reversing.** All
three deferred items came back green, and the one that was expected to be the
blocker isn't one at all.

Verdict per question:

| # | Question | Verdict |
|---|---|---|
| 1 | `uuidv7()` in pglite | **Non-issue.** pglite 0.5.4 bundles **PostgreSQL 18.3**; `uuidv7()` is present and works. No shim, no `$defaultFn`, no polyfill. The shared-schema principle survives intact. |
| 2 | Migrations + boot | **Works.** All 22 migrations apply in ~70 ms. The real `buildApp` boots. `gateway.test.ts` passes **56/56** on pglite; `history.test.ts` **22/23**. |
| 3 | RE2 under Electron | **Works,** after a mandatory `@electron/rebuild` step (~73 s here). Also verified: `argon2`, and pglite itself, under Electron. |
| 4 | Backup | **File copy while closed is a valid backup** (proved by restore). A better primitive exists: `dumpDataDir()` produces a restorable tarball *while running*. |

Three things #298's plan must absorb that the design did not anticipate:

1. **`Db` has to be widened.** `PgliteDatabase` is *not* assignable to
   `NodePgDatabase` — this is a real type break, not a cosmetic one. The fix is
   small and is spelled out in the work map.
2. **`fsync` is off and cannot be turned on**, and **pglite takes no lock on
   its data directory** — a second process opens the same directory happily.
   The desktop single-instance lock moves from "polish" to "correctness".
3. **One existing integration test cannot pass on pglite by construction**
   (it needs two connections to prove per-identity write-queue sharding). That
   is the honest cost of single-connection semantics, and it is a *test*
   consequence rather than a product one.

---

## Q1 — `uuidv7()`

`apps/server/src/db/schema.ts:23` declares `const uuidv7 = sql\`uuidv7()\`` and
12 tables take it as their PK default; the generated migrations carry
`DEFAULT uuidv7()` in the DDL. The spike brief assumed pglite would be on an
older Postgres. It isn't.

```
$ node design/spikes/mx2-pglite/sql-features.mjs      # (via the probe script)
cold boot (in-memory) ms: 960
version(): PostgreSQL 18.3 (PGlite 0.5.4) on wasm32-unknown-linux-gnu,
           compiled by emcc ... 3.1.74 ..., 32-bit
server_version_num: {"server_version_num":"180003"}
pg_proc uuidv7: 2
pg_proc uuidv4: 1
pg_proc gen_random_uuid: 1
pg_proc uuid_extract_timestamp: 1
uuidv7() -> 019fd0fc-12e8-7000-9cff-38302d46169f
```

And it is genuinely exercised end to end, not just callable — the register
route inserts without an `id`, so the value below came from the DB-side
default:

```
[http] POST /api/auth/register -> 201
[db] app_users (note the v7 id): [{"id":"019fd11c-1a5e-7000-9563-077028790342", ...}]
[http] PUT /api/highlight-rules -> 200 {"rules":[{"id":"019fd11c-1a68-7fff-...","kind":"word","pattern":"amber"}]}
```

(`...-7000-...` / `...-7fff-...`: version nibble 7, as expected.)

### The fallbacks, evaluated anyway

Recorded because the spike was asked to, and because they are the answer if a
future pglite ever regresses to a pre-18 base:

- **(a) app-side `$defaultFn` with a JS uuidv7.** Would work for drizzle
  inserts — grep confirms there are only four `.execute()` raw-SQL call sites
  in the whole server (`ads/routes.ts:130`, `history.test.ts:665`,
  `seen-members/store.ts:298`, `gateway/snapshot.ts:46`) and **none of them is
  an INSERT**, so no raw path depends on the DB-side default today. But it
  does **not** save you: the 22 migration files already on disk contain
  `DEFAULT uuidv7()` in their DDL and would still fail at `migrate()` time.
  Changing the schema alone is therefore insufficient — which makes this the
  wrong lever regardless.
- **(b) a polyfill SQL function created before migrations run.** The actually
  workable option: `create function uuidv7() returns uuid` in plpgsql/SQL,
  executed against the fresh pglite instance *before* `migrate()`. It costs one
  driver-conditional statement and keeps every migration file byte-identical —
  i.e. it preserves the shared-schema principle at the price of a small
  driver-specific bootstrap. This is what I would have recommended.
- **(c) extensions.** Dead end: the base bundle ships **only `plpgsql`**.
  `create extension citext` → `extension "citext" is not available`; same for
  `pg_trgm`. Extra extensions are separate npm packages, and none of them
  provides `uuidv7()`.

**Recommendation: none of the above. Keep the schema exactly as it is.**

---

## Q2 — migrations, boot, and the integration reality

### All 22 migrations

```
$ node probe-migrate.mjs
boot ms: 948 (memory)
MIGRATE OK — ms: 70
tables: ad_ratings, ads, app_users, auth_sessions, campaigns, channel_directory,
        character_cache, character_notes, conversations, flist_accounts,
        flist_credentials, flist_mappings, highlight_rules, identities, ignores,
        messages, notification_seen, notifications, outbox_messages,
        profile_views, push_subscriptions, seen_members, user_preferences
public indexes: 44
applied migrations: 22
```

Zero failures. Nothing in `0000`–`0021` needed touching: `jsonb`, `bigserial`,
`pgEnum`, partial indexes, expression indexes (`lower(...)`), `.desc()` index
columns, and the FK cascades all took.

Every Postgres-ism the runtime SQL uses was then asked directly
(`sql-features.mjs`):

```
OK    uuidv7()          OK    jsonb ops           OK    cte + lateral
OK    uuid_extract_timestamp  OK  jsonb_set       OK    window fn
OK    gen_random_uuid()  OK   generate_series     OK    listen/notify
OK    hashtext()         OK   now()/interval      OK    pg_size_pretty
OK    pg_advisory_xact_lock   OK  on conflict do update   OK  to_tsvector (FTS)
OK    greatest/least     OK   ilike + escape
FAIL  citext ext -> extension "citext" is not available
FAIL  pg_trgm ext -> extension "pg_trgm" is not available
```

`pg_advisory_xact_lock` mattering is worth noting: `ads/routes.ts` uses it to
serialize PUTs per identity. It exists and runs — though on a single-connection
cluster it is trivially uncontended, which is the same observation as the
concurrency finding below.

### `buildApp` boots

`design/spikes/mx2-pglite/boot.mjs`, run from `apps/server` against the built
`dist/`:

```
[boot] PGlite.create ms: 970 (memory)
[boot] upgrade gate ms: 2
[boot] migrate (all 22) ms: 75
[boot] buildApp ms: 106
[boot] TOTAL cold boot ms: 1156
[http] GET /healthz -> 200 {"status":"ok"}
[http] POST /api/auth/register -> 201
[http] GET /api/auth/me -> 200
[http] PUT /api/highlight-rules -> 200 {"rules":[{"id":"019fd11c-...","kind":"word","pattern":"amber"}]}
[http] PUT /api/highlight-rules (RE2-refused) -> 422
[db] identityBadgeTotals (raw db.execute path): {"unread":3,"mentions":1}
[db] jsonb: [{"theme":"dark","t":"object","merged":{"extra":1,"theme":"dark","ownNick":true}}]
[db] partial+expression unique index enforced: duplicate key value violates unique constraint "conversations_identity_partner_uniq"
[boot] closed cleanly
```

Notable specifics:

- **The upgrade gate needs no adapter.** `assertUpgradeSafe` already declares
  its dependency as `{ query: (sql) => Promise<{ rows: ... }> }`
  (`db/upgrade-gate.ts:58`), and `PGlite` satisfies that structurally. It was
  passed the `PGlite` instance directly.
- **The one raw-SQL read works.** `gateway/snapshot.ts`'s
  `conversationCounts` — `CROSS JOIN LATERAL` + `count(*) FILTER (WHERE ...)` +
  a correlated `NOT EXISTS` — returned the right answer.
- **Cold boot is dominated by `initdb`, and only on first run.** Opening an
  *existing* data directory (the 100k-message one from the bench) is an order
  of magnitude cheaper:

  ```
  reopen #1: open 180ms, first query 47ms, rows 100000
  reopen #2: open  95ms, first query 18ms, rows 100000
  reopen #3: open  82ms, first query 15ms, rows 100000
  ```

  So: ~1.2 s on the very first launch of the desktop app, **<200 ms on every
  launch after that**.

### The type break — the one real surprise

Passing the pglite drizzle instance where `Db` is expected does **not**
compile:

```
src/spike-types.ts(13,7): error TS2322: Type 'PgliteDatabase<...> & { $client: ... }'
  is not assignable to type 'NodePgDatabase<...> & { $client: Pool; }'.
  ...
  The types of '_.session.transaction' are incompatible between these types.
  ...
  Type 'Results<{ [key: string]: any; }>' is missing the following properties
  from type 'QueryResult<QueryResultRow>': command, rowCount, oid
```

The divergence is the query-result HKT (`NodePgQueryResultHKT` vs
`PgliteQueryResultHKT`), which propagates into every transaction signature.
`Db` must widen to the shared supertype:

```ts
type Db = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
```

I applied that widening to `apps/server/src/db/index.ts` temporarily and
type-checked the whole server. **The entire codebase compiles with exactly one
further edit** — the generic HKT makes `db.execute()`'s result `unknown`:

```
src/modules/gateway/snapshot.ts(72,16): error TS18046: 'result' is of type 'unknown'.
```

Fixed by reading `.rows` through an explicit row type (both drivers return
`{ rows }`); after that:

```
$ tsc -p tsconfig.build.json --noEmit
--- typecheck done (empty above = clean)
```

And the widened alias is not a one-way door — a scratch file asserted that
*both* drivers satisfy it (`const a: WideDb = pgliteDb; const b: WideDb = nodePgDb;`
both compiled), and that `buildApp({ db: pgliteDb })` type-checks.

Regression check on the node-postgres path with the widening in place:

```
$ pnpm --filter @emberchat/server exec vitest run \
    src/modules/gateway/gateway.test.ts src/db/upgrade-gate.test.ts
 Test Files  2 passed (2)
      Tests  60 passed (60)
```

(All spike edits were reverted; the branch carries documentation only.)

### The integration suite, run on pglite

Two existing files were copied and had their fixture swapped (the whole diff is
in the spike README — five lines).

```
$ vitest run src/modules/gateway/gateway.pglite-spike.test.ts
 Test Files  1 passed (1)
      Tests  56 passed (56)
   Duration  27.61s

$ vitest run src/modules/history/history.pglite-spike.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 22 passed (23)
```

For comparison, the same gateway file on testcontainers: `28.76s`, 56 passed.
**pglite is not slower** — these suites are dominated by fchat-sim WebSocket
waits — but it does remove the container boot from the critical path.

The single failure is instructive rather than alarming:

```
FAIL  history sink > shards the write queue per identity —
      one identity's stalled write never blocks another's
Error: Timed out in waitFor!
 ❯ history.pglite-spike.test.ts:682
```

That test opens a `SELECT ... FOR UPDATE` transaction on one connection and
asserts a *different* identity's insert still lands on another. pglite is one
connection: the open transaction blocks everything, forever. The property under
test (per-identity sharding in the sink) is a server-side concern for a
multi-identity, multi-user instance; on the desktop it is one user, and the
consequence of losing it is that a stalled write briefly stalls the others.
**This test must become driver-conditional** — it cannot be made to pass on
pglite, and pretending otherwise would be a lie in the suite.

### Performance at ~100k messages

`bench.mjs`, identical SQL text on both sides, 100 000 messages across 20
conversations, macOS, `postgres:18-alpine` in Docker on loopback:

| | pglite 0.5.4 | postgres:18-alpine |
|---|---|---|
| connect | 1154 ms (first init) | 0 ms (already running) |
| migrate (22) | 112 ms | 138 ms |
| 2000 single-row inserts | 391 ms = **5115 rows/s** | 757 ms = 2642 rows/s |
| bulk insert 98 000 | 1410 ms | 1495 ms |
| conversation list | 0.30 ms | 0.90 ms |
| backfill newest 50 | 0.65 ms | 0.90 ms |
| page older (cursor) | 0.40 ms | 0.70 ms |
| unread count | 0.90 ms | 0.90 ms |
| mention count (identity-wide) | 8.20 ms | 5.80 ms |
| ILIKE search (identity-wide) | 85.80 ms | 70.00 ms |
| ILIKE search + `from:` filter | 2.40 ms | 2.40 ms |
| database size | 37 MB | 37 MB |

pglite wins the single-row insert path by ~2× (no socket round trip — the
history sink's actual shape) and loses ~20% on the one full-table scan
(unindexed ILIKE, already rate-limited server-side and already flagged as "the
one read here that costs real work" in `history/routes.ts`). Everything the UI
does on a keystroke is sub-millisecond on both. Sustained write throughput
under a tight loop measured ~7500 rows/s.

No performance objection to pglite exists at this scale.

---

## Q3 — RE2 under Electron

`re2` is a native addon; Electron 43 has a different Node ABI than the Node
that installed it. The failure is exactly the expected one:

```
$ ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron probe.cjs
runtime: { node: '24.18.1', electron: '43.3.0', modules: '148', ... }
REQUIRE re2 FAILED: The module '.../re2/build/Release/re2.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 148.
```

The rebuild fixes it:

```
$ time ./node_modules/.bin/electron-rebuild -f -w re2
Searching dependency tree
Building modules: re2
✔ Rebuild Complete
58.92s user 9.69s system 94% cpu 1:12.90 total
```

And then RE2 works everywhere it needs to — the module loads and matches
identically in the **main process** and in a **forked `ELECTRON_RUN_AS_NODE`
child** (which is how the design's child-process bouncer would start):

```
$ ./node_modules/.bin/electron main.cjs
main process ready; electron 43.3.0 modules 148
MAIN PROCESS re2 hit: true
MAIN PROCESS re2 miss: false
MAIN PROCESS RE2 OK
runtime: { node: '24.18.1', electron: '43.3.0', modules: '148', ... }
require('re2') ok in ms: 4
nick match hit: true
nick match miss: false
evil test: false ms: 0
lookbehind rejected as expected: invalid perl operator: (?<=
RE2 OK
forked child exit code: 0
```

The match shapes are the matcher's real ones — `boundaryPattern("Amber Vale")`
hits `"hey Amber Vale, ping"` and misses `"hey Amber Valery, ping"`; `(a+)+$`
against 40 `a`s returns instantly; `(?<=foo)bar` is refused, which is the 422
path the highlight PUT depends on.

### macOS-specific pain: none, but one workflow trap

Nothing macOS-specific broke: no Xcode prompt, no codesign issue, no
`arm64`/`x86_64` confusion. The trap is **the rebuild is one-way**:

```
$ node probe.cjs       # plain node, after the Electron rebuild
REQUIRE re2 FAILED: ... compiled against ... NODE_MODULE_VERSION 148.
This version of Node.js requires NODE_MODULE_VERSION 137.
```

One `node_modules` tree cannot serve both `vitest` (Node ABI 137) and Electron
(ABI 148). The desktop build therefore needs its own install/rebuild step, and
"run the tests, then package the app" in one tree will fail confusingly. This
is normal Electron practice, but it should be written into the packaging task
rather than discovered.

### The other native deps

`argon2` (the other native module in `apps/server`) rebuilds by the same
command with no extra work:

```
$ time ./node_modules/.bin/electron-rebuild -f -w argon2
Building modules: argon2, re2
✔ Rebuild Complete
60.20s user 9.74s system 97% cpu 1:11.73 total
```

And **pglite itself is fine under Electron** — it is WASM, so it has no ABI to
mismatch, but it was checked rather than assumed:

```
$ ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron pglite-under-electron.mjs
runtime: { node: '24.18.1', electron: '43.3.0', modules: '148' }
PGlite.create ms: 859
version: PostgreSQL 18.3 (PGlite 0.5.4) ...
uuidv7: 019fd119-fc0f-7000-b640-11e0a5818a93
PGLITE UNDER ELECTRON OK
```

Package weight, for the bundle budget: `@electric-sql/pglite` is **25 MB**
installed (10 MB `pglite.wasm` + 6.3 MB `pglite.data` + a 1.2 MB pgcrypto
tarball). Against Electron's ~100 MB baseline that is acceptable.

### Windows

**Not executed** — no Windows host available here. What the ecosystem says
(documentation claim, not evidence): `re2` has no prebuilt binaries for
Electron ABIs, so a Windows CI runner must compile it, which needs the MSVC
build tools that `windows-latest` GitHub runners already carry; `@electron/rebuild`
is the supported path and `electron-builder`'s docs treat native-module rebuild
as a normal per-platform build step. Treat it as a **CI build-time risk**:
budget a first Windows packaging run that fails on toolchain setup, not a
runtime risk.

### If RE2 ever proves painful

RE2 was chosen because it is **linear-time by construction** — a user-authored
highlight regex can never become a catastrophic-backtracking DoS
(`decisions.md` §10, `matcher.ts:7`). Two fallbacks, in order:

1. **`re2js`** (pure JavaScript port of RE2, v2.8.6, no native code). Executed
   under Electron: same semantics, same refusals, much slower.

   ```
   re2js hit: true
   re2js miss: false
   re2js lookbehind rejected: error parsing regexp: invalid named capture: `(?<=foo)bar`
   native re2: 500000 matches in 282ms
   re2js:      500000 matches in 8302ms
   ```

   ~29× slower, i.e. ~60k matches/s — with 25 rules that is ~2400 messages/s
   on one core. For a single-user desktop client that is comfortably enough,
   and it **keeps the linear-time property**. This is the fallback to take.
2. **Native `RegExp`** — fast, but it throws away the entire reason RE2 is
   there. On a desktop client the threat model does soften (the only person who
   can author a pathological rule is the person whose CPU it hangs), but a
   pattern pasted from a forum could still freeze the app with no way out, and
   the server and desktop would then disagree about which patterns are legal —
   the PUT's 422 would mean different things in the two hosts. **Not
   recommended** while `re2js` exists.

---

## Q4 — the backup story

All from `design/spikes/mx2-pglite/backup.mjs`, one run:

```
[1] live rows before close: 5000
[1] closed. data dir size: 39M
[1] COLD COPY reopened, rows: 5000
[1] COLD COPY writable, rows: 5001
[2] live rows after the hot copy (+2 writes): 5002
[2] HOT COPY opened, rows: 5001
[3] dumpDataDir(gzip) ms: 551 bytes: 4853283 name: live.tar.gz
[3] restored from tarball, rows: 5003
[3] restored newest row: before dump
[4] data_checksums = on (source: default)
[4] fsync = off (source: command line)
[4] full_page_writes = on (source: default)
[4] synchronous_commit = on (source: default)
[4] wal_level = replica (source: default)
[4] ALTER SYSTEM SET fsync=on accepted — see [5] for whether it sticks
[4] fsync after reopen: off
[5] child committed a row; SIGKILL self
[5] child signal: SIGKILL
[5] reopened after SIGKILL; committed row present: 1
[6] SECOND OPENER SUCCEEDED on the same dataDir — NO LOCK. rows: 5004
```

**File copy while closed is a valid backup.** Proved, not assumed: the copy
reopened with the right row count *and* accepted a write.

**`dumpDataDir()` is the better primitive and should be the documented one.**
It runs against a live instance, took 551 ms, and compressed a 39 MB data
directory to a 4.85 MB tarball that restored correctly through
`PGlite.create(dir, { loadDataDir })`. That is the desktop sibling of
`pg_dump` the design asked for — one file, small, restorable, no
stop-the-app step. `docs/self-hosting.md`'s backup drill gets a desktop
section built on this, not on `cp -R`.

**Live file copy: do not document it as safe.** Three copies taken by an
*external* process mid-write (detached `sh -c "sleep N; cp -R ..."`, so pglite's
synchronous WASM work could not starve them) all opened and were writable, at
three distinct points in time:

```
[open] .../ext1 rows: 251269   [open] writable OK
[open] .../ext2 rows: 273941   [open] writable OK
[open] .../ext3 rows: 296570   [open] writable OK
[open] .../live rows: 380458   [open] writable OK
```

Three successes are evidence that pglite keeps a crash-consistent on-disk
cluster (WAL replay repairs the torn tail on open) — they are **not** a proof
of safety. `cp -R` is not atomic across files; Postgres's own rules say a plain
filesystem copy of a running cluster is invalid without a backup-start/WAL
archive protocol, and none of that machinery exists here. The honest line for
the docs: **"quit the app, then copy — or use the in-app backup, which is
`dumpDataDir()`."**

**Durability: `fsync` is off and cannot be turned on.** `pg_settings` reports
`source: command line` — pglite passes it at startup, so it wins over
`postgresql.auto.conf`. `ALTER SYSTEM SET fsync = on` is *accepted* and does
write `fsync = 'on'` into `postgresql.auto.conf`, but the setting reads back
`off` after a reopen. `postgresqlconf: ["fsync = on"]`, `postgresqlconf` as a
string, and `initDbStartParams` all left it off; `startParams: ["-c","fsync=on"]`
failed initialization outright (`PGlite failed to initialize properly`).
Measured cost of caring: none available to measure — all three configurations
ran at 6300–6700 single-row commits/s because none of them actually enabled
fsync.

What that means in practice: a **process** crash is safe (SIGKILL test above —
the committed row survived, because the writes are already in the OS page
cache), but an **OS crash or power loss** can lose recently-committed
transactions. `full_page_writes` and `data_checksums` are on, so the failure
mode is "lose the last few seconds", not "corrupt the cluster". For a personal
chat log this is an acceptable trade — but it must be *stated* in the desktop
docs rather than left implied by "it's Postgres".

**There is no data-directory lock.** Two `PGlite` instances opened the same
directory simultaneously with no error. Real Postgres refuses this via
`postmaster.pid`; pglite does not. Two app instances (or a stale process plus a
relaunch) sharing a data directory is a corruption path with nothing standing
in the way. **`app.requestSingleInstanceLock()` is therefore load-bearing, not
polish** — and the desktop should additionally treat "data dir already open" as
a fatal, user-visible error rather than trusting Electron alone.

---

## The work map for #298

### Where the construction lives today

| File | What it does |
|---|---|
| `apps/server/src/db/index.ts` | `createDb(connectionString) → { db, pool }`; `export type Db = ReturnType<typeof createDb>["db"]`; re-exports `schema` |
| `apps/server/src/main.ts` | `createDb` → `assertUpgradeSafe({ pool })` → `migrate(db, { migrationsFolder })` (from `drizzle-orm/node-postgres/migrator`) → `buildApp({ config, db })`; `pool.end()` in the signal handlers |
| `apps/server/src/cli/admin.ts:102` | `createDb(databaseUrl)`, uses `pool` for teardown |
| 19 test files | `new PostgreSqlContainer("postgres:18-alpine").start()` → `createDb(uri)` → `migrate(...)` → `buildApp(...)` |

`buildApp` itself takes `db: Db` and touches nothing driver-specific — no
`$client` reference exists anywhere in `apps/server/src`. That is why the seam
is as small as it is.

### What the driver switch touches

1. **Widen `Db`** (`db/index.ts`) to
   `PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>`.
   Proven to compile for both drivers.
2. **Fix the one `db.execute()` read** (`gateway/snapshot.ts:72`) to read
   `.rows` through an explicit row type. The other three `.execute()` sites
   ignore their result and need nothing. *These two edits alone make the whole
   server type-check — verified.*
3. **Reshape `createDb` into a driver-tagged factory.** Suggested shape:

   ```ts
   export type DbDriver =
     | { kind: "node-postgres"; connectionString: string }
     | { kind: "pglite"; dataDir: string };

   export interface DbHandle {
     db: Db;
     /** pg's query shape — what the upgrade gate wants. Both drivers have it. */
     raw: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };
     migrate: (migrationsFolder: string) => Promise<void>;
     close: () => Promise<void>;
   }
   export function createDb(driver: DbDriver): DbHandle;
   ```

   The `migrate` member is the point: the migrator import differs per driver
   (`drizzle-orm/node-postgres/migrator` vs `drizzle-orm/pglite/migrator`) and
   `main.ts` should not know which. `raw` replaces the current `pool` for the
   upgrade gate, whose option type (`db/upgrade-gate.ts:58`) already describes
   exactly this and needs no change at all. `close()` replaces `pool.end()`.
4. **`main.ts` picks the driver from config**, defaulting to `node-postgres`
   from `DATABASE_URL` so server deployments are untouched.
5. **Dependency placement.** `@electric-sql/pglite` is 25 MB and the server
   image must not carry it. Either (a) keep it out of `apps/server` and have
   the desktop package construct the pglite handle itself against an exported
   factory, or (b) add it to `apps/server` and load it through a dynamic
   `import()` inside the `pglite` branch so the Docker build can prune it. (a)
   is cleaner and matches the session-engine boundary already established
   in MX1.
6. **Migration-time bootstrap hook.** Not needed today (`uuidv7()` exists), but
   the factory is the natural home for a per-driver "before migrate" step if a
   future pglite base version ever regresses. Worth leaving the seam shaped so
   it *could* hold one; not worth building now.

### What the integration suite needs to run twice

- **One fixture, not 19.** Add `makeTestDb()` to `apps/server/src/test-support/`
  that returns a `DbHandle` plus a teardown, choosing by an env var
  (`TEST_DB_DRIVER=pglite|postgres`, defaulting to `postgres`). The 19 files
  then lose their `PostgreSqlContainer` import and their `beforeAll` bodies
  shrink to three lines. This is a mechanical, reviewable change — the spike's
  swap diff is five lines per file.
- **`CONTAINER_BOOT_MS` stops applying** on the pglite path (there is no image
  pull). Either keep the constant and over-budget harmlessly, or make the
  fixture return the right budget.
- **One test goes driver-conditional:** `history.test.ts` › *"shards the write
  queue per identity"*. It needs two connections. Skip it on pglite with a
  comment pointing here — do not weaken the assertion for the node-postgres
  run, since that is the run that protects the property that matters on a
  server.
- **CI shape.** A second full matrix leg doubles the server suite's wall time
  for real coverage of a driver only the desktop uses. Cheaper and probably
  right: run the pglite leg on a **subset** (the db-heaviest files —
  `history`, `gateway`, `auth`, `ads`, `upgrade-gate`), and only until the
  desktop client actually ships, at which point revisit. Recorded as a decision
  for the user, not taken here.
- **Nice side effect:** on the files measured, pglite is no slower than
  testcontainers (27.61 s vs 28.76 s for `gateway.test.ts`) and needs no Docker
  — which makes a pglite leg viable on runners where Docker is awkward.

### What #298 does *not* need

- No `uuidv7()` shim, polyfill, or `$defaultFn` change.
- No migration edits, no second migrations folder, no dialect fork.
- No changes to `buildApp` or any module's queries.
- No adapter for the upgrade gate.
