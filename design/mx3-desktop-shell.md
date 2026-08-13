# MX3 — The desktop shell

> **Shipped — an as-built record, not a plan.** MX3 is complete — the shell,
> provisioning, chooser, thin client and tray all shipped. This document
> explains what was built and why, which is what a design doc is for; it is
> not a backlog. Open work lives on the issue board (`gh issue list`), never
> here.

*Implementation spec, written 2026-08-05 after MX2 closed. Covers issues
#299 (scaffold + loopback boot), #300 (mode chooser), #301 (provisioning +
secrets), #302 (thin-client mode), #304 (tray). Packaging/installers are MX4
(#305, #306) and none of this document builds them — but the scaffold's
artifact pipeline is shaped so MX4 packages what MX3 already runs. Standing
decisions honored here: embedded bouncer on loopback (standalone-client.md),
first-run mode chooser + close-to-tray + **no auto-updater in v1** (planned
2026-07-22), unsigned macOS + Windows on the shared release train (planned
2026-08-05). The MX2 facts this leans on: pglite needs a **single-instance
lock as correctness** (no data-dir lock of its own), `DB_DRIVER=pglite` +
`PGLITE_DATA_DIR` boot the real server, and **an Electron-ABI rebuild is
one-way** — a tree rebuilt for Electron cannot run the Node test suite
(design/mx2-pglite-spike.md).*

## Shape: a thin main process, no renderer code

`apps/desktop` is an Electron **main process + preload only**. There is no
renderer bundle and never will be: the renderer is the existing web app,
served by the embedded server on loopback and loaded with
`win.loadURL("http://127.0.0.1:<port>")` — byte-for-byte the deployment
shape, which is the whole point of the embedded-bouncer decision. The window
chrome, tray, and lifecycle are the entire UI surface this package owns
(plus one first-run chooser window, §4).

Out of the workspace's TypeScript project references it stays simple: plain
`tsc` build, `electron .` to run. Vite/HMR buys nothing for a process this
small.

## 1. The server artifact — solving the one-way ABI problem (#299)

The embedded server runs as an Electron `utilityProcess` (Electron's
supported Node child), which means its native deps (`argon2`, `re2`) must be
Electron-ABI — and the spike proved a rebuilt tree can no longer serve
`vitest`. The workspace tree must therefore **never** be rebuilt. Instead:

- `apps/desktop/scripts/build-server-runtime.mjs` produces
  `apps/desktop/server-runtime/` (gitignored):
  1. `pnpm --filter @emberchat/server deploy` — a self-contained prod tree
     (dist + pruned prod deps), the same shape the Docker image uses;
  2. `pnpm add @electric-sql/pglite` **inside that tree** — the server keeps
     pglite as a devDependency (the image prunes it; MX2), but the desktop
     runtime is exactly the consumer that needs it for real;
  3. `@electron/rebuild` over that tree only (`argon2`, `re2`), against the
     workspace's Electron version.
- The workspace tree stays Node-ABI forever; `pnpm test` and the desktop
  app coexist on one machine. The script is cached on a stamp file (server
  dist mtime + Electron version) and re-run by `desktop:dev`.
- The web dist rides along: `WEB_DIST` points at `apps/web/dist` in dev and
  at a copied `resources/web` in the packaged app (MX4's concern).

### As built (#299)

Four things the sketch above did not know, all found by building it:

1. **The deploy needs `--legacy`** (pnpm ≥ 10 otherwise refuses a workspace
   that isn't `inject-workspace-packages`), and it roots the *package* at the
   target — so the entry is `server-runtime/dist/main.js`, not a repo-shaped
   `apps/server/dist/main.js`. It also records `dev: false` in the workspace's
   install state, which makes the *next* pnpm command in the repo want to purge
   `node_modules`; the script snapshots that one file and puts it back.
2. **`pnpm add` inside the deployed tree cannot work.** The deployed manifest
   keeps its `workspace:*` specs, so any install run in that directory tries to
   re-resolve them and dies (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). pglite is
   installed in a one-dependency scratch project (hoisted, so it materializes
   as a plain directory) and copied in.
3. **Invariant 1 has a specific mechanism, and it fired on the first run.** A
   deployed pnpm tree contains exactly one symlink out of itself —
   `node_modules/.pnpm/node_modules/@emberchat/server` → `apps/server`, pnpm's
   hoist alias for the project it just deployed. `@electron/rebuild` resolves
   symlinks to real paths as it walks, went through that door into the
   workspace, and rebuilt the workspace's `argon2` and `re2` for Electron
   (`NODE_MODULE_VERSION 148`; `pnpm test` then couldn't load them). The script
   now severs every escaping symlink before rebuilding and asserts none remain,
   deploys with `--config.package-import-method=copy` so nothing is hardlinked
   back to the pnpm store, and fingerprints the workspace's `.node` files
   around the rebuild — the check that caught this.
4. **Electron ≥ 43 has no install script at all**; the ~100 MB binary is
   fetched lazily on the first `electron .`. So CI needs no opt-out beyond the
   `electron: false` entry in `pnpm-workspace.yaml`'s `allowBuilds`.

Cost on this machine: ~80 s cold (~70 s of it the rebuild), a no-op when the
stamp matches. The stamp is server dist/drizzle/manifest mtime + Electron
version + pglite spec.

## 2. Loopback boot (#299)

- The shell picks a free port itself (bind `127.0.0.1:0`, read, close —
  the standard race-accepted probe), then forks the runtime's `main.js` via
  `utilityProcess.fork` with env, not flags: `DB_DRIVER=pglite`,
  `PGLITE_DATA_DIR=<userData>/db`, `HOST=127.0.0.1`, `PORT=<port>`,
  `APP_BASE_URL=http://127.0.0.1:<port>` (this is what admits the renderer
  origin to the gateway allowlist — app.ts already loopback-aliases it),
  `WEB_DIST`, `AUTH_SECRET` (§3), `RETENTION_POLICY=forever` default.
- Readiness = polling `/healthz` (the image smoke test's contract); a crash
  before ready surfaces the child's stderr in a dialog rather than a blank
  window. The child dies with the app (`will-quit` → kill, and the child
  watches its parent's disconnect as the backstop).
- **Single-instance lock first**: `app.requestSingleInstanceLock()` before
  anything touches the data dir; the second instance focuses the first and
  exits. This is correctness, not politeness — pglite will happily corrupt a
  shared data dir (MX2).

As built, the child's environment is *complete* rather than a patch over
`process.env`: a developer's shell has `DATABASE_URL` and `AUTH_SECRET` in it,
and neither may reach the embedded bouncer. The full set is `NODE_ENV`,
`DB_DRIVER`, `PGLITE_DATA_DIR`, `HOST`, `PORT`, `APP_BASE_URL`, `WEB_DIST`,
`AUTH_SECRET`, `RETENTION_POLICY`, `CLIENT_VERSION` — everything else stays at
its schema default. `productName: "EmberChat"` in the package manifest is what
puts the data dir at `<userData>/db` under a human name instead of under the
package's npm name.

## 3. First-run provisioning + secrets (#301)

First run in local mode, before the server ever boots:

1. Generate `AUTH_SECRET` (32 random bytes) and an app-account password
   (random, never shown); username `desktop`, email a config-derived
   placeholder (the account is a login row on the user's own machine, not an
   identity).
2. Create the account through the **admin CLI code path** — the runtime's
   `cli/admin.js create-user --password-stdin` run as a one-shot
   `utilityProcess` against the same env. Sequential with the server boot,
   never concurrent (single-connection pglite).
3. Persist both secrets with `safeStorage.encryptString` to
   `<userData>/secrets.json` (fail closed if `isEncryptionAvailable()` is
   false: tell the user the OS keychain is unavailable rather than writing
   plaintext).

Every later boot: decrypt, boot server, **log in from the main process**
(`POST /api/auth/login` on loopback with a desktop `deviceLabel`), and hand
the session to the renderer by seeding the web app's own persisted-auth
localStorage key (`eb.auth`, shape per `apps/web/src/stores/auth.ts`) from
the preload before the page's scripts run. The renderer wakes up already
signed in — the user never sees the app's login screen, exactly as the
design promised; the F-List password prompt (memory-only vault, unchanged)
remains the only credential interaction.

### As built (#301)

1. **The admin CLI child is not a `utilityProcess`.** A utility process has no
   writable stdin — Electron's own docs: "Configuring `stdin` to any property
   other than `ignore` is not supported and will result in an error", and
   `UtilityProcess` exposes only `stdout`/`stderr`. `--password-stdin` is not
   negotiable (argv is readable by every process on the host, as the CLI's own
   header says), so the child is `child_process.spawn(process.execPath, …)`
   with `ELECTRON_RUN_AS_NODE=1`: the same Electron runtime a utility process
   gets — same `NODE_MODULE_VERSION`, so `server-runtime`'s Electron-ABI
   `argon2` loads — but an ordinary Node child, with a stdin. Everything else
   holds: same complete env (`buildAdminCliEnv`, no ambient inheritance),
   sequential with the server, exit code asserted, stderr into the dialog.
2. **The seed travels over `ipcRenderer.sendSync`.** Only synchronous work can
   hold the window between the preload and the page's scripts. The alternative,
   `additionalArguments`, would put a live refresh token on the renderer
   process's command line, where `ps` can read it. A sandboxed (`sandbox:
   true`) preload can do this: `ipcRenderer` is available there, and the
   isolated world shares the page's `localStorage`. The `sandbox: false` +
   `.mjs` fallback the scaffold flagged was not needed.
3. **One seed per boot, and it always wins.** The main process hands the seed
   to whoever asks first and returns `null` after that. Once, because the store
   rotates the seeded token as it boots — a reload re-writing the spent one
   would log the user out. Always, because the localStorage a previous boot
   left behind may hold an expired or evicted session, while this boot's login
   is known good.
4. **First run boots the server twice.** The admin CLI does not migrate ("the
   server migrates on boot", per its own header), and a first run's database is
   empty, so `create-user` fails on a table that does not exist. The server
   therefore gets one short boot to create the schema and is stopped —
   `stop()` now reports whether the child is confirmed gone, and provisioning
   refuses to continue if it is not — before the CLI opens the same directory.
   Second and later boots start the server exactly once.
5. **A half-finished first run heals itself; a corrupt secrets file does not.**
   If the CLI created the account but the secrets file never landed, the next
   boot's `create-user` fails with "already taken" and provisioning falls back
   to `reset-password` for the same account — nothing is destroyed, the
   password is machine-generated and never shown. A secrets file that exists
   but will not decode stays a hard error with the file's path in it: deleting
   it is the user's call, not the app's.
6. Login is a plain `fetch` from the main process; a fresh auth-session row per
   boot is absorbed by the M7 per-user session cap (25, evicted by
   `lastSeenAt`). No session reuse, no second secret to store.

## 4. First-run mode chooser (#300)

A small dedicated window (the one piece of shell-owned UI; plain HTML/CSS in
`apps/desktop`, styled with the design-system tokens, no framework): **"Use
locally"** (embedded bouncer, everything above) or **"Connect to my
server"** (thin client, §5, takes a URL). The choice and the URL persist in
`<userData>/config.json` (not a secret). Switching later is a menu item —
"Switch mode…" reopens the chooser; switching away from local **does not
delete the local data dir** (parting with history is a deliberate act; a
"delete local data" affordance can come with MX4's polish if wanted).

### As built (#300)

1. **Unreadable config means absent, and that is the whole recovery story.**
   `config.json` is plain JSON beside `secrets.json` and deliberately unlike
   it: a truncated file, an unknown `version`, a `serverUrl` that no longer
   validates all read as `undefined`, which brings the chooser back. Nothing is
   deleted, and re-picking "Use locally" lands on the install that was already
   there — where a corrupt *secrets* file has to be a hard error, because
   guessing would strand an account nobody has the password for. The stored URL
   is re-validated on every read, not just on the way in: it becomes a
   `loadURL`, and the file is one a person can open in an editor.
2. **The page is `file://` with a strict CSP and its own preload.**
   `default-src 'none'` plus `'self'` for its one script and one stylesheet —
   which does work for a `loadFile` document, verified rather than assumed. The
   bridge exposes exactly `chooseLocal()` and `chooseThinClient(url)`; the two
   values the page needs while building itself (product name, prefilled URL)
   ride in as `loadFile` query parameters instead of a third call. The
   `/healthz` probe therefore runs in the main process, which is where it
   belongs anyway: from the page it would be answering a CORS question.
3. **The tokens are copied by value, with a comment naming the source.** The
   chooser cannot read the web app's stylesheet (there is no server yet) and
   must not reach into `apps/web` at build time (invariant 2), so `chooser.css`
   restates the handful of Slate/Dusk values it uses. It is also the one
   surface with no theme preference to honour — it runs before there is a user.
4. **URL rules, one of them found by running it.** https required; `http://`
   only for the literal loopback spellings (never a name that merely resolves
   there). A scheme-less address gets `https://` — *except* on loopback, where
   it gets `http://`: typing `localhost:3000` and being told https is
   unreachable is a refusal on principle against the developer's own server.
   And a 200 is not proof: a parked domain, a router's login page and a static
   host that serves `index.html` for every path all answer one, so the body has
   to be the `/healthz` contract. That is what makes "wrong address"
   distinguishable from "your server is down".
5. **Switching relaunches; a first run applies in place.** Nothing has started
   on a first run, so the app simply continues into the chosen mode. A later
   change stops the server child cleanly (SIGTERM — pglite is a file on this
   user's disk) and then `app.relaunch()` + `exit`, rather than growing a
   second, subtler boot path whose only user is a switch nobody makes twice.
   Re-picking the mode already running writes nothing and just closes the
   window. The local data directory is untouched in every case.
6. **The thin-client window here is the naive one** — `loadURL` plus the
   scaffold's navigation policy, which is most of §5's behaviour and none of
   its hardening (#302). The auth-seed preload is shared by both windows and is
   inert in this mode: no login happened, so the dispenser answers `null`.
7. The window is fixed at 560×656 *content* pixels: the page measures 568 at
   rest and 643 with the longest refusal wrapped to two lines, and a fixed
   window that clipped the sentence explaining its own refusal would be the one
   thing this window must not do.

## 5. Thin-client mode (#302)

The window loads the remote instance's URL directly — the whole web app
comes from the user's self-hosted server, login screen and all, exactly like
a browser tab with an app frame around it. No embedded server, no
provisioning, no localStorage seeding. Validation on entry: fetch
`<url>/healthz` and refuse with a legible message otherwise. External links
(profile links etc.) open in the system browser in both modes
(`setWindowOpenHandler`); navigation away from the app origin is refused.

### As built (#302)

The sketch above is one paragraph because in local mode the window's content
comes from a server this process started. Thin-client mode changes exactly one
thing and it changes everything downstream of it: **the renderer is a machine
this process does not control**. Five consequences, each with its own file:

1. **Every IPC channel checks its caller** (`ipc-sender.ts`, wired in
   `main.ts`). `ipcMain` is process-wide — a handler registered for the chooser
   is reachable from any renderer, including a main window at somebody else's
   origin. Each of the five channels names one legitimate caller: the chooser's
   two answer its `file://` page, the error page's two answer its own, and the
   auth seed answers the origin this process chose to show. The predicate is
   pure and table-tested; the wiring adds a `webContents` identity check beside
   it, because the two refuse different things — identity refuses *another
   window*, the URL refuses *this window showing another document*, and a
   subframe is refused by both. Nothing in the page's world can reach these
   channels today (`contextIsolation` + a preload that exposes nothing), so
   this is the second lock; it is worth having because the first is one
   Chromium bug from being off and the cost is a boolean. Verified in a real
   frame, not just in unit tests: the shipped preload calling from the real
   page is allowed, the same preload on a remote origin is refused, and so is
   the same page in a window the main process was not expecting.
2. **The shell owns the failure surface** (`error/` + `error-window.ts` +
   `error-page.ts`). A `did-fail-load` on the main frame, or a dead renderer,
   replaces the window with a static `file://` page built exactly like the
   chooser — `default-src 'none'`, tokens copied by value, variable strings as
   query parameters, a bridge of exactly two calls (Retry, Switch mode…). It is
   a *second window* rather than a document in the app window, because the app
   window is allowed to be at the app origin and nowhere else (#299's
   navigation policy) and because that window's preload deliberately has no
   bridge. Retry re-runs the whole launch — probe included — and a second
   failure that differs from the first re-states headline, sentence and code in
   place rather than lying about which failure is on screen.
3. **The probe runs on every launch, on Electron's network stack.** The stored
   URL was already re-validated as text on every read (#300 as-built 1); this
   is the other half. `net.fetch` rather than Node's `fetch` is the load-bearing
   detail: it uses the same Chromium stack, system trust store and proxy config
   the window is about to use, so the probe accepts a server if and only if the
   window would have — Node's own CA bundle would refuse a certificate the OS
   trusts. Cost: one `GET /healthz` before a connection Chromium was about to
   make anyway. Benefit: the error page appears in about a second instead of
   after a TCP timeout, and it can say *which* thing went wrong.
4. **Certificate errors are fatal and say so by name.** No `certificate-error`
   listener, no `setCertificateVerifyProc`, no "proceed anyway" — a test greps
   the shell's sources for all three, and the copy is checked for the words a
   bypass would need. Electron's default refusal arrives as `ERR_CERT_*`, and
   both halves name it: the probe extracts the code from either stack's
   error shape (undici's `cause.code`, Chromium's `net::ERR_CERT_…`) and the
   page shows it on a row of its own. Against a local https server with a
   self-signed certificate the app refuses at the probe, logs
   `ERR_CERT_AUTHORITY_INVALID`, and the stand-in server records no request at
   all — nothing was sent to it.
5. **The seed is provably inert, not merely unused** (`createSeedHolder`).
   #300 observed that the shared preload's dispenser answers `null` in this
   mode. That was true by omission — a variable that never got assigned along
   one code path. It is now a property of the startup plan: the holder is built
   from `plan.kind`, and arming one in any mode but `local` throws. The preload
   is untouched and stays shared (`preload.cts` has no mode to branch on and
   should not learn one).

Two smaller findings, both from running it:

- **The default session already persists**, and that is what makes "keep me
  signed in" work in this mode: with no `partition` set, cookies and
  localStorage live in the user-data directory (`Cookies`, `Local Storage/`)
  and survive a full restart. Verified rather than assumed — a stand-in server
  reported `visits=1, cookieBefore=false` on the first launch and `visits=2,
  cookieBefore=true` on the second.
- **"Switch mode…" from the error page needed one change in #300's code.**
  `applyChoice` treats re-picking the running configuration as a no-op that
  closes the chooser; reached from the error page there is no window to be a
  no-op *of*, and re-entering the same address means "try that again". It now
  requires an app window to be open before taking that shortcut — without it,
  closing the chooser would leave no windows and quit the app.

What is deliberately **not** here: the issue's original sketch also mentioned
per-server credentials in `safeStorage`, a reconnect banner and a version-skew
warning. All three belong to the web app the remote server serves — it already
has its own login, its own gateway reconnect surface and M7's `/api/meta`
release check — and putting a second one in the shell would mean the desktop
build disagreeing with the browser about the same server. The shell's job here
is the window, the failure surface and the trust boundary.

## 6. Tray + lifecycle (#304)

- **Local mode:** window close hides to tray; the bouncer keeps running —
  that IS the product. Tray: app name + status, Open, Quit. Explicit Quit
  stops the server child cleanly (SIGTERM → the existing graceful close) and
  exits. The dock/taskbar reflects hidden state per-platform conventions
  (macOS: keep dock icon, standard; Windows: tray icon).
- **Thin-client mode:** close quits. There is no local bouncer to keep
  alive, and the remote one doesn't need this process — pretending
  otherwise would be tray theater.
- First close in local mode shows a one-time notice ("still running in the
  tray — your sessions stay online"), the honest-deal line the design doc
  asked the UI to say out loud.

### As built (#304)

The sketch is three bullets because the behaviour is three bullets. What it
does not say is that "close" is two different events with two different
answers, and that the difference between them is where a lifecycle goes wrong.

1. **Two decisions, and a hidden window is still a window.** A window's `close`
   event asks *should this window go away* (`decideWindowClose`); `window-all-closed`
   asks *should the app go away* (`decideLastWindowClosed`). Both are pure
   functions over the same three facts — mode, is there a tray, is a quit
   already under way (`tray-model.ts`) — and both are in the table tests. In
   local mode the first answer is "hide", which means the second event usually
   never fires at all: a hidden window still counts as a window. The path that
   does reach it is the one where a window is *destroyed* rather than closed
   (#302's dead-renderer replacement) and the thin-client and chooser cases,
   which quit exactly as they did before. That is why the app's survival is not
   left to "the event did not fire" — it is a verdict, logged as one.
2. **`before-quit` is what keeps close-to-tray from eating the quit.** A window
   that hides itself on close hides itself during `app.quit()` too, and the app
   never finishes leaving. Electron's own idiom fixes it: `before-quit` sets a
   flag, the flag is the third input to both decisions, and the mode switch's
   relaunch — which never goes through `before-quit` — folds in through the
   existing `stopping`. The tray's Quit is therefore a plain `app.quit()`, not
   its own shutdown sequence: `will-quit` stays the only place the server child
   is stopped, and invariant 6 keeps its single writer.
3. **The tray comes up before the server, not after.** A first run spends the
   better part of a minute provisioning with no window on screen, and the tray
   is the only thing the app can show for itself while that happens — which is
   also where the spec's "connecting" state earns its keep: `connecting` until
   `/healthz` answers, `running` after, and nothing in between. Two states, no
   poller: the shell knows the child booted and that `onUnexpectedExit` has not
   fired, and a status line built out of anything more would be a monitor the
   spec did not ask for. The status is also deliberately about *the bouncer*
   and not about F-Chat, whose per identity connection state is the web app's
   to display and not this process's to claim. (The line itself was reworded by
   the copy pass — see "The copy pass (#543)" below.)
4. **The notice is a notification, and the flag follows it rather than leading
   it.** A modal dialog appearing where the user's window just was is the app
   arguing with them; a notification is what every other close-to-tray app
   uses. `<userData>/config.json` gains one optional `trayNoticeSeen: true`,
   written only after something was actually shown — on a machine with
   notifications unavailable the sentence is still owed and the next close may
   try again. Additive, so `version` stays 1: an older build ignores the key, a
   newer one reads a file without it as "not said yet", and the worst case in
   either direction is one extra sentence. The chooser carries the flag across
   a mode switch (`withTrayNoticeSeen`), because switching away and back is not
   a reason to explain the tray twice.
5. **Two icons, because the two platforms want different pictures.** macOS's
   menu bar takes a *template* image — black plus alpha, tinted by the OS for
   light, dark and selected — which the plate cannot survive (a black rounded
   square is not an icon), so the template is the flame's silhouette alone.
   Windows' notification area gets the artwork as drawn, plate included, which
   is what keeps the mark legible on a light *and* a dark taskbar. Both at 1x
   and 2x; `nativeImage` picks up the `@2x` file beside the one it is given.
   They are generated by `scripts/generate-tray-icons.mjs` on exactly the terms
   `apps/web/scripts/generate-icons.mjs` set: hand-run, output committed,
   single-sourced from `favicon.svg` so a retint of the mark reaches the tray
   through one command. Reading the web app's art at *build* time would be
   invariant 2; reading it in a generator nobody runs on a build is how the
   repo already keeps one drawing instead of three.
6. **One test hook, kept on purpose** (`test-hooks.ts`). Everything above is a
   click on a close button, a hidden window and a menu item in the system tray
   — none of which any headless test can produce, and GUI automation is out of
   bounds. So the app drives itself: with `EMBER_DESKTOP_LIFECYCLE_PROBE` set
   to `close` or `close-then-quit`, local mode closes its own window a couple
   of seconds after it opens and (for the second value) calls the very function
   the tray's Quit item calls. Unset — which is every real launch — the file
   does nothing, and a test asserts that. It stays in because MX4's packaged
   smoke test wants exactly this.

What that bought, run against an isolated `--user-data-dir` on macOS: in local
mode the window closes to `hide-to-tray`, the process is still alive, its
server child is still alive and `/healthz` still answers 200 while nothing is
on screen, and `config.json` has grown its `trayNoticeSeen`. `close-then-quit`
then logs the tray's quit, closes the window for real, and the process exits 0
with the server child confirmed gone and the port refusing connections. In
thin-client mode the same close logs `close` → `last window closed: quit` and
the process exits 0; so does the #302 state where the shell's error window is
the only window there is.

Not verifiable without a person at the machine, and left for the MX4 device
pass: that the tray icon renders legibly (and inverts correctly in a dark menu
bar), that "Open" and a dock click bring the hidden window back, that the
notification actually appears — an unsigned dev run's notifications arrive
under Electron's identity, and a packaged build is the first honest test of
that — and that the mode switch's `tray.destroy()` leaves no ghost icon.

### The copy pass (#543)

Watching the shell's windows after MX3 showed how much of this spec's own
vocabulary had leaked into them: "the bouncer stopped", "the embedded server
exited unexpectedly (code N)", "this computer runs the bouncer". Every sentence
a user can actually read was rewritten in plain language — the chooser's two
option bodies, the error page's headlines and note, the tray status line and
one-time notice, and every `showErrorBox` detail on the startup paths
(`main.ts`, `embedded-server.ts`, `desktop-login.ts`, `admin-cli.ts`,
`paths.ts`, `provisioning.ts`, `secrets.ts`, `server-url.ts`).

Two rules came out of it and are worth keeping. **Say what it means for the
user, not what a process did** — the tray now reads "Running — you stay online
with the window closed" rather than naming a server child. And **the technical
detail survives, demoted**: a human first line, a blank line, then
`Details: <exit code / error name / path / stderr>`, because a bug report needs
the code and a headline does not. "Bouncer" and "embedded server" stay exactly
where they were in comments, logs and this document; they are simply not
sentences any more.

## 7. What MX3 explicitly does not do

- No packaging/installers/signing (MX4 — now built; see
  [mx4-packaging.md](mx4-packaging.md), which also records the two things it
  changed here: the server runtime is deployed **hoisted** so the tree carries
  no links a packager has to reproduce, and `paths.ts` grew a packaged branch
  beside every dev one).
- No auto-updater: the web app's existing update surface (M7's release
  check via `/api/meta`) already renders inside the embedded shell and
  serves as the download hint — nothing new needed in v1.
- No multi-device listening beyond loopback (a future opt-in, per design).
- No macOS/Windows platform-specific polish beyond what tray conventions
  require (MX4).

## Invariants

1. The workspace `node_modules` is never Electron-rebuilt; only
   `server-runtime/` is. A leaked rebuild is the "invalid ELF/ABI" class of
   failure the spike documented — the build script must be the only writer.
2. The renderer is the unmodified web app; `apps/desktop` contains no
   renderer JS beyond the preload seed. Any desktop-conditional behavior in
   `apps/web` needs its own justification and review.
3. The embedded server binds `127.0.0.1` only; the origin allowlist stays
   derived from `APP_BASE_URL`. Never `0.0.0.0`.
4. Secrets exist only under `safeStorage`; no plaintext fallback.
5. The single-instance lock precedes any data-dir access.
6. Local-mode Quit is the only path that stops the server child; window
   close never does.

## Issue cut

- **#299**: package scaffold, `build-server-runtime` pipeline, free-port
  boot, `/healthz` readiness, window on loopback, single-instance lock,
  child lifecycle. Provisional hardcoded local mode (chooser comes next).
- **#301**: provisioning flow, safeStorage, main-process login + preload
  auth seeding. After this lands the app is usable end-to-end in local mode.
- **#300**: the chooser window + config persistence + switch-mode menu item.
- **#302**: thin-client mode behind the chooser.
- **#304**: tray + lifecycle + the one-time notice.

#299 → #301 are sequential; #300/#302/#304 can follow in any order but land
one at a time (each is small). Testing: the shell's logic (port probe,
provisioning sequencing, config persistence) is plain Node — unit-testable
with vitest in `apps/desktop` without booting Electron; whole-app E2E waits
for MX4's packaged builds (Playwright's Electron driver is worth a look
then, not now). Every PR targets `staging`.
