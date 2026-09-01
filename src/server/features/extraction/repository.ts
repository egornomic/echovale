import type Sqlite from "better-sqlite3";
import type { ExtractionRecord, Row } from "../shared.js";

export class ExtractionRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  getPendingExtractions(limit = 100): ExtractionRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, url FROM articles WHERE extraction_status = 'pending'
         ORDER BY discovered_at LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
    }));
  }

  getExtractionRecord(id: number): ExtractionRecord | null {
    const row = this.sqlite
      .prepare(`SELECT id, url FROM articles WHERE id = ? AND extraction_status = 'pending'`)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      url: row.url === null ? null : String(row.url),
    };
  }

  markExtractionProcessing(id: number): boolean {
    return (
      this.sqlite
        .prepare(
          "UPDATE articles SET extraction_status = 'processing' WHERE id = ? AND extraction_status = 'pending'",
        )
        .run(id).changes > 0
    );
  }

  requestExtraction(userId: number, id: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE articles
           SET extraction_status = 'pending', extraction_error = NULL
           WHERE id = ? AND extraction_status != 'processing'
             AND NOT (extraction_status = 'complete' AND content_html IS NOT NULL)
             AND EXISTS (
               SELECT 1 FROM feed_articles
               JOIN feeds ON feeds.id = feed_articles.feed_id
               WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
             )`,
        )
        .run(id, userId).changes > 0
    );
  }

  completeExtraction(
    id: number,
    input: {
      contentHtml: string | null;
      imageUrl: string | null;
      contentSource: "article" | null;
      status: "complete" | "failed";
      error: string | null;
    },
  ): boolean {
    const updated = this.sqlite
      .prepare(
        `UPDATE articles
         SET content_html = ?, image_url = COALESCE(?, image_url), content_source = ?,
             extraction_status = ?, extraction_error = ?,
             content_revision = content_revision +
               CASE WHEN ? = 'complete'
                          AND (content_html IS NOT ? OR content_source IS NOT ?)
                    THEN 1 ELSE 0 END
         WHERE id = ? AND extraction_status = 'processing'`,
      )
      .run(
        input.contentHtml,
        input.imageUrl,
        input.contentSource,
        input.status,
        input.error,
        input.status,
        input.contentHtml,
        input.contentSource,
        id,
      ).changes;
    return updated > 0;
  }
}
