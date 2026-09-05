import type Sqlite from "better-sqlite3";
import type {
  Feed,
  FeedErrorKind,
  FeedHealthStatus,
  FeedPollIntervalMinutes,
  WebFeedConfig,
} from "../../../shared/types.js";
import { xFeedUrl } from "../../../shared/x.js";
import { accountActivityCutoff } from "../../account-activity.js";
import { nitterBaseUrls } from "../../x-feed.js";
import type { FolderRepository } from "../folders/repository.js";
import {
  type FeedRecord,
  feedPollIntervalSql,
  feedRecordColumns,
  mapFeed,
  mapFeedRecord,
  now,
  type ParsedFeed,
  type Row,
  visibleClause,
  WEB_FEED_POLL_INTERVAL_MINUTES,
} from "../shared.js";
import { observeScheduledRefresh } from "./schedule.js";

export interface SourceSubscription {
  feedId: number;
  userId: number;
  initialized: boolean;
}

export class FeedRepository {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly folders: FolderRepository,
    private readonly accountActivityWindowDays: number | null,
  ) {}

  listFeeds(userId: number): Feed[] {
    return this.selectFeeds(userId);
  }

  private selectFeeds(userId: number, feedId?: number): Feed[] {
    const feedIdClause = feedId === undefined ? "" : "AND feeds.id = ?";
    const rows = this.sqlite
      .prepare(
        `SELECT feeds.id, feeds.folder_id AS folderId, feeds.title,
                feed_sources.feed_url AS feedUrl, feed_sources.site_url AS siteUrl,
                feed_sources.source_kind AS sourceKind,
                feed_sources.health_status AS healthStatus,
                feed_sources.last_error_kind AS lastErrorKind,
                source_web_feed_configs.last_match_count AS lastMatchCount,
                feeds.created_at AS createdAt,
                ${feedPollIntervalSql} AS pollIntervalMinutes,
                feeds.paused, feed_sources.refreshing,
                MAX(COALESCE(articles.published_at, feed_articles.delivered_at)) AS lastPostAt,
                feed_sources.last_attempt_at AS lastAttemptAt,
                feed_sources.last_success_at AS lastSuccessAt,
                feed_sources.last_http_status AS lastHttpStatus,
                feed_sources.last_error AS lastError,
                feed_sources.next_poll_at AS nextPollAt,
                SUM(CASE WHEN articles.id IS NOT NULL AND feed_articles.is_read = 0
                         AND ${visibleClause} THEN 1 ELSE 0 END) AS unreadCount,
                SUM(CASE WHEN articles.id IS NOT NULL AND ${visibleClause} THEN 1 ELSE 0 END)
                  AS totalCount
         FROM feeds
         JOIN feed_sources ON feed_sources.id = feeds.source_id
         LEFT JOIN source_web_feed_configs
           ON source_web_feed_configs.source_id = feed_sources.id
         LEFT JOIN feed_articles ON feed_articles.feed_id = feeds.id
         LEFT JOIN articles ON articles.id = feed_articles.article_id
         WHERE feeds.user_id = ? ${feedIdClause}
         GROUP BY feeds.id
         ORDER BY feeds.title COLLATE NOCASE`,
      )
      .all(...(feedId === undefined ? [userId] : [userId, feedId])) as Row[];
    return rows.map(mapFeed);
  }

  getFeed(userId: number, id: number): Feed | null {
    return this.selectFeeds(userId, id)[0] ?? null;
  }

  private publishedSource(feedUrl: string, userId: number): number {
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO feed_sources (
           feed_url, source_kind, source_config_key, title, poll_interval_minutes,
           next_poll_at, created_at, updated_at
         ) VALUES (?, 'published', '', ?,
                   (SELECT poll_interval_minutes FROM settings WHERE user_id = ?), ?, ?, ?)`,
      )
      .run(feedUrl, feedUrl, userId, timestamp, timestamp, timestamp);
    return Number(
      this.sqlite
        .prepare(
          `SELECT id FROM feed_sources
           WHERE source_kind = 'published' AND feed_url = ? AND source_config_key = ''`,
        )
        .pluck()
        .get(feedUrl),
    );
  }

  createFeed(
    userId: number,
    input: {
      feedUrl: string;
      title?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed {
    this.folders.assertFolderExists(userId, input.folderId);
    const timestamp = now();
    const feedUrl = xFeedUrl(input.feedUrl, nitterBaseUrls()) ?? new URL(input.feedUrl).toString();
    const sourceId = this.publishedSource(feedUrl, userId);
    if (input.siteUrl !== undefined) {
      this.sqlite
        .prepare("UPDATE feed_sources SET site_url = COALESCE(site_url, ?) WHERE id = ?")
        .run(input.siteUrl, sourceId);
    }
    const result = this.sqlite
      .prepare(
        `INSERT INTO feeds (
           user_id, source_id, folder_id, title, paused, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        sourceId,
        input.folderId ?? null,
        input.title?.trim() || feedUrl,
        input.paused ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.getFeed(userId, Number(result.lastInsertRowid)) as Feed;
  }

  updateFeed(
    userId: number,
    id: number,
    input: {
      title?: string;
      feedUrl?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed | null {
    const existing = this.getFeed(userId, id);
    if (!existing) return null;
    this.folders.assertFolderExists(userId, input.folderId);
    const feedUrl = input.feedUrl
      ? ((existing.sourceKind === "published" ? xFeedUrl(input.feedUrl, nitterBaseUrls()) : null) ??
        new URL(input.feedUrl).toString())
      : existing.feedUrl;
    if (existing.sourceKind === "web" && feedUrl !== existing.feedUrl) {
      throw new Error("To change a web feed URL, edit its page selection.");
    }
    const oldSourceId = this.sourceIdForFeed(id);
    const sourceId =
      existing.sourceKind === "published" && feedUrl !== existing.feedUrl
        ? this.publishedSource(feedUrl, userId)
        : oldSourceId;
    const title = input.title ?? (existing.title === existing.feedUrl ? feedUrl : existing.title);
    const paused = input.paused ?? existing.paused;
    const sourceChanged = sourceId !== oldSourceId;
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE feeds
           SET source_id = ?, title = ?, folder_id = ?, paused = ?,
               initialized_at = CASE WHEN ? = 1 THEN NULL ELSE initialized_at END,
               updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          sourceId,
          title,
          input.folderId === undefined ? existing.folderId : input.folderId,
          paused ? 1 : 0,
          sourceChanged ? 1 : 0,
          now(),
          id,
          userId,
        );
      if (input.siteUrl !== undefined) {
        this.sqlite
          .prepare("UPDATE feed_sources SET site_url = ? WHERE id = ?")
          .run(input.siteUrl, sourceId);
      }
      if (!paused && (sourceChanged || existing.paused)) {
        this.sqlite
          .prepare("UPDATE feed_sources SET next_poll_at = ? WHERE id = ?")
          .run(now(), sourceId);
      }
      if (sourceChanged) this.deleteOrphanSource(oldSourceId);
    })();
    return this.getFeed(userId, id);
  }

  deleteFeed(userId: number, id: number): boolean {
    const changed = this.sqlite.transaction(() => {
      const deleted = this.sqlite
        .prepare("DELETE FROM feeds WHERE id = ? AND user_id = ?")
        .run(id, userId).changes;
      if (deleted > 0) this.deleteOrphanSources();
      return deleted;
    })();
    return changed > 0;
  }

  private deleteOrphanSource(sourceId: number): void {
    this.sqlite
      .prepare(
        `DELETE FROM feed_sources
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM feeds WHERE source_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM articles
             JOIN feed_articles ON feed_articles.article_id = articles.id
             WHERE articles.source_id = feed_sources.id
           )`,
      )
      .run(sourceId, sourceId);
  }

  private deleteOrphanSources(): void {
    this.sqlite
      .prepare(
        `DELETE FROM feed_sources
         WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE source_id = feed_sources.id)
           AND NOT EXISTS (
             SELECT 1 FROM articles
             JOIN feed_articles ON feed_articles.article_id = articles.id
             WHERE articles.source_id = feed_sources.id
           )`,
      )
      .run();
  }

  sourceIdForFeed(feedId: number): number {
    const value = this.sqlite
      .prepare("SELECT source_id FROM feeds WHERE id = ?")
      .pluck()
      .get(feedId);
    return value === undefined ? 0 : Number(value);
  }

  getFeedRecord(sourceId: number): FeedRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT ${feedRecordColumns}
         FROM feed_sources
         LEFT JOIN source_web_feed_configs
           ON source_web_feed_configs.source_id = feed_sources.id
         WHERE feed_sources.id = ?`,
      )
      .get(sourceId) as Row | undefined;
    return row ? mapFeedRecord(row) : null;
  }

  getWebFeedConfig(userId: number, feedId: number): WebFeedConfig | null {
    const row = this.sqlite
      .prepare(
        `SELECT source_web_feed_configs.config_json AS configJson
         FROM feeds
         JOIN feed_sources ON feed_sources.id = feeds.source_id
         JOIN source_web_feed_configs
           ON source_web_feed_configs.source_id = feed_sources.id
         WHERE feeds.id = ? AND feeds.user_id = ? AND feed_sources.source_kind = 'web'`,
      )
      .get(feedId, userId) as { configJson: string } | undefined;
    return row ? (JSON.parse(row.configJson) as WebFeedConfig) : null;
  }

  getRefreshCandidates(feedIds?: number[]): FeedRecord[] {
    const values: number[] = [];
    let selected = "AND feeds.paused = 0";
    if (feedIds) {
      if (feedIds.length === 0) return [];
      selected = `AND feeds.id IN (${feedIds.map(() => "?").join(", ")})`;
      values.push(...feedIds);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT ${feedRecordColumns}
         FROM feed_sources
         LEFT JOIN source_web_feed_configs
           ON source_web_feed_configs.source_id = feed_sources.id
         WHERE EXISTS (
           SELECT 1 FROM feeds
           WHERE feeds.source_id = feed_sources.id ${selected}
         )`,
      )
      .all(...values) as Row[];
    return rows.map(mapFeedRecord);
  }

  getUserRefreshFeedIds(userId: number, requestedIds?: number[]): number[] {
    if (requestedIds?.length === 0) return [];
    const selected = requestedIds
      ? `AND paused = 0 AND id IN (${requestedIds.map(() => "?").join(", ")})`
      : "AND paused = 0";
    return (
      this.sqlite
        .prepare(`SELECT id FROM feeds WHERE user_id = ? ${selected}`)
        .all(userId, ...(requestedIds ?? [])) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  getDueFeedIds(at = now()): number[] {
    const activityJoin =
      this.accountActivityWindowDays === null
        ? ""
        : "JOIN users ON users.id = feeds.user_id AND users.last_active_at > ?";
    const values =
      this.accountActivityWindowDays === null
        ? [at]
        : [accountActivityCutoff(at, this.accountActivityWindowDays), at];
    return (
      this.sqlite
        .prepare(
          `SELECT MIN(feeds.id) AS id
           FROM feed_sources
           JOIN feeds ON feeds.source_id = feed_sources.id AND feeds.paused = 0
           ${activityJoin}
           WHERE feed_sources.refreshing = 0
             AND (feed_sources.next_poll_at IS NULL OR feed_sources.next_poll_at <= ?)
           GROUP BY feed_sources.id
           ORDER BY COALESCE(feed_sources.next_poll_at, feed_sources.created_at)`,
        )
        .all(...values) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  markFeedRefreshing(sourceId: number): void {
    this.sqlite
      .prepare("UPDATE feed_sources SET refreshing = 1, last_attempt_at = ? WHERE id = ?")
      .run(now(), sourceId);
  }

  listSourceSubscriptions(sourceId: number): SourceSubscription[] {
    return this.sqlite
      .prepare(
        `SELECT id AS feedId, user_id AS userId, initialized_at IS NOT NULL AS initialized
         FROM feeds WHERE source_id = ? ORDER BY id`,
      )
      .all(sourceId) as SourceSubscription[];
  }

  createWebFeedRecord(
    userId: number,
    input: {
      title: string;
      pageUrl: string;
      folderId: number | null;
      config: WebFeedConfig;
      parsed: ParsedFeed;
    },
  ): number {
    const timestamp = now();
    const configJson = JSON.stringify(input.config);
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO feed_sources (
           feed_url, site_url, source_kind, source_config_key, title, refreshing,
           poll_interval_minutes, next_poll_at, created_at, updated_at
         ) VALUES (?, ?, 'web', ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        input.pageUrl,
        input.parsed.siteUrl ?? input.pageUrl,
        configJson,
        input.parsed.title.trim() || input.pageUrl,
        WEB_FEED_POLL_INTERVAL_MINUTES,
        timestamp,
        timestamp,
        timestamp,
      );
    const sourceId = Number(
      this.sqlite
        .prepare(
          `SELECT id FROM feed_sources
           WHERE source_kind = 'web' AND feed_url = ? AND source_config_key = ?`,
        )
        .pluck()
        .get(input.pageUrl, configJson),
    );
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO source_web_feed_configs (
           source_id, config_json, selection_revision, last_match_count, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(sourceId, configJson, input.parsed.articles.length, timestamp, timestamp);
    const result = this.sqlite
      .prepare(
        `INSERT INTO feeds (
           user_id, source_id, folder_id, title, paused, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        userId,
        sourceId,
        input.folderId,
        input.title.trim() || input.parsed.title.trim() || input.pageUrl,
        timestamp,
        timestamp,
      );
    return Number(result.lastInsertRowid);
  }

  updateWebFeedSelectionRecord(feedId: number, config: WebFeedConfig, parsed: ParsedFeed): number {
    const feed = this.sqlite
      .prepare("SELECT user_id AS userId, title, folder_id AS folderId FROM feeds WHERE id = ?")
      .get(feedId) as { userId: number; title: string; folderId: number | null } | undefined;
    if (!feed) throw new Error(`Feed ${feedId} is missing`);
    const oldSourceId = this.sourceIdForFeed(feedId);
    const oldRevision = Number(
      this.sqlite
        .prepare("SELECT selection_revision FROM source_web_feed_configs WHERE source_id = ?")
        .pluck()
        .get(oldSourceId) ?? 0,
    );
    const temporaryId = this.createWebFeedRecord(feed.userId, {
      title: feed.title,
      pageUrl: config.pageUrl,
      folderId: feed.folderId,
      config,
      parsed,
    });
    const newSourceId = this.sourceIdForFeed(temporaryId);
    this.sqlite
      .prepare(
        `UPDATE source_web_feed_configs
         SET selection_revision = MAX(selection_revision, ?)
         WHERE source_id = ?`,
      )
      .run(oldRevision + 1, newSourceId);
    this.sqlite.prepare("DELETE FROM feeds WHERE id = ?").run(temporaryId);
    this.sqlite
      .prepare("UPDATE feeds SET source_id = ?, initialized_at = NULL, updated_at = ? WHERE id = ?")
      .run(newSourceId, now(), feedId);
    if (oldSourceId !== newSourceId) this.deleteOrphanSource(oldSourceId);
    return newSourceId;
  }

  selectionRevisionMatches(sourceId: number, expectedRevision: number): boolean {
    const revision = this.sqlite
      .prepare("SELECT selection_revision FROM source_web_feed_configs WHERE source_id = ?")
      .pluck()
      .get(sourceId);
    return revision !== undefined && Number(revision) === expectedRevision;
  }

  markSubscriptionInitialized(feedId: number, initializedAt: string): void {
    this.sqlite
      .prepare("UPDATE feeds SET initialized_at = COALESCE(initialized_at, ?) WHERE id = ?")
      .run(initializedAt, feedId);
  }

  subscriptionNeedsRefresh(feedId: number): boolean {
    return (
      this.sqlite.prepare("SELECT initialized_at FROM feeds WHERE id = ?").pluck().get(feedId) ===
      null
    );
  }

  sourceHasSuccessfulRefresh(sourceId: number): boolean {
    return (
      this.sqlite
        .prepare("SELECT last_success_at FROM feed_sources WHERE id = ?")
        .pluck()
        .get(sourceId) !== null
    );
  }

  isInitialSourceRefresh(sourceId: number): boolean {
    return (
      this.sqlite
        .prepare("SELECT last_success_at FROM feed_sources WHERE id = ?")
        .pluck()
        .get(sourceId) === null
    );
  }

  updateFromParsedFeed(sourceId: number, parsed: ParsedFeed): void {
    const timestamp = now();
    this.sqlite
      .prepare(
        `UPDATE feeds
         SET title = ?, updated_at = ?
         WHERE source_id = ?
           AND title = (SELECT feed_url FROM feed_sources WHERE id = ?)`,
      )
      .run(parsed.title, timestamp, sourceId, sourceId);
    this.sqlite
      .prepare(
        `UPDATE feed_sources
         SET title = ?, site_url = COALESCE(?, site_url), updated_at = ? WHERE id = ?`,
      )
      .run(parsed.title, parsed.siteUrl, timestamp, sourceId);
  }

  completeSuccessfulRefresh(
    sourceId: number,
    input: {
      httpStatus: number;
      etag: string | null;
      lastModified: string | null;
      scheduled: boolean;
      insertedArticleCount: number;
      webMatchCount?: number;
    },
  ): void {
    const completedAt = now();
    const current = this.sqlite
      .prepare(
        `SELECT poll_interval_minutes AS pollIntervalMinutes,
                activity_rate_per_hour AS activityRatePerHour,
                last_scheduled_observation_at AS lastScheduledObservationAt
         FROM feed_sources WHERE id = ?`,
      )
      .get(sourceId) as {
      pollIntervalMinutes: FeedPollIntervalMinutes;
      activityRatePerHour: number | null;
      lastScheduledObservationAt: string | null;
    };
    const schedule = input.scheduled
      ? observeScheduledRefresh(current, {
          completedAt,
          insertedArticleCount: input.insertedArticleCount,
        })
      : current;
    const nextPollAt = new Date(
      Date.parse(completedAt) + schedule.pollIntervalMinutes * 60_000,
    ).toISOString();
    this.sqlite
      .prepare(
        `UPDATE feed_sources
         SET refreshing = 0, health_status = 'healthy', last_success_at = ?,
             last_http_status = ?, last_error_kind = NULL, last_error = NULL,
             etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
             poll_interval_minutes = ?, activity_rate_per_hour = ?,
             last_scheduled_observation_at = ?, next_poll_at = ? WHERE id = ?`,
      )
      .run(
        completedAt,
        input.httpStatus,
        input.etag,
        input.lastModified,
        schedule.pollIntervalMinutes,
        schedule.activityRatePerHour,
        schedule.lastScheduledObservationAt,
        nextPollAt,
        sourceId,
      );
    if (input.webMatchCount !== undefined) {
      this.sqlite
        .prepare(
          `UPDATE source_web_feed_configs
           SET last_match_count = ?, updated_at = ? WHERE source_id = ?`,
        )
        .run(input.webMatchCount, completedAt, sourceId);
    }
  }

  markFeedFailure(
    sourceId: number,
    input: {
      httpStatus: number | null;
      error: string;
      errorKind: FeedErrorKind;
      healthStatus: FeedHealthStatus;
      retryMinutes: number;
      expectedSelectionRevision?: number;
    },
  ): void {
    const nextPollAt = new Date(Date.now() + input.retryMinutes * 60_000).toISOString();
    this.sqlite.transaction(() => {
      if (
        input.expectedSelectionRevision !== undefined &&
        !this.selectionRevisionMatches(sourceId, input.expectedSelectionRevision)
      )
        return;
      this.sqlite
        .prepare(
          `UPDATE feed_sources
           SET refreshing = 0, health_status = ?, last_http_status = ?, last_error_kind = ?,
               last_error = ?, next_poll_at = ? WHERE id = ?`,
        )
        .run(
          input.healthStatus,
          input.httpStatus,
          input.errorKind,
          input.error,
          nextPollAt,
          sourceId,
        );
      if (input.errorKind === "selection_broken") {
        this.sqlite
          .prepare(
            `UPDATE source_web_feed_configs
             SET last_match_count = 0, updated_at = ? WHERE source_id = ?`,
          )
          .run(now(), sourceId);
      }
    })();
  }

  listOpmlFeeds(userId: number): Array<{
    title: string;
    feedUrl: string;
    siteUrl: string | null;
    folderId: number | null;
  }> {
    return this.sqlite
      .prepare(
        `SELECT feeds.title, feed_sources.feed_url AS feedUrl,
                feed_sources.site_url AS siteUrl, feeds.folder_id AS folderId
         FROM feeds JOIN feed_sources ON feed_sources.id = feeds.source_id
         WHERE feeds.user_id = ? AND feed_sources.source_kind = 'published'
         ORDER BY feeds.title COLLATE NOCASE`,
      )
      .all(userId) as Array<{
      title: string;
      feedUrl: string;
      siteUrl: string | null;
      folderId: number | null;
    }>;
  }
}
