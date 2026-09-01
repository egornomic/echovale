import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function authApp(publicOrigin?: string) {
  const database = new AppDatabase(":memory:");
  const authService = new AuthService(database.auth);
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
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: currentSession },
      payload: { currentPassword: "reader-password", newPassword: "new-reader-password" },
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
