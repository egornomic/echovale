import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { type AuthOptions, AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function authApp(publicOrigin?: string, options?: AuthOptions) {
  const database = new AppDatabase(":memory:");
  const authService = new AuthService(database.auth, 20, options);
  const extractionQueue = new ExtractionQueue(database.extractions, 1, 1_000);
  const refreshService = new FeedRefreshService(database.feeds, 1, 1_000);
  const app = await createApp({
    database,
    authService,
    extractionQueue,
    refreshService,
    publicOrigin,
  });
  cleanups.push(
    () => app.close(),
    () => Promise.all([refreshService.stop(), extractionQueue.stop()]).then(() => undefined),
    () => database.close(),
  );
  return { app, database };
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = value?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected a session cookie");
  return cookie;
}

describe("hosted account authentication", () => {
  it("uses opaque public account IDs and atomically enforces the account cap", async () => {
    const { app, database } = await authApp(undefined, { maxAccounts: 2 });
    const attempts = await Promise.all(
      ["first-reader", "second-reader", "third-reader"].map((username) =>
        app.inject({
          method: "POST",
          url: "/api/auth/register",
          payload: { username, password: "reader-password" },
        }),
      ),
    );

    expect(attempts.map(({ statusCode }) => statusCode).sort()).toEqual([201, 201, 403]);
    expect(
      database.connection.prepare("SELECT COUNT(*) FROM users WHERE enabled = 1").pluck().get(),
    ).toBe(2);
    for (const response of attempts.filter(({ statusCode }) => statusCode === 201)) {
      expect(response.json()).toEqual({
        user: {
          id: expect.stringMatching(/^[a-f0-9]{32}$/),
          username: expect.any(String),
          hasPassword: true,
        },
      });
      expect(response.body).not.toMatch(/"id":\d/);
      const bootstrap = await app.inject({
        method: "GET",
        url: "/api/bootstrap",
        headers: { cookie: cookieFrom(response.headers["set-cookie"]) },
      });
      expect(bootstrap.json().feeds).toMatchObject([
        {
          title: "feedfold releases",
          feedUrl: "https://github.com/egornomic/feedfold/releases.atom",
          paused: false,
        },
      ]);
    }
  });

  it("keeps the default feed removed when an account signs in again", async () => {
    const { app } = await authApp();
    const payload = { username: "reader", password: "reader-password" };
    const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload });
    const headers = { cookie: cookieFrom(registered.headers["set-cookie"]) };
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers });
    const [feed] = bootstrap.json().feeds;
    expect(
      (await app.inject({ method: "DELETE", url: `/api/feeds/${feed.id}`, headers })).statusCode,
    ).toBe(204);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload });
    const afterLogin = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: cookieFrom(login.headers["set-cookie"]) },
    });
    expect(afterLogin.json().feeds).toEqual([]);
  });

  it("does not exceed the account cap across database connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-auth-cap-"));
    const databasePath = join(directory, "feedfold.db");
    const firstDatabase = new AppDatabase(databasePath);
    const secondDatabase = new AppDatabase(databasePath);
    try {
      const first = new AuthService(firstDatabase.auth, 20, { maxAccounts: 1 });
      const second = new AuthService(secondDatabase.auth, 20, { maxAccounts: 1 });
      const registrations = await Promise.all([
        first.register("first-reader", "reader-password"),
        second.register("second-reader", "reader-password"),
      ]);
      expect(registrations.filter(Boolean)).toHaveLength(1);
      expect(
        firstDatabase.connection
          .prepare("SELECT COUNT(*) FROM users WHERE enabled = 1")
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists keyed login cooldowns across authentication service instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-auth-limit-"));
    const databasePath = join(directory, "feedfold.db");
    const firstDatabase = new AppDatabase(databasePath);
    const secondDatabase = new AppDatabase(databasePath);
    const limits: AuthOptions = {
      rateLimits: {
        loginPerIp: { attempts: 20, windowMs: 60_000 },
        loginPerAccount: { attempts: 2, windowMs: 60_000 },
      },
    };
    try {
      const first = new AuthService(firstDatabase.auth, 20, limits);
      expect(first.consumeLoginAttempt("192.0.2.15", "Reader")).toBeNull();
      expect(first.consumeLoginAttempt("192.0.2.15", "reader")).toBeNull();

      const afterRestart = new AuthService(secondDatabase.auth, 20, limits);
      expect(afterRestart.consumeLoginAttempt("198.51.100.8", "READER")).toBeGreaterThan(0);
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns an accurate retry window when a login cooldown is active", async () => {
    const { app } = await authApp(undefined, {
      rateLimits: {
        loginPerIp: { attempts: 20, windowMs: 60_000 },
        loginPerAccount: { attempts: 2, windowMs: 60_000 },
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "reader", password: "wrong-password" },
          })
        ).statusCode,
      ).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "reader", password: "wrong-password" },
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("requires recent authentication and resumes a sensitive operation", async () => {
    const { app, database } = await authApp("https://reader.example.test");
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    const cookie = cookieFrom(registration.headers["set-cookie"]);
    database.connection
      .prepare("UPDATE sessions SET recent_auth_at = ?")
      .run("2000-01-01T00:00:00.000Z");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/passkeys/options",
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json()).toMatchObject({
      code: "RECENT_AUTH_REQUIRED",
      operationId: expect.any(String),
    });
    const operationId = blocked.json<{ operationId: string }>().operationId;
    const blockedAiCredential = await app.inject({
      method: "PUT",
      url: "/api/ai/providers/openai/key",
      headers: { cookie },
      payload: { apiKey: "sk-test" },
    });
    expect(blockedAiCredential.statusCode).toBe(428);
    expect(blockedAiCredential.json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/step-up/password",
          headers: { cookie },
          payload: { operationId, password: "wrong-password" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/step-up/password",
          headers: { cookie },
          payload: { operationId, password: "reader-password" },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/passkeys/options",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("allows removal of the final login method after valid recent authentication", async () => {
    const { app } = await authApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    const cookie = cookieFrom(registration.headers["set-cookie"]);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/auth/password",
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).json(),
    ).toMatchObject({ user: { username: "reader", hasPassword: false } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "reader", password: "reader-password" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("allows first-run setup, stores an Argon2id hash, and closes account creation", async () => {
    const { app, database } = await authApp("https://reader.example.test");

    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({
      registrationAvailable: true,
      passkeysAvailable: true,
    });
    const weakPassword = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "too-short" },
    });
    expect(weakPassword.statusCode).toBe(400);

    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.headers["set-cookie"]).toContain("HttpOnly");
    expect(registration.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(registration.headers["set-cookie"]).toContain("Secure");
    expect(registration.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    const cookie = cookieFrom(registration.headers["set-cookie"]);
    const passwordHash = database.connection
      .prepare("SELECT password_hash FROM users WHERE username = 'reader'")
      .pluck()
      .get();
    expect(passwordHash).toEqual(expect.stringMatching(/^\$argon2id\$/));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/passkeys/options",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/passkeys/options",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({
      registrationAvailable: false,
      passkeysAvailable: true,
    });
    const secondAccount = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "partner", password: "partner-password" },
    });
    expect(secondAccount.statusCode).toBe(403);
    expect(secondAccount.json()).toEqual({ error: "Account creation is closed on this server." });
  });

  it("changes the password, keeps the current session, and ends every other session", async () => {
    const { app } = await authApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    const firstSession = cookieFrom(registration.headers["set-cookie"]);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "reader", password: "reader-password" },
    });
    const currentSession = cookieFrom(login.headers["set-cookie"]);

    const changed = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie: currentSession },
      payload: { password: "new-reader-password" },
    });
    expect(changed.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: firstSession },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: currentSession },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "reader", password: "reader-password" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "reader", password: "new-reader-password" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("deletes an authenticated account, its credentials, sessions, and private state", async () => {
    const { app, database } = await authApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    const currentSession = cookieFrom(registration.headers["set-cookie"]);
    const userId = Number(
      database.connection.prepare("SELECT id FROM users WHERE username = 'reader'").pluck().get(),
    );
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "reader", password: "reader-password" },
    });
    const otherSession = cookieFrom(otherLogin.headers["set-cookie"]);
    const timestamp = new Date().toISOString();

    database.connection
      .prepare(
        `INSERT INTO feed_sources (feed_url, source_kind, title, created_at, updated_at)
         VALUES ('https://example.com/feed.xml', 'published', 'Example', ?, ?)`,
      )
      .run(timestamp, timestamp);
    const sourceId = Number(
      database.connection
        .prepare("SELECT id FROM feed_sources WHERE feed_url = 'https://example.com/feed.xml'")
        .pluck()
        .get(),
    );
    database.connection
      .prepare(
        `INSERT INTO folders (user_id, parent_id, name, created_at, updated_at)
         VALUES (?, NULL, 'Saved', ?, ?)`,
      )
      .run(userId, timestamp, timestamp);
    const folderId = Number(database.connection.prepare("SELECT id FROM folders").pluck().get());
    database.connection
      .prepare(
        `INSERT INTO feeds (user_id, source_id, folder_id, title, created_at, updated_at)
         VALUES (?, ?, ?, 'Example', ?, ?)`,
      )
      .run(userId, sourceId, folderId, timestamp, timestamp);
    const feedId = Number(
      database.connection.prepare("SELECT id FROM feeds WHERE title = 'Example'").pluck().get(),
    );
    database.connection
      .prepare(
        `INSERT INTO articles (source_id, external_id, title, discovered_at)
         VALUES (?, 'article-1', 'Example article', ?)`,
      )
      .run(sourceId, timestamp);
    const articleId = Number(database.connection.prepare("SELECT id FROM articles").pluck().get());
    database.connection
      .prepare(
        `INSERT INTO feed_articles (feed_id, article_id, delivered_at, is_read, is_starred)
         VALUES (?, ?, ?, 1, 1)`,
      )
      .run(feedId, articleId, timestamp);
    database.connection
      .prepare(
        `INSERT INTO ignored_feed_articles (feed_id, external_id)
         VALUES (?, 'ignored-article')`,
      )
      .run(feedId);
    database.connection
      .prepare(
        `INSERT INTO rules (
           user_id, name, conditions_json, condition_operator, action, created_at, updated_at
         ) VALUES (?, 'Keep example', '[]', 'and', 'keep', ?, ?)`,
      )
      .run(userId, timestamp, timestamp);
    const ruleId = Number(database.connection.prepare("SELECT id FROM rules").pluck().get());
    database.connection
      .prepare(`INSERT INTO article_rule_matches (feed_id, article_id, rule_id) VALUES (?, ?, ?)`)
      .run(feedId, articleId, ruleId);
    database.connection
      .prepare(
        `INSERT INTO ai_credentials (
           user_id, provider, encrypted_api_key, created_at, updated_at
         ) VALUES (?, 'openai', 'encrypted-key', ?, ?)`,
      )
      .run(userId, timestamp, timestamp);
    database.connection
      .prepare(
        `INSERT INTO ai_feature_settings (user_id, feature, provider, model, updated_at)
         VALUES (?, 'article_summary', 'openai', 'test-model', ?)`,
      )
      .run(userId, timestamp);
    database.connection
      .prepare(
        `INSERT INTO article_ai_summaries (
           user_id, article_id, source_revision, prompt_version, source_kind, provider, model,
           summary_text, generated_at
         ) VALUES (?, ?, 1, 1, 'feed', 'openai', 'test-model', 'Summary', ?)`,
      )
      .run(userId, articleId, timestamp);
    database.connection
      .prepare(
        `INSERT INTO article_ai_translations (
           user_id, article_id, target_language, source_kind, source_revision, prompt_version,
           provider, model, translation_html, generated_at
         ) VALUES (?, ?, 'Polish', 'feed', 1, 1, 'openai', 'test-model', '<p>Tekst</p>', ?)`,
      )
      .run(userId, articleId, timestamp);
    database.connection
      .prepare(
        `INSERT INTO passkeys (
           id, user_id, public_key, counter, device_type, backed_up, transports_json, created_at
         ) VALUES ('passkey-1', ?, x'01', 0, 'singleDevice', 0, '[]', ?)`,
      )
      .run(userId, timestamp);
    database.connection
      .prepare(
        `INSERT INTO auth_challenges (
           id_hash, challenge, kind, user_id, origin, rp_id, expires_at
         ) VALUES ('challenge-1', 'challenge', 'passkey-registration', ?,
                   'https://reader.example.test', 'reader.example.test', ?)`,
      )
      .run(userId, new Date(Date.now() + 60_000).toISOString());
    database.connection
      .prepare(
        `INSERT INTO quota_daily_usage (scope, resource, day, count)
         VALUES (?, 'feed_discovery', date('now'), 1)`,
      )
      .run(`user:${userId}`);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/auth/account",
        })
      ).statusCode,
    ).toBe(401);

    database.connection
      .prepare("UPDATE sessions SET recent_auth_at = '2000-01-01T00:00:00.000Z'")
      .run();
    const blocked = await app.inject({
      method: "DELETE",
      url: "/api/auth/account",
      headers: { cookie: currentSession },
    });
    expect(blocked.statusCode).toBe(428);
    const operationId = blocked.json<{ operationId: string }>().operationId;

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/step-up/password",
      headers: { cookie: currentSession },
      payload: { operationId, password: "wrong-password" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(database.connection.prepare("SELECT COUNT(*) FROM users").pluck().get()).toBe(1);

    const authenticated = await app.inject({
      method: "POST",
      url: "/api/auth/step-up/password",
      headers: { cookie: currentSession },
      payload: { operationId, password: "reader-password" },
    });
    expect(authenticated.statusCode).toBe(204);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/auth/account",
      headers: { cookie: currentSession },
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.headers["set-cookie"]).toContain("Max-Age=0");

    for (const table of [
      "users",
      "sessions",
      "settings",
      "folders",
      "feeds",
      "feed_articles",
      "ignored_feed_articles",
      "rules",
      "article_rule_matches",
      "ai_credentials",
      "ai_feature_settings",
      "article_ai_summaries",
      "article_ai_translations",
      "passkeys",
      "auth_challenges",
      "auth_operations",
      "quota_daily_usage",
    ]) {
      expect(database.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_sources").pluck().get()).toBe(2);
    expect(database.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get()).toBe(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: otherSession },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "reader", password: "reader-password" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toMatchObject({
      registrationAvailable: true,
    });
  });

  it("rejects cross-site state changes without ending the session", async () => {
    const { app } = await authApp("https://reader.example.test");
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "reader", password: "reader-password" },
    });
    const cookie = cookieFrom(registration.headers["set-cookie"]);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
