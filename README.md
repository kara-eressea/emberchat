# EmberChat

A third-party client for [F-Chat](https://www.f-list.net/), F-List's chat
system — built around one idea: **your characters stay online when your
browser doesn't.**

A small server (a "bouncer") holds your F-Chat sessions open around the
clock. Browsers, phones and the desktop app are synchronized views onto
those sessions: close every window and the conversation keeps arriving;
open one again — anywhere — and you catch up on what you missed, with
your place kept.

On top of that foundation:

- **Full history**, searchable, kept server-side with retention you control
- **Markdown composing**, translated to F-Chat's BBCode on the wire
- **Delayed send** — schedule a message, recall it before it goes out
- **Multi-device**: every window, tab and phone stays in sync, including
  read state
- **Granular highlights** and a notification inbox, with **web push** that
  reaches your phone while the app is closed
- An in-app **profile viewer** with a kink-compatibility matcher, character
  search, eicon search, and roleplay-ad tools with rotation campaigns
- A **phone-sized client** (installable as a home-screen app) and a
  **desktop app** — same features everywhere

> Status: **pre-1.0** (currently v0.28.0). The feature set is complete and
> in daily use; what remains before 1.0 is confidence — real-device passes
> and soak time. Expect the occasional rough edge.

## Getting it

**Desktop app** — the simplest way to run EmberChat: one download for
macOS or Windows with the client, server and database inside, no Docker
and nothing to administer. Your characters stay online while the app runs,
window closed or not, and it backs itself up from the menu. It can also
act as a thin client for a server you host. Install steps (including the
unsigned-build first-launch dance), data locations and backups:
[`docs/desktop.md`](docs/desktop.md).

**Self-hosting** — a Docker image for running the bouncer on a machine
that never sleeps, reachable from any browser. One compose file, one
`.env` with two secrets, accounts created by a bundled admin CLI. The full
walkthrough — reverse proxy, upgrades (a boot-time gate means a bad
`docker pull` can never ruin your database), backups and the restore
drill: [`docs/self-hosting.md`](docs/self-hosting.md).

One instance serves one person (or one real household) by design: F-List's
moderation correlates households by IP, and unrelated users behind one
bouncer would misrepresent each other. EmberChat is self-hostable software,
not a hosted service.

## Repository layout

- `apps/server` — Fastify + ws bouncer server (Postgres, or pglite when
  embedded)
- `apps/web` — Vite + React client
- `apps/desktop` — Electron shell: embedded server on loopback, or thin
  client
- `packages/session-engine` — the held F-Chat sessions, host-agnostic
- `packages/fchat-protocol` — F-Chat wire types + codec
- `packages/protocol` — EmberChat client↔server protocol
- `packages/markdown-bbcode` — Markdown → BBCode translation + BBCode AST
- `packages/matcher` — the kink-compatibility matcher
- `packages/fchat-sim` — local F-Chat mock server for dev/test
- `design/` — architecture, decisions, milestone history, protocol
  reference

## Development

Requires Node ≥ 24, pnpm 11 (via `corepack enable`), and Docker (dev
Postgres, testcontainers-based tests).

```sh
pnpm install
pnpm build   # turbo build across all packages
pnpm test    # vitest per package
pnpm lint    # eslint + prettier check
```

Running the stack locally — everything talks to `fchat-sim`, the bundled
fake F-Chat, so development never touches the live service:

```sh
docker compose -f docker-compose.dev.yml up -d            # Postgres on :5432
cp apps/server/.env.example apps/server/.env              # sim endpoints are the active defaults
pnpm --filter @emberchat/fchat-sim start                  # fake F-Chat on :9090 (build first)
node --env-file=apps/server/.env apps/server/dist/main.js # API + gateway on :3000
pnpm --filter @emberchat/web dev                          # web on :5173, proxies /api to :3000
```

Create an app account with the admin CLI (`node
--env-file=apps/server/.env apps/server/dist/cli/admin.js create-user …`,
see `--help`) or set `REGISTRATION_ENABLED=true` in dev. Inside the app,
add the sim's fixture F-List account: `amber@example.test` / `hunter2`
(characters "Amber Vale", "Cindral").

E2E tests (`pnpm --filter @emberchat/web e2e`) boot their own Postgres +
sim + server; nothing above needs to be running.

Note on TypeScript versions: packages compile with the native TypeScript 7
compiler (per-package devDependency), while the repo root pins TypeScript
6.0 for typescript-eslint, which needs the JS compiler API that TS 7.0
does not ship. Collapse to a single version once TS 7.1's API lands and
typescript-eslint supports it.

## License

[MIT](LICENSE)
