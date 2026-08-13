# EmberChat

A third-party web client + server ("bouncer") for **F-Chat**, the WebSocket chat system of F-List.net. The server holds one F-Chat connection per character identity — even when no browser is attached — and browsers are synchronized views onto those server-held sessions. Headline features over the official client: staying online when the app closes, catch-up on missed history, Markdown composing (translated to F-Chat's BBCode subset on the wire), delayed-send "editing", multi-device login, granular highlight rules.

## Current state

**Milestones 1–11 shipped, plus the MP mobile track, Web Push, the MX desktop client, and the pre-1.0 review round** — the bouncer, web client, self-host hardening, profile viewer/matcher/eicon search, client polish, ads + character search, the responsive/PWA phone client, push notifications, the Electron desktop app (embedded pglite server or thin client, with in-app backup), and a full four-audit quality round are implemented and released; the name "EmberChat" is final (a build-time constant, not config). Still gating v1.0: the three real-device confidence passes — Android push soak, iPhone re-check, `design/desktop-checklist.md` — which are hardware work, not commits.

**Never state the current version from memory or from this file** — `git tag` and `gh release list` are the truth; check them.

### The issue board is the authority

`gh issue list` is the single answer to "what is missing" and "what is next". Nothing else — not this file, not `design/milestones.md`, not a comment — is a backlog. Two rules follow:

- **Find something to look at later? File an issue.** Not a TODO comment, not a line in a design doc, not a paragraph appended to the tracker. A deferral that lives anywhere else is invisible to `gh issue list`, which means it is invisible. (Verified 2026-08-13: the repo has zero `TODO`/`FIXME` markers. Keep it that way.)
- **Design docs explain, the board tracks.** `design/*.md` is for *why a thing is the way it is* — decisions, rationale, as-built notes. When a doc records something still to do, it should name the issue rather than restate the work. `design/milestones.md` tracks milestone progress and stops there.

### Filing issues

The board is only as useful as it is trustworthy, so these cut both ways — the first three get work *onto* it, the last two keep it from becoming a graveyard.

- **The trigger is "not now", not "found".** Fixing it in the PR you are already writing? The PR is the record — no issue. Not fixing it now? File it before you forget, then get back to what you were doing.
- **Never fix an incidental discovery inside an unrelated PR.** Noticing Y while doing X is the most common way a tight, reviewable PR becomes a sprawling one. File Y, finish X.
- **A deferral in a comment must name its issue.** Comments explain why code is shaped as it is; they are not a backlog. A `deferred`/`for now` with no `#N` is exactly what hides work — #611 had to be excavated from a comment that said "captured so it is not rediscovered as a new bug", which is an issue's job written in the wrong place.
- **What makes an issue worth filing:** the finding, where it lives (file and symbol), why it was not done now, and what the fix would be. Anything less is a note to yourself that nobody else — including you in three months — can act on.
- **Do not file a wish with no failure mode**, and close `wontfix` freely. A board that only ever grows stops being a task board.

Deliberately absent: any priority or severity ladder. `bug`/`enhancement`/`question` plus the `area:*` labels are enough at this size, and a P0–P3 scheme on a two-person project is ceremony that goes stale. Also absent: any "file before you start" rule — you would resent it on a one-line fix, and a rule people route around weakens the ones that matter.

### Sizing work: sub-issues under a milestone

Established practice, so follow it rather than inventing a shape:

- **A track gets a GitHub milestone and a package cut of issues** — one issue per landable package, dependency-ordered, each with its own PR. That is what WP-A/WP-B (#521/#522), MP1–MP4 (#375–#378), the MX milestone (#295→#306) and the UP-A…E cut in `design/uploads.md` all are.
- **An issue that grows a package cut should be split** rather than grown. If a single issue's plan sprouts phases, cut it into sub-issues and open a milestone to hold them, leaving the original as the parent or closing it in favour of the cut. #580 → #585 + #581 + #580 is the worked example: the audit found two prerequisites hiding inside one toggle, and splitting them made each independently reviewable.
- **Order the cut so each piece can land on `main` alone.** Stacked PRs are fine (base one branch on another; GitHub retargets as each merges), but each should still be green and shippable on its own.

## Dev environment

- Docker (and docker-compose) is available locally — used for Postgres, fchat-sim, and the prod image.
- Playwright is available for E2E tests.
- Host OS varies between machines (macOS, Linux/WSL2) — keep scripts and tooling portable, no OS-specific assumptions.

## Document map

| Path | Contents |
|---|---|
| `design/project-description.md` | Original project brief and motivation |
| `design/decisions.md` | Locked architectural decisions (stack, tenancy, credentials, MVP scope) |
| `design/architecture.md` | Monorepo layout, server/bouncer design, DB schema, client architecture, gateway protocol |
| `design/milestones.md` | **Milestone status tracker** — open/closed milestones and their step checklists. Keep it updated as steps complete. It is *not* a backlog: open work lives on the issue board |
| `design/milestone-8..11-*.md` | As-built records for the four milestones that carry detail not restated elsewhere. **M1–M7 had plan docs; they were deleted 2026-08-13** — forward-looking scope for long-shipped work, with everything durable in them already in `decisions.md`/`architecture.md`. The step checklists in `milestones.md` are what remains |
| `design/standalone-client.md` | Desktop-client design (M7 step 8, in build as MX): embedded bouncer, session-library boundary (extracted at MX1), pglite, Electron |
| `design/mx2-pglite-spike.md` | **MX2 spike findings** (#297) — pglite confirmed (PG 18.3, uuidv7 native, buildApp boots); the `Db` widening, fsync/no-lock caveats, `dumpDataDir()` backups, the #298 work map. Harnesses in `design/spikes/mx2-pglite/` |
| `design/mx3-desktop-shell.md` | **MX3 implementation spec** — thin Electron main (renderer = the web app on loopback), the server-runtime artifact pipeline (the one-way-ABI answer), provisioning/safeStorage/auth seeding, chooser, thin-client, tray; issue cut #299→#304 |
| `design/mx4-packaging.md` | **MX4 implementation spec + as-built** — the two unsigned installers, the `extraResources`/`paths.ts` layout, version-by-`extraMetadata`, the packaged smoke test, the separate desktop-build workflow, and the Windows `utilityProcess`-cannot-listen finding |
| `design/desktop-checklist.md` | The MX track's real-machine pass — macOS, then Windows, then both. What no CI runner answered: Gatekeeper, SmartScreen, keychain prompts, tray icons on real menu bars, the orphaned-bouncer risk |
| `docs/desktop.md` | **User doc for the desktop app** — install per platform (with the unsigned first-launch dance), the two modes, where data lives / backup / uninstall, updating, FAQ. Sibling of `docs/self-hosting.md` |
| `design/uploads.md` | **UP spec — proposed, nothing built** (#594): upload an image from the composer, get a link, post it. The four decisions that gate the build (video scope, scrub-by-re-encode, same-origin serving, what the admin agrees to host), then storage/schema/routes/client/desktop and the UP-A…E cut |
| `design/web-push.md` | **WP spec + as-built** — full-content encrypted payloads, the push-only service worker, the PM trigger kept separate from the notification store, subscriptions cascading with auth sessions |
| `design/feature-parity-audit.md` | **Historical snapshot (2026-07-15)** — EmberChat vs. the official F-Chat 3.0 client at M6. Its five `❓ decision` items were all made and are recorded there; its `📅 M8` labels predate the MX/MP tracks and no longer describe the plan. Read it as a record, not a backlog |
| `design/mobile-client.md` | **MP track — closed** (MP1–MP4 shipped): the plan, and the rationale record for why not an app store. Points at the three as-built specs below |
| `design/mp1-responsive-shell.md` | **MP1 implementation spec** — the three zoom-corrected layout tiers, `data-layout`, package A–G cut and invariants |
| `design/mp2-touch.md` | **MP2 implementation spec + as-built** — long-press action sheets, the keyboard inset, 44px targets, the momentum finding |
| `design/mp3-pwa.md` | **MP3 implementation spec** — manifest/icons from config, safe areas, theme-color, frozen-tab lifecycle; no service worker (decision + rationale) |
| `design/mobile-device-checklist.md` | The MP track's real-device pass, MP2 §6 + MP3 §8 merged into one runnable list — Android, then iOS. What no emulator or second engine can answer |
| `design/testing-strategy.md` | fchat-sim, unit/integration/E2E strategy, responsible live testing |
| `design/risks-and-open-questions.md` | ToS exposure, protocol gaps, scaling ceiling |
| `design/chat-protocol.md` | F-Chat wire protocol (copied from F-List wiki) |
| `design/client-commands.md`, `design/server-commands.md` | Full F-Chat command reference |
| `design/chat-error-codes.md`, `design/chat-bbcode-tags.md`, `design/chat-json-endpoints.md` | Error codes, supported BBCode subset, F-List JSON API |
| `design/ui/README.md`, `design/ui/COMPONENTS.md` | Final UI design system — exact tokens, component specs |
| `prototype/*.dc.html` | HTML mockups (custom `<x-dc>` runtime) — **visual reference only, never reuse the code** |

## Key decisions (do not relitigate without the user)

- **TypeScript monorepo** (pnpm workspaces + Turborepo): `apps/server` (Fastify + ws), `apps/web` (Vite + React + Zustand), `packages/fchat-protocol`, `packages/protocol`, `packages/markdown-bbcode`, `packages/fchat-sim`, `packages/session-engine` (the held F-Chat sessions, host-agnostic — its boundary is test-enforced, see `design/standalone-client.md`).
- **Self-hostable software, admin-only instances (revised 2026-07-16)** — not a managed service: F-List's IP/household-based abuse management is incompatible with a multi-tenant bouncer. Registration disabled (admin CLI bootstrap); no email flows in v1.0. Exposure hardening + self-host docs are v1.0 scope (Milestone 7); an eventual standalone desktop client (Tauri/Electron, shared session library) is designed in M7 and built post-v1.0 (see `design/decisions.md` §2).
- **F-List credentials are session-only, in memory ("bouncer-lite")** — never persisted. The in-memory vault lets sessions re-ticket and auto-reconnect while the server process lives; a server restart logs everyone out of F-Chat until passwords are re-entered. At-rest storage is a possible future opt-in (see `design/decisions.md` §3).
- **Postgres + Drizzle ORM**, Docker deployment on a VPS (docker-compose).
- **Public open-source repo (MIT)** — strict secrets hygiene: env files gitignored, `.env.example` only, no real credentials in fixtures.
- **"EmberChat" is the final product name (user decision, 2026-08-06)** — a build-time constant (`APP_NAME` in `packages/protocol`), not config: the `APP_NAME`/`CLIENT_NAME` env knobs are gone (#556), and the IDN `cname` is the same frozen string, which is what the F-List policy's "honest, unique client identifier" wants. Never a scattered literal — everything imports the constant (`apps/web/src/shipping-shape.test.ts` fails on a stray one; the two literals with a reason are `index.html`'s `<title>` and the desktop's `productName`, both guarded/commented). **Domains and origins stay deployment config** (`APP_BASE_URL`, the IDN `cversion`) — those genuinely differ per self-host.
- **Workflow:** `main` always shippable; short-lived `feat/`/`fix/`/`chore/`/`docs/` branches; Conventional Commits; everything via squash-merged PRs gated by CI; no develop/integration branches (see `design/decisions.md` §7). **No merge queue** — GitHub's merge queue is org-repos-only (the 2026-08-03 setup attempt 422'd; verified absent 2026-08-04, `mergeQueue: null`). Merging is classic auto-merge with the strict up-to-date rule: `gh pr merge --auto --squash`, and when a green PR reports `BEHIND`, `gh pr update-branch` (or a local rebase on conflicts) un-sticks it — two green PRs will deadlock each other without this. `ci.yml`'s `merge_group:` trigger is harmless and stays in case the repo ever moves to an org.
- **Code style: idiomatic, current-generation stack.** Write idiomatic TypeScript/React/SQL — follow each tool's own conventions rather than inventing house patterns. Adopt recent stable versions at scaffold time (e.g. TypeScript 7, Postgres 18, current Node LTS) and pin majors; prefer upgrading dependencies over pinning old ones.
- **Releases:** `gh release create vX.Y.Z` on the main HEAD (lightweight tag; `release.yml` builds the ghcr image with the version baked into `/healthz`, `/api/meta` and the IDN `cversion`). Minor bump when the round includes a feature, patch for fixes-only; package.json versions stay `0.0.0`. Notes are hand-written in the `## New` / `## Fixed` / `## Notes` house style — user-facing phrasing, one line per change, `(#issue, #PR)` refs. Issues and PRs share one number sequence: verify any `#N` with `gh issue view` / `gh pr view` before citing it in notes or code comments. Test-only or docs-only changes don't warrant a release; app changes ship with the next one.
- UI follows `design/ui/COMPONENTS.md` exactly — style against CSS custom-property tokens, never hard-coded hex; accents are user-swappable.

## Non-negotiable protocol constraints (F-List developer policy)

- Identify with a unique `cname`/`cversion` (`EmberChat/<semver>`) in `IDN` before anything else.
- Reply to `PIN` (never send more than one per 10s); reconnect backoff **≥ 10 seconds**; respect `VAR` flood/length limits at runtime (never hardcode them).
- Send only well-structured BBCode from the supported chat subset (`b i u s sup sub color url user icon eicon noparse`).
- Never crash on unknown commands — log and swallow.
- Ticket API: ≤ 1 request/sec; **each new ticket invalidates all previous tickets account-wide** → all ticket acquisition goes through the per-account TicketManager.
- Message/command logs are allowed, but their location must be known and accessible to the user.
- Heavy testing against the live server is discouraged — develop against `packages/fchat-sim`. The F-List test server is bot-development only (helpdesk, 2026-07-13), so manual verification passes run against the production server: short, supervised, single account, minimal traffic (see `design/testing-strategy.md`).
