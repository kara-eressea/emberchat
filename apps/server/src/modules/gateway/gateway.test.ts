// Gateway integration tests against real Postgres (testcontainers), fchat-sim
// and a listening HTTP server — app.inject cannot carry a WebSocket upgrade,
// so the suite talks to /gateway over real sockets like a browser would.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FchatSim, rawDataToString } from "@emberchat/fchat-sim";
import {
  parseServerCommand,
  serializeClientCommand,
  serializeServerCommand,
  type ClientCommand,
} from "@emberchat/fchat-protocol";
import {
  GATEWAY_CLOSE,
  PREFS_DEFAULTS,
  PROTOCOL_VERSION,
  UNREAD_DISPLAY_CAP,
  type ClientFrame,
  type NotificationDto,
  type ResumeCursors,
  type ServerFrame,
  type UserPrefs,
} from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import {
  ads,
  authSessions,
  conversations,
  identities,
  ignores,
  messages,
  outboxMessages,
} from "../../db/schema.js";
import { ConversationLimitError } from "../history/sink.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_MS,
  INTEGRATION_SLOW_MS,
} from "../../test-support/budgets.js";
import { type FchatSession, FlistApiClient } from "@emberchat/session-engine";
import { MAX_FRAMES_PER_MINUTE } from "./connection.js";

const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
/** Injected handshake window; production's is `HELLO_TIMEOUT_MS`, private to
 * connection.ts — this is a shorter one, not a reference to that value. */
const HELLO_TIMEOUT_TEST_MS = 2_000;
/** Injected slow-consumer cap; production's is `MAX_BUFFERED_BYTES`, likewise
 * private to connection.ts. */
const MAX_BUFFERED_TEST_BYTES = 16 * 1024;

// Sim-backed round trips (connect → IDN → join → relay) outgrow the 5s default.
vi.setConfig({ testTimeout: INTEGRATION_MS });

let testDb: TestDb;
let db: Db;
let sim: FchatSim;
let app: FastifyInstance;
let gatewayUrl: string;

beforeAll(async () => {
  // lfrp_flood is zeroed: the RP-messages test sends several ads and would
  // otherwise wait out the live 10-minute pace (pacing itself is covered in
  // fchat-session.test.ts against a dedicated sim).
  // staFloodSeconds scales F-Chat's 5s status gate (ERR 14) down with the
  // session's own pacing window below, so the multi-device status tests
  // exercise a real gate without sitting out five seconds.
  sim = new FchatSim({ serverVars: { lfrp_flood: 0 }, staFloodSeconds: 1 });
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
    // The reconnect scenario can't wait out the 10s policy floor.
    sessionTuning: {
      backoffFloorMs: 200,
      backoffCapMs: 400,
      statusGateMs: 1200,
    },
    gatewayTuning: {
      // The dead-socket test can't wait out the 30s production heartbeat.
      heartbeatMs: 300,
      // Shortened from 10s so the no-hello test doesn't sit out the real
      // window. Still far above the connect→hello gap every other test
      // leaves (one round trip), so nobody else sees this timer.
      helloTimeoutMs: HELLO_TIMEOUT_TEST_MS,
      // Shrunk from 1 MiB so the slow-consumer test can overrun it; only a
      // socket that has stopped reading entirely ever gets near it.
      maxBufferedBytes: MAX_BUFFERED_TEST_BYTES,
    },
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = `${address.replace(/^http/, "ws")}/gateway`;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close(); // onClose stops all sessions
  await testDb.stop();
  await sim.stop();
});

// ── Test gateway client ───────────────────────────────────────────────────────

class TestClient {
  readonly #socket: WebSocket;
  readonly #frames: ServerFrame[] = [];
  #wake: (() => void) | undefined;
  #closed: { code: number; reason: string } | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data: WebSocket.RawData) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData decode
      this.#frames.push(JSON.parse(data.toString()) as ServerFrame);
      this.#wake?.();
    });
    socket.on("close", (code, reason) => {
      this.#closed = { code, reason: reason.toString() };
      this.#wake?.();
    });
  }

  static connect(): Promise<TestClient> {
    const socket = new WebSocket(gatewayUrl);
    const client = new TestClient(socket);
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        resolve(client);
      });
      socket.once("error", reject);
    });
  }

  send(frame: ClientFrame): void {
    this.#socket.send(JSON.stringify(frame));
  }

  /** Bypasses the frame type — for the "what if it isn't JSON at all" path. */
  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  /** Removes and returns the first frame matching the predicate, in arrival
   * order; waits for it if it has not arrived yet. */
  async next<T extends ServerFrame>(
    predicate: (frame: ServerFrame) => frame is T,
    timeoutMs = FRAME_WAIT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index !== -1) {
        return this.#frames.splice(index, 1)[0] as T;
      }
      if (this.#closed) {
        throw new Error(
          `socket closed (${String(this.#closed.code)}) while waiting`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out; buffered: ${JSON.stringify(
            this.#frames.map((f) =>
              f.t === "event" ? `event:${(f.d as { kind: string }).kind}` : f.t,
            ),
          )}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  nextOfType<T extends ServerFrame["t"]>(t: T, timeoutMs = FRAME_WAIT_MS) {
    return this.next(
      (frame): frame is Extract<ServerFrame, { t: T }> => frame.t === t,
      timeoutMs,
    );
  }

  nextEvent<K extends string>(kind: K, timeoutMs = FRAME_WAIT_MS) {
    return this.next(
      (
        frame,
      ): frame is Extract<ServerFrame, { t: "event" }> & {
        d: { kind: K };
      } => frame.t === "event" && frame.d.kind === kind,
      timeoutMs,
    );
  }

  async hello(token: string, resume?: ResumeCursors) {
    this.send({
      t: "hello",
      d: {
        token,
        protocolVersion: PROTOCOL_VERSION,
        ...(resume ? { resume } : {}),
      },
    });
    return this.nextOfType("ready");
  }

  async subscribe(identityId: string) {
    this.send({ t: "sub", d: { identityId } });
    return this.nextOfType("snapshot");
  }

  waitForClose(
    timeoutMs = FRAME_WAIT_MS,
  ): Promise<{ code: number; reason: string }> {
    if (this.#closed) {
      return Promise.resolve(this.#closed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for close"));
      }, timeoutMs);
      this.#socket.on("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  close(): void {
    this.#socket.close();
  }

  /** Stops reading the socket: the ws client can no longer answer the
   * server's pings, which is what a slept laptop or a dropped NAT tunnel
   * looks like from the server side. */
  goSilent(): void {
    this.#socket.pause();
  }

  /** Starts reading again — needed to see a close frame queued behind the
   * backlog that went unread while the client was silent. */
  wakeUp(): void {
    this.#socket.resume();
  }

  get bufferedFrames(): readonly ServerFrame[] {
    return this.#frames;
  }
}

const openClients: TestClient[] = [];
async function connectClient(): Promise<TestClient> {
  const client = await TestClient.connect();
  openClients.push(client);
  return client;
}
afterEach(() => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
});

// ── Production-path setup helpers (mirrors history.test.ts) ─────────────────

let userCounter = 0;
/** A bare second participant on the sim (the "other side" of moderation). */
class SimClient {
  readonly #socket: WebSocket;
  readonly #queue: string[] = [];
  readonly #waiters: Array<(raw: string) => void> = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const raw = rawDataToString(data);
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(raw);
      } else {
        this.#queue.push(raw);
      }
    });
  }

  static async connect(
    fchat: FchatSim,
    account: string,
    character: string,
  ): Promise<SimClient> {
    const socket = new WebSocket(fchat.wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new SimClient(socket);
    client.send({
      cmd: "IDN",
      payload: {
        method: "ticket",
        account,
        ticket: fchat.issueTicketFor(account),
        character,
        cname: "EmberChat-test-observer",
        cversion: "0.0.0",
      },
    });
    await client.waitFor("IDN");
    return client;
  }

  send(command: ClientCommand): void {
    this.#socket.send(serializeClientCommand(command));
  }

  async next(timeoutMs = FRAME_WAIT_MS): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a sim frame"));
      }, timeoutMs);
      this.#waiters.push((raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
    });
  }

  /** Skips frames until one starts with the given command name. */
  async waitFor(cmd: string): Promise<string> {
    for (;;) {
      const raw = await this.next();
      if (raw === cmd || raw.startsWith(`${cmd} `)) {
        return raw;
      }
    }
  }

  close(): void {
    this.#socket.terminate();
  }
}

async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `gateway-${String(userCounter)}@example.test`,
      username: `gateway${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

/**
 * Fresh user + vaulted account + identity row. Every scenario logs in the
 * same character, so the previous scenario's session is stopped first —
 * otherwise the sim displaces it and it reconnects mid-test.
 */
let lastIdentityId: string | undefined;
async function createIdentity(): Promise<{
  identityId: string;
  token: string;
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
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: accountId, characterName: CHARACTER })
    .returning({ id: identities.id });
  lastIdentityId = identity!.id;
  return { identityId: identity!.id, token };
}

function waitForOnline(session: FchatSession): Promise<void> {
  if (session.status === "online") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for online (${session.status})`));
    }, FRAME_WAIT_MS);
    session.events.on("status", (event) => {
      if (event.status === "online") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** Starts the session directly (as cmd session.connect would). */
async function startSession(identityId: string): Promise<FchatSession> {
  const [row] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, identityId));
  const session = app.sessions.start({
    identityId,
    character: CHARACTER,
    accountId: row!.flistAccountId,
    accountName: ACCOUNT,
  });
  await waitForOnline(session);
  return session;
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

/** The nested event payload: event frames are `{ t, d: { identityId, kind, d } }`. */
function eventPayload<T>(frame: { d: unknown }): T {
  return (frame.d as { d: T }).d;
}

/** Consumes conversation.updated events until one matches the predicate —
 * conversation creation emits an update too, so tests skip ahead to the
 * state they care about. */
async function nextConversationUpdate<
  T extends { id: string; lastReadMessageId: number | null },
>(client: TestClient, predicate: (conversation: T) => boolean): Promise<T> {
  for (;;) {
    const frame = await client.nextEvent("conversation.updated");
    const { conversation } = eventPayload<{ conversation: T }>(frame);
    if (predicate(conversation)) {
      return conversation;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("channel rejoin semantics (decisions.md §9)", () => {
  it("pins over the gateway; an explicit reconnect rejoins pinned channels only", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");
    await joinAndSettle(session, "Development");
    await app.history.flush();

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const frontpage = snapshot.d.channels.find((c) => c.key === "Frontpage");
    expect(frontpage).toBeDefined();

    // conv.pin: ack carries the updated conversation, and the update fans out.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "conv.pin",
        d: { convId: frontpage!.convId, pinned: true },
      },
    });
    const pinAck = await client.nextOfType("ack");
    expect(pinAck.d).toMatchObject({
      ok: true,
      conversation: { id: frontpage!.convId, pinned: true },
    });
    await nextConversationUpdate<{
      id: string;
      lastReadMessageId: number | null;
      pinned: boolean;
    }>(client, (c) => c.id === frontpage!.convId && c.pinned);

    // Explicit disconnect, then connect: the user chose to log off, so only
    // the pinned channel comes back and the casual one reconciles to
    // joined = false.
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "session.disconnect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    client.send({
      t: "cmd",
      id: 3,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const fresh = app.sessions.get(identityId);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(session);
    await waitForOnline(fresh!);
    await vi.waitFor(() => {
      expect(fresh!.state.channels.has("Frontpage")).toBe(true);
    });
    expect(fresh!.state.channels.has("Development")).toBe(false);

    // The reconcile runs once the session is online, through the sink queue.
    await app.history.flush();
    const [devRow] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Development"),
        ),
      );
    expect(devRow?.joined).toBe(false);

    // A second connect while the session is live must not reseed anything —
    // leave Frontpage, reconnect from another tab, still left.
    fresh!.leaveChannel("Frontpage");
    await vi.waitFor(() => {
      expect(fresh!.state.channels.has("Frontpage")).toBe(false);
    });
    client.send({
      t: "cmd",
      id: 4,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(app.sessions.get(identityId)).toBe(fresh);
    expect(fresh!.state.channels.has("Frontpage")).toBe(false);
  });

  it("leaving a pinned channel over the gateway unpins it (#169)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");
    await app.history.flush();

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const frontpage = snapshot.d.channels.find((c) => c.key === "Frontpage");
    expect(frontpage).toBeDefined();

    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "conv.pin",
        d: { convId: frontpage!.convId, pinned: true },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    // Pinned means auto-rejoin: the restart-recovery seed includes it.
    expect(await app.history.channelsForResume(identityId)).toEqual([
      "Frontpage",
    ]);

    // Explicit leave takes the conversation row out of the sidebar
    // everywhere (#327) and drops it from the resume set, so nothing drags
    // the channel back on the next reconnect — subsuming the old
    // unpin-on-leave. The row is hidden, not deleted: its kept history stays.
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "channel.leave", d: { key: "Frontpage" } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    const removed = await client.nextEvent("conversation.removed");
    expect(eventPayload<{ convId: string }>(removed).convId).toBe(
      frontpage!.convId,
    );
    // Once the hide drains through the sink, no seed resurrects it…
    await vi.waitFor(async () => {
      await app.history.flush();
      expect(await app.history.channelsForResume(identityId)).toEqual([]);
    });
    expect(await app.history.pinnedChannelKeys(identityId)).toEqual([]);
    // …yet the row itself survives, marked hidden — history is never deleted.
    const [left] = await db
      .select({ hidden: conversations.hidden, joined: conversations.joined })
      .from(conversations)
      .where(eq(conversations.id, frontpage!.convId));
    expect(left).toEqual({ hidden: true, joined: false });
  });

  it("recovers an F-Chat drop with no user interaction: re-tickets from the vault, rejoins channels (M2 verification)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Invalidate the server's cached ticket account-wide (a newer ticket
    // always does), then drop the connection: the reconnect must survive the
    // stale-ticket rejection by re-fetching through the vaulted password —
    // the full "re-ticket from the vault" path, not the ticket cache.
    sim.issueTicketFor(ACCOUNT);
    sim.disconnect(CHARACTER);

    // Subscribed browsers watch the outage and recovery as status events.
    for (;;) {
      const frame = await client.nextEvent("session.status", FRAME_WAIT_MS);
      if (eventPayload<{ status: string }>(frame).status === "online") {
        break;
      }
    }
    await vi.waitFor(() => {
      expect(
        session.state.channels.get("Frontpage")?.members.has(CHARACTER),
      ).toBe(true);
    });
  });

  it("session.connect and session.disconnect maintain the autoConnect intent flag and fan it out", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId); // identity.updated arrives via fan-out

    const flag = async () => {
      const [row] = await db
        .select({ autoConnect: identities.autoConnect })
        .from(identities)
        .where(eq(identities.id, identityId));
      return row?.autoConnect;
    };
    expect(await flag()).toBe(false); // direct insert bypasses the API default

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(await flag()).toBe(true);
    expect(
      eventPayload<{ autoConnect: boolean }>(
        await client.nextEvent("identity.updated"),
      ).autoConnect,
    ).toBe(true);

    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "session.disconnect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(await flag()).toBe(false);
    expect(
      eventPayload<{ autoConnect: boolean }>(
        await client.nextEvent("identity.updated"),
      ).autoConnect,
    ).toBe(false);
  });

  it("a connect while autoConnect is set is a recovery: joined plus pinned channels, no reconcile", async () => {
    const { identityId, token } = await createIdentity();
    // Persisted state from "before the outage": flagged for auto-connect,
    // one casually joined channel, one pinned channel whose joined flag was
    // lost mid-outage (an explicit leave would have unpinned it, #169).
    await db
      .update(identities)
      .set({ autoConnect: true })
      .where(eq(identities.id, identityId));
    await db.insert(conversations).values([
      {
        identityId,
        kind: "channel",
        channelKey: "Frontpage",
        title: "Frontpage",
        joined: true,
        pinned: false,
      },
      {
        identityId,
        kind: "channel",
        channelKey: "Development",
        title: "Development",
        joined: false,
        pinned: true,
      },
    ]);

    const client = await connectClient();
    await client.hello(token);
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const session = app.sessions.get(identityId);
    expect(session).toBeDefined();
    await waitForOnline(session!);
    await vi.waitFor(() => {
      expect(session!.state.channels.has("Frontpage")).toBe(true);
    });
    // Pinned means auto-rejoin (#169): the pin comes back alongside the
    // joined set.
    await vi.waitFor(() => {
      expect(session!.state.channels.has("Development")).toBe(true);
    });

    // And it never reconciles: the casual row keeps its joined flag.
    await app.history.flush();
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Frontpage"),
        ),
      );
    expect(row?.joined).toBe(true);
  });

  it("an explicit connect that never reaches online leaves the recovery set intact", async () => {
    const { identityId, token } = await createIdentity(); // autoConnect false
    // A character no longer on the account: identify is rejected until the
    // session gives up — it never reaches online.
    await db
      .update(identities)
      .set({ characterName: "Nobody Real" })
      .where(eq(identities.id, identityId));
    await db.insert(conversations).values({
      identityId,
      kind: "channel",
      channelKey: "Frontpage",
      title: "Frontpage",
      joined: true,
      pinned: false,
    });

    const client = await connectClient();
    await client.hello(token);
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const session = app.sessions.get(identityId);
    expect(session).toBeDefined();
    await vi.waitFor(
      () => {
        expect(session!.status).toBe("stopped");
      },
      { timeout: 10_000 },
    );

    // The destructive scenario-3 reconcile never ran — after re-auth, a
    // recovery still finds the channel set intact.
    await app.history.flush();
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Frontpage"),
        ),
      );
    expect(row?.joined).toBe(true);
  });
});

describe("social lists over the gateway (#194/#199)", () => {
  it("snapshots cached social and fans out bookmark changes live", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const authorization = { authorization: `Bearer ${token}` };

    const a = await connectClient();
    await a.hello(token);
    const before = await a.subscribe(identityId);
    // Nothing cached yet this server run: the snapshot carries null and
    // the client falls back to the REST load.
    expect(before.d.self.social).toBeNull();

    // First REST load fills the server cache — and itself fans out.
    const loaded = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/social`,
      headers: authorization,
    });
    expect(loaded.statusCode).toBe(200);
    const seeded = await a.nextEvent("social.updated");

    // A second device now attaches with the lists already in its snapshot
    // — no new F-List API calls (#194).
    const b = await connectClient();
    await b.hello(token);
    const snapshot = await b.subscribe(identityId);
    expect(snapshot.d.self.social).toEqual(
      eventPayload<{ social: object }>(seeded).social,
    );

    // A bookmark add reaches every attached device instantly (#199),
    // presence-enriched from the live roster (Nyx is an online NPC).
    const added = await app.inject({
      method: "POST",
      url: `/api/identities/${identityId}/social/bookmark`,
      headers: authorization,
      payload: { action: "add", name: "Nyx Firemane" },
    });
    expect(added.statusCode).toBe(200);
    const [eventA, eventB] = await Promise.all([
      a.nextEvent("social.updated"),
      b.nextEvent("social.updated"),
    ]);
    expect(eventA).toEqual(eventB);
    const { social } = eventPayload<{
      social: { bookmarks: { name: string; online: boolean }[] };
    }>(eventA);
    expect(social.bookmarks.map((row) => row.name)).toContain("Nyx Firemane");
    expect(
      social.bookmarks.find((row) => row.name === "Nyx Firemane")?.online,
    ).toBe(true);

    // Clean up the shared sim account for later scenarios.
    const removed = await app.inject({
      method: "POST",
      url: `/api/identities/${identityId}/social/bookmark`,
      headers: authorization,
      payload: { action: "remove", name: "Nyx Firemane" },
    });
    expect(removed.statusCode).toBe(200);
    await a.nextEvent("social.updated");
    await b.nextEvent("social.updated");
  });
});

describe("gateway handshake", () => {
  it("answers hello with ready and lists the user's identities", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    const ready = await client.hello(token);
    expect(ready.d.identities).toEqual([
      {
        id: identityId,
        name: CHARACTER,
        sessionStatus: "online",
        // Inserted directly by the test helper, so the API default (true)
        // does not apply.
        autoConnect: false,
        unread: 0,
        mentions: 0,
        notificationsUnseen: 0,
      },
    ]);

    client.send({ t: "ping" });
    await client.nextOfType("pong");
  });

  it("ready carries per-identity badge totals without a session or a sub", async () => {
    const { identityId, token } = await createIdentity();
    // No session started — the rail must paint badges for offline identities
    // (their history persists regardless).
    const [dev, lounge] = await db
      .insert(conversations)
      .values([
        { identityId, kind: "channel", channelKey: "Dev", title: "Dev" },
        { identityId, kind: "channel", channelKey: "Lounge", title: "Lounge" },
      ])
      .returning();
    await db.insert(messages).values([
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: "unread one",
      },
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `oi ${CHARACTER}!`,
        // Seeded directly, so the flag is set here; live traffic gets it
        // stamped by the sink's highlight matcher at persist time (M5).
        mention: true,
      },
      {
        conversationId: lounge!.id,
        senderCharacter: "Tally Marsh",
        kind: "msg" as const,
        bbcode: "unread two",
      },
      {
        conversationId: lounge!.id,
        senderCharacter: CHARACTER,
        kind: "msg" as const,
        bbcode: `I, ${CHARACTER}, sent this myself`,
        sentByUs: true, // own sends count as neither
      },
    ]);

    const client = await connectClient();
    const ready = await client.hello(token);
    // Totals aggregate across both conversations: 3 inbound unread, 1 mention.
    expect(ready.d.identities[0]).toMatchObject({
      id: identityId,
      sessionStatus: "offline",
      unread: 3,
      mentions: 1,
    });
  });

  it("leaves messages from ignored senders out of every count (audit backlog)", async () => {
    const { identityId, token } = await createIdentity();
    const [dev] = await db
      .insert(conversations)
      .values({ identityId, kind: "channel", channelKey: "Dev", title: "Dev" })
      .returning();
    // The identity ignores Spam Bot — the mirror the sink maintains from IGN.
    await db
      .insert(ignores)
      .values({ identityId, character: "Spam Bot" })
      .onConflictDoNothing();
    await db.insert(messages).values([
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: "the one that counts",
      },
      {
        conversationId: dev!.id,
        // Cased differently on the wire: F-Chat resolves names
        // case-insensitively, and so must the exclusion.
        senderCharacter: "SPAM BOT",
        kind: "msg" as const,
        bbcode: `buy gold ${CHARACTER}`,
        mention: true,
      },
    ]);

    const client = await connectClient();
    const ready = await client.hello(token);
    // Only the unignored message: the ignored one is filtered out of the log
    // client-side, so a badge for it could never be cleared by reading it.
    expect(ready.d.identities[0]).toMatchObject({ unread: 1, mentions: 0 });

    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.channels[0]).toMatchObject({
      key: "Dev",
      unread: 1,
      mentions: 0,
    });
  });

  it("ready totals exclude muted conversations and muted identities (#430)", async () => {
    const { identityId, token } = await createIdentity();
    const [dev, lounge] = await db
      .insert(conversations)
      .values([
        { identityId, kind: "channel", channelKey: "Dev", title: "Dev" },
        { identityId, kind: "channel", channelKey: "Lounge", title: "Lounge" },
      ])
      .returning();
    await db.insert(messages).values([
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `oi ${CHARACTER}`,
        mention: true,
      },
      {
        conversationId: lounge!.id,
        senderCharacter: "Tally Marsh",
        kind: "msg" as const,
        bbcode: `also oi ${CHARACTER}`,
        mention: true,
      },
    ]);

    // Baseline: both conversations feed the totals.
    const before = await connectClient();
    expect((await before.hello(token)).d.identities[0]).toMatchObject({
      unread: 2,
      mentions: 2,
    });

    const setter = await connectClient();
    await setter.hello(token);
    await setter.subscribe(identityId);
    setter.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "prefs.set",
        d: { prefs: { mutedConvIds: [dev!.id] } },
      },
    });
    await setter.nextOfType("ack");

    // The favicon indicator falls back to these totals for an unsynced
    // identity and cannot decompose them, so the mute has to hold here.
    const muted = await connectClient();
    expect((await muted.hello(token)).d.identities[0]).toMatchObject({
      unread: 1,
      mentions: 1,
    });
    // Per-conversation snapshot counts stay mute-blind: sidebar badges keep
    // accruing for a muted room (decisions.md §10).
    const snapshot = await muted.subscribe(identityId);
    expect(
      snapshot.d.channels.find((channel) => channel.key === "Dev"),
    ).toMatchObject({ unread: 1, mentions: 1 });

    // A muted identity contributes nothing at all.
    setter.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "prefs.set",
        d: { prefs: { mutedIdentityIds: [identityId] } },
      },
    });
    await setter.nextOfType("ack");
    const silenced = await connectClient();
    expect((await silenced.hello(token)).d.identities[0]).toMatchObject({
      unread: 0,
      mentions: 0,
    });
  });

  it("rejects a bad token and a wrong protocol version", async () => {
    const bad = await connectClient();
    bad.send({
      t: "hello",
      d: { token: "not-a-jwt", protocolVersion: PROTOCOL_VERSION },
    });
    expect((await bad.waitForClose()).code).toBe(GATEWAY_CLOSE.unauthorized);

    const token = await registerUser();
    const wrongVersion = await connectClient();
    wrongVersion.send({
      t: "hello",
      d: { token, protocolVersion: PROTOCOL_VERSION + 1 },
    });
    expect((await wrongVersion.waitForClose()).code).toBe(
      GATEWAY_CLOSE.versionMismatch,
    );
  });

  it("closes a connection that never says hello", async () => {
    const silent = await connectClient();
    const closed = await silent.waitForClose();
    expect(closed.code).toBe(GATEWAY_CLOSE.helloTimeout);
    expect(closed.reason).toBe("no hello");
  });

  it("closes pre-hello connections that send garbage", async () => {
    const client = await connectClient();
    client.send({ t: "sub", d: { identityId: "not-even-a-uuid" } } as never);
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.badRequest);
  });
});

describe("gateway fan-out", () => {
  it("delivers identical event streams to two clients on the same identity", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const a = await connectClient();
    const b = await connectClient();
    await a.hello(token);
    await b.hello(token);
    await a.subscribe(identityId);
    await b.subscribe(identityId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "first",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Tally Marsh", message: "psst" },
    });
    await inject(session, {
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Nyx Firemane" },
        title: "Frontpage",
      },
    });

    const collect = async (client: TestClient) => [
      await client.nextEvent("message.new"),
      await client.nextEvent("message.new"),
      await client.nextEvent("member.join"),
    ];
    const [fromA, fromB] = await Promise.all([collect(a), collect(b)]);
    expect(fromA).toEqual(fromB);

    const [channelMsg, pm] = fromA as [
      (typeof fromA)[number],
      (typeof fromA)[number],
    ];
    expect(eventPayload<{ message: object }>(channelMsg).message).toMatchObject(
      {
        kind: "msg",
        senderCharacter: "Nyx Firemane",
        bbcode: "first",
        sentByUs: false,
      },
    );
    expect(eventPayload<{ message: object }>(pm).message).toMatchObject({
      kind: "pm",
      bbcode: "psst",
    });
  });

  it("keeps an already-attached client receiving after a second device attaches (#407)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const a = await connectClient();
    await a.hello(token);
    await a.subscribe(identityId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "before",
        channel: "Frontpage",
      },
    });
    await a.nextEvent("message.new");

    // A second browser attaches to the same identity, mid-life of the first:
    // hello with resume cursors, sub, and the shell's connect-on-visit.
    const b = await connectClient();
    await b.hello(token, { [identityId]: { convCursors: {} } });
    await b.subscribe(identityId);
    b.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    await b.nextOfType("ack");

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "after",
        channel: "Frontpage",
      },
    });

    const [fromA, fromB] = await Promise.all([
      a.nextEvent("message.new"),
      b.nextEvent("message.new"),
    ]);
    expect(
      eventPayload<{ message: { bbcode: string } }>(fromA).message.bbcode,
    ).toBe("after");
    expect(
      eventPayload<{ message: { bbcode: string } }>(fromB).message.bbcode,
    ).toBe("after");
  });

  it("keeps an already-attached client receiving across a session restart driven by a second device (#407)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const a = await connectClient();
    await a.hello(token);
    await a.subscribe(identityId);

    // The session goes down (user disconnect / detached ceiling) …
    app.sessions.stop(identityId, "test restart");
    await a.nextEvent("session.status");

    // … and a newly attached browser brings it back (connect-on-visit).
    const b = await connectClient();
    await b.hello(token);
    await b.subscribe(identityId);
    b.send({ t: "cmd", id: 1, d: { identityId, action: "session.connect" } });
    await b.nextOfType("ack");
    const restarted = app.sessions.get(identityId)!;
    await waitForOnline(restarted);
    await joinAndSettle(restarted, "Frontpage");

    await inject(restarted, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "after restart",
        channel: "Frontpage",
      },
    });

    const [fromA, fromB] = await Promise.all([
      a.nextEvent("message.new"),
      b.nextEvent("message.new"),
    ]);
    expect(
      eventPayload<{ message: { bbcode: string } }>(fromA).message.bbcode,
    ).toBe("after restart");
    expect(
      eventPayload<{ message: { bbcode: string } }>(fromB).message.bbcode,
    ).toBe("after restart");
  });

  it("drops a socket that stopped answering the heartbeat, and keeps the others fed (#407)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const dead = await connectClient();
    const alive = await connectClient();
    await dead.hello(token);
    await alive.hello(token);
    await dead.subscribe(identityId);
    await alive.subscribe(identityId);

    // The first device vanishes without a close frame (sleep / NAT drop):
    // the heartbeat finds its ping unanswered and terminates the socket
    // instead of leaving a zombie in the fan-out set.
    expect(app.gatewayHub.subscriberCount(identityId)).toBe(2);
    dead.goSilent();
    const deadline = Date.now() + 10_000;
    while (
      app.gatewayHub.subscriberCount(identityId) > 1 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(app.gatewayHub.subscriberCount(identityId)).toBe(1);

    // The still-live device keeps receiving, undisturbed.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "still flowing",
        channel: "Frontpage",
      },
    });
    const event = await alive.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(event).message.bbcode,
    ).toBe("still flowing");
    expect(app.gatewayHub.hasSubscribers(identityId)).toBe(true);
  });

  it("pools activity reports from every attached browser (#619)", async () => {
    // The wire half of shared activity sync: the frame reaches the connection,
    // the hub reads the newest across devices, and the away hook is told at
    // once rather than on the next sweep. (What the sweep then does with it is
    // modules/away/auto-away.test.ts.)
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const laptop = await connectClient();
    const phone = await connectClient();
    await laptop.hello(token);
    await phone.hello(token);
    await laptop.subscribe(identityId);
    await phone.subscribe(identityId);

    // Attaching is itself a report — a browser that has never reported reads
    // as "unknown" and holds the identity out of auto-away entirely, so the
    // real client sends one on open. These test clients do not, hence the
    // explicit frames below.
    expect(app.gatewayHub.activityAcross(identityId)).toBe("unknown");

    const notified: string[] = [];
    const previous = app.gatewayHub.onActivity;
    app.gatewayHub.onActivity = (id) => notified.push(id);
    try {
      laptop.send({ t: "activity" });
      await vi.waitFor(() => {
        expect(notified).toEqual([identityId]);
      }, FRAME_WAIT_MS);
      // Still unknown: the phone has not spoken, and its silence is not
      // evidence about its user.
      expect(app.gatewayHub.activityAcross(identityId)).toBe("unknown");

      phone.send({ t: "activity" });
      await vi.waitFor(() => {
        expect(notified).toHaveLength(2);
      }, FRAME_WAIT_MS);
      const pooled = app.gatewayHub.activityAcross(identityId);
      expect(typeof pooled).toBe("number");

      // A ping is a timer, not a person: it must never pass for activity.
      const beforePing = pooled;
      laptop.send({ t: "ping" });
      await laptop.nextOfType("pong");
      expect(app.gatewayHub.activityAcross(identityId)).toBe(beforePing);
      expect(notified).toHaveLength(2);
    } finally {
      app.gatewayHub.onActivity = previous;
    }
  });

  it("snapshots live channel state with unread and mention counts", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development");
    const say = (message: string) =>
      inject(session, {
        cmd: "MSG",
        payload: { character: "Nyx Firemane", message, channel: "Development" },
      });
    await say("unread me");
    await say(`hey ${CHARACTER}, look at this`); // mention
    await say("Amber Valery is someone else"); // word boundary: no match
    await inject(session, {
      cmd: "SYS",
      payload: { message: `${CHARACTER} joined`, channel: "Development" },
    }); // sys rows never count as mentions
    // Our own send counts as neither unread nor mention — matching the
    // client's live behavior.
    await session.sendChannelMessage(
      "Development",
      `I, ${CHARACTER}, speak of myself`,
    );
    await app.history.flush();

    // A conversation with more unread than the cap: counting stops one past
    // the largest number a badge shows exactly, so the client can tell
    // "saturated" from "exactly 99" and render "99+" (#582).
    const [flooded] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Flooded",
        title: "Flooded",
      })
      .returning();
    await db.insert(messages).values(
      Array.from({ length: 120 }, (_, i) => ({
        conversationId: flooded!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `spam ${String(i + 1)}`,
      })),
    );

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.self).toEqual({
      character: CHARACTER,
      sessionStatus: "online",
      status: "online",
      statusmsg: "",
      ignores: [],
      chatop: false,
      iconBlacklist: [],
      sendDelaySeconds: 0,
      prefs: PREFS_DEFAULTS,
      outbox: [],
      campaign: null,
      social: null,
      // The sim serves the documented default VARs.
      limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 0 },
    });
    expect(snapshot.d.channels).toHaveLength(2);
    const channel = snapshot.d.channels.find((c) => c.key === "Development")!;
    expect(channel).toMatchObject({
      key: "Development",
      joined: true,
      unread: 4,
      mentions: 1,
    });
    expect(channel.members.map((m) => m.character)).toContain(CHARACTER);
    expect(channel.description).not.toBe("");

    const capped = snapshot.d.channels.find((c) => c.key === "Flooded")!;
    // Strictly above the cap is the whole point: a count that stopped AT it is
    // indistinguishable from a channel holding exactly that many, and the
    // badge renders a flat "99" forever. The client half of this contract is
    // asserted in the web app's badges.test.ts.
    expect(capped.unread).toBe(UNREAD_DISPLAY_CAP + 1);
    expect(capped.unread).toBeGreaterThan(UNREAD_DISPLAY_CAP);
    expect(capped.mentions).toBe(0);
  });

  it("highlight rules match at persist time and badge a detached identity", async () => {
    const { identityId, token } = await createIdentity();
    const auth = { authorization: `Bearer ${token}` };

    // A pattern RE2 refuses is the client's 422 at PUT, never a silent skip.
    const refused = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: { rules: [{ kind: "regex", pattern: "(?<=x)y" }] },
    });
    expect(refused.statusCode).toBe(422);
    // Nick rules must be a valid character name (schema-level 400).
    const badNick = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: { rules: [{ kind: "nick", pattern: "no/slashes" }] },
    });
    expect(badNick.statusCode).toBe(400);

    // Full-list replacement dedupes payload-internal duplicates.
    const put = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: {
        rules: [
          { kind: "word", pattern: "dragonfruit" },
          { kind: "regex", pattern: "lem+on" },
          { kind: "word", pattern: "dragonfruit" },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ rules: unknown[] }>().rules).toHaveLength(2);
    const got = await app.inject({
      method: "GET",
      url: "/api/highlight-rules",
      headers: auth,
    });
    expect(
      got.json<{ rules: { pattern: string }[] }>().rules.map((r) => r.pattern),
    ).toEqual(["dragonfruit", "lem+on"]);

    // Traffic lands while NO gateway client is attached — the flags must be
    // stamped at persist time, not computed for whoever happens to watch.
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development");
    const say = (message: string) =>
      inject(session, {
        cmd: "MSG",
        payload: { character: "Nyx Firemane", message, channel: "Development" },
      });
    await say("fancy some DRAGONFRUIT tea?"); // word rule, case-insensitive
    await say("dragonfruits are different"); // word boundary: no match
    await say("lemmmon squash"); // regex rule
    await say(`${CHARACTER}, hello`); // own nick (default on)
    await app.history.flush();

    // A fresh device's snapshot reads the stored flags.
    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const channel = snapshot.d.channels.find((c) => c.key === "Development")!;
    expect(channel).toMatchObject({ unread: 4, mentions: 3 });

    // highlightOwnNick off → prefs patch invalidates the matcher's cache.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "prefs.set",
        d: { prefs: { highlightOwnNick: false } },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    await client.nextEvent("prefs.updated");
    await say(`${CHARACTER}, again`);
    expect(
      eventPayload<{ message: { mention: boolean } }>(
        await client.nextEvent("message.new"),
      ).message.mention,
    ).toBe(false);

    // Compare-and-set (M5 audit): a PUT carrying knownIds from a stale
    // load must 409 instead of silently deleting the other device's rules.
    const stale = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: {
        rules: [{ kind: "word", pattern: "kumquat" }],
        knownIds: ["00000000-0000-7000-8000-00000000dead"],
      },
    });
    expect(stale.statusCode).toBe(409);
    // Matching knownIds pass.
    const currentIds = got
      .json<{ rules: { id: string }[] }>()
      .rules.map((r) => r.id);
    const fresh = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: {
        rules: [
          { kind: "word", pattern: "dragonfruit" },
          { kind: "regex", pattern: "lem+on" },
        ],
        knownIds: currentIds,
      },
    });
    expect(fresh.statusCode).toBe(200);

    // Replacing the rules invalidates the rules cache the same way.
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/highlight-rules",
      headers: auth,
      payload: { rules: [] },
    });
    expect(cleared.statusCode).toBe(200);
    await say("more dragonfruit!");
    expect(
      eventPayload<{ message: { mention: boolean } }>(
        await client.nextEvent("message.new"),
      ).message.mention,
    ).toBe(false);
  });

  it("fans notification.new to every attached device and badges the ready frame", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");
    const one = await connectClient();
    const two = await connectClient();
    await one.hello(token);
    await two.hello(token);
    await one.subscribe(identityId);
    await two.subscribe(identityId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `${CHARACTER}, look at this`,
        channel: "Frontpage",
      },
    });

    // Multi-device: the inbox is server-held state, so both attached tabs
    // learn about the entry, not just whichever one happens to be focused.
    for (const client of [one, two]) {
      const { notification } = eventPayload<{
        notification: NotificationDto;
      }>(await client.nextEvent("notification.new"));
      expect(notification).toMatchObject({
        kind: "mention",
        character: "Nyx Firemane",
        muted: false,
        excerpt: `${CHARACTER}, look at this`,
      });
      expect(notification.messageId).toBeGreaterThan(0);
      expect(notification.convId).toBeDefined();
    }

    // A cold load badges off `ready` alone — no sub, no inbox fetch.
    const fresh = await connectClient();
    const ready = await fresh.hello(token);
    expect(
      ready.d.identities.find((identity) => identity.id === identityId)
        ?.notificationsUnseen,
    ).toBe(1);
  });

  it("ignore.add/remove drive IGN, fan out the list, persist the mirror, and keep messages", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "ignore.add", d: { character: "Nyx Firemane" } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    // The server's IGN ack fans the whole list out.
    const updated = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(updated).characters).toEqual([
      "Nyx Firemane",
    ]);

    // An inbound PRI from the ignored character is still persisted and
    // fanned out — hiding is the render's job, history keeps everything.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "you can't hear me" },
    });
    const msg = await client.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(msg).message.bbcode,
    ).toBe("you can't hear me");

    // A live, IGN-seeded session serves its own state to snapshots — no
    // sink-queue race.
    const live = await connectClient();
    await live.hello(token);
    const liveSnapshot = await live.subscribe(identityId);
    expect(liveSnapshot.d.self.ignores).toEqual(["Nyx Firemane"]);

    // The persisted mirror serves snapshots without a live session (the add
    // ack must have reached the DB, not just session state).
    await app.history.flush();
    app.sessions.stop(identityId, "test: mirror path");
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self.ignores).toEqual(["Nyx Firemane"]);

    // Reconnect: the sim replays IGN init (full replacement) and the remove
    // ack must also persist through to the mirror. The init fans out its own
    // ignore.updated — consume it so the remove assertion sees the right one.
    const restarted = await startSession(identityId);
    const reseeded = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(reseeded).characters).toEqual(
      ["Nyx Firemane"],
    );
    expect(restarted.state.isIgnored("Nyx Firemane")).toBe(true);
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "ignore.remove",
        d: { character: "Nyx Firemane" },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    const removed = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(removed).characters).toEqual(
      [],
    );
    await app.history.flush();
    app.sessions.stop(identityId, "test: mirror path");
    const after = await connectClient();
    await after.hello(token);
    const cleared = await after.subscribe(identityId);
    expect(cleared.d.self.ignores).toEqual([]);
  });

  it("a rail reorder fans out as identities.reordered", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    const response = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [identityId] },
    });
    expect(response.statusCode).toBe(204);
    const evt = await client.nextEvent("identities.reordered");
    expect(eventPayload<{ order: string[] }>(evt).order).toEqual([identityId]);
  });

  it("status.set fans out as presence and lands in the next snapshot's self", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "status.set",
        d: { status: "busy", statusmsg: "plotting" },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    // Our own STA converges every subscribed tab via the presence fan-out.
    await client.next(
      (frame): frame is Extract<ServerFrame, { t: "event" }> =>
        frame.t === "event" &&
        frame.d.kind === "presence" &&
        frame.d.d.character === CHARACTER &&
        frame.d.d.status === "busy",
    );

    // A fresh sub reads the status straight from the session (self block).
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self).toMatchObject({
      status: "busy",
      statusmsg: "plotting",
    });

    // Short of online there is nothing to set: the ack must say so.
    app.sessions.stop(identityId);
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "status.set",
        d: { status: "away", statusmsg: "" },
      },
    });
    const refused = await client.nextOfType("ack");
    expect(refused.d.ok).toBe(false);
  });

  it("two browsers racing the same status change earn no ERR on either", async () => {
    // The multi-device bug: auto-away runs in every attached browser, so a
    // second browser holding a stale view re-sent a status the session was
    // already on. F-Chat answered ERR 14 ("wait five seconds between status
    // changes") — session-scoped, so it surfaced in the browser that had sent
    // nothing, whose client-side swallow guard could never cover it.
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const browserA = await connectClient();
    await browserA.hello(token);
    await browserA.subscribe(identityId);
    const browserB = await connectClient();
    await browserB.hello(token);
    await browserB.subscribe(identityId);

    const setStatus = (
      client: typeof browserA,
      id: number,
      status: "away" | "busy" | "online",
      statusmsg: string,
    ) => {
      client.send({
        t: "cmd",
        id,
        d: {
          identityId,
          action: "status.set",
          d: { status, statusmsg },
        },
      });
    };
    const presence = (client: typeof browserA, status: string) =>
      client.next(
        (frame): frame is Extract<ServerFrame, { t: "event" }> =>
          frame.t === "event" &&
          frame.d.kind === "presence" &&
          frame.d.d.character === CHARACTER &&
          frame.d.d.status === status,
      );

    setStatus(browserA, 1, "away", "afk");
    expect((await browserA.nextOfType("ack")).d.ok).toBe(true);
    await presence(browserA, "away");
    await presence(browserB, "away");

    // A's activity restores "online"; B, a beat behind, sends the same
    // restore. The redundant one is acked and re-asserted, never forwarded.
    setStatus(browserA, 2, "online", "");
    expect((await browserA.nextOfType("ack")).d.ok).toBe(true);
    setStatus(browserB, 1, "online", "");
    expect((await browserB.nextOfType("ack")).d.ok).toBe(true);
    await presence(browserA, "online");
    await presence(browserB, "online");

    // A real change inside the gate window: acked now, sent when it opens.
    setStatus(browserB, 2, "busy", "heads down");
    expect((await browserB.nextOfType("ack")).d.ok).toBe(true);
    await presence(browserA, "busy");
    await presence(browserB, "busy");

    // The whole point: no error reached either browser. A deliberate 0 — this
    // is a negative assertion over the already-buffered frames, so it must not
    // inherit FRAME_WAIT_MS and idle for it.
    for (const client of [browserA, browserB]) {
      await expect(client.nextEvent("error", 0)).rejects.toThrow(/timed out/);
    }
  });

  it("resolves DM presence case-insensitively and fans the LIS roster out as presence.bulk", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    // A DM opened with a lowercase name must still find its partner's
    // presence at snapshot time (rows keep the creator's casing).
    await app.history.ensurePmConversation(identityId, "nyx firemane");

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const dm = snapshot.d.dms.find((d) => d.partner === "nyx firemane");
    expect(dm).toMatchObject({ online: true, status: "online" });

    // The already-online roster (LIS) streams after identify; subscribed
    // clients that raced it get the batches as presence.bulk events.
    await inject(session, {
      cmd: "LIS",
      payload: { characters: [["Late Arrival", "None", "busy", "brb"]] },
    });
    const bulk = await client.nextEvent("presence.bulk");
    expect(eventPayload<{ characters: unknown[] }>(bulk).characters).toEqual([
      ["Late Arrival", "None", "busy", "brb"],
    ]);
  });

  it("seeds pm.open ack with the partner's live presence (#229)", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Nyx Firemane is an online NPC in the sim roster; opening a DM with a
    // lowercase spelling must still resolve her presence case-insensitively.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "pm.open",
        d: { character: "nyx firemane" },
      },
    });
    const ack = await client.nextOfType("ack");
    expect(ack.d.ok).toBe(true);
    expect(ack.d.conversation).toMatchObject({
      kind: "pm",
      presence: { online: true, status: "online" },
    });
  });

  it("replays missed messages via catchup, then streams live without duplicates", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    // First client sees one message and remembers its cursor.
    const first = await connectClient();
    await first.hello(token);
    await first.subscribe(identityId);
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m1",
        channel: "Frontpage",
      },
    });
    const seen = await first.nextEvent("message.new");
    const seenEvent = eventPayload<{
      convId: string;
      message: { id: number };
    }>(seen);
    first.close();

    // Two messages land while nobody is attached.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m2",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m3",
        channel: "Frontpage",
      },
    });
    await app.history.flush();

    // Resume from the cursor: catchup must contain exactly m2 and m3.
    const second = await connectClient();
    await second.hello(token, {
      [identityId]: {
        convCursors: { [seenEvent.convId]: seenEvent.message.id },
      },
    });
    await second.subscribe(identityId);
    const catchup = await second.nextOfType("catchup");
    expect(catchup.d.convId).toBe(seenEvent.convId);
    expect(catchup.d.done).toBe(true);
    expect(catchup.d.messages.map((m) => m.bbcode)).toEqual(["m2", "m3"]);

    // Live flow continues after catchup — and m2/m3 never arrive twice.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m4",
        channel: "Frontpage",
      },
    });
    const live = await second.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(live).message.bbcode,
    ).toBe("m4");
    expect(second.bufferedFrames.filter((f) => f.t === "event")).toHaveLength(
      0,
    );
  });

  it("replays the unread tail of conversations the client has no cursor for", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    // A client sees one Frontpage message and detaches with its cursor.
    const first = await connectClient();
    await first.hello(token);
    await first.subscribe(identityId);
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "before detach",
        channel: "Frontpage",
      },
    });
    const seen = eventPayload<{ convId: string; message: { id: number } }>(
      await first.nextEvent("message.new"),
    );
    first.close();

    // While detached: a brand-new PM thread arrives (no client cursor)…
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "new thread" },
    });
    await app.history.flush();
    // …a large conversation appears with more unread than one batch…
    const [seeded] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Seeded",
        title: "Seeded",
      })
      .returning();
    await db.insert(messages).values(
      Array.from({ length: 210 }, (_, i) => ({
        conversationId: seeded!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `bulk ${String(i + 1)}`,
      })),
    );
    // …and a fully-read conversation exists that must not be replayed.
    const [readConv] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "pm",
        partnerCharacter: "Tally Marsh",
        title: "Tally Marsh",
      })
      .returning();
    const [readMsg] = await db
      .insert(messages)
      .values({
        conversationId: readConv!.id,
        senderCharacter: "Tally Marsh",
        kind: "pm",
        bbcode: "already read",
      })
      .returning();
    await db
      .update(conversations)
      .set({ lastReadMessageId: readMsg!.id })
      .where(eq(conversations.id, readConv!.id));

    // Resume with only the Frontpage cursor.
    const second = await connectClient();
    await second.hello(token, {
      [identityId]: {
        convCursors: { [seen.convId]: seen.message.id },
      },
    });
    await second.subscribe(identityId);

    // Frontpage (cursor'd, nothing new): 1 empty done frame. PM tail: 1
    // frame. Seeded backlog: all 210 rows are unread and inside the eager
    // day window (#254), so the whole backlog replays — a full batch (200)
    // then the closing 10-row done frame.
    const frames = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(await second.nextOfType("catchup"));
    }
    const byConv = new Map<string, { bbcode: string }[]>();
    for (const frame of frames) {
      const list = byConv.get(frame.d.convId) ?? [];
      list.push(...frame.d.messages);
      byConv.set(frame.d.convId, list);
    }
    expect(byConv.get(seen.convId)).toEqual([]);
    expect(byConv.has(readConv!.id)).toBe(false);

    const [pmConv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.partnerCharacter, "Nyx Firemane"),
        ),
      );
    expect(byConv.get(pmConv!.id)?.map((m) => m.bbcode)).toEqual([
      "new thread",
    ]);

    // The whole unread backlog replays — it fits the eager window (#254).
    const tail = byConv.get(seeded!.id) ?? [];
    expect(tail).toHaveLength(210);
    expect(tail[0]?.bbcode).toBe("bulk 1");
    expect(tail.at(-1)?.bbcode).toBe("bulk 210");

    // Live still flows and no further catchup frames are pending.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "live again" },
    });
    const live = await second.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(live).message.bbcode,
    ).toBe("live again");
    expect(second.bufferedFrames.filter((f) => f.t === "catchup")).toHaveLength(
      0,
    );
  });

  it("caps the eager no-cursor replay at the day window", async () => {
    const { identityId, token } = await createIdentity();
    // 300 stale rows (older than the eager day window) followed by 250
    // unread recent rows — more than one batch, so the pre-#254 tail alone
    // would cut into the recent backlog, and the stale prefix must not
    // replay eagerly (it stays one history.page away).
    const [conv] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Backlog",
        title: "Backlog",
      })
      .returning();
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(messages).values(
      Array.from({ length: 300 }, (_, i) => ({
        conversationId: conv!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `stale ${String(i + 1)}`,
        createdAt: stale,
      })),
    );
    await db.insert(messages).values(
      Array.from({ length: 250 }, (_, i) => ({
        conversationId: conv!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `recent ${String(i + 1)}`,
      })),
    );

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    // The full recent backlog replays (batch of 200, then the 50-row done
    // frame); nothing stale is eagerly streamed.
    const replayed = [];
    for (;;) {
      const frame = await client.nextOfType("catchup");
      replayed.push(...frame.d.messages);
      if (frame.d.done) {
        break;
      }
    }
    expect(replayed).toHaveLength(250);
    expect(replayed[0]?.bbcode).toBe("recent 1");
    expect(replayed.at(-1)?.bbcode).toBe("recent 250");
    client.close();
  });

  it("pages older history over the gateway until exhaustion", async () => {
    const { identityId, token } = await createIdentity();
    const [conv] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Archive",
        title: "Archive",
      })
      .returning();
    const rows = await db
      .insert(messages)
      .values(
        Array.from({ length: 120 }, (_, i) => ({
          conversationId: conv!.id,
          senderCharacter: "Nyx Firemane",
          kind: "msg" as const,
          bbcode: `old ${String(i + 1)}`,
        })),
      )
      .returning();

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    while (!(await client.nextOfType("catchup")).d.done) {
      // drain the eager replay; paging is what's under test
    }

    // Page down from row 101: 51..100 first, then 1..50 with hasMore=false.
    client.send({
      t: "cmd",
      id: 41,
      d: {
        identityId,
        action: "history.page",
        d: { convId: conv!.id, beforeId: rows[100]!.id, limit: 50 },
      },
    });
    const page1 = await client.nextOfType("ack");
    expect(page1.d.ok).toBe(true);
    expect(page1.d.hasMore).toBe(true);
    expect(page1.d.messages?.map((m) => m.bbcode)).toEqual(
      Array.from({ length: 50 }, (_, i) => `old ${String(i + 51)}`),
    );

    client.send({
      t: "cmd",
      id: 42,
      d: {
        identityId,
        action: "history.page",
        d: { convId: conv!.id, beforeId: rows[50]!.id, limit: 50 },
      },
    });
    const page2 = await client.nextOfType("ack");
    expect(page2.d.hasMore).toBe(false);
    expect(page2.d.messages?.map((m) => m.bbcode)).toEqual(
      Array.from({ length: 50 }, (_, i) => `old ${String(i + 1)}`),
    );

    // A conversation the identity does not own never pages.
    const other = await createIdentity();
    const [foreign] = await db
      .insert(conversations)
      .values({
        identityId: other.identityId,
        kind: "channel",
        channelKey: "Foreign",
        title: "Foreign",
      })
      .returning();
    client.send({
      t: "cmd",
      id: 43,
      d: {
        identityId,
        action: "history.page",
        d: { convId: foreign!.id, beforeId: 10, limit: 50 },
      },
    });
    const denied = await client.nextOfType("ack");
    expect(denied.d.ok).toBe(false);
    expect(denied.d.error).toBe("conversation not found");
    client.close();
  });
});

describe("gateway commands", () => {
  it("connects a session, joins a channel, and sends a message end to end", async () => {
    const { identityId, token } = await createIdentity();

    const client = await connectClient();
    const observer = await connectClient();
    await client.hello(token);
    await observer.hello(token);
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.self.sessionStatus).toBe("offline");
    await observer.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    const connectAck = await client.nextOfType("ack");
    expect(connectAck).toMatchObject({ id: 1, d: { ok: true } });
    // Status events fan out to every subscriber while the session comes up.
    for (;;) {
      const status = await client.nextEvent("session.status");
      if (eventPayload<{ status: string }>(status).status === "online") {
        break;
      }
    }

    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "channel.join", d: { key: "Development" } },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    const conversation = await nextConversationUpdate<{
      id: string;
      channelKey: string | null;
      joined: boolean;
      lastReadMessageId: number | null;
    }>(client, (c) => c.joined);
    expect(conversation).toMatchObject({
      channelKey: "Development",
      joined: true,
    });

    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "msg.send",
        d: { convId: conversation.id, bbcode: "hello from the gateway" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 3,
      d: { ok: true },
    });
    // Both subscribers see our own send, flagged sentByUs.
    for (const c of [client, observer]) {
      const event = await c.nextEvent("message.new");
      expect(eventPayload<{ message: object }>(event).message).toMatchObject({
        senderCharacter: CHARACTER,
        bbcode: "hello from the gateway",
        sentByUs: true,
      });
    }
  });

  it("creates a private room, invites, and admits the invitee (M6 rooms)", async () => {
    const { identityId, token } = await createIdentity();
    // A second identity on the same account receives the invite.
    const [row] = await db
      .select({ accountId: identities.flistAccountId })
      .from(identities)
      .where(eq(identities.id, identityId));
    const [cindral] = await db
      .insert(identities)
      .values({ flistAccountId: row!.accountId, characterName: "Cindral" })
      .returning({ id: identities.id });

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    await client.nextOfType("ack");

    const invitee = await connectClient();
    await invitee.hello(token);
    await invitee.subscribe(cindral!.id);
    invitee.send({
      t: "cmd",
      id: 1,
      d: { identityId: cindral!.id, action: "session.connect" },
    });
    await invitee.nextOfType("ack");

    // CCR: the ack confirms the send; the minted ADH- key arrives through
    // the ordinary join fan-out.
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "channel.create",
        d: { title: "Gateway Attic" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    const room = await nextConversationUpdate<{
      id: string;
      channelKey: string | null;
      title: string;
      joined: boolean;
      lastReadMessageId: number | null;
    }>(client, (c) => c.joined);
    expect(room.channelKey).toMatch(/^ADH-/);
    expect(room.title).toBe("Gateway Attic");
    const key = room.channelKey!;

    // Invite → the other identity's subscribers get the actionable event.
    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "channel.invite",
        d: { key, character: "Cindral" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 3,
      d: { ok: true },
    });
    const invite = await invitee.nextEvent("channel.invite");
    expect(eventPayload<object>(invite)).toEqual({
      sender: CHARACTER,
      title: "Gateway Attic",
      key,
    });

    // The invitee is admitted to the closed room…
    invitee.send({
      t: "cmd",
      id: 2,
      d: { identityId: cindral!.id, action: "channel.join", d: { key } },
    });
    await invitee.nextOfType("ack");
    const joined = await nextConversationUpdate<{
      id: string;
      channelKey: string | null;
      joined: boolean;
      lastReadMessageId: number | null;
    }>(invitee, (c) => c.joined && c.channelKey === key);
    expect(joined.channelKey).toBe(key);

    // …and RST flips the room public without an error.
    client.send({
      t: "cmd",
      id: 4,
      d: {
        identityId,
        action: "channel.status",
        d: { key, status: "public" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 4,
      d: { ok: true },
    });

    app.sessions.stop(cindral!.id);
  });

  it("moderates a room: promote/demote, describe, kick with SystemLine, ban/banlist/unban (M6 op tooling)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Own room (owner role) with Birch as the second member.
    await session.createRoom("Mod Bench");
    const room = await nextConversationUpdate<{
      channelKey: string | null;
      joined: boolean;
    }>(client, (c) => c.joined);
    const key = room.channelKey!;
    await session.inviteToChannel(key, "Birch Rowan");
    const birch = await SimClient.connect(
      sim,
      "birch@example.test",
      "Birch Rowan",
    );
    birch.send({ cmd: "JCH", payload: { channel: key } });
    await birch.waitFor("CDS");
    await client.nextEvent("member.join");

    let cmdId = 0;
    const cmd = (action: string, d: unknown) => {
      cmdId += 1;
      client.send({
        t: "cmd",
        id: cmdId,
        d: { identityId, action, d } as never,
      });
      return client.nextOfType("ack");
    };
    // Content-matched channel.info wait — the join flow already queued
    // earlier channel.info frames (COL/CDS on join), so kind alone is
    // ambiguous here.
    const nextInfo = (
      match: (d: {
        key: string;
        oplist?: string[];
        description?: string;
      }) => boolean,
    ) =>
      client.next(
        (frame): frame is Extract<ServerFrame, { t: "event" }> =>
          frame.t === "event" &&
          (frame.d as { kind: string }).kind === "channel.info" &&
          match(eventPayload(frame as { d: unknown })),
      );

    // Promote → the post-fold oplist fans out as channel.info.
    expect(
      (await cmd("channel.promote", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);
    await nextInfo(
      (d) =>
        d.key === key &&
        JSON.stringify(d.oplist) === JSON.stringify([CHARACTER, "Birch Rowan"]),
    );
    expect(
      (await cmd("channel.demote", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);
    await nextInfo(
      (d) =>
        d.key === key &&
        JSON.stringify(d.oplist) === JSON.stringify([CHARACTER]),
    );

    // Describe → CDS broadcast → channel.info carries the new description.
    expect(
      (await cmd("channel.describe", { key, description: "House rules." })).d
        .ok,
    ).toBe(true);
    await nextInfo((d) => d.key === key && d.description === "House rules.");

    // Kick → member.leave + a persisted SystemLine naming operator+target.
    expect(
      (await cmd("channel.kick", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);
    expect(
      eventPayload<object>(await client.nextEvent("member.leave")),
    ).toEqual({ channelKey: key, character: "Birch Rowan" });
    expect(
      eventPayload<{ message: object }>(await client.nextEvent("message.new"))
        .message,
    ).toMatchObject({
      kind: "sys",
      bbcode: `Birch Rowan was kicked from the channel by ${CHARACTER}.`,
    });

    // Ban (Birch can rejoin after a kick, so ban while absent), list, unban.
    expect(
      (await cmd("channel.ban", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);
    expect(
      eventPayload<{ message: object }>(await client.nextEvent("message.new"))
        .message,
    ).toMatchObject({
      kind: "sys",
      bbcode: `Birch Rowan was banned from the channel by ${CHARACTER}.`,
    });
    expect((await cmd("channel.banlist", { key })).d.ok).toBe(true);
    expect(
      eventPayload<{ message: { bbcode: string } }>(
        await client.nextEvent("message.new"),
      ).message.bbcode,
    ).toBe("Channel bans for Mod Bench: Birch Rowan.");
    // A second ban is refused by the sim — the ERR fans out as an error.
    expect(
      (await cmd("channel.ban", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);
    expect(
      eventPayload<{ number: number }>(await client.nextEvent("error")).number,
    ).toBe(41);
    expect(
      (await cmd("channel.unban", { key, character: "Birch Rowan" })).d.ok,
    ).toBe(true);

    birch.close();
  }, 30_000);

  it("being kicked drops the channel from the session and stops rejoins (M6)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Birch owns a room; Amber gets invited, joins, then is kicked.
    const birch = await SimClient.connect(
      sim,
      "birch@example.test",
      "Birch Rowan",
    );
    birch.send({ cmd: "CCR", payload: { channel: "Birch's Bench" } });
    const jchRaw = await birch.waitFor("JCH");
    const key = (JSON.parse(jchRaw.slice(4)) as { channel: string }).channel;
    birch.send({ cmd: "CIU", payload: { channel: key, character: CHARACTER } });
    await client.nextEvent("channel.invite");
    session.joinChannel(key);
    await nextConversationUpdate<{
      channelKey: string | null;
      joined: boolean;
    }>(client, (c) => c.joined && c.channelKey === key);

    birch.send({ cmd: "CKU", payload: { channel: key, character: CHARACTER } });
    // The conversation un-joins (sink flag) and the SystemLine lands.
    await nextConversationUpdate<{
      channelKey: string | null;
      joined: boolean;
    }>(client, (c) => !c.joined && c.channelKey === key);
    expect(
      eventPayload<{ message: { bbcode: string } }>(
        await client.nextEvent("message.new"),
      ).message.bbcode,
    ).toBe(`${CHARACTER} was kicked from the channel by Birch Rowan.`);
    // The session forgot the channel — no rejoin on reconnect.
    expect(session.state.channels.has(key)).toBe(false);

    birch.close();
  }, 30_000);

  it("sends ads and rolls, tracks room mode, and releases delayed ads as LRP (M6 RP messages)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development"); // mode "both": ads allowed
    // The CDS that joinAndSettle waits on precedes the sink's async persist;
    // flush so the conversation row exists before we query it (matches every
    // other DB-reading test — without it the query races under CI load and
    // `conv` is undefined).
    await app.history.flush();

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Development"),
        ),
      );
    const convId = conv!.id;

    // An ad goes out as LRP and persists with its own kind.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "Seeking a scene partner.", kind: "lrp" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 1,
      d: { ok: true },
    });
    expect(
      eventPayload<{ message: object }>(await client.nextEvent("message.new"))
        .message,
    ).toMatchObject({
      kind: "lrp",
      senderCharacter: CHARACTER,
      bbcode: "Seeking a scene partner.",
      sentByUs: true,
    });

    // A roll comes back as the sim-computed RLL, persisted as our own.
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "channel.roll",
        d: { key: "Development", dice: "2d6" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    const roll = eventPayload<{ message: { kind: string; bbcode: string } }>(
      await client.nextEvent("message.new"),
    ).message;
    expect(roll).toMatchObject({ kind: "rll", sentByUs: true });
    expect(roll.bbcode).toContain(`[b]${CHARACTER}[/b] rolls 2d6:`);

    // Ads never go to PM conversations.
    client.send({
      t: "cmd",
      id: 3,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const pmAck = await client.nextOfType("ack");
    client.send({
      t: "cmd",
      id: 4,
      d: {
        identityId,
        action: "msg.send",
        d: { convId: pmAck.d.conversation!.id, bbcode: "ad?", kind: "lrp" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 4,
      d: { ok: false, error: "ads can only go to channels" },
    });

    // RMO fans out as channel.info so the composer can re-gate live.
    await inject(session, {
      cmd: "RMO",
      payload: { channel: "Development", mode: "chat" },
    });
    expect(
      eventPayload<{ key: string; mode: string }>(
        await client.nextEvent("channel.info"),
      ),
    ).toEqual({ key: "Development", mode: "chat" });

    // A due outbox row with kind "lrp" (a delayed ad) releases as an LRP
    // frame and persists as an lrp message, not a msg. (The RMO above was
    // injected at our session only — the sim's room stayed "both", so the
    // ad is accepted on the wire.)
    await db.insert(outboxMessages).values({
      identityId,
      conversationId: convId,
      markdown: "delayed ad",
      bbcode: "delayed ad",
      kind: "lrp",
      releaseAt: new Date(Date.now() - 1000),
    });
    const released = await client.nextEvent("message.new", FRAME_WAIT_MS);
    expect(eventPayload<{ message: object }>(released).message).toMatchObject({
      kind: "lrp",
      bbcode: "delayed ad",
      sentByUs: true,
    });
  }, 30_000);

  it("surfaces BRO broadcasts and RTB website events (M6 step 9)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    await inject(session, {
      cmd: "BRO",
      payload: { message: "The server restarts in 30 minutes." },
    });
    expect(
      eventPayload<{ message: string }>(await client.nextEvent("sys")),
    ).toEqual({
      message: "Server broadcast: The server restarts in 30 minutes.",
    });

    await inject(session, {
      cmd: "RTB",
      payload: {
        type: "note",
        sender: "Nyx Firemane",
        subject: "About that scene",
        id: 42,
      },
    });
    expect(eventPayload<object>(await client.nextEvent("rtb"))).toEqual({
      type: "note",
      character: "Nyx Firemane",
      subject: "About that scene",
    });

    await inject(session, {
      cmd: "RTB",
      payload: { type: "friendrequest", name: "Tally Marsh" },
    });
    expect(eventPayload<object>(await client.nextEvent("rtb"))).toEqual({
      type: "friendrequest",
      character: "Tally Marsh",
    });
  });

  it("refetches and fans out the friend lists when the other party accepts (#364)", async () => {
    const FRIEND = "Thistle Reed";
    const FRIEND_ACCOUNT = "thistlereed@example.test";
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    const auth = { authorization: `Bearer ${token}` };

    const sent = await app.inject({
      method: "POST",
      url: `/api/identities/${identityId}/social/request`,
      headers: auth,
      payload: { action: "send", character: FRIEND },
    });
    expect(sent.statusCode).toBe(200);
    // The request id rides the next read (the send dropped the cache), which
    // fans its own lists out — drained here so the assertion below can only
    // match the refresh the accept triggers.
    const listed = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/social`,
      headers: auth,
    });
    const outgoing = listed
      .json<{ outgoing: { id: number; name: string }[] }>()
      .outgoing.find((row) => row.name === FRIEND);
    expect(outgoing).toBeDefined();
    await client.nextEvent("social.updated");

    // The other party accepts on the website; F-List bridges that to our
    // chat socket as RTB friendadd, and nothing else tells us about it.
    const accepted = await fetch(`${sim.httpUrl}/json/api/request-accept.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        account: FRIEND_ACCOUNT,
        ticket: sim.issueTicketFor(FRIEND_ACCOUNT),
        request_id: String(outgoing!.id),
      }),
    });
    expect(await accepted.json()).toEqual({ error: "" });

    expect(eventPayload<object>(await client.nextEvent("rtb"))).toEqual({
      type: "friendadd",
      character: FRIEND,
    });
    // The point of the fix: the sidebar's Friends section is driven by these
    // lists, so without the refetch + fan-out the new friend would sit in
    // Direct Messages until someone hit the manual ↻.
    const refreshed = eventPayload<{
      social: { friends: { name: string }[]; outgoing: unknown[] };
    }>(await client.nextEvent("social.updated", FRAME_WAIT_MS));
    expect(refreshed.social.friends.map((row) => row.name)).toContain(FRIEND);
    expect(refreshed.social.outgoing).toEqual([]);
  });

  it("opens a PM conversation and advances the read cursor across clients", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);

    const client = await connectClient();
    const other = await connectClient();
    await client.hello(token);
    await other.hello(token);
    await client.subscribe(identityId);
    await other.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const ack = await client.nextOfType("ack");
    expect(ack.d.ok).toBe(true);
    const conversation = ack.d.conversation!;
    expect(conversation).toMatchObject({
      kind: "pm",
      partnerCharacter: "Nyx Firemane",
    });

    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "read me" },
    });
    const event = await client.nextEvent("message.new");
    const message = eventPayload<{ message: { id: number } }>(event).message;

    client.send({
      t: "ack",
      d: { identityId, convId: conversation.id, messageId: message.id },
    });
    // The other tab's unread counter converges via conversation.updated.
    const converged = await nextConversationUpdate(
      other,
      (c) => c.id === conversation.id && c.lastReadMessageId !== null,
    );
    expect(converged.lastReadMessageId).toBe(message.id);
  });

  interface ConvRow {
    id: string;
    kind: string;
    joined: boolean;
    lastReadMessageId: number | null;
  }

  it("closes a PM conversation and reopens it on the next inbound message", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);

    const client = await connectClient();
    const other = await connectClient();
    await client.hello(token);
    await other.hello(token);
    await client.subscribe(identityId);
    await other.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const opened = (await client.nextOfType("ack")).d.conversation!;
    expect(opened.joined).toBe(true);

    // pm.close drops the "window open" flag: the ack carries the row and
    // the other tab converges through conversation.updated.
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "pm.close", d: { convId: opened.id } },
    });
    const closeAck = await client.nextOfType("ack");
    expect(closeAck.d.ok).toBe(true);
    expect(closeAck.d.conversation).toMatchObject({
      id: opened.id,
      joined: false,
    });
    const closed = await nextConversationUpdate<ConvRow>(
      other,
      (c) => c.id === opened.id && !c.joined,
    );
    expect(closed.kind).toBe("pm");

    // Closed DMs leave the snapshot; the row and its history survive.
    const resub = await connectClient();
    await resub.hello(token);
    const snapshot = await resub.subscribe(identityId);
    expect(
      snapshot.d.dms.some((dm: { convId: string }) => dm.convId === opened.id),
    ).toBe(false);

    // An inbound PRI reopens the window before the message lands.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "still there?" },
    });
    const reopened = await nextConversationUpdate<ConvRow>(
      other,
      (c) => c.id === opened.id && c.joined,
    );
    expect(reopened.kind).toBe("pm");

    // A pm.close for a channel conversation (or unknown id) refuses.
    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "pm.close",
        d: { convId: "00000000-0000-7000-8000-000000000000" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 3,
      d: { ok: false, error: "Conversation not found" },
    });
  });

  it("cuts a live connection when its auth session is revoked", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    const ready = await client.hello(token);
    await client.subscribe(identityId);

    // Logout/expiry: the auth session rows disappear. The next frame's
    // re-verification must cut the socket — REST 401s immediately and the
    // gateway must not be the survivor.
    await db
      .delete(authSessions)
      .where(eq(authSessions.userId, ready.d.userId));
    client.send({ t: "sub", d: { identityId } });
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.unauthorized);
  });

  it("does not resurrect a deleted identity from the ownership cache", async () => {
    const { identityId, token } = await createIdentity();

    const client = await connectClient();
    await client.hello(token); // ready caches ownership of the identity

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(204);

    // A stale cache hit here would log the character into F-Chat as an
    // orphaned session no client could ever see or stop.
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 1,
      d: { ok: false, error: "identity not found" },
    });
    expect(app.sessions.get(identityId)).toBeUndefined();
  });

  it("disconnects a connection that floods frames", async () => {
    const token = await registerUser();
    const client = await connectClient();
    await client.hello(token);
    for (let i = 0; i <= MAX_FRAMES_PER_MINUTE; i += 1) {
      client.send({ t: "ping" });
    }
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.rateLimited);
  });

  it("denies access to another user's identity", async () => {
    const { identityId } = await createIdentity();
    await startSession(identityId);
    const strangerToken = await registerUser();

    const stranger = await connectClient();
    await stranger.hello(strangerToken);
    stranger.send({ t: "sub", d: { identityId } });
    const error = await stranger.nextOfType("error");
    expect(error.d.message).toBe("identity not found");

    stranger.send({
      t: "cmd",
      id: 9,
      d: { identityId, action: "channel.join", d: { key: "Development" } },
    });
    expect(await stranger.nextOfType("ack")).toMatchObject({
      id: 9,
      d: { ok: false, error: "identity not found" },
    });
  });

  it("ad-library PUT fans out ads.updated to subscribed devices (M10)", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    const put = await app.inject({
      method: "PUT",
      url: `/api/identities/${identityId}/ads`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ads: [{ content: "hello scene", tags: ["fantasy"], disabled: false }],
      },
    });
    expect(put.statusCode).toBe(200);
    const event = eventPayload<{
      ads: { content: string; tags: string[]; disabled: boolean }[];
    }>(await client.nextEvent("ads.updated"));
    expect(event.ads).toHaveLength(1);
    expect(event.ads[0]).toMatchObject({
      content: "hello scene",
      tags: ["fantasy"],
      disabled: false,
    });
  });

  it("ads.cooldowns reports per-channel waits; immediate bypasses the delay (M10)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development"); // mode "both": ads allowed
    await app.history.flush();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Development"),
        ),
      );
    const convId = conv!.id;

    // Fresh session: the channel is clear to post.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "ads.cooldowns",
        d: { keys: ["Development"] },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 1,
      d: { ok: true },
    });
    expect(
      eventPayload<{ waits: Record<string, number> }>(
        await client.nextEvent("ads.cooldowns"),
      ).waits,
    ).toEqual({ Development: 0 });

    // Raise the pace VAR live (the suite's sim zeroes lfrp_flood so other
    // tests can post freely): the gate reads the live VAR, so the next ad
    // opens a real window and the wait becomes deterministic.
    await inject(session, {
      cmd: "VAR",
      payload: { variable: "lfrp_flood", value: 600 },
    });

    // Posting an ad starts the per-channel window; the next query reports
    // a remaining wait derived from the live lfrp_flood VAR.
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "cooldown probe ad", kind: "lrp" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    await client.nextEvent("message.new");
    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "ads.cooldowns",
        d: { keys: ["Development"] },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 3,
      d: { ok: true },
    });
    const after = eventPayload<{ waits: Record<string, number> }>(
      await client.nextEvent("ads.cooldowns"),
    ).waits;
    expect(after["Development"]).toBeGreaterThan(0);

    // A second immediate ad inside the window REFUSES with the friendly
    // cooldown copy (M10 step 10: the ERR-56-class refusal surface) —
    // never a silent queue that would ghost-post minutes later.
    client.send({
      t: "cmd",
      id: 30,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "too soon", kind: "lrp" },
      },
    });
    const refused = await client.nextOfType("ack");
    expect(refused.id).toBe(30);
    expect(refused.d.ok).toBe(false);
    expect(refused.d.error).toContain("next available in");

    // With a send delay set, `immediate: true` (the post flow) skips the
    // outbox and puts the message on the wire now.
    client.send({
      t: "cmd",
      id: 4,
      d: { identityId, action: "prefs.set", d: { sendDelaySeconds: 60 } },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 4,
      d: { ok: true },
    });
    client.send({
      t: "cmd",
      id: 5,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "right now", immediate: true },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 5,
      d: { ok: true },
    });
    expect(
      eventPayload<{ message: object }>(await client.nextEvent("message.new"))
        .message,
    ).toMatchObject({ kind: "msg", bbcode: "right now", sentByUs: true });
  }, 30_000);

  it("character.search round-trips FKS results and refusals (M10)", async () => {
    sim.setCharacterProfile("Nyx Firemane", { kinks: { "523": "fave" } });
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // A kink Nyx faves: the reply carries the bare name (never ourselves).
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "character.search",
        d: { kinks: ["523"] },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 1,
      d: { ok: true },
    });
    const hit = eventPayload<{
      ok: boolean;
      characters?: string[];
      kinks?: string[];
    }>(await client.nextEvent("character.search", FRAME_WAIT_MS));
    expect(hit.ok).toBe(true);
    expect(hit.characters).toContain("Nyx Firemane");
    expect(hit.characters).not.toContain(CHARACTER);
    expect(hit.kinks).toEqual(["523"]);

    // A kink nobody has: the server's ERR 18 comes back as a refusal.
    // (The session's own FKS gate paces this second search past the sim's
    // 5s window, so the refusal is the no-results one, not the flood.)
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "character.search",
        d: { kinks: ["999999"] },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    const miss = eventPayload<{ ok: boolean; code?: number }>(
      await client.nextEvent("character.search", INTEGRATION_SLOW_MS),
    );
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe(18);
  }, 40_000);

  it("delayed send parks in the outbox, recalls, and releases due rows", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // A long delay: everything below must stay parked until recalled.
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "prefs.set", d: { sendDelaySeconds: 120 } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(
      eventPayload<{ sendDelaySeconds: number }>(
        await client.nextEvent("prefs.updated"),
      ),
    ).toEqual({ sendDelaySeconds: 120, prefs: PREFS_DEFAULTS });

    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const opened = await client.nextOfType("ack");
    const convId = (opened.d as { conversation: { id: string } }).conversation
      .id;

    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "[b]later[/b]", markdown: "**later**" },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    const scheduled = await client.nextEvent("outbox.updated");
    const items = eventPayload<{
      items: { id: string; convId: string; markdown: string; state: string }[];
    }>(scheduled).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      convId,
      markdown: "**later**",
      state: "scheduled",
    });

    // A late subscriber's snapshot carries the delay and the pending row —
    // pending sends are visible on every device, not just the sender's tab.
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self.sendDelaySeconds).toBe(120);
    expect(snapshot.d.self.outbox).toHaveLength(1);

    // ArrowUp recall: the typed Markdown comes back and the row dies.
    client.send({
      t: "cmd",
      id: 4,
      d: { identityId, action: "outbox.recall", d: { outboxId: items[0]!.id } },
    });
    expect((await client.nextOfType("ack")).d).toMatchObject({
      ok: true,
      markdown: "**later**",
    });
    expect(
      eventPayload<{ items: unknown[] }>(
        await client.nextEvent("outbox.updated"),
      ).items,
    ).toEqual([]);
    client.send({
      t: "cmd",
      id: 5,
      d: { identityId, action: "outbox.recall", d: { outboxId: items[0]!.id } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(false);

    // A due row already in the table (the restart case) releases via the
    // poll and round-trips as a persisted own message.
    await db.insert(outboxMessages).values({
      identityId,
      conversationId: convId,
      markdown: "overdue",
      bbcode: "overdue",
      releaseAt: new Date(Date.now() - 1000),
    });
    const released = await client.nextEvent("message.new", FRAME_WAIT_MS);
    expect(
      eventPayload<{ message: { bbcode: string; sentByUs: boolean } }>(released)
        .message,
    ).toMatchObject({ bbcode: "overdue", sentByUs: true });
    expect(
      eventPayload<{ items: unknown[] }>(
        await client.nextEvent("outbox.updated"),
      ).items,
    ).toEqual([]);
  }, 30_000);

  it("prefs.set patches merge per key and survive in the snapshot", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Patch one prefs key: everything else resolves to its default.
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "prefs.set", d: { prefs: { accent: "moss" } } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(
      eventPayload<{ sendDelaySeconds: number; prefs: UserPrefs }>(
        await client.nextEvent("prefs.updated"),
      ),
    ).toEqual({
      sendDelaySeconds: 0,
      prefs: { ...PREFS_DEFAULTS, accent: "moss" },
    });

    // A later sendDelay-only patch must not clobber the stored accent.
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "prefs.set", d: { sendDelaySeconds: 45 } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(
      eventPayload<{ sendDelaySeconds: number; prefs: UserPrefs }>(
        await client.nextEvent("prefs.updated"),
      ),
    ).toEqual({
      sendDelaySeconds: 45,
      prefs: { ...PREFS_DEFAULTS, accent: "moss" },
    });

    // A fresh device reads the same resolved state from its snapshot —
    // no live session required (prefs are per user, not per F-Chat socket).
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self.prefs).toEqual({
      ...PREFS_DEFAULTS,
      accent: "moss",
    });
    expect(snapshot.d.self.sendDelaySeconds).toBe(45);
  });

  it("outbox: releases in order, claims beat recalls, failures say why", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const opened = await client.nextOfType("ack");
    const convId = (opened.d as { conversation: { id: string } }).conversation
      .id;

    // Two overdue rows: they must hit the wire in release order (the
    // milestone-4.md ordering requirement the step-8 suite had dropped).
    await db.insert(outboxMessages).values([
      {
        identityId,
        conversationId: convId,
        markdown: "first",
        bbcode: "first",
        releaseAt: new Date(Date.now() - 2000),
      },
      {
        identityId,
        conversationId: convId,
        markdown: "second",
        bbcode: "second",
        releaseAt: new Date(Date.now() - 1000),
      },
    ]);
    const a = await client.nextEvent("message.new", FRAME_WAIT_MS);
    const b = await client.nextEvent("message.new", FRAME_WAIT_MS);
    expect(
      eventPayload<{ message: { bbcode: string } }>(a).message.bbcode,
    ).toBe("first");
    expect(
      eventPayload<{ message: { bbcode: string } }>(b).message.bbcode,
    ).toBe("second");

    // A row the worker has claimed ("releasing") is no longer recallable —
    // that window is exactly where a recall would double-post (audit).
    const [claimed] = await db
      .insert(outboxMessages)
      .values({
        identityId,
        conversationId: convId,
        markdown: "in flight",
        bbcode: "in flight",
        releaseAt: new Date(Date.now() + 60_000),
        state: "releasing",
      })
      .returning();
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "outbox.recall", d: { outboxId: claimed!.id } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(false);
    await db.delete(outboxMessages).where(eq(outboxMessages.id, claimed!.id));

    // A release with no live session fails visibly, with the reason.
    app.sessions.stop(identityId, "test: dead session");
    await db.insert(outboxMessages).values({
      identityId,
      conversationId: convId,
      markdown: "doomed",
      bbcode: "doomed",
      releaseAt: new Date(Date.now() - 1000),
    });
    for (;;) {
      const update = await client.nextEvent("outbox.updated", FRAME_WAIT_MS);
      const items = eventPayload<{
        items: { state: string; failureReason?: string }[];
      }>(update).items;
      const failed = items.find((item) => item.state === "failed");
      if (failed) {
        expect(failed.failureReason).toMatch(/no live session/);
        break;
      }
    }
  }, 45_000);
});

// ── M7 exposure hardening ─────────────────────────────────────────────────────

describe("gateway hardening", () => {
  it("refuses a browser Origin outside the allow-list, admits the app's own", async () => {
    // Hostile page: Origin present but unknown → policy close before hello.
    const evil = new WebSocket(gatewayUrl, {
      headers: { origin: "https://evil.example" },
    });
    const closed = await new Promise<{ code: number }>((resolve, reject) => {
      evil.on("close", (code) => {
        resolve({ code });
      });
      evil.on("error", reject);
    });
    expect(closed.code).toBe(GATEWAY_CLOSE.badOrigin);

    // The app's own origin (APP_BASE_URL default) handshakes normally.
    const token = await registerUser();
    const friendly = new WebSocket(gatewayUrl, {
      headers: { origin: "http://localhost:3000" },
    });
    await new Promise<void>((resolve, reject) => {
      friendly.once("open", () => {
        resolve();
      });
      friendly.once("error", reject);
    });
    friendly.send(
      JSON.stringify({
        t: "hello",
        d: { token, protocolVersion: PROTOCOL_VERSION },
      }),
    );
    const ready = await new Promise<{ t: string }>((resolve) => {
      friendly.once("message", (data: WebSocket.RawData) => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData decode
        resolve(JSON.parse(data.toString()) as { t: string });
      });
    });
    expect(ready.t).toBe("ready");
    friendly.close();
  });

  it("disconnects a client whose send backlog overruns the buffer cap", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // A client that stops reading: the kernel buffers absorb a few hundred KB
    // before ws reports any backlog at all, so the fan-out has to push well
    // past the cap before `bufferedAmount` moves. Channel descriptions are the
    // cheapest big event — translated to channel.info, no persistence.
    client.goSilent();
    const filler = "x".repeat(256 * 1024);
    let pushed = 0;
    // 128 × 256 KiB caps the loop well above any autotuned socket buffer;
    // it exits the moment the cap is overrun, which is long before that.
    while (app.gatewayHub.subscriberCount(identityId) > 0 && pushed < 128) {
      // A slow consumer is not a dead one — it keeps sending. Without this
      // the heartbeat would terminate the socket first (#407) and the close
      // code under test would never be reached.
      client.send({ t: "ping" });
      await inject(session, {
        cmd: "CDS",
        payload: { channel: "Development", description: filler },
      });
      pushed += 1;
    }
    // Dropped from the fan-out server-side — the close frame itself is stuck
    // behind the backlog until the client reads again.
    expect(app.gatewayHub.subscriberCount(identityId)).toBe(0);
    expect(pushed).toBeGreaterThan(0);

    client.wakeUp();
    const closed = await client.waitForClose();
    expect(closed.code).toBe(GATEWAY_CLOSE.slowConsumer);
    expect(closed.reason).toBe("send buffer overflow");
  }, 30_000);

  it("closes the connection once a user exhausts the hello budget", async () => {
    const token = await registerUser(); // no identities — hellos are cheap
    // Budget is 20/min per user; the 21st authenticated hello is refused.
    for (let i = 0; i < 20; i += 1) {
      const client = await connectClient();
      await client.hello(token);
      client.close();
    }
    const overBudget = await connectClient();
    overBudget.send({
      t: "hello",
      d: { token, protocolVersion: PROTOCOL_VERSION },
    });
    const closed = await overBudget.waitForClose();
    expect(closed.code).toBe(GATEWAY_CLOSE.rateLimited);
    expect(closed.reason).toContain("hello rate limit");
  }, 30_000);
});

describe("alert staff (SFC)", () => {
  it("user.report puts the SFC on the wire and the sim records it", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "user.report",
        d: {
          character: "Nyx Firemane",
          report:
            "Current Tab/Channel: Frontpage | Reporting User: Nyx Firemane | test complaint",
        },
      },
    });
    const ack = await client.nextOfType("ack");
    expect(ack.d).toMatchObject({ ok: true });
    expect(sim.staffReports.at(-1)).toMatchObject({
      character: "Nyx Firemane",
      report: expect.stringContaining("test complaint") as string,
    });
    // The live server answers with a SYS — the sim mirrors it, and it
    // reaches the client as a notice-bearing event.
    const sys = await client.nextEvent("sys");
    expect(eventPayload<{ message: string }>(sys).message).toContain(
      "The moderators have been alerted.",
    );
  });
});

// TPN dedup/pacing is covered against a dedicated sim in
// fchat-session.test.ts; what's untested above this line is the gateway
// plumbing — a browser's cmd reaching the wire, and an inbound TPN reaching
// every browser attached to the same identity.
describe("typing telemetry (TPN)", () => {
  it("puts a browser's typing.set on the wire and fans an inbound TPN to every attached browser", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const browserA = await connectClient();
    await browserA.hello(token);
    await browserA.subscribe(identityId);
    const browserB = await connectClient();
    await browserB.hello(token);
    await browserB.subscribe(identityId);
    const birch = await SimClient.connect(
      sim,
      "birch@example.test",
      "Birch Rowan",
    );

    // Outbound: the cmd reaches the partner as a TPN naming us.
    browserA.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "typing.set",
        d: { character: "Birch Rowan", status: "typing" },
      },
    });
    expect((await browserA.nextOfType("ack")).d).toMatchObject({ ok: true });
    expect(parseServerCommand(await birch.waitFor("TPN"))).toEqual({
      cmd: "TPN",
      payload: { character: CHARACTER, status: "typing" },
    });

    // Inbound: the partner's own TPN reaches BOTH attached browsers — a
    // second device must not miss the status the first one sees.
    birch.send({
      cmd: "TPN",
      payload: { character: CHARACTER, status: "paused" },
    });
    for (const browser of [browserA, browserB]) {
      expect(
        eventPayload<{ character: string; status: string }>(
          await browser.nextEvent("typing"),
        ),
      ).toEqual({ character: "Birch Rowan", status: "paused" });
    }

    birch.close();
  });

  it("refuses typing.set for a disconnected session", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // No session started: the telemetry has nowhere to go, and the browser
    // is told rather than left believing the partner saw it.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "typing.set",
        d: { character: "Birch Rowan", status: "typing" },
      },
    });
    expect((await client.nextOfType("ack")).d).toMatchObject({
      ok: false,
      error: "session not connected",
    });
  });
});

// ── The refusal side (#561) ──────────────────────────────────────────────────
//
// Everything above walks the happy path. This block walks the other axis: the
// frames the gateway must reject, and the acks that say so. A refusal that
// quietly stops being sent is a button that does nothing, forever, with no
// error anywhere — and the pre-`hello` cases are the auth ordering itself.

describe("gateway refusals", () => {
  /** Awaits the ack for one specific cmd id (the acks below interleave). */
  function ackFor(client: TestClient, id: number) {
    return client.next(
      (frame): frame is Extract<ServerFrame, { t: "ack" }> & { id: number } =>
        frame.t === "ack" && frame.id === id,
    );
  }

  it("drops a pre-hello frame that is not JSON, and only errors on one after hello", async () => {
    const early = await connectClient();
    early.sendRaw("{ not json at all");
    const closed = await early.waitForClose();
    expect(closed.code).toBe(GATEWAY_CLOSE.badRequest);
    expect(closed.reason).toBe("frame is not valid JSON");

    // Once identified there is a session worth preserving: the same garbage
    // earns an error frame, not a disconnect.
    const { token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    client.sendRaw("{ not json at all");
    expect((await client.nextOfType("error")).d.message).toBe(
      "frame is not valid JSON",
    );
    client.send({ t: "ping" });
    await client.nextOfType("pong");
  });

  it("closes a well-formed cmd that arrives before hello", async () => {
    const { identityId } = await createIdentity();
    const client = await connectClient();
    // Schema-valid, owner-valid — and still refused, because identity comes
    // before everything.
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.disconnect" },
    });
    const closed = await client.waitForClose();
    expect(closed.code).toBe(GATEWAY_CLOSE.unauthorized);
    expect(closed.reason).toBe("hello first");
  });

  it("refuses a second hello without disturbing the first", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    client.send({
      t: "hello",
      d: { token, protocolVersion: PROTOCOL_VERSION },
    });
    expect((await client.nextOfType("error")).d.message).toBe(
      "already identified",
    );
    // The connection keeps the identity it already had.
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.identityId).toBe(identityId);
  });

  it("answers ok:false for a conversation id that is not this identity's", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // A well-formed UUID nobody owns — conversation ids are guessable, so
    // ownership is checked on every path that takes one.
    const stranger = randomUUID();
    const cases: {
      action: string;
      d: Record<string, unknown>;
      error: string;
    }[] = [
      {
        action: "conv.pin",
        d: { convId: stranger, pinned: true },
        error: "conversation not found",
      },
      {
        action: "msg.send",
        d: { convId: stranger, bbcode: "hello?" },
        error: "conversation not found",
      },
      {
        action: "history.page",
        d: { convId: stranger, beforeId: 1, limit: 10 },
        error: "conversation not found",
      },
      {
        action: "pm.close",
        d: { convId: stranger },
        error: "Conversation not found",
      },
    ];
    let id = 100;
    for (const testCase of cases) {
      id += 1;
      client.send({
        t: "cmd",
        id,
        d: { identityId, action: testCase.action, d: testCase.d },
      } as ClientFrame);
      expect((await ackFor(client, id)).d, testCase.action).toEqual({
        ok: false,
        error: testCase.error,
      });
    }
  });

  it("refuses an over-long delayed send at compose time, not at release time", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");
    // The join echo and the conversation row are separate steps: poll for
    // the row rather than assuming the persist already landed (it has not,
    // reliably, under the pglite driver).
    let convId = "";
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.identityId, identityId),
            eq(conversations.channelKey, "Frontpage"),
          ),
        );
      expect(row).toBeDefined();
      convId = row!.id;
    }, FRAME_WAIT_MS);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "prefs.set", d: { sendDelaySeconds: 120 } },
    });
    expect((await ackFor(client, 1)).d.ok).toBe(true);

    // Deferring the VAR check to release time would fail the send silently,
    // minutes after the user could still do anything about it.
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "a".repeat(5000) },
      },
    });
    expect((await ackFor(client, 2)).d).toEqual({
      ok: false,
      // chat_max, read from the live VARs — never a hardcoded number.
      error: `Message exceeds the server's ${String(session.state.vars.chat_max)}-byte limit`,
    });
    expect(
      await db
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.identityId, identityId)),
    ).toEqual([]);

    // The same text under the limit does park, so the refusal above is the
    // length check and not the delayed path being broken.
    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "msg.send",
        d: { convId, bbcode: "short enough" },
      },
    });
    expect((await ackFor(client, 3)).d.ok).toBe(true);
  });

  it("refuses pm.open past the per-identity conversation ceiling", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // The ceiling itself (and the count that reaches it) belongs to the sink
    // and is tested there; what is dark here is the gateway's handling —
    // this one error class must become an ack instead of propagating as an
    // internal error, and every other failure must still propagate.
    const spy = vi
      .spyOn(app.history, "ensurePmConversation")
      .mockRejectedValue(new ConversationLimitError());
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "pm.open", d: { character: "One Too Many" } },
    });
    expect((await ackFor(client, 1)).d).toEqual({
      ok: false,
      error: "Too many conversations for this identity",
    });

    spy.mockRejectedValue(new Error("the database fell over"));
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "pm.open", d: { character: "Another" } },
    });
    // Anything else is a genuine fault: it reaches the cmd handler's catch,
    // which says so rather than dressing it up as a user-facing refusal.
    expect((await ackFor(client, 2)).d).toEqual({
      ok: false,
      error: "internal error",
    });
    spy.mockRestore();
  });

  it("routes every campaign command and turns a CampaignError into plain language", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    // A room that allows ads: the campaign refuses a chat-only channel.
    await joinAndSettle(session, "Development");
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    let id = 0;
    const campaignCmd = async (action: string, d: Record<string, unknown>) => {
      id += 1;
      client.send({
        t: "cmd",
        id,
        d: { identityId, action, d },
      } as ClientFrame);
      return (await ackFor(client, id)).d;
    };

    // stop / renew / drop before there is anything to act on.
    for (const action of ["campaign.stop", "campaign.renew"]) {
      expect(await campaignCmd(action, {}), action).toEqual({
        ok: false,
        error: "There's no campaign for this character",
      });
    }
    expect(await campaignCmd("campaign.drop", { key: "Development" })).toEqual({
      ok: false,
      error: "There's no campaign for this character",
    });

    // A start with nothing to rotate.
    expect(
      await campaignCmd("campaign.start", {
        tags: ["winter"],
        channels: ["Development"],
      }),
    ).toEqual({
      ok: false,
      error: "None of your enabled ads carry those tags — nothing would post",
    });

    await db.insert(ads).values({
      identityId,
      content: "warm fire, cold night",
      tags: ["winter"],
      sortOrder: 0,
    });
    // A start naming a room the character is not in.
    expect(
      await campaignCmd("campaign.start", {
        tags: ["winter"],
        channels: ["Ghost Room"],
      }),
    ).toEqual({
      ok: false,
      error:
        "You're not in one of those channels any more — reopen the setup and pick again",
    });

    expect(
      await campaignCmd("campaign.start", {
        tags: ["winter"],
        channels: ["Development"],
      }),
    ).toEqual({ ok: true });
    expect(
      eventPayload<{ campaign: { channels: { key: string }[] } }>(
        await client.nextEvent("campaign.updated"),
      ).campaign.channels.map((c) => c.key),
    ).toEqual(["Development"]);

    // Replacing a running campaign is an explicit confirmation, and a drop
    // only takes a channel the campaign actually has.
    expect(
      await campaignCmd("campaign.start", {
        tags: ["winter"],
        channels: ["Development"],
      }),
    ).toEqual({
      ok: false,
      error:
        "A campaign is already running — replacing it needs an explicit confirmation",
    });
    expect(await campaignCmd("campaign.drop", { key: "Ghost Room" })).toEqual({
      ok: false,
      error: "That channel isn't part of the campaign",
    });
    expect(await campaignCmd("campaign.renew", {})).toEqual({ ok: true });
    expect(await campaignCmd("campaign.stop", {})).toEqual({ ok: true });
  });

  it("turns a refused session send into an ok:false ack rather than silence", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    const key = "Frontpage";
    const character = "Birch Rowan";
    // Each entry arms one session method to reject and then drives the cmd
    // that is supposed to carry that rejection back to the browser. Stubbing
    // is the point: these are wire refusals (not an op, room gone, gate
    // full) that the sim cannot be made to produce on demand.
    const cases: {
      action: string;
      d: Record<string, unknown>;
      arm: (error: Error) => { mockRestore: () => void };
    }[] = [
      {
        action: "channel.create",
        d: { title: "Moss Parlour" },
        arm: (e) => vi.spyOn(session, "createRoom").mockRejectedValue(e),
      },
      {
        action: "channel.invite",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "inviteToChannel").mockRejectedValue(e),
      },
      {
        action: "channel.status",
        d: { key, status: "public" },
        arm: (e) => vi.spyOn(session, "setRoomStatus").mockRejectedValue(e),
      },
      {
        action: "status.set",
        d: { status: "away", statusmsg: "brb" },
        arm: (e) => vi.spyOn(session, "setStatus").mockRejectedValue(e),
      },
      {
        action: "ignore.add",
        d: { character },
        arm: (e) => vi.spyOn(session, "ignore").mockRejectedValue(e),
      },
      {
        action: "ignore.remove",
        d: { character },
        arm: (e) => vi.spyOn(session, "unignore").mockRejectedValue(e),
      },
      {
        action: "channel.roll",
        d: { key, dice: "1d10" },
        arm: (e) => vi.spyOn(session, "rollDice").mockRejectedValue(e),
      },
      {
        action: "user.report",
        d: { character, report: "spam" },
        arm: (e) => vi.spyOn(session, "reportToStaff").mockRejectedValue(e),
      },
      {
        action: "channel.kick",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "kickFromChannel").mockRejectedValue(e),
      },
      {
        action: "channel.ban",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "banFromChannel").mockRejectedValue(e),
      },
      {
        action: "channel.unban",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "unbanFromChannel").mockRejectedValue(e),
      },
      {
        action: "channel.timeout",
        d: { key, character, minutes: 5 },
        arm: (e) =>
          vi.spyOn(session, "timeoutFromChannel").mockRejectedValue(e),
      },
      {
        action: "channel.promote",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "promoteOp").mockRejectedValue(e),
      },
      {
        action: "channel.demote",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "demoteOp").mockRejectedValue(e),
      },
      {
        action: "channel.owner",
        d: { key, character },
        arm: (e) => vi.spyOn(session, "setRoomOwner").mockRejectedValue(e),
      },
      {
        action: "channel.describe",
        d: { key, description: "moss, mostly" },
        arm: (e) =>
          vi.spyOn(session, "setRoomDescription").mockRejectedValue(e),
      },
      {
        action: "channel.mode",
        d: { key, mode: "chat" },
        arm: (e) => vi.spyOn(session, "setRoomMode").mockRejectedValue(e),
      },
      {
        action: "channel.banlist",
        d: { key },
        arm: (e) => vi.spyOn(session, "requestBanlist").mockRejectedValue(e),
      },
    ];

    let id = 200;
    for (const testCase of cases) {
      const spy = testCase.arm(new Error(`${testCase.action} was refused`));
      id += 1;
      client.send({
        t: "cmd",
        id,
        d: { identityId, action: testCase.action, d: testCase.d },
      } as ClientFrame);
      expect((await ackFor(client, id)).d, testCase.action).toEqual({
        ok: false,
        error: `${testCase.action} was refused`,
      });
      spy.mockRestore();
    }
  });

  it("delivers a failed character search as an outcome, not as a dropped ack", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    const spy = vi
      .spyOn(session, "searchCharacters")
      .mockRejectedValue(new Error("the search went nowhere"));
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "character.search",
        d: { kinks: ["523"] },
      },
    });
    // The cmd is acked as accepted — the pace gate can hold the frame for
    // seconds — and the outcome arrives as its own event.
    expect((await ackFor(client, 1)).d.ok).toBe(true);
    expect(
      eventPayload<{ ok: boolean; code: number; message: string }>(
        await client.nextEvent("character.search"),
      ),
    ).toEqual({ ok: false, code: 0, message: "the search went nowhere" });
    spy.mockRestore();
  });
});
