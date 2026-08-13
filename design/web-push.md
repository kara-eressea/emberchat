# WP — Web Push

> **Shipped — an as-built record, not a plan.** The WP track shipped. This
> document explains what was built and why, which is what a design doc is for;
> it is not a backlog. Open work lives on the issue board (`gh issue list`),
> never here.

*Implementation spec, written 2026-08-05 at the pre-MX planning conversation.
User decisions locked there: Web Push ships **before** MX; payloads carry
**full content** (sender + excerpt — RFC 8291 encrypts end-to-end, the
Google/Apple relays route but cannot read); reply-from-notification and the
Badging API are **out of scope** for this round. This is the milestone
`design/mp3-pwa.md` §"no service worker" explicitly deferred to: the no-SW
decision stands for caching/offline — the service worker introduced here does
push display and notification-click routing and nothing else, forever enforced
by test (§6).*

## What this round delivers

A browser that has opted in gets OS notifications for chat activity **while no
EmberChat tab is open** — the bouncer's headline feature (the session outlives
the browser) finally has a signal path back to the user. Tapping the
notification opens/focuses the app on the right conversation.

Delivery channel: standard Web Push (VAPID + RFC 8291 encryption) via the
`web-push` npm package. Works on Android Chrome, desktop Chrome/Edge/Firefox,
and iOS ≥16.4 **only when installed to the home screen** (document this; it
goes on `design/mobile-device-checklist.md`).

## What triggers a push

Two trigger sources, one sender:

1. **The notification bus** — `NotificationStore`'s in-process event
   (`apps/server/src/modules/notifications/store.ts:211`), exactly the stream
   `GatewayHub` already fans out as `notification.new`
   (`modules/gateway/gateway.ts:94-102`). Covers kinds `mention`,
   `friendrequest`, `note`, `comment`. Rows stamped `muted: true` are **not**
   pushed.
2. **Private messages** — PMs deliberately do not land in the notification
   store (no PM kind exists; only stamped mentions do). The history sink is
   the one place that sees every persisted PM with identity context
   (`modules/history/sink.ts`, the same region that calls `recordMention` at
   `:640`) — it calls the push sender directly for PM-conversation messages
   not sent by the identity itself. This is a push-only signal: no schema
   change, no inbox row, no gateway event.

**No attached-client suppression server-side.** The sender pushes on every
qualifying event regardless of `GatewayHub.hasSubscribers` — a frozen phone
tab (MP3-B) holds a live socket while rendering nothing, so "a client is
attached" proves nothing about the user seeing anything. Dedup against an
open tab happens at display time (§4): the SW skips display when a focused
window client exists, and notification `tag`s shared with
`lib/desktop-notify.ts` collapse the page-fired and push-fired copies into
one. Accepted round-1 limitation: reading on one device does not retract
already-delivered pushes on another.

## Preferences

No new preference keys for filtering. The sender reuses the existing prefs
(`packages/protocol/src/prefs.ts`, resolved server-side via the same
`resolvePrefs` path the store already uses):

- `desktopNotifyMentions` / `desktopNotifyPms` / `desktopNotifyNotes` gate the
  corresponding push kinds (mention / PM / friendrequest+note+comment).
- `notifyShowContent` — when false, payloads carry kind + character but no
  excerpt (the existing privacy toggle extends to push; full content is the
  default per the user's decision).
- `mutedIdentityIds` / `mutedConvIds` — the store already stamps `muted` for
  inbox kinds; the PM trigger must apply both lists itself.

The one *new* user-facing control is per-device: "Push notifications on this
device" in the Notifications preferences pane (§4).

## 1. Server: schema

New table `push_subscriptions` (one migration):

- `id` uuid PK, `uuidv7()` default (schema convention, `schema.ts:23`)
- `userId` uuid → `app_users.id` cascade
- `authSessionId` uuid → `auth_sessions.id` **cascade** — ties the
  subscription's lifetime to the browser login that created it: logout deletes
  the `auth_sessions` row (revocation is immediate, `plugins/auth.ts`), the
  session janitor prunes expired rows — both cascade the push subscription
  away. No separate push janitor needed.
- `endpoint` text, **unique** (re-subscribing upserts on endpoint)
- `p256dh` text, `auth` text (the browser's encryption keys)
- `createdAt` timestamptz
- Index on `userId`.
- Cap: max 10 subscriptions per user; inserting past the cap deletes the
  oldest first.

Subscriptions are **user-scoped, not identity-scoped**: a browser install
belongs to a user; notifications from all their identities push to it (the
payload names the receiving identity when the user has more than one).

## 2. Server: config

Three new env vars in `config.ts`, following the `CREDENTIALS_KEY` idiom
(`z.preprocess` mapping `""` → `undefined` for docker-compose `${VAR:-}`
passthrough, `superRefine` shape validation, generation hint in the error
message):

- `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` — base64url VAPID pair;
  error message includes the one-liner
  `npx web-push generate-vapid-keys`.
- `PUSH_VAPID_SUBJECT` — `mailto:` or `https:` URL (required by the push
  services).

Cross-field policy guard in `loadConfig` (`config.ts:200-236` region):
all-three-or-none. Unset ⇒ push is silently disabled: routes return
404-or-flag (§3 — the client needs to know), no sender constructed. Update
`.env.example`, `docs/self-hosting.md` env table, and `docker-compose.yml`
passthrough. Self-host docs also note: push requires the site on HTTPS
(secure context), and iOS needs home-screen install.

## 3. Server: module `modules/push/`

**`PushSender`** — constructed in `buildApp` when VAPID config is present;
subscribes the notification bus (same pattern as `GatewayHub`'s subscription,
`gateway.ts:94`) and exposes the PM hook for the sink. Uses `web-push` with
the VAPID details. Per send:

- Resolve prefs once per event, filter per §Preferences.
- Payload (JSON, encrypted by the library): `{ kind, identity, character,
  excerpt?, convId?, url }` where `url` is the in-app route the click should
  land on (conversation route for mention/PM, `/app/@me`-equivalent inbox
  surface for RTB kinds). Keep the payload under the 4 KB push limit —
  excerpts are already ≤160 chars (`EXCERPT_MAX`).
- **Prune on rejection**: HTTP 404/410 from the push service deletes that
  subscription row. Other failures log-and-continue (never throw into the
  sink or the store's emit path — the trigger call sites must be fire-and-
  forget).
- Sends to a user's subscriptions go concurrently; no retry queue in round 1.

**Routes** `modules/push/routes.ts`, registered at `/api/push`, copying the
notifications-routes pattern exactly (`preHandler: app.authenticate`, zod
type provider, per-route `config.rateLimit`):

- `GET /api/push/vapid-key` → `{ enabled: boolean, key?: string }` — this is
  also the client's feature-detection: `enabled: false` when config is unset.
- `PUT /api/push/subscription` — body `{ endpoint, keys: { p256dh, auth } }`
  (validate endpoint is an `https:` URL); upsert on endpoint, owned by
  `request.user.sub` + current `sid` (the `authSessionId`).
- `DELETE /api/push/subscription` — body `{ endpoint }`; delete only rows
  owned by the requesting user.

## 4. Web client

**The service worker** — `apps/web/public/sw.js`, plain static file (Vite
copies `public/` to the dist root; dev/preview serve it at `/sw.js`
automatically; no bundling, no TypeScript — it is deliberately small enough
to not need it):

- `push` handler: parse JSON payload, `showNotification` with title/body
  formatted consistently with `lib/desktop-notify.ts`, the **same `tag`
  scheme** as desktop-notify (this is the double-notification dedup: when a
  background tab's page-side notification and the push both fire, matching
  tags collapse them; `renotify` stays default-false so no double sound),
  `data: { url }`, and the app icon (`/icons/icon-192.png`).
- Suppression: before showing, `clients.matchAll({ type: "window" })` — if
  any client is **focused**, skip display (the page's own notification path
  owns the focused case, mirroring `showMessageNotification`'s
  `document.hasFocus()` gate).
- `notificationclick` handler: close, then focus an existing window client
  (navigating it via `client.navigate`/postMessage to the payload `url`) or
  `clients.openWindow(url)`.
- **No `fetch` handler, no caching, no `install`/`activate` logic beyond
  `skipWaiting`/`clients.claim`.** MP3's no-SW-caching decision stands.

**Server serving**: production serves `sw.js` out of `WEB_DIST` via the
existing `@fastify/static` root (`plugins/web-static.ts`) — add
`cache-control: no-cache` for `/sw.js` specifically so SW updates propagate
promptly (root-scope SWs must not be cached long).

**Registration & subscription flow** — new `apps/web/src/lib/push.ts`:

- The SW is registered **only when push is enabled on this device** (a
  per-device flag in localStorage — device-scoped state does not belong in
  server prefs). No push ⇒ the app never registers a SW; MP3's footprint is
  unchanged for everyone who doesn't opt in.
- Enable flow (from the prefs pane): fetch `/api/push/vapid-key` (bail if
  `enabled: false` — hide the whole control), `Notification.requestPermission`
  (reuse `ensureNotifyPermission`), `navigator.serviceWorker.register("/sw.js")`,
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`,
  `PUT` the subscription. On boot with the flag set: re-register, re-check the
  subscription, re-PUT (subscription rotation happens; re-PUT is the standard
  self-heal).
- Disable flow: `pushManager.getSubscription()?.unsubscribe()`, `DELETE` to
  the server, unregister the SW, clear the flag.
- Logout (`stores/auth.ts` logout path): best-effort local unsubscribe + SW
  unregister; the server side is already handled by the `authSessionId`
  cascade.

**Prefs UI** — `NotificationsPane.tsx` gains a "Push notifications on this
device" toggle next to the desktop-notifications block, with the same
permission-denied warning treatment (`:124-134`), hidden entirely when the
server reports `enabled: false` or the browser lacks `PushManager`. Copy
notes the iOS home-screen requirement when relevant
(`navigator.standalone` heuristics are not required — a static hint line is
fine).

## 5. Tests

- **Sender integration** (`modules/push/push.test.ts`, testcontainers
  harness per `notifications.test.ts`): register a subscription whose
  `endpoint` points at a local HTTP listener started by the test; record a
  mention through the store; assert an encrypted POST arrives (TTL/urgency
  headers present, body non-empty — do not decrypt); assert a 410 response
  deletes the row; assert muted rows and pref-disabled kinds do not send;
  assert the logout cascade removes the row.
- **Route tests**: auth required, ownership on DELETE, upsert on endpoint,
  the `enabled: false` shape when config is unset, subscription cap.
- **Config tests**: all-three-or-none guard, base64url validation.
- **Web unit** (jsdom): `lib/push.ts` enable/disable flows with mocked
  `serviceWorker`/`pushManager`; `sw.js` handler logic if extracted into a
  testable pure function is over-engineering — keep sw.js trivial instead.
- **`shipping-shape.test.ts` (`:70`, `:83`)**: re-scope, do not delete. The
  guards now allow exactly `public/sw.js` and the `lib/push.ts` registration
  path, and gain a **new assertion**: `sw.js` must not contain a `fetch`
  event listener or any cache API reference (`caches.`, `CacheStorage`) —
  the no-offline-caching decision stays enforced by test.
- **E2E**: real push delivery is not CI-testable (needs a live push
  service). One Playwright spec covers the UI flow with a granted
  notifications permission: toggle appears when the server has VAPID keys,
  enable → SW registered (`navigator.serviceWorker.getRegistration()`),
  subscription PUT observed; disable → unregistered. Everything
  compositor/OS-level goes on `design/mobile-device-checklist.md` (new WP
  section: closed-PWA push on Android, iOS home-screen push, notification
  tap → correct conversation).

## 6. Invariants (spec-header material for the PRs)

1. The service worker never handles `fetch` and never touches the Cache API
   — push display and click routing only. Enforced by shipping-shape test.
2. No SW registration occurs unless the user enabled push on that device.
3. Push triggers are fire-and-forget: a push failure can never fail or delay
   the history sink or a notification insert.
4. Payload content respects `notifyShowContent`; muted
   identities/conversations never push.
5. Subscriptions die with their auth session (cascade) — no orphaned
   endpoints receiving pushes after logout.
6. VAPID config unset ⇒ feature invisible end-to-end (no routes advertising,
   no UI, no sender).

## Package cut

- **WP-A (server, #521)**: migration, config, `modules/push/` (sender +
  routes), sink PM hook, sender/route/config tests, docs (`.env.example`,
  self-hosting, compose).
- **WP-B (web, #522)**: `sw.js`, `lib/push.ts`, prefs-pane toggle, logout
  hook, shipping-shape re-scope, web unit tests, the E2E flow spec,
  checklist section.

WP-A merges first; WP-B consumes its routes. One release (minor bump) when
both land and the user's device soak confirms Android delivery.
