import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { productionListenMessage, productionLogger } from "../../src/server/logging.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("production logging", () => {
  it("records operational and pseudonymous security data without sensitive request values", async () => {
    let output = "";
    const database = new AppDatabase(":memory:");
    const authService = new AuthService(database.auth);
    const extractionQueue = new ExtractionQueue(database.extractions, 1, 1_000);
    const refreshService = new FeedRefreshService(database.feeds, 1, 1_000);
    const app = await createApp({
      database,
      authService,
      extractionQueue,
      refreshService,
      logger: productionLogger({ write: (line) => (output += line) }),
    });
    app.post("/audit/error", async () => {
      throw new Error("PRIVATE_ERROR https://private.example/article?token=ERROR_TOKEN");
    });
    cleanups.push(
      () => app.close(),
      () => Promise.all([refreshService.stop(), extractionQueue.stop()]).then(() => undefined),
      () => database.close(),
    );

    await app.listen({
      host: "127.0.0.1",
      port: 0,
      listenTextResolver: productionListenMessage,
    });
    const { port } = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const sensitiveHeaders = {
      authorization: "Bearer PRIVATE_AUTHORIZATION",
      cookie: "feedfold_session=PRIVATE_COOKIE",
      "x-api-key": "PRIVATE_API_KEY",
    };

    expect(
      (
        await fetch(
          `${baseUrl}/api/articles?search=PRIVATE_SEARCH&feedUrl=${encodeURIComponent("https://private.example/feed?token=PRIVATE_FEED_TOKEN")}`,
          { headers: sensitiveHeaders },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { ...sensitiveHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            username: "PRIVATE_USERNAME",
            password: "PRIVATE_PASSWORD",
            prompt: "PRIVATE_AI_PROMPT",
            url: "https://private.example/article",
          }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/audit/error?query=PRIVATE_ERROR_QUERY`, {
          method: "POST",
          headers: { ...sensitiveHeaders, "content-type": "application/json" },
          body: JSON.stringify({ content: "PRIVATE_REQUEST_BODY" }),
        })
      ).status,
    ).toBe(500);

    for (const sensitiveValue of [
      "PRIVATE_SEARCH",
      "PRIVATE_FEED_TOKEN",
      "PRIVATE_AUTHORIZATION",
      "PRIVATE_COOKIE",
      "PRIVATE_API_KEY",
      "PRIVATE_USERNAME",
      "PRIVATE_PASSWORD",
      "PRIVATE_AI_PROMPT",
      "PRIVATE_REQUEST_BODY",
      "PRIVATE_ERROR",
      "PRIVATE_ERROR_QUERY",
      "https://private.example",
      "127.0.0.1",
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const articleRequest = records.find((record) => record.route === "/api/articles");
    expect(articleRequest).toMatchObject({
      event: "http_request",
      method: "GET",
      route: "/api/articles",
      statusCode: 401,
      securityEvent: "authentication_required",
    });
    expect(articleRequest?.durationMs).toEqual(expect.any(Number));
    expect(articleRequest?.sourceId).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{16}$/));

    const loginRequest = records.find((record) => record.route === "/api/auth/login");
    expect(loginRequest).toMatchObject({
      method: "POST",
      statusCode: 401,
      securityEvent: "authentication_failed",
      sourceId: articleRequest?.sourceId,
    });
    expect(records).toContainEqual(expect.objectContaining({ event: "request_handler_failed" }));
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "http_request",
        method: "POST",
        route: "/audit/error",
        statusCode: 500,
      }),
    );
  });
});
