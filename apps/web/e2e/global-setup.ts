// Boots the real backend for the E2E suite: Postgres in a container, the
// fchat-sim F-Chat stand-in, and the built server as a child process (it
// migrates on boot). Returns the teardown that stops all three.

import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { FchatSim } from "@emberchat/fchat-sim";
import { API_PORT, PREVIEW_PORT, WEB_PORT } from "../playwright.config.js";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/main.js", import.meta.url),
);

// The bouncer's pino stream, teed to a file: a spec that hangs on a locator
// is usually waiting on the server, and that side of the story is invisible
// in Playwright traces. CI uploads this next to playwright-report/.
const SERVER_LOG = fileURLToPath(new URL("../e2e-server.log", import.meta.url));

async function waitForHealthy(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited with code ${String(child.exitCode)} during startup`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await delay(500);
  }
  throw new Error(`server never became healthy at ${url}`);
}

/**
 * A throwaway VAPID keypair, so the stack boots with push CONFIGURED and the
 * preferences toggle exists to be driven (push.spec). Generated per run rather
 * than committed: a private key in the repo is a private key in the repo, even
 * a meaningless one, and the shape is the whole requirement — base64url of a
 * P-256 point (65 bytes) and its scalar (32), which is exactly what
 * `web-push generate-vapid-keys` prints and what `config.ts` validates.
 *
 * Nothing is ever sent with it. Real delivery needs a real push service, which
 * is precisely the part of this feature no CI can exercise (web-push.md §5).
 */
function vapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  // The private JWK carries both halves; the public key VAPID puts on the wire
  // is the uncompressed point, 0x04 then the two coordinates.
  const jwk = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  return {
    publicKey: point.toString("base64url"),
    privateKey: Buffer.from(jwk.d ?? "", "base64url").toString("base64url"),
  };
}

/** Resolves true when nothing is listening on 127.0.0.1:`port`. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Fail fast, and legibly, if the API port is already taken. A bouncer left
 * behind by an interrupted run otherwise surfaces as an EADDRINUSE buried in
 * the piped child output and then a health wait that times out two minutes
 * later — or, worse, as every spec talking to the STALE server and failing in
 * ways that have nothing to do with the code. (The two Vite ports are
 * Playwright's own webServers, started before this hook and already bound by
 * the time it runs; `--strictPort` gives them the same fast failure.)
 */
async function assertApiPortFree(): Promise<void> {
  if (await portFree(API_PORT)) {
    return;
  }
  throw new Error(
    `E2E API port ${String(API_PORT)} is already in use.\n` +
      "Most likely a bouncer from an interrupted run is still alive: stop it " +
      "(lsof -ti tcp:" +
      String(API_PORT) +
      " | xargs kill).\n" +
      "Another working copy is not the cause — since #617 each copy derives " +
      "its own ports from its path. A second run of THIS copy is, and needs " +
      "an explicit range: E2E_API_PORT / E2E_WEB_PORT.",
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertApiPortFree();

  let sim: FchatSim | undefined;
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
  let server: ChildProcess | undefined;

  const teardown = async () => {
    if (server) {
      const child = server;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    await container?.stop();
    await sim?.stop();
  };

  try {
    // A tiny flood window lets the chat spec seed history quickly; the
    // server's rate gate follows the live VAR, so it speeds up equally.
    sim = new FchatSim({ serverVars: { msg_flood: 0.05 } });
    await sim.start();
    // Profile fixtures for the M8 Images/Guestbook tabs (chat.spec): the
    // images ride inside character-data (their static.f-list.net URLs are
    // intercepted in the browser); 12 guestbook posts exercise the 0-based
    // 10-per-page pagination, one with an owner reply.
    sim.setCharacterProfile("Nyx Firemane", {
      images: [
        { id: 9001, extension: "png", width: 400, height: 300 },
        { id: 9002, extension: "jpg", description: "A portrait" },
        { id: 9003, extension: "png" },
      ],
      // M10 fks E2E: Nyx (always-online NPC) is the first search hit for
      // "Campfire Stories" (id 501, in the sim's canned vocabulary).
      kinks: { "501": "fave" },
    });
    // Kolvarr is offline until m10.spec connects him — the saved-search
    // rerun then finds one NEW character and the badge reads "1 new".
    sim.setCharacterProfile("Kolvarr", { kinks: { "501": "yes" } });
    // DM mini-profile sidebar (#170, dm-sidebar.spec): the partner needs a
    // profile so the sidebar's note and compatibility summary load, and the
    // viewer's own character needs one so the match pill (not the "connect
    // your own character" prompt) renders.
    sim.setCharacterProfile("Bramble Fen", { kinks: { "501": "yes" } });
    sim.setCharacterProfile("Thistle Vane", { kinks: { "501": "fave" } });
    sim.setGuestbook(
      "Nyx Firemane",
      Array.from({ length: 12 }, (_, index) => ({
        from: index === 0 ? "Old Greywhisker" : `Visitor ${String(index)}`,
        message:
          index === 0
            ? "Wonderful [b]company[/b] around the fire."
            : `Guestbook entry number ${String(index)}.`,
        postedAt: 1_752_000_000 - index * 86_400,
        ...(index === 0 ? { reply: "Likewise, old friend." } : {}),
      })),
    );
    // Specs drive a second character straight against the sim (the "other
    // side" of the relay); Playwright forwards process.env to workers.
    process.env["FCHAT_SIM_WS_URL"] = sim.wsUrl;
    process.env["FCHAT_SIM_TICKET_URL"] = sim.ticketUrl;
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    // Specs provision app users through the admin CLI (registration is
    // disabled — the E2E stack runs the production shape); the CLI needs
    // the database directly.
    process.env["E2E_DATABASE_URL"] = container.getConnectionUri();
    const vapid = vapidKeys();
    server = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(API_PORT),
        DATABASE_URL: container.getConnectionUri(),
        AUTH_SECRET: "e2e-test-secret-0123456789abcdefghijklmn",
        AUTH_RATE_LIMIT_MAX: "1000",
        FCHAT_URL: sim.wsUrl,
        FLIST_API_URL: sim.httpUrl,
        EICON_INDEX_BASE_URL: sim.httpUrl,
        // The sim is local — the 1 req/s policy budget only matters against
        // the real F-List, and serializing on it starves parallel specs.
        FLIST_API_MIN_INTERVAL_MS: "0",
        // Likewise the 10s reconnect floor: it binds against F-List's server,
        // not our sim. A genuine drop under runner contention would otherwise
        // park the character offline past every spec's connect budget.
        FCHAT_RECONNECT_FLOOR_MS: "300",
        FCHAT_RECONNECT_CAP_MS: "2000",
        // The whole parallel suite arrives from one loopback IP; the
        // production per-IP backstop would 429 innocent specs.
        RATE_LIMIT_MAX: "100000",
        // Browser pages originate from the Vite dev server — or from `vite
        // preview` serving the built bundle, which the caret projects use.
        // The gateway's WS origin check must know both (Vite proxies /api
        // same-origin, but the Origin header still names the page's origin).
        CORS_ORIGIN: [
          `http://127.0.0.1:${String(WEB_PORT)}`,
          `http://127.0.0.1:${String(PREVIEW_PORT)}`,
        ].join(","),
        // M11 campaign E2E: shrunken rotation timings so a real posted ad
        // lands inside the test budget — legal only against the sim (the
        // config guard refuses these against real F-Chat).
        CAMPAIGN_TICK_MS: "250",
        CAMPAIGN_BASE_INTERVAL_MS: "2000",
        CAMPAIGN_START_JITTER_MS: "0",
        CAMPAIGN_INTERVAL_JITTER_MS: "0",
        CAMPAIGN_SPACING_MS: "250",
        // No phone-home from CI runs.
        UPDATE_CHECK_ENABLED: "false",
        // Web Push configured, so `/api/push/vapid-key` reports enabled and
        // the preferences toggle renders (push.spec). All three or none.
        PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
        PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
        PUSH_VAPID_SUBJECT: "mailto:e2e@example.test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverLog = createWriteStream(SERVER_LOG);
    server.stdout?.pipe(serverLog);
    server.stderr?.pipe(process.stderr);
    await waitForHealthy(
      `http://127.0.0.1:${String(API_PORT)}/healthz`,
      server,
    );
  } catch (error) {
    // Partial-failure hygiene: a leaked server child would keep the API port
    // bound and fail every subsequent run's health wait.
    await teardown();
    throw error;
  }

  return teardown;
}
