// E2E against the full stack: Postgres (testcontainers) + fchat-sim + the
// built server process are booted in global-setup; the vite dev server below
// proxies /api to that server (same-origin, like production).

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port number, got "${raw}"`);
  }
  return port;
}

// Two working copies must be able to run the suite at once. That was already
// possible via the env overrides below, but only by picking a free range by
// hand (#617) — so the defaults are now derived from this copy's own path
// instead of being the same two numbers everywhere.
//
// Deliberately a hash rather than a probe-for-a-free-port: the ports are
// module-level constants that `defineConfig` and global-setup both read, so
// resolving them would mean async work at config load. Deriving them keeps it
// synchronous and, more usefully, *stable* — a given checkout always gets the
// same ports, so the `lsof` in global-setup's error message stays copy-and-
// pasteable and a stale bouncer is findable tomorrow.
//
// The block sits below the ephemeral range macOS allocates from (49152+), and
// the stride leaves a spare port per copy for whatever comes next. Two copies
// colliding needs a hash collision across 400 slots; the fail-fast guard in
// global-setup still catches it and says what to do.
const PORT_BLOCK_START = 39_000;
const PORT_BLOCK_SLOTS = 400;
const PORTS_PER_COPY = 4;

function derivedPortBase(): number {
  // apps/web/ of this checkout — distinct per working copy, and unchanged
  // across runs of the same one.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const slot = createHash("sha256").update(here).digest().readUInt16BE(0);
  return PORT_BLOCK_START + (slot % PORT_BLOCK_SLOTS) * PORTS_PER_COPY;
}

const PORT_BASE = derivedPortBase();

// The other two are already collision-free: fchat-sim binds 0 and
// testcontainers maps Postgres to a free host port.
export const API_PORT = envPort("E2E_API_PORT", PORT_BASE);
export const WEB_PORT = envPort("E2E_WEB_PORT", PORT_BASE + 1);
// `vite preview` serving apps/web/dist — the bundle a self-host actually
// ships. The Firefox caret project runs against this one (see below).
// Derived from WEB_PORT so an explicit override shifts this with it.
export const PREVIEW_PORT = envPort("E2E_PREVIEW_PORT", WEB_PORT + 1);

/** The phone-device slice, named once: the mobile project claims it and the
 * Chromium project gives it up, so the two partition the suite. */
const MOBILE_SPECS = "mobile-*.spec.ts";

/**
 * The two mobile specs a WebKit engine cannot run at all (MP4, #378).
 *
 * Both are built entirely out of `Input.dispatchTouchEvent` (e2e/long-press.ts)
 * — a finger that goes down, stays down past 450ms and lifts. Playwright's
 * cross-engine touch API only *taps*, and `newCDPSession` throws on anything
 * that is not Chromium, so there is no hold to be had here: every test in both
 * files is a hold. Ported to synthetic `PointerEvent`s they would still run,
 * and would then be asserting about events this file dispatched rather than
 * about WebKit's — which is the opposite of why the project exists. Scoped out
 * whole rather than half-ported, and said so in each file's header too.
 *
 * The two mixed files (mobile-keyboard-scroll, mobile-targets) keep their
 * CDP-free tests here and skip the rest per test, at the call site.
 */
const WEBKIT_UNREACHABLE = [
  "mobile-longpress.spec.ts",
  "mobile-sheets.spec.ts",
];

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // The HTML report is what makes a CI flake readable after the fact (which
  // test, which retry, the attached trace) — the workflow uploads
  // playwright-report/ unconditionally, so it has to actually be written.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Pinned rather than left to default to the runner's core count: CI would
  // otherwise change parallel load whenever GitHub resizes ubuntu-latest, and
  // timing-sensitive flakes reproduce differently at different worker counts.
  // 2 is what the runner gives today, so this is a no-op that stays one
  // (standing to-do, 2026-08-01).
  workers: process.env.CI ? 2 : "50%",
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    // Keep a full trace whenever a test fails (including the retry) so CI
    // failures that don't reproduce locally can still be inspected after the
    // fact — uploaded as an artifact from the workflow.
    trace: "retain-on-failure",
  },
  // The suite is Chromium's, on a desktop viewport, plus four small named
  // slices: one on a phone device profile (MP1 package G), one repeat of that
  // slice on WebKit (MP4), and two on Firefox. The phone slice is a partition
  // — those specs run there instead of in the desktop project, not as well.
  // The other three are second passes, each scoped to somewhere the engines
  // genuinely disagree and one engine can hide a real bug: caret/font metrics
  // (#408, #434 — a caret is painted, not queryable, so it needs a second
  // engine rather than a second assertion), message-log scroll geometry (#411,
  // reported off Firefox three times and never reproduced on Chromium), and
  // the phone tier, whose keyboard, hover and install questions are all
  // ultimately about iOS Safari and were all answered by Blink. Everything
  // else behaves the same everywhere, and a full second pass of the desktop
  // suite would roughly double the E2E leg of CI.
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      // Everything except the phone-device slice below, so no spec runs twice.
      testIgnore: [MOBILE_SPECS],
    },
    {
      // MP1 package G (#375): the phone tier on an actual phone context —
      // Pixel-class viewport, `isMobile`, `hasTouch`, coarse pointer, no
      // hover. The descriptor is taken whole rather than hand-rolled: the
      // properties that matter here (`hover: none` gating the reveal
      // affordances, a real touch pointer for `page.tap`) come as a set, and
      // half a phone is a worse test than none.
      //
      // Scoped by filename, the way the Firefox projects are: `mobile-*` runs
      // here and nowhere else. It is *not* where the two viewport-crossing
      // specs live (pane-stack, phone-overlays). `setViewportSize` does work
      // inside a mobile context — it neither throws nor is ignored — but it
      // leaves `isMobile` and `hasTouch` exactly as the context was built, so
      // the "back on a desktop viewport" half of those specs would be
      // asserting about a 1280px touchscreen with a phone's user agent and
      // device pixel ratio. They assert about the desktop the shell actually
      // has to restore, so they stay in the plain Chromium project and keep
      // resizing; this project holds the specs that are phone from boot to
      // teardown and never touch the viewport at all.
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
      testMatch: [MOBILE_SPECS],
    },
    {
      // MP4 (#378): the same phone specs on WebKit, on an iPhone-class
      // descriptor. This is the closest automatable thing to iOS Safari, which
      // is the engine every unanswered MP2/MP3 question points at — the
      // keyboard inset (`visual-viewport.ts` exists for the engine that shrinks
      // only the visual viewport), `hover: none` gating the touch fallbacks,
      // and the safe-area/notch metadata. Blink answered all of those with its
      // own numbers; nothing had ever asked WebKit.
      //
      // A dependency rather than a fourth concurrent project, and this is not
      // a scheduling preference: the sim gives a character exactly one
      // connection and a second IDN displaces the first (world.ts). These are
      // the *same spec files*, so the same characters — run concurrently, the
      // two projects would spend the run kicking each other offline. Serial is
      // the only way to reuse the files rather than fork a parallel roster of
      // fixtures for one engine.
      name: "mobile-webkit",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
      testMatch: [MOBILE_SPECS],
      testIgnore: WEBKIT_UNREACHABLE,
      dependencies: ["mobile-chromium"],
    },
    {
      name: "firefox",
      // Gecko leaves the caret out of every screenshot, so the caret tests
      // film it instead and read the blink back out of the recording. Video
      // has to be declared here (Playwright forbids test.use({ video })), and
      // the size matches the viewport 1:1 so a DOM bounding box indexes
      // straight into a decoded frame.
      use: {
        browserName: "firefox",
        // …and against `vite preview`, i.e. the bundle a self-host actually
        // serves: the caret bug was reported off a production deployment and
        // measured green on the dev server twice, so at least one of the two
        // caret passes runs on the built output.
        baseURL: `http://127.0.0.1:${String(PREVIEW_PORT)}`,
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
      },
      testMatch: ["typography.spec.ts"],
      // Only the caret tests: the rest of the spec reads computed style, which
      // no second engine can disagree about.
      grep: /caret/,
    },
    {
      // The open-at-the-tail family on Gecko (#411). This bug was reported off
      // a Firefox deployment three times and reproduced on Chromium none of
      // them — the scroll geometry it depends on (when a re-measure shifts
      // scrollTop, when a scroll event is dispatched relative to a
      // ResizeObserver delivery) is exactly where the engines are free to
      // differ. A separate project rather than more testMatch on the caret one
      // above, because that project is scoped by `grep: /caret/` and carries
      // video for the film-the-caret trick; neither applies here.
      name: "firefox-tail",
      use: { browserName: "firefox" },
      testMatch: [
        "open-at-tail.spec.ts",
        "focus-read.spec.ts",
        "stick-intent.spec.ts",
      ],
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      // Generous: on a cold CI runner this window also covers global-setup's
      // first-time postgres image pull.
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env: {
        EMBERCHAT_API_PROXY: `http://127.0.0.1:${String(API_PORT)}`,
      },
    },
    {
      // The built bundle, for the caret pass. `turbo e2e` depends on the web
      // app's own build, so dist/ is always fresh; a bare `playwright test`
      // needs `pnpm --filter @emberchat/web build` first.
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${String(PREVIEW_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(PREVIEW_PORT)}`,
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      env: {
        EMBERCHAT_API_PROXY: `http://127.0.0.1:${String(API_PORT)}`,
      },
    },
  ],
});
