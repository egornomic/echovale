import type { ReadableStreamDefaultReader } from "node:stream/web";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const FEED_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Delivery events</title>
    <link>https://example.test/</link>
    <description>Delivery event test feed</description>
    <item>
      <guid>delivered-story</guid>
      <title>Delivered story</title>
      <link>https://example.test/delivered-story</link>
      <pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate>
      <description>A newly delivered story.</description>
    </item>
  </channel>
</rss>`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function feedResponse(): Response {
  return new Response(FEED_SOURCE, {
    status: 200,
    headers: { "Content-Type": "application/rss+xml" },
  });
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The operation timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function eventReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n\n")) {
      const result = await reader.read();
      if (result.done) throw new Error("The event stream ended before the next event.");
      buffered += decoder.decode(result.value, { stream: true });
    }
    const boundary = buffered.indexOf("\n\n");
    const event = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    return event;
  };
}

describe("feed refresh delivery events", () => {
  it("notifies only the owning account after delivered articles are committed", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth, 20, { allowPublicRegistration: true });
    const firstUser = (await auth.register("first-reader", "reader-password"))?.user;
    const secondUser = (await auth.register("second-reader", "reader-password"))?.user;
    if (!firstUser || !secondUser) throw new Error("Test accounts were not created");
    const feed = database.feeds.createFeed(firstUser.id, {
      title: "First reader's feed",
      feedUrl: "https://example.test/first.xml",
      folderId: null,
      paused: true,
    });
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, async () =>
      feedResponse(),
    );
    cleanups.push(
      () => database.close(),
      () => refresh.stop(),
    );

    const firstUserUnreadCounts: number[] = [];
    let secondUserNotifications = 0;
    refresh.subscribe(firstUser.id, () => {
      firstUserUnreadCounts.push(database.bootstrap.getBootstrap(firstUser.id).counts.unread);
    });
    refresh.subscribe(secondUser.id, () => {
      secondUserNotifications += 1;
    });

    expect(refresh.request([feed.id])).toEqual({ requested: 1, refreshingFeedIds: [feed.id] });
    await refresh.waitForIdle();

    expect(firstUserUnreadCounts).toEqual([1]);
    expect(secondUserNotifications).toBe(0);
    expect(database.bootstrap.getBootstrap(secondUser.id).counts.unread).toBe(0);
  });

  it("authenticates the hosted event stream, emits delivery changes, and closes cleanly", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth);
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, async () =>
      feedResponse(),
    );
    const app = await createApp({
      database,
      authService: auth,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    let appClosed = false;
    const controller = new AbortController();
    cleanups.push(
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      async () => {
        controller.abort();
        if (!appClosed) await app.close();
      },
    );
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });

    const unauthorized = await fetch(`${origin}/api/refresh/events`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Sign in to continue." });

    const registration = await fetch(`${origin}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "stream-reader", password: "reader-password" }),
    });
    const cookie = registration.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Registration did not return a session cookie");
    const account = (await registration.json()) as { user: { id: number } };
    const feed = database.feeds.createFeed(account.user.id, {
      title: "Streamed feed",
      feedUrl: "https://example.test/stream.xml",
      folderId: null,
      paused: true,
    });

    const response = await fetch(`${origin}/api/refresh/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The event stream did not return a response body");
    const nextEvent = eventReader(reader);
    expect(await within(nextEvent())).toBe("data: changed");

    refresh.request([feed.id]);
    await refresh.waitForIdle();

    expect(await within(nextEvent())).toBe("data: changed");
    expect(database.bootstrap.getBootstrap(account.user.id).counts.unread).toBe(1);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(204);
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect((await within(reader.read())).done).toBe(true);

    await within(app.close());
    appClosed = true;
    expect((await within(reader.read())).done).toBe(true);
  });
});
