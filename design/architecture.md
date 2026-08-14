# Architecture

See `decisions.md` for the rationale behind the stack choices. This document is the build reference.

## Monorepo layout

pnpm workspaces + Turborepo; root `tsconfig.base.json`, ESLint flat config, Prettier, Vitest everywhere.

```
emberchat/
├── package.json                 # pnpm workspace root, turbo pipeline
├── turbo.json
├── docker-compose.yml           # prod-ish: server + postgres
├── docker-compose.dev.yml       # dev: postgres + fchat-sim; apps run on host with HMR
├── apps/
│   ├── server/                  # @emberchat/server — Fastify + ws, the bouncer
│   └── web/                     # @emberchat/web — Vite + React client
├── packages/
│   ├── fchat-protocol/          # F-Chat wire types + codec
│   ├── protocol/                # EmberChat client↔server types (WS + REST DTOs)
│   ├── markdown-bbcode/         # MD→BBCode + BBCode AST/sanitizer
│   ├── session-engine/          # the held F-Chat sessions, host-agnostic (MX1)
│   └── fchat-sim/               # local F-Chat mock server for dev/test
└── design/, prototype/          # docs (unchanged)
```

### packages/fchat-protocol

Zero-dependency (except zod), isomorphic.

- `src/codec.ts` — frame parse/serialize: `XXX {json}` (3-char command, optional payload, no trailing space when bare).
- `src/server-commands.ts` / `src/client-commands.ts` — one zod schema + TS type per command from `server-commands.md` / `client-commands.md`. Parsing an unknown command returns `{ cmd, raw }` — never throws (developer policy: never crash on unknown commands).
- `src/vars.ts` — typed `ServerVars` (chat_max, priv_max, lfrp_max, lfrp_flood, msg_flood, permissions, icon_blacklist) with defaults; runtime VAR values are always authoritative.
- `src/error-codes.ts` — from `chat-error-codes.md`.
- `src/flist-api.ts` — types for `getApiTicket.php` and the JSON endpoints (character-list, friend-list, bookmark-*, ignore-list, …).

### packages/session-engine

The bouncer's heart, extracted from `apps/server` at MX1 so the desktop shell
can embed it: `fchat-session.ts` (the state machine), `session-state.ts`,
`event-bus.ts`, `rate-gate.ts`, `registry.ts`, the `flist-api` pair
(`api-client.ts`, `ticket-manager.ts`) and the credential vault — all described
under "Server" below, which is where they ran until the extraction. Dependencies
are fixed at `ws`, the node stdlib, `@emberchat/fchat-protocol` and zod: no
Fastify, no pino (logging is the structural `SessionLogger`), no Drizzle, no
config module. Every other I/O concern is injected or inverted through the event
bus. `src/boundary.test.ts` walks the package's own imports and fails the build
on anything else (design/standalone-client.md).

### packages/protocol

The EmberChat gateway envelope, event/command unions, REST DTOs, shared enums (presence, roles, conversation kinds). Versioned: `PROTOCOL_VERSION = 1` exchanged in the hello handshake.

### packages/markdown-bbcode

- `mdToBBCode()` targeting exactly the chat subset: `b i u s sup sub color(12 fixed colors) url user icon eicon noparse`. Nothing else is ever emitted.
- `parseBBCode()` → typed AST for safe React rendering (no innerHTML).
- `sanitize()` strips unsupported tags.
- Isomorphic: server translates on send; client uses both for composer preview and message render.

## Server (`apps/server`)

**Stateful, single-process in v1** — one Node process owns all F-Chat sockets. Everything behind interfaces so sharding sessions by account later is a deployment concern.

```
apps/server/src/
├── main.ts                      # bootstrap: config, db, fastify, registry, gateway
├── config.ts                    # env parsing (zod): DATABASE_URL, FCHAT_URL, APP_BASE_URL,
│                                #   CLIENT_NAME/VERSION (IDN cname/cversion; default honest + unique)
├── db/                          # drizzle schema + migrations
├── modules/
│   ├── auth/                    # register/login/refresh, argon2id, refresh-token rotation; M7: email verify/reset
│   ├── flist-accounts/          # account rows (name only, no secrets) + in-memory credential vault (decisions.md §3)
│   ├── identities/              # identity CRUD, character-list fetch via flist-api
│   ├── flist-api/               # (the client + ticket manager live in the engine package since MX1)
│   │   ├── with-ticket.ts       # ticketed call: retry once on refusal; upstream error → HTTP status
│   │   └── character-data-budget.ts  # sliding 170/h window under F-List's 200/h character-data cap
│   ├── session-engine/
│   │   └── connect-identity.ts  # app-level orchestration: autoConnect + wiring the history sink
│   │                            #   (the engine itself is @emberchat/session-engine — MX1)
│   ├── gateway/
│   │   ├── gateway.ts           # browser WS endpoint /gateway
│   │   ├── connection.ts        # per-browser-socket: auth, subscriptions, bounded send buffer
│   │   └── snapshot.ts          # sync snapshots from session-state + db cursors
│   ├── history/                 # message persistence, cursor pagination, unread computation, retention hook
│   ├── outbox/                  # delayed-send queue (M4; table exists from day one)
│   └── preferences/             # highlight rules, prefs (M5)
└── plugins/                     # fastify: auth guard, @fastify/rate-limit, cors
```

### FchatSession state machine

States: `idle → acquiring_ticket → connecting → identifying → online → backoff → (acquiring_ticket…) | stopped`.

- Get ticket from TicketManager → open wss → send `IDN {method:"ticket", account, ticket, character, cname, cversion}` immediately (identify first or be disconnected).
- `PIN` → reply `PIN` (never more than one per 10s outbound); watchdog: ~90s of silence → treat connection as dead.
- Consume HLO/VAR/CON/LIS/NLN/FLN/STA into session-state; ICH/JCH/LCH/COL/CDS into per-channel member/mode state; MSG/PRI/LRP/RLL/SYS → event bus (history sink + gateway fan-out).
- Reconnect: jittered exponential backoff **floored at 10s** (developer policy), capped ~5 min; rejoin pinned channels on reconnect.
- All outbound commands pass through rate-gate (token bucket seeded from VARs) and length checks (chat_max/priv_max).
- Unknown inbound commands: structured-log and swallow.
- **DM send-failure correlation (#491).** F-Chat never acknowledges a PRI and its ERRs reference no frame, so a refusal is attributed positionally: each sent PRI is remembered with a `sendId` for `PM_REFUSAL_WINDOW_MS`, and an ERR 6/20 inside that window is matched to one of them — by the name the ERR renders (20), else by which recipient the roster says is offline (6), else oldest-first. Sending any command that could raise 6/20 on its own account (IGN, CIU, SFC, PRO/KIN, the chanop set) closes the window, and a teardown empties it: the mechanism always fails towards *no* mark rather than a wrong one. The history sink maps `sendId → messages.id` and stamps `messages.failure_reason`, which fans out as `message.updated`.

### TicketManager

One instance per **F-List account** (not per identity): in-memory `{ ticket, issuedAt, inflight }` + mutex. `getTicket()` returns the cached ticket if < ~25 min old; otherwise coalesces all concurrent callers into ONE `getApiTicket.php` POST (passing `no_friends/no_bookmarks/no_characters=true` where character data isn't needed). This prevents two identities on one account from invalidating each other's tickets. Tickets are never persisted — re-acquired from the in-memory credential vault.

### Credential vault (bouncer-lite — decisions.md §3)

In-memory `Map<flistAccountId, password>` inside `flist-accounts/`. Seeded when the user adds an account or re-enters the password after a server restart (`POST /api/flist-accounts/:id/unlock`); read only by the TicketManager; cleared when the last session for the account stops or the user disconnects. Never logged, serialized, or persisted — a server restart empties it, and affected identities show "re-enter password to reconnect" in the UI.

## Database schema (Postgres + Drizzle)

```
app_users            id, email uniq, username uniq, password_hash, email_verified_at, created_at
auth_sessions        id, user_id, refresh_token_hash, device_label, expires_at, created_at, last_seen_at
email_tokens         id, user_id, kind ('verify'|'reset'), token_hash, expires_at            -- M7
flist_accounts       id, user_id, account_name, created_at        -- no secrets; creds live in the in-memory vault
identities           id, flist_account_id, character_name uniq(account,name),
                     auto_connect bool, sort_order, created_at   -- auto_connect = connect when the account's vault is unlocked
conversations        id, identity_id, kind ('channel'|'pm'), channel_key nullable,  -- F-Chat name or ADH-id
                     partner_character nullable, title, pinned bool, joined bool,
                     last_read_message_id bigint, uniq(identity_id, kind, coalesce(channel_key,partner_character))
messages             id bigserial PK, conversation_id FK, sender_character,
                     kind ('msg'|'lrp'|'rll'|'sys'|'pm'), bbcode text, source_markdown text null,
                     sent_by_us bool, failure_reason text null, created_at timestamptz  -- failure_reason: #491
outbox_messages      id, identity_id, conversation_id, markdown, bbcode, release_at, state    -- M4
highlight_rules      id, user_id, kind ('word'|'nick'|'regex'), pattern, created_at            -- M5
user_preferences     user_id PK, prefs jsonb                                                   -- M5
ignores              identity_id, character, PK(identity_id, character)
channel_directory    channel_key PK, kind ('official'|'open'), title, last_seen_count, refreshed_at  -- M6 cache
```

- Messages stored **per identity** via `conversations.identity_id` (see decisions.md). `messages.id` doubles as the gateway resume cursor.
- Key index: `messages (conversation_id, id DESC)` — pagination, unread counts (`WHERE id > last_read_message_id`), catch-up replay.
- Growth: monthly range partitioning on `created_at` reserved for M7; retention job hook from M2.
- Unread/mention counters computed server-side at snapshot time (capped display at 99), not maintained incrementally.

## Client (`apps/web`)

```
apps/web/src/
├── main.tsx, router.tsx         # routes: / (landing), /login, /register, /identities, /app/:identityId?/:conversationId?
├── theme/
│   ├── tokens.ts                # neutrals + 5 accents from ui/COMPONENTS.md; exact mix() port
│   └── theme.ts                 # applyTheme(accent): derives accentSoft/accentMed/codebg/hover* and writes
│                                #   CSS custom properties on :root; Moss Green warn-dot override
├── gateway/
│   ├── socket.ts                # WS lifecycle, hello/resume, heartbeat, reconnect
│   └── dispatch.ts              # protocol events → store mutations
├── stores/                      # Zustand
│   ├── auth.ts                  # app-account session
│   ├── sessions.ts              # Map<identityId, IdentitySession> mirroring COMPONENTS.md state model
│   ├── messages.ts              # per-conversation windowed buffers (≤ ~1,500 rows) + pagination cursors
│   └── ui.ts                    # active identity, panels, dialogs; local prefs until M5
├── components/
│   ├── shell/                   # AppShell grid (60/244/1fr/232), IdentityRail, Sidebar, MeBar
│   ├── chat/                    # ChannelHeader, MessageLog (virtualized), MessageLine, SystemLine,
│   │                            #   DateDivider, CodeBlock, Composer (+ MD preview), MemberList, MemberContextMenu
│   ├── dialogs/                 # ChannelBrowser (M6), Preferences (M5)
│   └── auth/                    # Landing, Login, Register, IdentityPicker
└── lib/                         # REST api client, nick-color hash, time formatting
```

- Every component styles against `var(--eb-*)` tokens — never hex (COMPONENTS.md mandate). Accent switch = re-run `applyTheme()`.
- **The product name is a build-time constant** (decisions.md §5, revised 2026-08-06, #556): `APP_NAME` in `packages/protocol`, imported by the web build, the server and the install manifest. It used to be runtime config — a `window.__CONFIG__` bootstrap injected into `index.html` with `/config.json` as its fallback — and all of that plumbing is gone with the knob, so the served document is Vite's own and carries no inline script. **Domains and origins remain deployment config** (`APP_BASE_URL`), as does the IDN `cversion`.
- Fonts: IBM Plex Sans/Mono self-hosted via `@fontsource`.
- Message log virtualized with @tanstack/react-virtual; reverse infinite scroll prepends older REST pages with scroll anchoring; store buffers are windowed so neither store nor DOM grows unbounded.
- Inbound BBCode → `parseBBCode()` AST → React elements. `[url]` gets rel=noopener + shown-host safety; `[user]` links to the character's profile; `[icon]/[eicon]` render as inline images from f-list URLs at a **fixed ~60px box with explicit width/height** (keeps virtualized row measurement stable before the GIF loads), lazy-loaded. User preferences (M5): display mode inline vs. name-only chip with hover-preview popover, and animate on/off (frozen first frame via canvas when off) — decisions.md §8.

## Client↔server protocol (`packages/protocol`)

### REST (bearer access token, refresh rotation)

```
POST /api/auth/register | login | refresh | logout
GET/POST/DELETE /api/flist-accounts             # add account (password verified via one ticket fetch, then vaulted in memory)
POST /api/flist-accounts/:id/unlock             # re-enter password after server restart to re-seed the vault
GET  /api/flist-accounts/:id/characters         # proxied character-list for IdentityPicker
POST /api/identities  /  DELETE /api/identities/:id
GET  /api/identities/:id/conversations/:convId/messages?before=<msgId>&limit=50
GET/PUT /api/preferences, /api/highlight-rules  # M5
```

### WebSocket `/gateway`

Envelope both directions: `{ t: string, id?: number, d?: object }` (`id` = client request id, echoed in acks).

Client→server:

```
hello    { token, protocolVersion, resume?: { [identityId]: { convCursors: {convId: lastMessageId} } } }
sub      { identityId }                      # attach to a session's event stream
unsub    { identityId }
cmd      { identityId, action, d }           # action ∈ 'msg.send' {convId, markdown|bbcode},
                                             #   'msg.retry' {convId, messageId} (re-send a refused DM), 'pm.open',
                                             #   'channel.join' {key}, 'channel.leave', 'status.set',
                                             #   'typing.set', 'ignore.add/remove',
                                             #   'session.connect'/'session.disconnect'
ack      { identityId, convId, messageId }   # advance read cursor (drives unread counters everywhere)
ping     {}
activity {}                                  # "the user did something here, just now" — pooled across the
                                             #   identity's devices to decide auto-away (decisions.md §10, #619).
                                             #   Deliberately not `ping`: that one is a timer, not a person
```

Server→client:

```
ready    { userId, identities: [{id, name, sessionStatus}] }
snapshot { identityId, self, channels: [{convId, key, title, topic, desc, pinned, members, mode, unread, mention}],
           dms, friends, bookmarks, ignored, presenceVersion }
event    { identityId, kind, d }             # 'message.new' (persisted, carries messages.id),
                                             #   'message.updated' (a persisted row changed after the fact — a
                                             #     refused DM's cause, or its clearing on a retry),
                                             #   'conversation.updated' (created/joined flag/read cursor — unread
                                             #   counters converge across tabs), 'member.join/leave',
                                             #   'channel.members' (ICH full list), 'channel.info' (desc/mode/oplist),
                                             #   'presence', 'typing', 'session.status', 'error', 'sys'
catchup  { identityId, convId, messages: [...], done }
ack      { id, ok, error?, ...result }       # result e.g. pm.open → { conversation }
pong     {}
```

The exact contract (zod schemas for client→server, types for server→client,
close codes) lives in `packages/protocol/src/gateway.ts`.

**Resume semantics — snapshot + durable replay.** Volatile state (member lists, presence, session status) is never replayed; the client gets a fresh `snapshot` on every `sub`. Durable state (messages) resumes via per-conversation `messages.id` cursors: the server sends `catchup` batches for everything after the cursor, then live `event`s. The messages table *is* the resume log — no separate event-log bookkeeping. Multiple tabs/devices each `sub`; fan-out is per-connection with slow-consumer disconnect (bounded send buffer).
