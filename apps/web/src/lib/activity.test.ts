// Activity reporting (#619). The browser decides nothing about away status —
// its whole job is a throttle with the right shape, and both edges of that
// shape are load-bearing, so both are asserted here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityMock = vi.hoisted(() => vi.fn());
vi.mock("../gateway/socket.js", () => ({
  gateway: { activity: activityMock },
}));
import {
  noteActivity,
  resetActivityForTest,
  startActivityReporting,
} from "./activity.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** Where the module's own constant sits; the assertions bracket it. */
const REPORT_INTERVAL = 30 * SECOND;

beforeEach(() => {
  resetActivityForTest();
  activityMock.mockClear();
});

describe("activity reporting", () => {
  it("reports the leading edge — a return from idle is not made to wait", () => {
    // The user has been away for ten minutes and touches the trackpad. That
    // first event has to reach the bouncer immediately: it is what clears the
    // away, and the whole feature is judged on how fast that happens.
    const t = 10 * MINUTE;
    noteActivity(t);
    expect(activityMock).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst — pointermove fires continuously", () => {
    let t = MINUTE;
    noteActivity(t);
    for (let i = 0; i < 500; i += 1) {
      t += 20; // ~50 events a second, which is what a trackpad produces
      noteActivity(t);
    }
    expect(activityMock).toHaveBeenCalledTimes(1);
  });

  it("keeps reporting faster than the shortest away threshold", () => {
    // autoAwayMinutes bottoms out at 1. If the reports were spaced at or
    // beyond that, a continuously active user would look idle to the sweep
    // and get awayed mid-sentence.
    expect(REPORT_INTERVAL).toBeLessThan(MINUTE);

    let t = MINUTE;
    noteActivity(t);
    expect(activityMock).toHaveBeenCalledTimes(1);

    // Just under the interval: still folded into the first report.
    noteActivity(t + REPORT_INTERVAL - SECOND);
    expect(activityMock).toHaveBeenCalledTimes(1);

    // Just past it: the server's view refreshes.
    t += REPORT_INTERVAL;
    noteActivity(t);
    expect(activityMock).toHaveBeenCalledTimes(2);
  });

  it("is purely event-driven — it arms no timer of its own", () => {
    // Nothing here may fire without the user. A report on a timer would mean
    // an abandoned tab reported forever and its identity could never go idle,
    // which is the exact failure the server-side framing exists to avoid.
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal("window", {
      addEventListener: (name: string) => added.push(name),
      removeEventListener: (name: string) => removed.push(name),
    });
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");

    const stop = startActivityReporting();
    expect(added).toContain("pointermove");
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();

    stop();
    expect(removed).toEqual(added); // every listener handed back

    interval.mockRestore();
    timeout.mockRestore();
    vi.unstubAllGlobals();
  });
});
