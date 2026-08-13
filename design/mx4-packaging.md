# MX4 — Packaging and the release train

> **Shipped — an as-built record, not a plan.** MX4 is complete — both
> installers ship from the release train. This document explains what was
> built and why, which is what a design doc is for; it is not a backlog. Open
> work lives on the issue board (`gh issue list`), never here.

*Implementation spec + as-built, written 2026-08-05 alongside #305. Covers the
one issue that turns MX3's running shell into two files a person can download:
an unsigned macOS DMG and an unsigned Windows NSIS installer, attached to the
same `vX.Y.Z` GitHub release the server image is published against. #306 (docs)
is the rest of MX4 and is deliberately not here. Standing decisions honored:
**unsigned** first release, **macOS + Windows** and no Linux, **one shared
release train**, **no auto-updater** (planning 2026-08-05; #541 records the
electron-updater future and the signing gate in front of it).*

This file exists rather than another section of `mx3-desktop-shell.md` because
almost nothing in it is about the shell. It is about a build: where the pieces
end up, what the two operating systems disagree about, and what a packaged
build can be *made* to prove about itself. MX3's document stays the description
of a running app; this one is the description of a shippable one.

## 1. What the two artifacts contain

`apps/desktop/electron-builder.yml` is the whole configuration. The shape it
describes:

- **`app.asar`: the main process, and nothing else.** Every other artifact is
  an `extraResources` entry, for three separate and independent reasons — a
  native module cannot be `dlopen`'d out of an archive (the server runtime), a
  child process serves the web dist from a real directory it walks itself, and
  the chooser and error pages are `file://` documents with their own CSP.
- **`resources/` is one flat layer**: `server-runtime/`, `web/`, `chooser/`,
  `error/`, `assets/`. Flat because MX3's build script already went to some
  trouble to make the server runtime **sealed and relocatable** (§1 as-built 3
  there: no symlink leads out of it), and a relocatable tree wants a
  destination that is just a name.
- The web dist is renamed `dist` → `web` on the way in, so the resources layer
  reads as a list of things rather than a list of `dist`s.

`paths.ts` is the single resolver for both layouts, and MX4 turned it into one
pure function — `resolveArtifactPaths({ packaged, desktopRoot, resourcesPath,
platform })` — rather than a set of `app.isPackaged` branches spread through the
shell. Everything but the web dist is the same expression with a different root;
the web dist is the one artifact whose two layouts genuinely differ, because in
a checkout it belongs to `apps/web` and in a bundle it does not belong to
anybody. `paths.test.ts` pins both layouts, which means the packaged layout is
tested on a machine that has never packaged anything.

## 2. The version, which is the whole reason packaging touches semantics

House policy keeps every `package.json` in the workspace at `0.0.0`; the release
version is the tag. The desktop shell is the first consumer for which that is
not merely cosmetic: it passes `app.getVersion()` to the embedded server as
`CLIENT_VERSION`, which becomes the `cversion` F-List sees in `IDN`. A packaged
release that identified itself as `EmberChat/0.0.0` would be a protocol
compliance problem, not a cosmetic one.

So the version is injected at package time and nowhere else:

    electron-builder --mac dmg -c.extraMetadata.version=0.26.0

`extraMetadata` merges into the `package.json` that goes into the bundle, which
is what `app.getVersion()` reads — and, because electron-builder's own
`${version}` macro resolves against the same merged metadata, it is also what
names the artifact. Nothing in the tree is rewritten, no build step edits a
manifest, and a checkout keeps saying `0.0.0`, which is the honest label for
something that is not a release.

**Verified** (macOS, local, 2026-08-05): a DMG built with
`-c.extraMetadata.version=0.26.0` produced `EmberChat-0.26.0-mac-arm64.dmg`;
the mounted app's `Info.plist` reports `CFBundleShortVersionString` and
`CFBundleVersion` `0.26.0`; and the running app logs `EmberChat 0.26.0 startup:
local (packaged)` — a line the startup path gained for exactly this, since
`app.getVersion()` is the single value that feeds both the bundle metadata and
the server child's environment. The CI smoke step asserts that line against the
version it injected, so the chain is a test rather than a memory.

## 3. Unsigned, and where the signing seam is

No Apple Developer identity, no notarization, no Windows certificate — the
planning call, not an oversight. What that costs the user is documented in #306
(the right-click-Open dance on macOS, SmartScreen's "more info" on Windows).

What matters here is that it stays **config-only** to reverse:

- macOS: `identity: null`, `notarize: false`, `hardenedRuntime: false`, and
  `CSC_IDENTITY_AUTO_DISCOVERY=false` in CI so a runner's keychain is never
  searched. Signing later means removing `identity`, turning the other two on,
  adding an entitlements file under `directories.buildResources`, and giving CI
  the certificate secrets. No code in `apps/desktop` changes.
- Windows: no `signtoolOptions`/`azureSignOptions` block at all. Symmetrical.

One thing worth writing down because it surprises: an unsigned arm64 macOS app
still launches. electron-builder logs `skipped macOS code signing`, and the
bundle keeps the Electron binary's own **linker-signed ad-hoc** signature
(`codesign -dv` → `flags=0x20002(adhoc,linker-signed)`, `Identifier=Electron`),
which is what satisfies Apple Silicon's requirement that every executable carry
*some* signature. Gatekeeper still refuses it on first open, because that is a
quarantine question and not a signature one.

`publish: null` is in the config for a related reason: with no publish provider,
electron-builder generates no `latest-mac.yml`/`latest.yml` update feed. That is
the no-auto-updater decision expressed as configuration rather than as an
absence. (It is also load-bearing: without it, electron-builder 26.15 dies in
`computeChannelNames` reading `channel` off a null publish config.)

## 4. The packaged smoke test

`scripts/smoke-packaged.mjs`. Every failure mode packaging introduces is a
question about *where things ended up*, and none of them is visible to `tsc`, to
vitest, or to `electron .` on a checkout. They are visible the first time the
real bundle boots the real bouncer. So the test takes the installer apart the
way a user does — `hdiutil attach` the DMG and copy the `.app` off it on macOS,
run the NSIS installer with `/S /D=…` on Windows — seeds an isolated
`--user-data-dir` with `{"mode":"local"}` so the launch does not stop at the
first-run chooser, and launches it with `EMBER_DESKTOP_LIFECYCLE_PROBE=
close-then-quit`.

That hook is MX3's (§6 as-built 6, kept in on the explicit grounds that "MX4's
packaged smoke test wants exactly this"), and it is the app calling its own
close and quit — no GUI automation, no AppleScript. The assertions are exit 0
plus four lines, each of which is a claim about the *bundle* and not about the
shell's logic:

| Line | What it proves about the package |
|---|---|
| `<version> startup: local (packaged)` | the version injection arrived; `app.isPackaged` picked the packaged branch of `paths.ts` |
| `lifecycle probe: close-then-quit` | local mode got as far as a window, i.e. provisioning, the admin CLI in `resources/server-runtime` and the login all worked |
| `window close: hide-to-tray` | the tray exists — a missing icon resource throws where the tray is built |
| `quit: from the tray` | the one path that stops the server child (invariant 6) survived packaging |

Between them they exercise the whole local-mode boot: schema creation, the admin
CLI as an `ELECTRON_RUN_AS_NODE` child out of the resources layer, `safeStorage`
against the real OS keychain, the bouncer on loopback, the main-process login,
and the web app served out of `resources/web`. What it cannot cover is the two
things that need a person: whether the tray icon *renders* legibly and whether
the close-to-tray notification actually appears. Those stay on MX3's device-pass
list.

**It earned its keep twice**, and neither finding was reachable any other way:
it caught a bundle missing 95% of the server's dependencies (§6.1) and it
caught a Windows build whose bouncer could not open a socket at all (§6.3). Both
legs now run it in full — the Windows leg was never degraded.

Two changes came out of running it that belong to the shell rather than the
packaging. A boot that dies before readiness now **retries on a fresh port**
(three attempts; `findFreePort` always documented the race it accepts, and
Windows widens it with OS-excluded port ranges) — which is also the instrument
that proved the Windows failure was not port-specific. And `fail()` **logs
instead of raising a modal dialog** when the lifecycle probe is set: a modal
`showErrorBox` on an automated launch waits for a click that never comes, which
turned a one-second failure into a five-minute timeout.

## 5. CI: a second workflow, not two more jobs

`.github/workflows/desktop-build.yml`, separate from `release.yml`. The reasons,
in order of weight:

1. `release.yml` is one ubuntu job whose entire content is buildx. These legs
   are macOS and Windows, take an order of magnitude longer, and compile native
   modules. A broken runner image on one platform must not delay or muddy the
   image push that self-hosters actually pull.
2. This workflow needs `workflow_dispatch`, to prove the pipeline from a branch.
   `release.yml` must never have one — a manual run of *that* publishes an
   image.
3. They can be re-run independently, which is the difference between "the DMG
   leg flaked" and "re-publish the release".

They are still one train: both trigger on `v*.*.*`, so `gh release create
vX.Y.Z` (the house process, unchanged, and still a human's command) starts both,
and both put their output on that one release. The desktop legs upload with `gh
release upload --clobber`, deliberately outside electron-builder's own
publisher, so what lands on the release is exactly the file the smoke test just
ran. On a `workflow_dispatch` run nothing is published: the installers are
workflow artifacts and the version is `0.0.0-dev.<sha>`.

Each leg is: corepack pnpm → `pnpm build` → `server-runtime` **on this runner**
(argon2 and re2 are native; pglite is WASM and would have travelled) → an
invariant-1 witness → the shell's unit tests on this OS → electron-builder →
the packaged smoke test → upload.

The invariant-1 witness is one line — `require('argon2'); require('re2')` under
plain Node, from the workspace's own tree, after the Electron rebuild has run.
The build script fingerprints those files internally; this is the cheap second
witness, and it is the one that would catch a Windows link kind the seal walk
does not recognise as a way out of the tree.

### The PR leg (#562, added after the fact)

The workflow originally triggered on `v*.*.*` and `workflow_dispatch` only,
which meant the artifact pipeline, electron-builder and the packaged smoke test
first ran *after* a release tag was pushed — the worst moment to learn that the
bundle no longer boots, and the only verification `embedded-server.ts` and
`main.ts` had at all (a test audit put both at 0% unit coverage; the first is no
longer).

So the workflow also triggers on pull requests that touch `apps/desktop/**`,
`packages/session-engine/**` or the workflow file, and those runs take the
`pr-smoke` job instead of the matrix: **macOS only**, `--mac dir` instead of a
DMG, and `smoke-packaged.mjs --unpacked`. Same pipeline, same probe, no
installer.

One platform and that platform, for reasons rather than thrift. Linux is not a
target (below), and packaging one would mean a runner whose tray needs
libappindicator and whose `safeStorage` has no keyring — a green that means
nothing. macOS is a shipped target, its runners are free for public
repositories, and it is the `utilityProcess` branch of the child split, which is
what every platform except Windows uses. Windows stays on the tag leg: slower
runner, slower smoke (a real NSIS install), and the same code path the PR leg
already proved everywhere else. What only a tag run still answers: the DMG and
the NSIS script themselves, and Windows' `spawn` branch.

### macOS is arm64 only, and that is an arch decision about natives

Not a popularity call. The server runtime's native modules are compiled on the
runner that packages them, so a leg can only produce the architecture it runs
on. An x64 or universal DMG needs an x64 macOS runner to compile x64 natives on;
that is a matrix entry the day it is wanted, and nothing in
`electron-builder.yml` is arm-specific. Cross-compiling argon2 and re2 to make
one universal binary would trade a runner for a whole class of build failure.

## 6. As built — the four things that were only true after running it

1. **electron-builder drops the root `node_modules` of any copy, and no filter
   can put it back.** `app-builder-lib`'s `filter.js` opens with `if (relative
   === "node_modules") return false`, ahead of every user pattern — so
   `extraResources: [{ from: server-runtime }]` copies a deployed pnpm tree
   *minus the ~95% of it that is dependencies*. It packages perfectly and dies
   on first boot with `ERR_MODULE_NOT_FOUND: @fastify/cors`. The fix is to name
   the directory as a source of its own (`from: server-runtime/node_modules, to:
   server-runtime/node_modules`), which moves it out of the special case:
   nothing *inside* it is called `node_modules` at the root. Found by the smoke
   test on its first run, which is precisely the class of bug it exists for.

2. **The runtime tree is now deployed hoisted, and that is a packaging fix.**
   `pnpm deploy`'s default layout links every package from `.pnpm`, and those
   links do not survive being packaged: electron-builder recreates them with
   `fs.symlink`, which on Windows needs a privilege an ordinary user does not
   have; pnpm writes *junctions* rather than symlinks there in the first place,
   so the two ends do not agree on what kind of link it is; and an NSIS
   installer has no way to represent either. `--config.node-linker=hoisted`
   makes a flat tree of real directories and the whole question disappears on
   both targets. It is also what MX3's "sealed and relocatable" was really
   reaching for: a tree that can be copied anywhere, by anything, and still
   resolve. The seal walk stays — it now asserts a property instead of
   repairing one, which is the right direction for a guard.

3. **A Windows `utilityProcess` cannot open a listening socket — so the bouncer
   is spawned differently there.** The largest finding of the round, and a real
   defect rather than a CI inconvenience: the packaged Windows app started,
   read its config, resolved every artifact out of `resources/`, and then its
   embedded server died on `listen UNKNOWN 127.0.0.1:<port>`, with
   `getaddrinfo EAI_FAIL` and `WSALookupServiceBegin failed with: 10108`
   alongside — a process with no usable Winsock. Three ports in a row, so not
   the port. Two probes on the *same machine in the same job* then settled it:

   | Probe | Result |
   |---|---|
   | the runner's own Node, `listen(0, "127.0.0.1")` | OK |
   | the **packaged Electron binary**, `ELECTRON_RUN_AS_NODE=1`, same listen | OK |
   | the OS's excluded TCP port ranges | 80, 5985–5986, 47001, 49700–49899 — none of the refused ports |
   | the Electron `utilityProcess` | refused, every time |

   Not the host, not the port, not Electron: the process type. Windows
   therefore starts the bouncer with `child_process.spawn(process.execPath,
   [entry], { ELECTRON_RUN_AS_NODE: "1" })` — the mechanism `admin-cli.ts`
   already uses, for the same reason it gives there (identical runtime, same
   `NODE_MODULE_VERSION`, so the Electron-ABI natives still load, but an
   ordinary OS process). macOS keeps `utilityProcess`, deliberately: it is
   proven there, and Electron cleans it up when the main process dies, which is
   worth having for a child holding a pglite directory no second writer may
   touch. The Windows path buys that back only for the ordinary exits
   (`stopChildOnExit`); a hard crash of the main process could still leave a
   bouncer behind, and that is the one thing this split costs.

4. **Windows portability in `build-server-runtime.mjs`**, each fix naming the
   behavior it accommodates:
   - **`.cmd` cannot be spawned directly.** corepack's `pnpm` on Windows is
     `pnpm.cmd`, and since the BatBadBut fix (Node 18.20.2/20.12.2/21.7.3,
     CVE-2024-27980) `spawn` refuses a `.cmd`/`.bat` target with EINVAL unless
     `shell: true`. That flag hands the line to `cmd.exe`, which does its own
     word splitting, so the arguments are quoted here — a checkout under "My
     Documents" would otherwise arrive as two arguments. Untouched elsewhere.
   - **Severing a link is `unlink` on Unix and `rmdir` on Windows.** A Windows
     directory link is a directory-shaped reparse point: `unlink` refuses it
     with EPERM/EISDIR. `severLink` tries one and falls back to the other.
     `rmSync({ recursive: true })` would be the obvious one-liner and is exactly
     what must not be used on a link.
   - **`rmSync` gets retries.** A `node_modules` tree this size is routinely
     still held by an indexer or a scanner milliseconds after the process that
     wrote it exited; the failure is a transient EBUSY/EPERM. A no-op elsewhere.
   - The walk itself needed nothing: libuv reports junctions as
     `UV_DIRENT_LINK`, so `isSymbolicLink()` is true for them and
     `isDirectory()` is false, which is what makes the seal mean the same thing
     on both targets. That is now written down where the walk is.

## 7. What MX4's packaging deliberately does not do

- **No auto-updater**, and no update feed for one to read (#541).
- **No Linux targets** (planning 2026-08-05; the tray icon path already answers
  for Linux, so adding a target later is config).
- **No signing**, per §3.
- **No "delete local data" affordance** in the uninstaller
  (`deleteAppDataOnUninstall: false`). Parting with history stays a deliberate
  act, the same call the mode switch makes (MX3 §4).
- No tag is ever created by CI. `gh release create vX.Y.Z` remains a human's
  command; the workflows only react to it.

## Invariants (in addition to MX3's)

7. The packaged app resolves every artifact through `resolveArtifactPaths`.
   A second place that knows where `resources/` is will disagree with the first.
8. The version reaches the app only through `extraMetadata`. No build step
   rewrites a `package.json` in the tree.
9. Nothing in `apps/web` or `apps/server` is packaging-aware. The desktop build
   consumes their ordinary outputs and nothing else (MX3 invariant 2, extended
   from the shell to the build).
10. Both packaging legs run the packaged smoke test in full. A leg that cannot
    is a finding to chase, not a check to weaken — §6.3 is what that looks like
    when it is chased, and the answer was a real defect in the product.
