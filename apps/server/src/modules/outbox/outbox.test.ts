// The delayed-send outbox worker (milestone-4.md), against real Postgres with
// stubbed sessions — the release paths that the gateway suite only reaches
// incidentally: the per-identity concurrency guard (M6 audit), the failed-row
// TTL sweep (M7 audit), the restart recovery, and the ordinary channel
// release. Nothing here touches F-Chat: the sessions are fakes, because what
// is under test is which method the worker calls with which arguments.

import { and, asc, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OutboxItemDto } from "@emberchat/protocol";
import type { FchatSession, SessionRegistry } from "@emberchat/session-engine";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import {
  appUsers,
  conversations,
  flistAccounts,
  identities,
  outboxMessages,
} from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_SLOW_MS,
} from "../../test-support/budgets.js";
import { Outbox } from "./outbox.js";

// Every wait below is FRAME_WAIT_MS; the per-test budget must sit ABOVE it or
// the outer timeout fires first and the helper's diagnostic never prints
// (the #404/#425 lesson, spelled out in the budgets module).
vi.setConfig({ testTimeout: INTEGRATION_SLOW_MS });

/** Fast enough that "the next poll" is never the slow part of a test. */
const POLL_MS = 20;

/**
 * Older than any plausible failed-row TTL. Deliberately a fixed date rather
 * than `now - FAILED_ROW_TTL_MS`: the sweep's window is the module's business,
 * and a test that imports the constant to rebuild the same arithmetic only
 * restates it. "Ancient" and "just now" are the two cases the sweep has to
 * separate, whatever the window happens to be.
 */
const LONG_AGO = new Date("2001-01-01T00:00:00Z");

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await makeTestDb();
  db = testDb.db;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await testDb.stop();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let counter = 0;

async function seedIdentity(): Promise<string> {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      email: `outbox-${String(counter)}@example.test`,
      username: `outbox${String(counter)}`,
      passwordHash: "x",
    })
    .returning({ id: appUsers.id });
  const [account] = await db
    .insert(flistAccounts)
    .values({ userId: user!.id, accountName: `acct-${String(counter)}` })
    .returning({ id: flistAccounts.id });
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: account!.id, characterName: "Vesna Marlowe" })
    .returning({ id: identities.id });
  return identity!.id;
}

async function seedChannelConversation(
  identityId: string,
  channelKey: string,
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ identityId, kind: "channel", channelKey, title: channelKey })
    .returning({ id: conversations.id });
  return row!.id;
}

async function seedPmConversation(
  identityId: string,
  partner: string,
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      identityId,
      kind: "pm",
      partnerCharacter: partner,
      title: partner,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

interface SentCall {
  method: "sendChannelMessage" | "sendChannelAd" | "sendPrivateMessage";
  target: string;
  bbcode: string;
  options?: unknown;
}

interface FakeSession {
  session: FchatSession;
  sent: SentCall[];
  /** Makes the next send park until `release()` is called. */
  hold: () => void;
  release: () => void;
}

function fakeSession(): FakeSession {
  const sent: SentCall[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const record =
    (method: SentCall["method"]) =>
    (target: string, bbcode: string, options?: unknown) => {
      sent.push({
        method,
        target,
        bbcode,
        ...(options !== undefined ? { options } : {}),
      });
      const held = gate;
      gate = undefined;
      return held ?? Promise.resolve();
    };
  return {
    sent,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
    },
    session: {
      sendChannelMessage: record("sendChannelMessage"),
      sendChannelAd: record("sendChannelAd"),
      sendPrivateMessage: record("sendPrivateMessage"),
    } as unknown as FchatSession,
  };
}

interface Harness {
  outbox: Outbox;
  broadcasts: { identityId: string; items: OutboxItemDto[] }[];
}

const running: Outbox[] = [];
afterEach(async () => {
  // Awaited (#576): a stop() that merely cleared the timer left this test's
  // in-flight tick free to claim the NEXT test's rows — and fail them
  // against this test's session registry, which cannot know the new
  // identity. The victim saw its earliest row vanish into
  // "no live session at release time".
  await Promise.all(running.splice(0).map((outbox) => outbox.stop()));
});

function makeOutbox(sessions: Map<string, FchatSession>): Harness {
  const broadcasts: { identityId: string; items: OutboxItemDto[] }[] = [];
  const outbox = new Outbox({
    db,
    sessions: {
      get: (identityId: string) => sessions.get(identityId),
    } as unknown as SessionRegistry,
    hub: {
      broadcast: (identityId, event) => {
        broadcasts.push({ identityId, items: event.d.items });
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    pollIntervalMs: POLL_MS,
  });
  running.push(outbox);
  return { outbox, broadcasts };
}

function rowsFor(identityId: string) {
  return db
    .select({
      id: outboxMessages.id,
      state: outboxMessages.state,
      bbcode: outboxMessages.bbcode,
      failureReason: outboxMessages.failureReason,
    })
    .from(outboxMessages)
    .where(eq(outboxMessages.identityId, identityId))
    .orderBy(asc(outboxMessages.releaseAt), asc(outboxMessages.createdAt));
}

// ── Release ──────────────────────────────────────────────────────────────────

describe("outbox release", () => {
  it("puts a plain channel message on the wire as a channel message", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));

    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "**warm**",
      bbcode: "[b]warm[/b]",
      releaseAt: new Date(Date.now() - 1000),
    });
    h.outbox.start();

    await vi.waitFor(() => {
      expect(fake.sent).toEqual([
        {
          method: "sendChannelMessage",
          target: "Cabin Fever",
          bbcode: "[b]warm[/b]",
        },
      ]);
    }, FRAME_WAIT_MS);
    // Released rows are deleted (what actually went out lives in messages),
    // and every attached device is told.
    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect(h.broadcasts.at(-1)).toEqual({ identityId, items: [] });
  });

  it("claims nothing scheduled after stop() resolves (#576)", async () => {
    // The flake this pins: each test's outbox polls the shared database, and
    // a stop() that only cleared the timer left an in-flight tick free to
    // claim rows a LATER test had just scheduled — failing them against a
    // registry that never heard of the new identity. stop() now waits the
    // tick out and the tick refuses to claim once stopped, so after stop()
    // resolves this outbox touches nothing, ever.
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Ember Hall");
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));
    h.outbox.start();
    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "before",
      bbcode: "before",
      releaseAt: new Date(Date.now() - 1000),
    });
    // Prove the poll is live, then stop between polls.
    await vi.waitFor(() => {
      expect(fake.sent).toHaveLength(1);
    }, FRAME_WAIT_MS);
    await h.outbox.stop();

    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "after",
      bbcode: "after",
      releaseAt: new Date(Date.now() - 1000),
    });
    // Give a zombie tick every chance it used to have.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    expect(fake.sent).toHaveLength(1);
    expect(await rowsFor(identityId)).toEqual([
      expect.objectContaining({ state: "scheduled", bbcode: "after" }),
    ]);
  });

  it("routes a DM and a delayed ad to their own send methods", async () => {
    const identityId = await seedIdentity();
    const pmId = await seedPmConversation(identityId, "Birch Rowan");
    const channelId = await seedChannelConversation(identityId, "Winter Tales");
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));

    const past = Date.now() - 1000;
    await h.outbox.schedule({
      identityId,
      conversationId: pmId,
      markdown: "hi",
      bbcode: "hi",
      releaseAt: new Date(past),
    });
    await h.outbox.schedule({
      identityId,
      conversationId: channelId,
      markdown: "ad",
      bbcode: "ad",
      kind: "lrp",
      releaseAt: new Date(past + 1),
    });
    h.outbox.start();

    await vi.waitFor(() => {
      expect(fake.sent).toHaveLength(2);
    }, FRAME_WAIT_MS);
    expect(fake.sent).toEqual([
      { method: "sendPrivateMessage", target: "Birch Rowan", bbcode: "hi" },
      {
        method: "sendChannelAd",
        target: "Winter Tales",
        bbcode: "ad",
        // A parked ad is MEANT to wait out the 10-minute lfrp gate; only
        // this user's own queue waits behind it.
        options: { wait: true },
      },
    ]);
  });

  it("keeps a refused row with its reason instead of losing the text", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    // No session for this identity: the release has nowhere to go.
    const h = makeOutbox(new Map());

    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "typed this",
      bbcode: "typed this",
      releaseAt: new Date(Date.now() - 1000),
    });
    h.outbox.start();

    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([
        expect.objectContaining({
          state: "failed",
          failureReason: "no live session at release time",
        }),
      ]);
    }, FRAME_WAIT_MS);
    // Still recallable, so the composer can get the text back.
    const recalled = await h.outbox.recall(
      identityId,
      (await rowsFor(identityId))[0]!.id,
    );
    expect(recalled).toEqual({ markdown: "typed this" });
  });

  it("surfaces rows a dead worker left claimed rather than re-sending them", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    await db.insert(outboxMessages).values({
      identityId,
      conversationId: convId,
      markdown: "in flight when the process died",
      bbcode: "x",
      state: "releasing",
      releaseAt: new Date(Date.now() - 1000),
    });
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));
    h.outbox.start();

    // Ambiguous by nature — it may already have reached F-Chat, so it is
    // surfaced with the ambiguity spelled out, never silently re-sent.
    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([
        expect.objectContaining({
          state: "failed",
          failureReason: "interrupted by a restart — it may have been sent",
        }),
      ]);
    }, FRAME_WAIT_MS);
    expect(fake.sent).toEqual([]);
  });
});

// ── The concurrency guard (M6 audit) ─────────────────────────────────────────

describe("outbox concurrency", () => {
  it("never lets one identity's stalled chain hold up another's due rows", async () => {
    const slowId = await seedIdentity();
    const fastId = await seedIdentity();
    const slowConv = await seedChannelConversation(slowId, "Slow Room");
    const fastConv = await seedChannelConversation(fastId, "Fast Room");
    const slow = fakeSession();
    const fast = fakeSession();
    const h = makeOutbox(
      new Map([
        [slowId, slow.session],
        [fastId, fast.session],
      ]),
    );

    const past = Date.now() - 1000;
    // The slow identity's first send parks (a queued ad waiting out the
    // 10-minute lfrp gate is exactly this shape) and it has a second row
    // behind it.
    await h.outbox.schedule({
      identityId: slowId,
      conversationId: slowConv,
      markdown: "one",
      bbcode: "one",
      releaseAt: new Date(past),
    });
    await h.outbox.schedule({
      identityId: slowId,
      conversationId: slowConv,
      markdown: "two",
      bbcode: "two",
      releaseAt: new Date(past + 1),
    });
    await h.outbox.schedule({
      identityId: fastId,
      conversationId: fastConv,
      markdown: "unrelated",
      bbcode: "unrelated",
      releaseAt: new Date(past + 2),
    });
    slow.hold();
    h.outbox.start();

    // The slow identity's chain is parked on its first send…
    await vi.waitFor(() => {
      expect(slow.sent.map((call) => call.bbcode)).toEqual(["one"]);
    }, FRAME_WAIT_MS);
    // …and the other user's row still goes out. That is the whole invariant.
    await vi.waitFor(() => {
      expect(fast.sent.map((call) => call.bbcode)).toEqual(["unrelated"]);
    }, FRAME_WAIT_MS);
    await vi.waitFor(async () => {
      expect(await rowsFor(fastId)).toEqual([]);
    }, FRAME_WAIT_MS);

    // And the stalled identity's own second row was not claimed by a later
    // poll: release order within an identity is promised, so it waits. A
    // negative assertion cannot be polled — give a broken guard a generous
    // run of poll intervals to claim the row in.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 25));
    expect(slow.sent.map((call) => call.bbcode)).toEqual(["one"]);
    expect((await rowsFor(slowId)).map((row) => row.state)).toEqual([
      "releasing",
      "scheduled",
    ]);

    // Once the gate opens the chain drains, in order.
    slow.release();
    await vi.waitFor(async () => {
      expect(await rowsFor(slowId)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect(slow.sent.map((call) => call.bbcode)).toEqual(["one", "two"]);
  });
});

// ── The failed-row sweep (M7 audit) ──────────────────────────────────────────

describe("outbox failed-row sweep", () => {
  it("reaps failures past the TTL, keeps recent ones, and fans the change", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    const failed = (
      markdown: string,
      failedAt: Date | null,
      releaseAt: Date,
    ) => ({
      identityId,
      conversationId: convId,
      markdown,
      bbcode: markdown,
      state: "failed",
      failureReason: "send failed",
      failedAt,
      releaseAt,
    });
    await db.insert(outboxMessages).values([
      // Well past any TTL: gone.
      failed("ancient", LONG_AGO, LONG_AGO),
      // A pre-migration row has no failedAt — the sweep falls back to
      // releaseAt rather than keeping it forever.
      failed("legacy", null, LONG_AGO),
      // Failed long after its release: the TTL keys on the failure, not on
      // releaseAt, so this one still has its full window to be seen (M7
      // audit). Both halves of that rule are in this one row.
      failed("recent", new Date(), LONG_AGO),
    ]);
    const h = makeOutbox(new Map());
    h.outbox.start();

    await vi.waitFor(async () => {
      expect((await rowsFor(identityId)).map((row) => row.bbcode)).toEqual([
        "recent",
      ]);
      // The rows reaching their final state does NOT mean the fan-out has
      // happened: #sweepFailed deletes first and only then awaits #fan, which
      // runs its own `list` query before broadcasting. Waiting on the rows
      // alone let this poll land inside that window on a loaded runner —
      // three CI failures, `fan` undefined, nothing wrong with the code. Both
      // observables belong in the same wait.
      expect(
        h.broadcasts.some((event) => event.identityId === identityId),
      ).toBe(true);
    }, FRAME_WAIT_MS);
    // Attached devices are told, or their pending lists keep showing rows
    // the database no longer has.
    const fan = h.broadcasts.find((event) => event.identityId === identityId);
    expect(fan?.items.map((item) => item.markdown)).toEqual(["recent"]);
    expect(fan?.items[0]).toMatchObject({ state: "failed" });
  });

  it("leaves other identities' failures alone", async () => {
    const mine = await seedIdentity();
    const theirs = await seedIdentity();
    const mineConv = await seedChannelConversation(mine, "Mine");
    const theirsConv = await seedChannelConversation(theirs, "Theirs");
    await db.insert(outboxMessages).values([
      {
        identityId: mine,
        conversationId: mineConv,
        markdown: "stale",
        bbcode: "stale",
        state: "failed",
        failedAt: LONG_AGO,
        releaseAt: LONG_AGO,
      },
      {
        identityId: theirs,
        conversationId: theirsConv,
        markdown: "fresh",
        bbcode: "fresh",
        state: "failed",
        failedAt: new Date(),
        releaseAt: LONG_AGO,
      },
    ]);
    const h = makeOutbox(new Map());
    h.outbox.start();

    await vi.waitFor(async () => {
      expect(await rowsFor(mine)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect((await rowsFor(theirs)).map((row) => row.bbcode)).toEqual(["fresh"]);
    // A scheduled row of the same age is not a failure and is never swept.
    const [survivor] = await db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.identityId, theirs),
          eq(outboxMessages.state, "failed"),
        ),
      );
    expect(survivor).toBeDefined();
  });
});
