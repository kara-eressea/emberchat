// Auto-away integration (M5 + #619): real Postgres (testcontainers) +
// fchat-sim through the production path, with the sweep clock injected via
// buildApp's test knob. Covers both questions the module answers — idle while
// attached (pooled across devices) and fully detached. The GatewayHub hook
// mechanics and the sweep's failure containment get their own container-free
// unit blocks at the bottom.

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import type { UserPrefsPatch } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import { flistAccounts, identities, userPreferences } from "../../db/schema.js";
import {
  type FchatSession,
  FlistApiClient,
  type SessionLogger,
  type SessionRegistry,
} from "@emberchat/session-engine";
import { AutoAway } from "./auto-away.js";
import { GatewayHub } from "../gateway/gateway.js";
import type { GatewayConnection } from "../gateway/connection.js";
import type { HistorySink } from "../history/sink.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";

const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
const MINUTE_MS = 60_000;

vi.setConfig({ testTimeout: INTEGRATION_MS });

let testDb: TestDb;
let db: Db;
let sim: FchatSim;
let app: FastifyInstance;
/** The injected sweep clock — tests advance it instead of waiting. */
let fakeNow = 1_000_000;

beforeAll(async () => {
  // The sim enforces F-Chat's status gate (ERR 14); both it and the session's
  // pacing window are scaled down so the away→hand-back pairs this suite
  // exercises don't each cost five seconds.
  sim = new FchatSim({ staFloodSeconds: 0.5 });
  await sim.start();
  testDb = await makeTestDb();
  db = testDb.db;
  app = await buildApp({
    config: loadConfig({
      ...testDb.env,
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      AUTH_RATE_LIMIT_MAX: "1000",
      REGISTRATION_ENABLED: "true",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
    autoAwayNow: () => fakeNow,
    sessionTuning: { statusGateMs: 800 },
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await testDb.stop();
  await sim.stop();
});

let userCounter = 0;
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `away-${String(userCounter)}@example.test`,
      username: `away${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

/** Production path to a live session (cf. history.test.ts). */
let lastIdentityId: string | undefined;
async function startIdentity(): Promise<{
  identityId: string;
  userId: string;
  accountId: string;
  session: FchatSession;
}> {
  if (lastIdentityId !== undefined) {
    app.sessions.stop(lastIdentityId);
  }
  const token = await registerUser();
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  const accountId = added.json<{ account: { id: string } }>().account.id;
  const [account] = await db
    .select({ userId: flistAccounts.userId })
    .from(flistAccounts)
    .where(eq(flistAccounts.id, accountId));
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: accountId, characterName: CHARACTER })
    .returning({ id: identities.id });
  const session = app.sessions.start({
    identityId: identity!.id,
    character: CHARACTER,
    accountId,
    accountName: ACCOUNT,
  });
  await waitForOnline(session);
  lastIdentityId = identity!.id;
  return {
    identityId: identity!.id,
    userId: account!.userId,
    accountId,
    session,
  };
}

function waitForOnline(session: FchatSession): Promise<void> {
  if (session.status === "online") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for online (${session.status})`));
    }, 10_000);
    const off = session.events.on("status", ({ status }) => {
      if (status === "online") {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

/** setStatus round-trips the rate gate — poll until the status settles. */
async function expectOwnStatus(
  session: FchatSession,
  status: string,
  statusmsg: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const own = session.ownStatus;
    if (own.status === status && own.statusmsg === statusmsg) {
      return;
    }
    if (Date.now() > deadline) {
      expect(own).toEqual({ status, statusmsg });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setPrefs(userId: string, prefs: UserPrefsPatch): Promise<unknown> {
  return db
    .insert(userPreferences)
    .values({ userId, prefs })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { prefs },
    });
}

/**
 * A stand-in for an attached browser. The hub reads exactly one thing off a
 * connection for this purpose — when it last reported user activity — so a
 * mutable box is the whole device: assigning to it *is* the browser reporting.
 */
interface FakeBrowser {
  lastActivityAt: number | undefined;
}

/** Attaches a fake browser to the identity and returns it plus its detach. */
function attach(
  identityId: string,
  lastActivityAt: number | undefined,
): { browser: FakeBrowser; detach: () => void } {
  const browser: FakeBrowser = { lastActivityAt };
  const connection = browser as unknown as GatewayConnection;
  app.gatewayHub.subscribe(identityId, connection);
  return {
    browser,
    detach: () => {
      app.gatewayHub.unsubscribe(identityId, connection);
    },
  };
}

/** What the gateway does when an `activity` frame arrives. */
function report(identityId: string, browser: FakeBrowser): void {
  browser.lastActivityAt = fakeNow;
  app.gatewayHub.notifyActivity(identityId);
}

describe("idle auto-away (pooled across devices)", () => {
  it("goes away once every attached device has gone quiet", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      autoAwayEnabled: true,
      autoAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    const laptop = attach(identityId, fakeNow);
    const phone = attach(identityId, fakeNow);

    fakeNow += 30_000;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "online", ""); // under the threshold

    fakeNow += MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    laptop.detach();
    phone.detach();
  });

  it("one active device keeps the whole identity online", async () => {
    // The #619 headline. A phone left face-down on a table is not evidence
    // that its owner has stopped typing on the laptop — and before the
    // bouncer pooled the reports, the phone's own idle timer would have
    // awayed the character out from under them.
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      autoAwayEnabled: true,
      autoAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    const phone = attach(identityId, fakeNow); // set down, never touched again
    const laptop = attach(identityId, fakeNow);

    for (let minute = 0; minute < 5; minute += 1) {
      fakeNow += MINUTE_MS;
      report(identityId, laptop.browser); // still typing over here
      await app.autoAway.sweep();
    }
    await expectOwnStatus(session, "online", "");

    // The laptop goes quiet too — now nobody is there.
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // …and a single report from either device brings it straight back,
    // without waiting for the next sweep.
    fakeNow += 1_000;
    report(identityId, phone.browser);
    await expectOwnStatus(session, "online", "");

    phone.detach();
    laptop.detach();
  });

  it("declines to judge while a device that cannot report is attached", async () => {
    // A client older than the `activity` frame reports nothing at all. Silence
    // from it is not evidence of an absent user, so the safe reading is to
    // leave the status alone entirely.
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      autoAwayEnabled: true,
      autoAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    const quiet = attach(identityId, fakeNow);
    const oldClient = attach(identityId, undefined);

    fakeNow += 10 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "online", "");

    // It disconnects; the remaining device's silence can now be trusted.
    oldClient.detach();
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    quiet.detach();
  });

  it("leaves the away in place when clear-on-return is off", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      autoAwayEnabled: true,
      autoAwayMinutes: 1,
      autoAwayClearOnReturn: false,
      autoAwayMessage: "afk",
    });
    const laptop = attach(identityId, fakeNow);

    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // Returning forgets the record rather than restoring — the away is the
    // user's to clear now, which is what the preference means.
    fakeNow += 1_000;
    report(identityId, laptop.browser);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expectOwnStatus(session, "away", "afk");

    laptop.detach();
  });

  it("stays inert while the pref is off (the default)", async () => {
    const { identityId, session } = await startIdentity();
    const laptop = attach(identityId, fakeNow);

    fakeNow += 24 * 60 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "online", "");

    laptop.detach();
  });
});

describe("detached auto-away", () => {
  it("applies away past the threshold and hands back on attach", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "Watering the moss",
    });

    // First subscriber-less sweep stamps the clock; the threshold counts
    // from there, not from some unobserved earlier moment.
    await app.autoAway.sweep();
    fakeNow += 30_000;
    await app.autoAway.sweep();
    expect(session.ownStatus.status).toBe("online");

    fakeNow += MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "Watering the moss");

    // Attach: the bouncer's away hands back to what it replaced.
    app.autoAway.onAttach(identityId);
    await expectOwnStatus(session, "online", "");
  });

  it("never clobbers a manually chosen status", async () => {
    const { userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
    });
    await session.setStatus("busy", "renovating the terrarium");

    await app.autoAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "busy", "renovating the terrarium");
  });

  it("stays inert while the pref is off (the default)", async () => {
    const { session } = await startIdentity();

    await app.autoAway.sweep();
    fakeNow += 24 * 60 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "online", "");
  });

  it("hands back inside the status gate without earning an ERR", async () => {
    // The bouncer's own STA rides the same pacing as a browser's: an away and
    // the hand-back that follows it a moment later are one status change apart
    // in F-Chat's eyes (ERR 14), so the restore waits out the window instead
    // of being refused — and the refusal would have fanned out to every
    // attached browser.
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "Watering the moss",
    });
    const errors: number[] = [];
    const restored: string[] = [];
    session.events.on("command", (command) => {
      if (command.cmd === "ERR") {
        errors.push(command.payload.number);
      }
      // Own-status echoes only fire when the frame reaches the wire (the sim
      // then broadcasts the same STA back, so a send shows up twice).
      if (
        command.cmd === "STA" &&
        command.payload.character === CHARACTER &&
        command.payload.status === "online"
      ) {
        restored.push(command.payload.statusmsg);
      }
    });

    await app.autoAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "Watering the moss");

    // Straight back — well inside the gate.
    app.autoAway.onAttach(identityId);
    await expectOwnStatus(session, "online", ""); // accepted at once
    expect(restored).toEqual([]); // …but not yet on the wire
    // Poll rather than sleeping out a wall-clock constant: the gate's release
    // is a positive event, so a loaded runner should make this slower, not
    // flaky (#546).
    await vi.waitFor(() => {
      expect(restored.length).toBeGreaterThan(0);
    }, FRAME_WAIT_MS);
    expect(new Set(restored)).toEqual(new Set([""]));
    expect(errors).toEqual([]);
  });

  it("does not restore a status the user changed meanwhile", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    await app.autoAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // A manual STA between our away and the attach: theirs wins.
    await session.setStatus("looking", "back, and looking");
    app.autoAway.onAttach(identityId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expectOwnStatus(session, "looking", "back, and looking");
  });
});

describe("detached auto-away lifecycle", () => {
  it("a session restart clears the applied record so the feature re-arms", async () => {
    const { identityId, userId, accountId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    await app.autoAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // Explicit disconnect → later reconnect: the fresh session starts
    // plain "online" and there is nothing to restore — a stale applied
    // record must not block going away again.
    app.sessions.stop(identityId);
    await app.autoAway.sweep(); // prunes the dead session's state
    const restarted = app.sessions.start({
      identityId,
      character: CHARACTER,
      accountId,
      accountName: ACCOUNT,
    });
    await waitForOnline(restarted);
    await app.autoAway.sweep(); // stamps a fresh detachment clock
    fakeNow += 2 * MINUTE_MS;
    await app.autoAway.sweep();
    await expectOwnStatus(restarted, "away", "afk");
  });

  it("stops a session past the detached-disconnect ceiling (default 72h)", async () => {
    const { identityId, session } = await startIdentity();
    const events: { status: string; reason?: string }[] = [];
    session.events.on("status", (event) => events.push(event));

    // The ceiling needs no prefs — it is the operator's knob, applied even
    // with detached-away off (the default from registerUser).
    await app.autoAway.sweep(); // stamps the detachment clock
    fakeNow += 71 * 60 * MINUTE_MS;
    await app.autoAway.sweep();
    expect(session.status).toBe("online"); // under the ceiling — untouched

    fakeNow += 2 * 60 * MINUTE_MS; // 73h total
    await app.autoAway.sweep();
    expect(session.status).toBe("stopped");
    expect(app.sessions.get(identityId)).toBeUndefined();
    expect(events.at(-1)).toEqual({
      status: "stopped",
      reason: "disconnected after 72h with no attached device",
    });
  });
});

describe("GatewayHub attach hook", () => {
  const fakeHistory = {
    events: { on: () => () => {} },
  } as unknown as HistorySink;

  it("fires on the zero→one transition only; hasSubscribers tracks the set", () => {
    const hub = new GatewayHub({ history: fakeHistory });
    const fired: string[] = [];
    hub.onFirstSubscribe = (identityId) => fired.push(identityId);
    const a = {} as GatewayConnection;
    const b = {} as GatewayConnection;

    expect(hub.hasSubscribers("i")).toBe(false);
    hub.subscribe("i", a);
    hub.subscribe("i", b); // second attach — no re-fire
    expect(fired).toEqual(["i"]);
    expect(hub.hasSubscribers("i")).toBe(true);

    hub.unsubscribe("i", a);
    hub.unsubscribe("i", b);
    expect(hub.hasSubscribers("i")).toBe(false);
    hub.subscribe("i", a); // zero→one again
    expect(fired).toEqual(["i", "i"]);
  });

  it("pools activity across subscribers, and reports 'unknown' for a silent one", () => {
    const hub = new GatewayHub({ history: fakeHistory });
    const laptop = { lastActivityAt: 100 } as unknown as GatewayConnection;
    const phone = { lastActivityAt: 400 } as unknown as GatewayConnection;
    const oldClient = {
      lastActivityAt: undefined,
    } as unknown as GatewayConnection;

    expect(hub.activityAcross("i")).toBeUndefined(); // nothing attached
    hub.subscribe("i", laptop);
    expect(hub.activityAcross("i")).toBe(100);
    hub.subscribe("i", phone);
    expect(hub.activityAcross("i")).toBe(400); // the newest wins

    // One device that has never reported poisons the answer: silence from a
    // client that cannot speak is not evidence of an absent user.
    hub.subscribe("i", oldClient);
    expect(hub.activityAcross("i")).toBe("unknown");
    hub.unsubscribe("i", oldClient);
    expect(hub.activityAcross("i")).toBe(400);
  });
});

describe("sweep failure containment", () => {
  /** A database whose reads reject and whose writes resolve — a pool blip. */
  function failingDb(error: Error): Db {
    const rejecting = {
      from: () => rejecting,
      innerJoin: () => rejecting,
      leftJoin: () => rejecting,
      where: () => Promise.reject(error),
    };
    return {
      select: () => rejecting,
      update: () => ({
        set: () => ({ where: () => Promise.resolve() }),
      }),
    } as unknown as Db;
  }

  it("logs a rejecting prefs query instead of rejecting into the interval", async () => {
    const logged: string[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (_fields: unknown, message: string) => logged.push(message),
    };
    const session = {
      status: "online",
      ownStatus: { status: "online", statusmsg: "" },
    };
    const away = new AutoAway({
      db: failingDb(new Error("connect ECONNREFUSED")),
      sessions: {
        entries: () => [["identity-1", session]],
      } as unknown as SessionRegistry,
      hub: { hasSubscribers: () => false } as unknown as GatewayHub,
      logger: logger as unknown as SessionLogger,
    });

    // First pass only stamps the detachment; the second reaches the query.
    await expect(away.sweep()).resolves.toBeUndefined();
    await expect(away.sweep()).resolves.toBeUndefined();
    expect(logged).toContain("auto-away sweep failed");

    // And the overlap guard is released, so the next tick still runs.
    await expect(away.sweep()).resolves.toBeUndefined();
    expect(logged).toHaveLength(2);
  });
});
