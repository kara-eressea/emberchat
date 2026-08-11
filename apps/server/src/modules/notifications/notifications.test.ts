// Notification-inbox integration tests (#467) against real Postgres
// (testcontainers) and fchat-sim. Everything goes through the production
// path — register → add F-List account → start the session — so the sink and
// the RTB handler attach exactly as they do in production.

import { asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { serializeServerCommand } from "@emberchat/fchat-protocol";
import { UNREAD_DISPLAY_CAP, type NotificationDto } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import {
  conversations,
  identities,
  messages,
  notifications,
  userPreferences,
} from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";
import { type FchatSession, FlistApiClient } from "@emberchat/session-engine";
import { RetentionJob } from "../history/retention.js";
import { excerptOf, NotificationStore } from "./store.js";

const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

vi.setConfig({ testTimeout: INTEGRATION_MS });

let testDb: TestDb;
let db: Db;
let sim: FchatSim;
let app: FastifyInstance;

beforeAll(async () => {
  sim = new FchatSim();
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
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await testDb.stop();
  await sim.stop();
});

let userCounter = 0;

interface Fixture {
  identityId: string;
  userId: string;
  session: FchatSession;
  token: string;
}

/** Fresh user + account + identity + a live session, like history.test.ts. */
let lastIdentityId: string | undefined;
async function startIdentity(): Promise<Fixture> {
  if (lastIdentityId !== undefined) {
    app.sessions.stop(lastIdentityId);
  }
  userCounter += 1;
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `notif-${String(userCounter)}@example.test`,
      username: `notif${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(registered.statusCode).toBe(201);
  const { accessToken: token, user } = registered.json<{
    accessToken: string;
    user: { id: string };
  }>();
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  const accountId = added.json<{ account: { id: string } }>().account.id;
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
  await waitForStatus(session, "online");
  lastIdentityId = identity!.id;
  return { identityId: identity!.id, userId: user.id, session, token };
}

/**
 * The three waits below take their deadline from `FRAME_WAIT_MS`, not from a
 * literal, because `budgets.ts` requires a wait helper's default deadline to
 * be ≥ its file's `testTimeout` tier — this file had 10s and 5s helpers under
 * a 15s tier, which is the #404/#425 shape. Note this is hygiene, not a fix
 * for #546: the flake there is an `IDN` refused mid-handshake, and the
 * session's policy backoff is a jittered 10–20s, so no deadline this file
 * could honestly carry would have caught it.
 */
function waitForStatus(
  session: FchatSession,
  status: string,
  timeoutMs = FRAME_WAIT_MS,
): Promise<void> {
  if (session.status === status) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`timed out waiting for ${status} (now ${session.status})`),
      );
    }, timeoutMs);
    session.events.on("status", (event) => {
      if (event.status === status) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function joinAndSettle(session: FchatSession, channel: string): Promise<void> {
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out joining ${channel}`));
    }, FRAME_WAIT_MS);
    const off = session.events.on("command", (command) => {
      if (command.cmd === "CDS" && command.payload.channel === channel) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  session.joinChannel(channel);
  return settled;
}

/** Injects a server frame and resolves once the session processed it. */
function inject(
  session: FchatSession,
  frame: Parameters<typeof serializeServerCommand>[0],
): Promise<void> {
  const seen = new Promise<void>((resolve) => {
    const off = session.events.on("command", (command) => {
      if (command.cmd === frame.cmd) {
        off();
        resolve();
      }
    });
  });
  sim.sendRawTo(CHARACTER, serializeServerCommand(frame));
  return seen;
}

/** The sink writes its inbox row inside the same serial task as the message,
 * so a flushed sink means the row has landed too. */
async function settle(): Promise<void> {
  await app.history.flush();
}

function rowsFor(identityId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.identityId, identityId))
    .orderBy(asc(notifications.id));
}

/** The RTB path is fire-and-forget from the session's command handler, so
 * its rows land a tick or two after the frame was processed. */
async function waitForRows(identityId: string, count: number): Promise<void> {
  const pollMs = 50;
  for (let attempt = 0; attempt < FRAME_WAIT_MS / pollMs; attempt += 1) {
    if ((await rowsFor(identityId)).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`timed out waiting for ${String(count)} inbox rows`);
}

describe("notification inbox — writers", () => {
  it("logs a mention exactly when the sink stamps one, and nothing else", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `[b]hey[/b] ${CHARACTER}, over here`,
        channel: "Frontpage",
      },
    });
    // Not about us: no highlight rule matches, so no inbox row.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Tally Marsh",
        message: "nothing to see here",
        channel: "Frontpage",
      },
    });
    // A DM is already directed at the user and carries no mention verdict.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: `psst ${CHARACTER}` },
    });
    await settle();

    const rows = await rowsFor(identityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mention",
      character: "Nyx Firemane",
      muted: false,
      // BBCode stripped for the row preview.
      excerpt: `hey ${CHARACTER}, over here`,
    });

    // It points at the message the sink stamped, in that conversation.
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.channelKey, "Frontpage"))
      .limit(1);
    const [stamped] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.mention, true))
      .orderBy(desc(messages.id))
      .limit(1);
    expect(rows[0]?.conversationId).toBe(conversation!.id);
    expect(rows[0]?.messageId).toBe(stamped!.id);
  });

  it("logs the three website RTB kinds and ignores the rest", async () => {
    const { identityId, session } = await startIdentity();

    await inject(session, {
      cmd: "RTB",
      payload: { type: "friendrequest", name: "Nyx Firemane" },
    });
    await inject(session, {
      cmd: "RTB",
      payload: {
        type: "note",
        character: "Tally Marsh",
        subject: "About last night",
      },
    });
    await inject(session, {
      cmd: "RTB",
      payload: { type: "comment", character: "Old Greywhisker" },
    });
    // A silent list sync: notice-less today, inbox-less too.
    await inject(session, {
      cmd: "RTB",
      payload: { type: "bookmarkadd", name: "Nyx Firemane" },
    });
    await waitForRows(identityId, 3);

    const rows = await rowsFor(identityId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.kind)).toEqual([
      "friendrequest",
      "note",
      "comment",
    ]);
    expect(rows[0]).toMatchObject({
      character: "Nyx Firemane",
      excerpt: "",
      conversationId: null,
      messageId: null,
    });
    expect(rows[1]).toMatchObject({
      character: "Tally Marsh",
      excerpt: "About last night",
    });
  });

  it("logs a muted conversation's mention but keeps it out of the badge", async () => {
    const { identityId, userId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");
    // One message first, purely to create the conversation row we mute.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Tally Marsh",
        message: "opening the room",
        channel: "Frontpage",
      },
    });
    await settle();
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.identityId, identityId))
      .limit(1);
    await db
      .insert(userPreferences)
      .values({ userId, prefs: { mutedConvIds: [conversation!.id] } })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { prefs: { mutedConvIds: [conversation!.id] } },
      });
    app.notifications.invalidatePrefs(userId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `quietly, ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await settle();

    const rows = await rowsFor(identityId);
    // The log keeps it — the inbox is a log, mutes only silence alerts.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.muted).toBe(true);
    expect(await app.notifications.unseenCount(identityId)).toBe(0);
  });
});

describe("notification inbox — REST", () => {
  it("pages by keyset newest-first and round-trips the seen watermark", async () => {
    const { identityId, token } = await startIdentity();
    const broadcasts = vi.spyOn(app.gatewayHub, "broadcast");
    const store = app.notifications;
    for (let i = 1; i <= 5; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        `Sender ${String(i)}`,
        `n${String(i)}`,
      );
    }
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=2`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      notifications: NotificationDto[];
      hasMore: boolean;
      lastSeenId: number;
      unseen: number;
    }>();
    expect(page1.notifications.map((n) => n.excerpt)).toEqual(["n5", "n4"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.lastSeenId).toBe(0);
    expect(page1.unseen).toBe(5);

    const second = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=2&before=${String(page1.notifications[1]!.id)}`,
      headers,
    });
    const page2 = second.json<{
      notifications: NotificationDto[];
      hasMore: boolean;
    }>();
    expect(page2.notifications.map((n) => n.excerpt)).toEqual(["n3", "n2"]);
    expect(page2.hasMore).toBe(true);

    // Marking the newest seen clears the badge...
    const newest = page1.notifications[0]!.id;
    const marked = await app.inject({
      method: "PUT",
      url: `/api/identities/${identityId}/notifications/seen`,
      headers,
      payload: { lastSeenId: newest },
    });
    expect(marked.json<{ lastSeenId: number; unseen: number }>()).toEqual({
      lastSeenId: newest,
      unseen: 0,
    });
    // ...and a lagging tab's stale mark never uncovers what was shown.
    const stale = await app.inject({
      method: "PUT",
      url: `/api/identities/${identityId}/notifications/seen`,
      headers,
      payload: { lastSeenId: 1 },
    });
    expect(stale.json<{ lastSeenId: number }>().lastSeenId).toBe(newest);

    // Multi-device: the moved watermark is fanned out, so another attached
    // browser's bell drops with this one instead of badging what was read.
    expect(broadcasts.mock.calls).toContainEqual([
      identityId,
      { kind: "notification.seen", d: { lastSeenId: newest, unseen: 0 } },
    ]);
    broadcasts.mockRestore();

    // A newer entry badges again, past the watermark.
    await store.recordRtb(identityId, "friendrequest", "Nyx Firemane");
    const after = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=50`,
      headers,
    });
    expect(after.json<{ unseen: number }>().unseen).toBe(1);
  });

  // #582: the bell badge had the same off-by-one the channel badge did — the
  // count stopped AT the display cap, so `unseen > CAP` was unreachable and
  // the badge sat at a flat 99 however deep the inbox got.
  it("saturates the unseen count one past the display cap", async () => {
    const { identityId } = await startIdentity();
    const store = app.notifications;
    for (let i = 1; i <= UNREAD_DISPLAY_CAP + 20; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        "Nyx Firemane",
        `d${String(i)}`,
      );
    }
    const unseen = await store.unseenCount(identityId);
    expect(unseen).toBe(UNREAD_DISPLAY_CAP + 1);
    // The property the badge actually depends on.
    expect(unseen).toBeGreaterThan(UNREAD_DISPLAY_CAP);
  });

  it("deletes one entry, recounts the badge and fans the correction out (#506)", async () => {
    const { identityId, token } = await startIdentity();
    const headers = { authorization: `Bearer ${token}` };
    const store = app.notifications;
    for (let i = 1; i <= 3; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        "Nyx Firemane",
        `d${String(i)}`,
      );
    }
    const rows = await rowsFor(identityId);
    expect(await store.unseenCount(identityId)).toBe(3);

    const broadcasts = vi.spyOn(app.gatewayHub, "broadcast");
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}/notifications/${String(rows[1]!.id)}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    // The count comes back RECOUNTED, not decremented client-side: the row
    // was unseen, so the badge is one lower and the server is what says so.
    expect(removed.json<{ removed: boolean; unseen: number }>()).toEqual({
      removed: true,
      unseen: 2,
    });
    expect((await rowsFor(identityId)).map((row) => row.excerpt)).toEqual([
      "d1",
      "d3",
    ]);
    // …and every other attached device drops the row and takes the same
    // number, rather than each tab arriving at its own answer.
    expect(broadcasts.mock.calls).toContainEqual([
      identityId,
      {
        kind: "notification.removed",
        d: { id: rows[1]!.id, unseen: 2 },
      },
    ]);

    // Idempotent: the second tab's delete of a row that is already gone is a
    // no-op with the current count, not an error the user has to read — and
    // it fans nothing out, because nothing changed.
    broadcasts.mockClear();
    const again = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}/notifications/${String(rows[1]!.id)}`,
      headers,
    });
    expect(again.json<{ removed: boolean; unseen: number }>()).toEqual({
      removed: false,
      unseen: 2,
    });
    expect(
      broadcasts.mock.calls.filter(
        ([, frame]) => frame.kind === "notification.removed",
      ),
    ).toEqual([]);

    // A row the user has already seen is not in the count, so deleting it
    // must not move the badge — the thing a decrement would have got wrong.
    await store.markSeen(identityId, rows[0]!.id);
    expect(await store.unseenCount(identityId)).toBe(1);
    const seenRow = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}/notifications/${String(rows[0]!.id)}`,
      headers,
    });
    expect(seenRow.json<{ unseen: number }>().unseen).toBe(1);
    broadcasts.mockRestore();
  });

  it("refuses to delete an entry on an identity the caller does not own", async () => {
    const mine = await startIdentity();
    const other = await startIdentity();
    await app.notifications.recordRtb(mine.identityId, "note", "Nyx Firemane");
    const [row] = await rowsFor(mine.identityId);

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/identities/${mine.identityId}/notifications/${String(row!.id)}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(refused.statusCode).toBe(404);
    expect(await rowsFor(mine.identityId)).toHaveLength(1);

    // The store's own guard, straight: an id from another inbox matches
    // nothing even when the identity is the caller's own.
    expect(await app.notifications.remove(other.identityId, row!.id)).toBe(
      false,
    );
    expect(await rowsFor(mine.identityId)).toHaveLength(1);
  });

  it("refuses an identity the caller does not own", async () => {
    const mine = await startIdentity();
    const other = await startIdentity();
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${mine.identityId}/notifications`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("notification inbox — lifecycle", () => {
  it("prunes down to the newest N per identity", async () => {
    const { identityId } = await startIdentity();
    const store = new NotificationStore(db, undefined, { maxPerIdentity: 3 });
    for (let i = 1; i <= 6; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        "Nyx Firemane",
        `p${String(i)}`,
      );
    }
    // The counter-driven pass has not fired yet at this volume — the cap is a
    // ceiling on growth, so ask for the pass explicitly.
    expect(await store.prune(identityId)).toBe(3);
    const rows = await rowsFor(identityId);
    expect(rows.map((row) => row.excerpt)).toEqual(["p4", "p5", "p6"]);
  });

  it("loses a mention entry when retention deletes its message", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `about you, ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await settle();
    const [row] = await rowsFor(identityId);
    expect(row?.messageId).not.toBeNull();

    // Age this identity's messages past the policy, then sweep: the cascade
    // must take the inbox row with it rather than leave a jump target
    // pointing at nothing.
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.identityId, identityId))
      .limit(1);
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(messages.conversationId, conversation!.id));
    const retention = new RetentionJob({
      db,
      policy: "90d",
      sweepIntervalMs: 60_000,
    });
    expect((await retention.sweepOnce()).deleted).toBeGreaterThan(0);
    expect(await rowsFor(identityId)).toHaveLength(0);
  });
});

describe("mute cache", () => {
  /**
   * Wraps `db.select(...)` so a chain runs as usual but parks its *result*
   * until `hold` resolves — the only way to sit inside the await gap the
   * generation guard is about, holding a row that is already stale.
   * Everything else on the database passes straight through.
   */
  function withHeldSelects(
    base: Db,
    hold: () => Promise<void> | undefined,
  ): Db {
    const call = (fn: unknown, self: object, args: unknown[]) =>
      (fn as (this: object, ...rest: unknown[]) => unknown).apply(self, args);
    const wrapChain = (chain: object): object =>
      new Proxy(chain, {
        get(target, prop) {
          if (prop === "then") {
            return (
              onFulfilled?: (value: unknown) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) =>
              Promise.resolve(target as PromiseLike<unknown>)
                .then(async (value) => {
                  await hold();
                  return value;
                })
                .then(onFulfilled, onRejected);
          }
          const value: unknown = Reflect.get(target, prop);
          if (typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            const result = call(value, target, args);
            return typeof result === "object" && result !== null
              ? wrapChain(result)
              : result;
          };
        },
      });
    return new Proxy(base, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== "function") {
          return value;
        }
        if (prop !== "select") {
          return (...args: unknown[]) => call(value, target, args);
        }
        return (...args: unknown[]) =>
          wrapChain(call(value, target, args) as object);
      },
    });
  }

  it("never refills from a read a prefs patch overtook", async () => {
    const { identityId, userId } = await startIdentity();
    let holding = false;
    let reached!: () => void;
    let release!: () => void;
    // `read` settles once a held query has actually run — so the row parked
    // behind `held` is provably the pre-patch one, with no timing guesswork.
    const read = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new NotificationStore(
      withHeldSelects(db, () => {
        if (!holding) {
          return undefined;
        }
        reached();
        return held;
      }),
      undefined,
    );

    // Warms the identity→user map and caches "nothing is muted".
    const first = await store.recordRtb(
      identityId,
      "note",
      "Nyx Firemane",
      "a",
    );
    expect(first?.muted).toBe(false);

    // Drop the cache so the next mention has to read, and park that read
    // at exactly the point the guard covers.
    store.invalidatePrefs(userId);
    holding = true;
    const overtaken = store.recordRtb(identityId, "note", "Nyx Firemane", "b");
    await read;

    // Meanwhile the user mutes this identity from another tab.
    await db
      .insert(userPreferences)
      .values({ userId, prefs: { mutedIdentityIds: [identityId] } })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { prefs: { mutedIdentityIds: [identityId] } },
      });
    store.invalidatePrefs(userId);

    release();
    await overtaken;
    holding = false;

    // The in-flight read saw the pre-patch row; it must not have parked it
    // in the cache. `muted` is immutable once written and drives Web Push,
    // so a stale entry keeps pushing to a muted identity indefinitely.
    const after = await store.recordRtb(
      identityId,
      "note",
      "Nyx Firemane",
      "c",
    );
    expect(after?.muted).toBe(true);
  });
});

describe("excerptOf", () => {
  it("strips BBCode, collapses whitespace and truncates", () => {
    expect(excerptOf("[b]bold[/b]  and\n[i]more[/i]")).toBe("bold and more");
    expect(excerptOf("x".repeat(300))).toHaveLength(160);
    expect(excerptOf("x".repeat(300)).endsWith("…")).toBe(true);
  });
});
