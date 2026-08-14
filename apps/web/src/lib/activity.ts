// Activity reporting (M5 auto-away, reframed by #619).
//
// This browser no longer decides anything about away status. It reports that
// the user did something, and the bouncer — the one layer that sees every
// device attached to an identity — pools the reports and owns the decision
// (apps/server/src/modules/away/auto-away.ts).
//
// That is the whole point of the reframing. F-Chat status is per character
// while activity is per device, so a client deciding alone can only ever be
// wrong on a multi-device account: a phone left on a table would away a
// character its owner is actively typing as from a laptop, and the other
// device would immediately undo it. What used to sit here — an idle timer, a
// map of applied aways, restore-by-value, a send cooldown, cross-tab activity
// sharing through localStorage, and a guard that swallowed the ERR 14s all of
// that provoked — was the cost of answering a question in the wrong place.
//
// Two properties the throttle has to keep:
// - **Leading edge.** The first event after a quiet spell reports at once, so
//   returning from away clears it immediately rather than at the next sweep.
// - **Faster than the shortest threshold.** `autoAwayMinutes` bottoms out at
//   one minute; reporting twice a minute keeps the server's view of an active
//   user at most half a threshold stale, so continuous activity can never be
//   mistaken for idleness.

import { gateway } from "../gateway/socket.js";

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** Minimum gap between reports — pointermove fires continuously. */
const REPORT_INTERVAL_MS = 30_000;

let lastReport = 0;

/** Every activity event lands here — exported for tests. */
export function noteActivity(now = Date.now()): void {
  if (now - lastReport < REPORT_INTERVAL_MS) {
    return;
  }
  lastReport = now;
  gateway.activity();
}

/** Installs the listeners; returns the teardown. */
export function startActivityReporting(): () => void {
  const onActivity = () => {
    noteActivity();
  };
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, onActivity, { passive: true });
  }
  return () => {
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, onActivity);
    }
  };
}

/** Test-only: reset the module state between cases. */
export function resetActivityForTest(): void {
  lastReport = 0;
}
