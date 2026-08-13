// Integration tests against real Postgres (testcontainers). One container +
// one app instance for the suite; the rate-limit test builds its own app so
// its counters stay isolated.

import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import {
  makeTestDb,
  TEST_DB_DRIVER,
  type TestDb,
} from "../../test-support/db.js";
import { appUsers, authSessions, userPreferences } from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_MS,
  LOADED_RUNNER_MS,
} from "../../test-support/budgets.js";
import { MAX_SESSIONS_PER_USER, ROTATION_GRACE_MS } from "./routes.js";
import { SessionJanitor } from "./session-janitor.js";
import { hashRefreshToken, REFRESH_TOKEN_TTL_MS } from "./tokens.js";

// Container-backed, and argon2 hashing runs on every register/login. The CLI
// tests below need more still — see LOADED_RUNNER_MS.
vi.setConfig({ testTimeout: INTEGRATION_MS });

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...testDb.env,
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    REGISTRATION_ENABLED: "true",
    ...overrides,
  });
}

beforeAll(async () => {
  testDb = await makeTestDb();
  db = testDb.db;
  app = await buildApp({
    config: testConfig(),
    db,
    logger: false,
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface TokenPair {
  user: { id: string; email: string; username: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
}

let counter = 0;
async function registerUser(): Promise<TokenPair> {
  counter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `user${counter}@example.test`,
      username: `user${counter}`,
      password: "correct horse battery staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<TokenPair>();
}

describe("register", () => {
  it("creates a user and returns a session", async () => {
    const body = await registerUser();
    expect(body.user).toMatchObject({
      email: `user${counter}@example.test`,
      username: `user${counter}`,
    });
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("stores an argon2id hash, never the password", async () => {
    const body = await registerUser();
    const [row] = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.id, body.user.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain("correct horse");
  });

  it("rejects duplicate emails with 409", async () => {
    const body = await registerUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: body.user.email,
        username: "someoneelse",
        password: "password123",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects invalid bodies with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", username: "x", password: "short" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("login", () => {
  it("returns a session for valid credentials (email is case-insensitive)", async () => {
    const { user } = await registerUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: user.email.toUpperCase(),
        password: "correct horse battery staple",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<TokenPair>().user.id).toBe(user.id);
  });

  it("rejects a wrong password and an unknown email identically", async () => {
    const { user } = await registerUser();
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "wrong password" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.test", password: "wrong password" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });
});

describe("access tokens", () => {
  it("grants /me with a valid token and rejects missing/garbage tokens", async () => {
    const { user, accessToken } = await registerUser();
    const ok = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ user: { id: string } }>().user.id).toBe(user.id);

    expect(
      (await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode,
    ).toBe(401);
    const garbage = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(garbage.statusCode).toBe(401);
  });
});

describe("refresh rotation", () => {
  it("rotates the refresh token; the pre-rotation one redeems within the grace window", async () => {
    const { refreshToken } = await registerUser();
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json<{ accessToken: string; refreshToken: string }>();
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // The lost-response recovery: a client that never received `rotated`
    // still holds the old token — within the grace it redeems again.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(200);
    const recovered = replay.json<{ refreshToken: string }>();
    expect(recovered.refreshToken).not.toBe(refreshToken);
    expect(recovered.refreshToken).not.toBe(rotated.refreshToken);

    // The grace redemption re-rotated: the orphaned token from `first` is
    // dead, the recovered one is the session's live token.
    const orphan = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(orphan.statusCode).toBe(401);
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken: recovered.refreshToken },
    });
    expect(second.statusCode).toBe(200);
  });

  it("closes the grace window: an old token past ROTATION_GRACE_MS is dead", async () => {
    const { user, refreshToken } = await registerUser();
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    await db
      .update(authSessions)
      .set({
        rotatedAt: new Date(Date.now() - ROTATION_GRACE_MS - 1000),
      })
      .where(eq(authSessions.userId, user.id));
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects unknown refresh tokens", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken: "definitely-not-issued" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("logout", () => {
  it("kills the session so its refresh token stops working", async () => {
    const { refreshToken } = await registerUser();
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken },
    });
    expect(logout.statusCode).toBe(204);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it("revokes outstanding access tokens immediately, not after their TTL", async () => {
    const { accessToken, refreshToken } = await registerUser();
    const before = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken },
    });

    // The JWT is still within its 15-minute TTL, but its session is gone.
    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("honours a pre-rotation token — the tab that signed out may hold one", async () => {
    const { accessToken, refreshToken } = await registerUser();
    // One tab refreshes; the tab the user clicks Log out in still holds the
    // token from before the rotation (the same case /refresh's grace window
    // exists for).
    const rotated = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(rotated.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    // The row is really gone: neither token refreshes, and the outstanding
    // access token dies with it — which is what takes the session's push
    // subscriptions (they cascade off auth_sessions) down with it.
    const stale = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(stale.statusCode).toBe(401);
    const current = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: {
        refreshToken: rotated.json<{ refreshToken: string }>().refreshToken,
      },
    });
    expect(current.statusCode).toBe(401);
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("login lockout", () => {
  it("locks the account after repeated failures — even for the right password", async () => {
    const attempt = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "lockout-target@example.test", password },
      });
    // The email doesn't even exist — unknown accounts lock identically, so
    // the lockout can't be used to probe which emails are registered.
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("wrong password")).statusCode).toBe(401);
    }
    const locked = await attempt("wrong password");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("session hygiene", () => {
  it("caps auth sessions per user, evicting the oldest on login", async () => {
    const { user } = await registerUser(); // one session exists now
    // Backfill far past the cap, oldest first, straight into the table.
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i += 1) {
      await db.insert(authSessions).values({
        userId: user.id,
        refreshTokenHash: `backfill-${String(counter)}-${String(i)}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(base + i * 1000),
      });
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: user.email,
        password: "correct horse battery staple",
      },
    });
    expect(login.statusCode).toBe(200);
    const rows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, user.id));
    expect(rows.length).toBe(MAX_SESSIONS_PER_USER);
    // The just-issued session survived the eviction.
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: {
        refreshToken: login.json<{ refreshToken: string }>().refreshToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
  });

  it("a refresh token lives 30 days and every refresh slides the window", async () => {
    // The user's decision in place of the never-built per-login "keep me
    // signed in" server toggle: one fixed, generous life, re-extended on use,
    // so a daily-used device never gets logged out and an abandoned one goes
    // cold on its own.
    const { user, refreshToken } = await registerUser();
    const issued = async () => {
      const [row] = await db
        .select({ expiresAt: authSessions.expiresAt })
        .from(authSessions)
        .where(eq(authSessions.userId, user.id));
      return row!.expiresAt.getTime();
    };
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(REFRESH_TOKEN_TTL_MS).toBe(thirtyDays);
    expect(await issued()).toBeCloseTo(Date.now() + thirtyDays, -4);

    // Wind the row back to a day from expiry, then refresh: the replacement
    // must start its own full window, not inherit the remaining day.
    const nearExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db
      .update(authSessions)
      .set({ expiresAt: nearExpiry })
      .where(eq(authSessions.refreshTokenHash, hashRefreshToken(refreshToken)));
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    expect(await issued()).toBeCloseTo(Date.now() + thirtyDays, -4);
  });

  it("the janitor sweeps expired sessions and leaves live ones", async () => {
    const { user, refreshToken } = await registerUser();
    await db.insert(authSessions).values({
      userId: user.id,
      refreshTokenHash: `expired-${String(counter)}`,
      expiresAt: new Date(Date.now() - 1000),
    });
    const janitor = new SessionJanitor({
      db,
      logger: { info: () => undefined, error: () => undefined },
    });
    expect(await janitor.sweep()).toBeGreaterThanOrEqual(1);
    // The live session still refreshes; the expired row is gone.
    const rows = await db
      .select({ hash: authSessions.refreshTokenHash })
      .from(authSessions)
      .where(eq(authSessions.userId, user.id));
    expect(rows.some((r) => r.hash.startsWith("expired-"))).toBe(false);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
  });
});

describe("version & meta surface", () => {
  it("healthz carries the version; /api/meta requires auth and reports status", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    // Liveness only — no version disclosure to unauthenticated scanners.
    expect(health.json()).toEqual({ status: "ok" });

    const anonymous = await app.inject({ method: "GET", url: "/api/meta" });
    expect(anonymous.statusCode).toBe(401);

    const { accessToken } = await registerUser();
    const meta = await app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meta.statusCode).toBe(200);
    // No check has run (tests never phone home) — no update announced.
    expect(meta.json()).toEqual({
      version: "0.0.0",
      updateAvailable: false,
      releasesUrl: "https://github.com/kara-eressea/emberchat/releases",
    });
  });
});

describe("security headers", () => {
  it("sends helmet headers; CSP only in SPA-serving mode", async () => {
    // API-only mode (the shared app): headers yes, CSP no.
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBeDefined();
    expect(health.headers["content-security-policy"]).toBeUndefined();

    // SPA-serving mode: the CSP arrives and allows F-List's static host.
    const dist = await mkdtemp(path.join(tmpdir(), "emberchat-csp-"));
    await writeFile(
      path.join(dist, "index.html"),
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    const spa = await buildApp({
      config: testConfig({ WEB_DIST: dist }),
      db,
      logger: false,
    });
    try {
      const page = await spa.inject({ method: "GET", url: "/" });
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data: https://static.f-list.net");
      expect(csp).toContain("frame-ancestors 'none'");

      // The served document carries no inline script at all since the
      // runtime-branding bootstrap went away with the rename knob (#556), so
      // `script-src` is exactly `'self'` — no hash to keep in step with a
      // script, and nothing an injected `<script>` could be mistaken for.
      // A mismatch here was always invisible at runtime (the browser blocks
      // the script and nothing says so), which is why it is asserted at all.
      const inline = [
        ...page.body.matchAll(
          /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g,
        ),
      ].map(([, script]) => script ?? "");
      expect(inline).toEqual([]);
      const scriptSrc = /(?:^|;)\s*script-src ([^;]*)/.exec(csp)?.[1] ?? "";
      expect(scriptSrc.trim()).toBe("'self'");
    } finally {
      await spa.close();
      await rm(dist, { recursive: true, force: true });
    }
  });

  it("widens img-src/media-src to a user-added preview host after refresh (#342)", async () => {
    const dist = await mkdtemp(path.join(tmpdir(), "emberchat-csp-user-"));
    await writeFile(
      path.join(dist, "index.html"),
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    const spa = await buildApp({
      config: testConfig({ WEB_DIST: dist }),
      db,
      logger: false,
    });
    try {
      const HOST = "wimg.rule34.xxx";

      // Before the user allowlists it, the browser would refuse the fetch.
      const before = String(
        (await spa.inject({ method: "GET", url: "/" })).headers[
          "content-security-policy"
        ],
      );
      expect(before).not.toContain(HOST);

      // A user adds the host to their allowlist (the shape prefs.set persists),
      // alongside a hostile entry that must never reach the header.
      const { user } = await registerUser();
      await db.insert(userPreferences).values({
        userId: user.id,
        prefs: { imagePreviewHosts: [HOST, "evil.example;script-src *"] },
      });

      // The prefs.set hook calls registry.refresh(); the header follows without
      // a restart because helmet evaluates the extra-hosts source per response.
      await spa.imagePreviewHosts.refresh();

      const after = String(
        (await spa.inject({ method: "GET", url: "/" })).headers[
          "content-security-policy"
        ],
      );
      const imgSrc = after
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("img-src "));
      const mediaSrc = after
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("media-src "));
      expect(imgSrc).toContain(`https://${HOST}`);
      expect(mediaSrc).toContain(`https://${HOST}`);
      // …and its subdomains, which is what makes an unpredictable per-CDN
      // subdomain loadable rather than needing its own allowlist entry (#593).
      // The client's matcher has always treated an entry as a suffix; before
      // this the header did not, so the browser refused what the client
      // resolved.
      expect(imgSrc).toContain(`https://*.${HOST}`);
      expect(mediaSrc).toContain(`https://*.${HOST}`);
      // The malformed entry was sanitized out — no directive injection.
      expect(after).not.toContain("script-src *");
      expect(imgSrc).not.toContain("evil.example");
    } finally {
      await spa.close();
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("registration gate", () => {
  it("404s when REGISTRATION_ENABLED is off (the default)", async () => {
    const gated = await buildApp({
      config: testConfig({
        REGISTRATION_ENABLED: "false",
      }),
      db,
      logger: false,
    });
    try {
      const response = await gated.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: "gated@example.test",
          username: "gated",
          password: "correct horse battery staple",
        },
      });
      expect(response.statusCode).toBe(404);
      // Login remains reachable on the same instance.
      const login = await gated.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "gated@example.test", password: "whatever else" },
      });
      expect(login.statusCode).toBe(401);
    } finally {
      await gated.close();
    }
  });

  it("defaults REGISTRATION_ENABLED to false", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://x",
        AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      }).REGISTRATION_ENABLED,
    ).toBe(false);
  });
});

describe("admin CLI", () => {
  /**
   * The suite's driver-conditional block. These two tests are the only ones
   * that put a *second process* on the test database, and pglite cannot have
   * one: it is a whole Postgres inside this process, with no shared buffers
   * and no data-directory lock, so the CLI child and this process see
   * different databases (test-support/db.ts). It fails silently, too — the
   * child exits 0, prints "Created user", and the row is simply not there.
   *
   * Production is not exposed to this: the desktop client is the only place a
   * CLI child meets pglite, and its first run stops the server before the CLI
   * starts (apps/desktop/src/provisioning.ts, tested there). So the pglite
   * leg skips these rather than weakening what they assert on Postgres.
   */
  const itNeedsASecondProcess = it.skipIf(TEST_DB_DRIVER === "pglite");
  const CLI = fileURLToPath(
    new URL("../../../dist/cli/admin.js", import.meta.url),
  );
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [CLI, ...args],
          {
            env: { ...process.env, ...testDb.env },
          },
          (error, stdout, stderr) => {
            resolve({
              code: error && "code" in error ? (error.code as number) : 0,
              stdout,
              stderr,
            });
          },
        );
      },
    );

  itNeedsASecondProcess(
    "create-user then reset-password round-trips through login",
    { timeout: LOADED_RUNNER_MS },
    async () => {
      const created = await run([
        "create-user",
        "--email",
        "cli-admin@example.test",
        "--username",
        "cli-admin",
        "--password",
        "first password here",
      ]);
      expect(created.stderr).toBe("");
      expect(created.code).toBe(0);
      expect(created.stdout).toContain("Created user cli-admin");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "cli-admin@example.test",
          password: "first password here",
        },
      });
      expect(login.statusCode).toBe(200);

      const reset = await run([
        "reset-password",
        "--email",
        "cli-admin@example.test",
        "--password",
        "second password here",
      ]);
      expect(reset.code).toBe(0);
      expect(reset.stdout).toContain("Password reset for cli-admin");

      const stale = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "cli-admin@example.test",
          password: "first password here",
        },
      });
      expect(stale.statusCode).toBe(401);
      const fresh = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "cli-admin@example.test",
          password: "second password here",
        },
      });
      expect(fresh.statusCode).toBe(200);
    },
  );

  itNeedsASecondProcess(
    "refuses duplicates and unknown emails with a nonzero exit",
    // Two CLI child processes with argon2 hashing — same loaded-CI-runner
    // budget as the round-trip test above.
    { timeout: LOADED_RUNNER_MS },
    async () => {
      const dupe = await run([
        "create-user",
        "--email",
        "cli-admin@example.test",
        "--username",
        "cli-admin",
        "--password",
        "first password here",
      ]);
      expect(dupe.code).toBe(1);
      expect(dupe.stderr).toContain("already taken");

      const missing = await run([
        "reset-password",
        "--email",
        "nobody-here@example.test",
        "--password",
        "does not matter 1",
      ]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("No user");
    },
  );
});

describe("rate limiting", () => {
  it("returns 429 after the per-route auth limit", async () => {
    const limited = await buildApp({
      config: testConfig({
        AUTH_RATE_LIMIT_MAX: "3",
      }),
      db,
      logger: false,
    });
    try {
      const attempt = () =>
        limited.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "nobody@example.test", password: "wrong password" },
        });
      for (let i = 0; i < 3; i += 1) {
        const allowed = await attempt();
        expect(allowed.statusCode).toBe(401);
        // Clients can pace themselves from the standard headers.
        expect(Number(allowed.headers["x-ratelimit-limit"])).toBe(3);
        expect(allowed.headers["x-ratelimit-remaining"]).toBeDefined();
      }
      const limited429 = await attempt();
      expect(limited429.statusCode).toBe(429);
      expect(Number(limited429.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});
