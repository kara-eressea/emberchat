# Desktop real-machine checklist

Everything the MX track built was verified on build machines: unit tests with
no Electron in them at all, and a packaged smoke test that installs the real
artifact and boots the real bouncer out of it on both operating systems. What
neither can be is *somebody's computer* — a machine with a quarantine bit, a
keychain that prompts, a SmartScreen reputation service, a menu bar, a taskbar
and a person looking at them. This file is the remainder, gathered from
[mx3-desktop-shell.md](mx3-desktop-shell.md) and
[mx4-packaging.md](mx4-packaging.md) into one list that can be run in one
sitting.

It is ordered as that sitting rather than by issue: **a macOS pass, then a
Windows pass, then the handful of checks that are the same on both**, each
starting with the install so everything after it happens in the app the checks
are about. Two machines, perhaps forty minutes.

Each item says what to look for and — where the failure has a known first
suspect — where to start if it is wrong. Nothing here blocks a release; this
is the confidence pass on work that shipped on measurement and inference.

## What is already known, and what is left

Five facts bound the list, all of them measured rather than assumed:

- **The packaged artifact boots, on both platforms, in CI.**
  `scripts/smoke-packaged.mjs` mounts the DMG (or runs the NSIS installer with
  `/S`), launches the installed app against an isolated `--user-data-dir`, and
  asserts four log lines: the injected version with `(packaged)` beside it,
  the window reaching local mode, `window close: hide-to-tray`, and
  `quit: from the tray`. Between them that exercises schema creation, the
  admin CLI out of `resources/`, `safeStorage` against the real OS keychain,
  the bouncer on loopback and the web app served from the bundle
  (mx4-packaging.md §4). **It earned its keep twice** — a bundle missing 95%
  of its dependencies, and a Windows build whose bouncer could not open a
  socket at all. So "does the packaged app work" is not what this list is for.
- **No GUI automation exists anywhere in this project, deliberately.** Every
  window behaviour was verified by the app driving *itself*
  (`EMBER_DESKTOP_LIFECYCLE_PROBE`, mx3-desktop-shell.md §6 as-built 6): it
  closes its own window and calls the same function the tray's Quit item
  calls. That proves the *decision* and the *lifecycle*. It has never proved
  that a click on a tray menu item arrives, that a hidden window comes back,
  or that anything is legible.
- **A CI runner cannot meet the security prompts at all.** Gatekeeper's
  refusal needs a quarantine attribute, which only a browser download sets —
  `curl` does not, so no scripted download reproduces it. SmartScreen's
  warning is a reputation service's opinion of a file it has never seen.
  Neither is a bug that could be caught; both are the first thing a user
  meets.
- **The Windows bouncer is spawned differently from the macOS one, and that
  costs exactly one thing.** MX4 §6.3: an Electron `utilityProcess` on Windows
  cannot open a listening socket (`listen UNKNOWN`, `WSALookupServiceBegin
  10108`, three ports, two probes on the same machine to establish it), so
  Windows starts the server with `child_process.spawn(process.execPath, …)`
  under `ELECTRON_RUN_AS_NODE`. macOS keeps `utilityProcess`, where Electron
  cleans the child up when the main process dies. Windows buys that back for
  ordinary exits only — **a hard crash of the shell could leave a bouncer
  behind**, and that is the one thing the split costs. It is the highest-value
  item on this list.
- **pglite takes no lock on its data directory** (mx2-pglite-spike.md Q4): two
  processes open the same directory happily, and a second writer is a
  corruption path. `app.requestSingleInstanceLock()` is therefore correctness,
  not politeness — which makes both the second-launch item and the orphan item
  below checks on the same property from two sides.

---

## macOS pass (Apple Silicon)

Do the download **in a browser**. A `curl`'d DMG carries no quarantine
attribute and the entire Install section below will silently pass without
testing anything.

### Install

- [ ] **Gatekeeper refuses the first double-click**, naming an unidentified
      developer. If the app just opens, the quarantine bit was never set —
      re-download in a browser before reading anything into it.
- [ ] **Right-click → Open → Open works, exactly once.** After that, ordinary
      double-clicks and Dock launches open it with no dialog at all. This is
      the sentence [docs/desktop.md](../docs/desktop.md) promises users; if the
      dance has to be repeated, that document is wrong and needs to say so.
- [ ] **The DMG window itself is sane**: the app and an Applications shortcut,
      and dragging one onto the other works. Nothing here is custom — it is
      electron-builder's default layout — which is exactly why nobody has
      looked at it.
- [ ] **The keychain prompt, on a Mac that is not the developer's.** First run
      writes `secrets.json` through `safeStorage`, and a fresh login keychain
      may ask for permission. Expect at most one prompt, and expect the app to
      continue when it is allowed. **Deny it** on a throwaway account: the app
      must say the keychain is unavailable and stop, never write secrets in
      plaintext (invariant 4).
- [ ] **The first run's silent minute looks intentional.** Provisioning takes
      the better part of a minute with no window on screen; the menu-bar icon
      appears first and reads *Starting up…*. A user with nothing to look at
      for that long is a bug report, so check that the icon really is there
      the whole time.

### Menu bar and lifecycle

- [ ] **The template icon is legible in a light menu bar, a dark menu bar, and
      while its menu is open** (macOS tints it for all three). It is the
      flame's silhouette alone — the plate cannot survive being a template
      image (mx3-desktop-shell.md §6 as-built 5). A black rounded square means
      the wrong file is being loaded.
- [ ] **Closing the window hides it and the notice appears.** Close with the
      red button or ⌘W: the window vanishes, the app is still in the menu bar,
      and a notification says it is still running. This is the first honest
      test of the notification — an unsigned dev run's notifications arrive
      under *Electron's* identity, and a packaged build is the first time it
      speaks as itself.
- [ ] **The notice is said once and never again**, including after quitting,
      relaunching, and switching mode away and back (`trayNoticeSeen` is
      carried across the switch on purpose). If notifications are disabled for
      the app, the flag should *not* be set — the sentence is still owed.
- [ ] **The hidden window comes back**, from the menu-bar "Open", from clicking
      the icon, and from clicking the Dock icon. Three routes, all of them
      unobserved by any test.
- [ ] **Your characters really do stay online with the window closed.** Close
      the window, then check from another client (or the F-List site) that the
      character is still connected. This is the product; nothing else on this
      list matters if it is false.
- [ ] **Quit from the menu bar quits, completely.** No leftover menu-bar icon,
      no EmberChat process in Activity Monitor, and the characters go offline.
- [ ] **A mode switch leaves no ghost icon** (`tray.destroy()` on relaunch).

## Windows pass

Download in a browser here too, for the same reason.

### Install

- [ ] **SmartScreen, as a user meets it**: *"Windows protected your PC"* →
      **More info** → **Run anyway**. Note the publisher line's exact wording —
      that is what people will quote in bug reports, and
      [docs/desktop.md](../docs/desktop.md) should match it.
- [ ] **No UAC prompt at any point.** The install is per-user by design
      (`perMachine: false`). An elevation prompt means that leaked, and an
      unsigned installer asking for admin is the exact shape of thing users are
      told to refuse.
- [ ] **The directory choice works**, and the Start-menu and desktop shortcuts
      exist and launch the app.
- [ ] **Antivirus.** An unsigned NSIS installer wrapping a Node runtime and two
      native modules is a shape some products quarantine on sight. Note
      anything that intercepts the download, the install or the first launch —
      including a delay long enough to look like a hang.

### The bouncer's lifecycle — the one real Windows risk

- [ ] **Nothing is orphaned after a hard crash of the shell.** With the app
      running in local mode, kill the *main* process from Task Manager (End
      task on the top-level EmberChat entry, not the tree). Then look for a
      remaining EmberChat process, and relaunch the app. Expected: no
      survivor, and a clean relaunch. A survivor is holding the pglite data
      directory, which nothing in pglite prevents a second process from opening
      as well — start from `stopChildOnExit` and the child's parent-disconnect
      watch (mx4-packaging.md §6.3). **This is the item this list exists for.**
- [ ] **A normal quit leaves nothing behind** — the control for the item above.
      Tray → Quit, then Task Manager: no EmberChat process, and the loopback
      port refuses connections.
- [ ] **A forced restart of the machine costs seconds, not the database.** With
      the app running and a conversation open, hard-reset the machine. On
      relaunch the app starts normally and the history is intact bar perhaps
      the newest lines. `fsync` is off and cannot be turned on (mx2 Q4);
      `full_page_writes` and checksums are on, so "lose the last few seconds"
      is the promise [docs/desktop.md](../docs/desktop.md) makes, and this is
      the check on it.

### The menu bar

- [ ] **No File/Edit/Help strip above the chat** (#579). `autoHideMenuBar`
      hides it; it is not removed, so **Alt** must still summon it — and while
      it is up, **Switch mode…**, **Save a backup…** and the update checkbox
      must all still be there and still work. If Alt brings back nothing, the
      menu was dropped rather than hidden and the shell's own items went with
      it (`window.ts`, `menu.ts`).
- [ ] **The window's usable height grew by the strip's height**, and nothing in
      the web app is clipped at the top as a result.

### The notification area

- [ ] **The icon is legible on a light and a dark taskbar.** Windows gets the
      artwork as drawn, plate included, which is what is supposed to make both
      work.
- [ ] **Find it where Windows actually puts it**: new tray icons go into the
      overflow ("hidden icons") flyout, and that is where most users will meet
      it. It must be identifiable there, and its menu must work from there.
- [ ] **The close-to-tray notice arrives as a real toast**, once, and is
      readable in the Action Center afterwards.
- [ ] **Open and Quit both work from the tray menu**, and a click on the icon
      restores the window.

### The `file://` path-case predicate

- [ ] **The chooser's and the error page's buttons work from an installed
      path.** Reach both on a real install: the chooser via **Switch mode…**,
      the error page by pointing thin-client mode at an address that fails.
      Every button on both pages must do something. This is the only test of
      `senderAllowed`'s Windows case-insensitive path comparison against
      Chromium's *actual* spelling of a `file://` URL for
      `C:\Users\…` — the unit tests pin the predicate, not Chromium's
      spelling, and a mismatch shows up as buttons that silently do nothing
      (`ipc-sender.ts`).
- [ ] **The same, from a profile path with a space or a non-ASCII character**
      in it, if such a machine is available. Same buttons, same expectation.

## Both platforms

- [ ] **The version is the release version, not `0.0.0`.** It sits at the top
      of the sidebar and under Preferences → General. It is also what F-Chat
      sees as `cversion`, which makes it a protocol-compliance check and not a
      cosmetic one (mx4-packaging.md §2).
- [ ] **The update surface points somewhere.** Once a newer release exists, the
      version tints and links to the releases page — the only update mechanism
      there is (#541). This is the one item that has to wait for a later
      release to exist.
- [ ] **A second launch focuses the first window** instead of opening a second
      one, and no second process survives the attempt. The single-instance lock
      is what stands between two processes and one pglite directory.
- [ ] **Thin-client mode against a real self-hosted instance over real TLS**:
      the address is accepted, the server's own login screen appears, signing
      in works, and it is *still* signed in after quitting and relaunching
      (session persistence lives in the user-data directory).
- [ ] **A certificate the OS does not trust is refused by name.** Point
      thin-client mode at a self-signed https server: an `ERR_CERT_*` code on
      the error page, no "proceed anyway" anywhere, and the app never sends a
      request to that server (mx3-desktop-shell.md §5 as-built 4).
- [ ] **Closing the window in thin-client mode quits the app** — no tray, no
      background process, because there is no local session to keep alive.
- [ ] **External links open in the system browser**, in both modes. A profile
      link should never navigate the app window away from the app.
- [ ] **Uninstalling keeps the data directory**, and reinstalling comes back to
      the same history and the same mode. `deleteAppDataOnUninstall: false` is
      deliberate (mx4-packaging.md §7); this is the check that it is also
      *true*.
- [ ] **A backup taken the documented way restores.** Quit, copy the user-data
      directory, delete the original, relaunch (a fresh first run), quit, put
      the copy back, relaunch: the history is there. The cold copy was proved
      valid in the spike against pglite directly (mx2 Q4) — never against a
      copy of a real install made by a person following
      [docs/desktop.md](../docs/desktop.md).
