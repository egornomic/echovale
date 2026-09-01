import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/server/database.js";
import { PUBLIC_DEPLOYMENT_POLICY } from "../../src/server/deployment-policy.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

afterEach(() => vi.useRealTimers());

describe("account activity", () => {
  it("persists recent hosted use beyond the lifetime of a login session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth, 20, { allowPublicRegistration: true });
    try {
      const session = await auth.register("active-reader", "reader-password");
      if (!session) throw new Error("Test account was not created");
      const lastActiveAt = () =>
        database.connection
          .prepare("SELECT last_active_at FROM users WHERE id = ?")
          .pluck()
          .get(session.user.id);

      expect(lastActiveAt()).toBe("2026-09-01T10:00:00.000Z");
      vi.setSystemTime(new Date("2026-09-01T10:04:00.000Z"));
      expect(auth.userForToken(session.token)).toEqual(session.user);
      expect(lastActiveAt()).toBe("2026-09-01T10:00:00.000Z");

      vi.setSystemTime(new Date("2026-09-01T10:06:00.000Z"));
      expect(auth.userForToken(session.token)).toEqual(session.user);
      expect(lastActiveAt()).toBe("2026-09-01T10:06:00.000Z");
      auth.endSession(session.token);
      expect(lastActiveAt()).toBe("2026-09-01T10:06:00.000Z");
    } finally {
      database.close();
    }
  });

  it("schedules a shared source only for recent unpaused subscribers", async () => {
    const database = new AppDatabase(":memory:", 20, PUBLIC_DEPLOYMENT_POLICY);
    const auth = new AuthService(database.auth, 20, { allowPublicRegistration: true });
    const first = (await auth.register("first-reader", "reader-password"))?.user;
    const second = (await auth.register("second-reader", "reader-password"))?.user;
    if (!first || !second) throw new Error("Test accounts were not created");
    let requests = 0;
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, async () => {
      requests += 1;
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel>
           <title>Shared source</title><link>https://publisher.example.test/</link>
           <item><guid>one</guid><title>One</title>
             <link>https://publisher.example.test/one</link></item>
         </channel></rss>`,
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    });
    try {
      const feedUrl = "https://publisher.example.test/feed.xml";
      const firstFeed = database.feeds.createFeed(first.id, { feedUrl });
      const secondFeed = database.feeds.createFeed(second.id, { feedUrl });
      database.connection
        .prepare(
          `UPDATE feed_sources SET next_poll_at = '2026-08-01T00:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(firstFeed.id);
      const setActivity = database.connection.prepare(
        "UPDATE users SET last_active_at = ? WHERE id = ?",
      );
      setActivity.run("2026-08-20T00:00:00.000Z", first.id);
      setActivity.run("2026-08-31T00:00:00.000Z", second.id);

      expect(database.feeds.getDueFeedIds("2026-09-01T00:00:00.000Z")).toEqual([secondFeed.id]);
      database.feeds.updateFeed(second.id, secondFeed.id, { paused: true });
      expect(database.feeds.getDueFeedIds("2026-09-01T00:00:00.000Z")).toEqual([]);

      database.feeds.updateFeed(second.id, secondFeed.id, { paused: false });
      database.connection
        .prepare(
          `UPDATE feed_sources SET next_poll_at = '2026-08-01T00:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(firstFeed.id);
      setActivity.run("2026-08-25T00:00:00.000Z", second.id);
      expect(database.feeds.getDueFeedIds("2026-09-01T00:00:00.000Z")).toEqual([]);

      database.auth.touchUserActivity(
        first.id,
        "2026-09-01T00:00:00.000Z",
        "2026-08-31T23:55:00.000Z",
      );
      expect(database.feeds.getDueFeedIds("2026-09-01T00:00:00.000Z")).toEqual([firstFeed.id]);

      setActivity.run("2026-08-20T00:00:00.000Z", first.id);
      expect(refresh.request([firstFeed.id, secondFeed.id]).requested).toBe(1);
      await refresh.waitForIdle();
      expect(requests).toBe(1);
      expect(database.connection.prepare("SELECT COUNT(*) FROM feed_articles").pluck().get()).toBe(
        2,
      );
    } finally {
      refresh.stop();
      database.close();
    }
  });
});
