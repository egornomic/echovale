import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/server/database.js";
import { observeScheduledRefresh } from "../../src/server/features/feeds/schedule.js";

afterEach(() => vi.useRealTimers());

describe("adaptive feed scheduling", () => {
  it("targets one new article per refresh using stable interval buckets", () => {
    const baseline = observeScheduledRefresh(
      {
        pollIntervalMinutes: 60,
        activityRatePerHour: null,
        lastScheduledObservationAt: null,
      },
      { completedAt: "2026-08-12T10:00:00.000Z", insertedArticleCount: 0 },
    );
    expect(baseline).toEqual({
      pollIntervalMinutes: 60,
      activityRatePerHour: null,
      lastScheduledObservationAt: "2026-08-12T10:00:00.000Z",
    });

    expect(
      observeScheduledRefresh(baseline, {
        completedAt: "2026-08-12T11:00:00.000Z",
        insertedArticleCount: 1,
      }),
    ).toMatchObject({ pollIntervalMinutes: 60, activityRatePerHour: 1 });
    expect(
      observeScheduledRefresh(baseline, {
        completedAt: "2026-08-12T11:00:00.000Z",
        insertedArticleCount: 6,
      }),
    ).toMatchObject({ pollIntervalMinutes: 10, activityRatePerHour: 6 });
  });

  it("holds at 60 minutes for an isolated post, then speeds up immediately for higher activity", () => {
    const quiet = observeScheduledRefresh(
      {
        pollIntervalMinutes: 60,
        activityRatePerHour: 0,
        lastScheduledObservationAt: "2026-08-12T10:00:00.000Z",
      },
      { completedAt: "2026-08-12T11:00:00.000Z", insertedArticleCount: 1 },
    );
    expect(quiet).toMatchObject({ pollIntervalMinutes: 60, activityRatePerHour: 1 });

    expect(
      observeScheduledRefresh(quiet, {
        completedAt: "2026-08-12T12:00:00.000Z",
        insertedArticleCount: 6,
      }),
    ).toMatchObject({ pollIntervalMinutes: 10, activityRatePerHour: 6 });
  });

  it("slows by only one bucket after an empty observation", () => {
    expect(
      observeScheduledRefresh(
        {
          pollIntervalMinutes: 5,
          activityRatePerHour: null,
          lastScheduledObservationAt: "2026-08-12T10:00:00.000Z",
        },
        { completedAt: "2026-08-12T11:00:00.000Z", insertedArticleCount: 0 },
      ),
    ).toMatchObject({ pollIntervalMinutes: 10, activityRatePerHour: 0 });
  });

  it("starts a changed feed URL with a fresh schedule", () => {
    const database = new AppDatabase(":memory:");
    try {
      database.settings.updateSettings(1, { pollIntervalMinutes: 30 });
      const feed = database.feeds.createFeed(1, {
        title: "News",
        feedUrl: "https://example.test/old.xml",
      });
      database.connection
        .prepare(
          `UPDATE feed_sources
           SET poll_interval_minutes = 5, activity_rate_per_hour = 12,
               last_scheduled_observation_at = '2026-08-12T10:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(feed.id);

      expect(
        database.feeds.updateFeed(1, feed.id, {
          feedUrl: "https://example.test/new.xml",
        }),
      ).toMatchObject({ pollIntervalMinutes: 30 });
      expect(
        database.connection
          .prepare(
            `SELECT activity_rate_per_hour AS activityRatePerHour,
                    last_scheduled_observation_at AS lastScheduledObservationAt
             FROM feed_sources
             WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
          )
          .get(feed.id),
      ).toEqual({ activityRatePerHour: null, lastScheduledObservationAt: null });
    } finally {
      database.close();
    }
  });

  it("learns from inserts, not edits, and ignores manual refreshes and failures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T11:00:00.000Z"));
    const database = new AppDatabase(":memory:");
    try {
      const feed = database.feeds.createFeed(1, {
        title: "Release notes",
        feedUrl: "https://example.test/releases.xml",
      });
      const article = (externalId: string, title: string) => ({
        externalId,
        title,
        url: `https://example.test/${externalId}`,
        author: null,
        publishedAt: null,
        summary: "",
        imageUrl: null,
        feedContentHtml: null,
      });
      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: {
          title: feed.title,
          siteUrl: "https://example.test",
          articles: [article("one", "One")],
        },
      });
      database.connection
        .prepare(
          `UPDATE feed_sources
           SET last_scheduled_observation_at = '2026-08-12T10:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(feed.id);

      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        scheduled: true,
        parsed: {
          title: feed.title,
          siteUrl: "https://example.test",
          articles: [article("one", "One, corrected"), article("two", "Two")],
        },
      });
      expect(
        database.connection
          .prepare(
            `SELECT poll_interval_minutes AS pollIntervalMinutes,
                    activity_rate_per_hour AS activityRatePerHour
             FROM feed_sources
             WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
          )
          .get(feed.id),
      ).toEqual({ pollIntervalMinutes: 30, activityRatePerHour: 1 });

      vi.setSystemTime(new Date("2026-08-12T11:30:00.000Z"));
      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: {
          title: feed.title,
          siteUrl: "https://example.test",
          articles: [article("three", "Three")],
        },
      });
      database.feeds.failRefresh(feed.id, {
        httpStatus: 503,
        error: "Unavailable",
        errorKind: "http",
        healthStatus: "failing",
        retryMinutes: 60,
      });
      expect(
        database.connection
          .prepare(
            `SELECT activity_rate_per_hour AS activityRatePerHour,
                    last_scheduled_observation_at AS lastScheduledObservationAt
             FROM feed_sources
             WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
          )
          .get(feed.id),
      ).toEqual({
        activityRatePerHour: 1,
        lastScheduledObservationAt: "2026-08-12T11:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });
});
