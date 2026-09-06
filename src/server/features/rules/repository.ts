import type Sqlite from "better-sqlite3";
import type {
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  RuleField,
} from "../../../shared/types.js";
import { articleMediaRuleText } from "../../article-media.js";
import { InvalidRequestError } from "../../errors.js";
import { mapRule, now, parseArticleMedia, type Row } from "../shared.js";

export class RuleRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  listRules(userId: number): Rule[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, feed_id AS feedId, folder_id AS folderId,
                conditions_json AS conditionsJson, condition_operator AS conditionOperator, action,
                enabled, matched_count AS matchedCount, created_at AS createdAt, updated_at AS updatedAt
         FROM rules WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(userId) as Row[];
    return rows.map(mapRule);
  }

  getRule(userId: number, id: number): Rule | null {
    return this.listRules(userId).find((rule) => rule.id === id) ?? null;
  }

  createRule(
    userId: number,
    input: {
      name: string;
      feedId?: number | null;
      folderId?: number | null;
      conditions: RuleCondition[];
      conditionOperator: RuleConditionOperator;
      action: RuleAction;
      enabled?: boolean;
    },
  ): Rule {
    this.assertRuleScope(userId, input.feedId, input.folderId);
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO rules (
           user_id, name, feed_id, folder_id, conditions_json, condition_operator, action, enabled,
           matched_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        userId,
        input.name,
        input.feedId ?? null,
        input.folderId ?? null,
        JSON.stringify(input.conditions),
        input.conditionOperator,
        input.action,
        (input.enabled ?? true) ? 1 : 0,
        timestamp,
        timestamp,
      );
    const id = Number(result.lastInsertRowid);
    this.reapplyRule(id);
    return this.getRule(userId, id) as Rule;
  }

  updateRule(
    userId: number,
    id: number,
    input: Partial<{
      name: string;
      feedId: number | null;
      folderId: number | null;
      conditions: RuleCondition[];
      conditionOperator: RuleConditionOperator;
      action: RuleAction;
      enabled: boolean;
    }>,
  ): Rule | null {
    const existing = this.getRule(userId, id);
    if (!existing) return null;
    const feedId = input.feedId === undefined ? existing.feedId : input.feedId;
    const folderId = input.folderId === undefined ? existing.folderId : input.folderId;
    this.assertRuleScope(userId, feedId, folderId);
    this.sqlite
      .prepare(
        `UPDATE rules
         SET name = ?, feed_id = ?, folder_id = ?, conditions_json = ?, condition_operator = ?,
             action = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.feedId === undefined ? existing.feedId : input.feedId,
        input.folderId === undefined ? existing.folderId : input.folderId,
        JSON.stringify(input.conditions ?? existing.conditions),
        input.conditionOperator ?? existing.conditionOperator,
        input.action ?? existing.action,
        (input.enabled ?? existing.enabled) ? 1 : 0,
        now(),
        id,
        userId,
      );
    this.reapplyRule(id);
    return this.getRule(userId, id);
  }

  deleteRule(userId: number, id: number): boolean {
    return (
      this.sqlite.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").run(id, userId)
        .changes > 0
    );
  }

  private assertRuleScope(
    userId: number,
    feedId: number | null | undefined,
    folderId: number | null | undefined,
  ): void {
    if (feedId && folderId) {
      throw new InvalidRequestError("Choose either one feed or one folder for this rule.");
    }
    if (
      feedId !== null &&
      feedId !== undefined &&
      !this.sqlite.prepare("SELECT 1 FROM feeds WHERE id = ? AND user_id = ?").get(feedId, userId)
    ) {
      throw new InvalidRequestError("That feed or folder no longer exists. Reload and try again.");
    }
    if (
      folderId !== null &&
      folderId !== undefined &&
      !this.sqlite
        .prepare("SELECT 1 FROM folders WHERE id = ? AND user_id = ?")
        .get(folderId, userId)
    ) {
      throw new InvalidRequestError("That feed or folder no longer exists. Reload and try again.");
    }
  }

  private reapplyRule(ruleId: number): void {
    const run = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM article_rule_matches WHERE rule_id = ?").run(ruleId);
      this.sqlite.prepare("UPDATE rules SET matched_count = 0 WHERE id = ?").run(ruleId);
      const rows = this.sqlite
        .prepare(
          `SELECT articles.id, feeds.id AS feedId
           FROM feed_articles
           JOIN articles ON articles.id = feed_articles.article_id
           JOIN feeds ON feeds.id = feed_articles.feed_id
           JOIN rules ON rules.user_id = feeds.user_id
           WHERE rules.id = ?`,
        )
        .all(ruleId) as Array<{ id: number; feedId: number }>;
      for (const row of rows) this.applyRuleToArticle(ruleId, row.feedId, row.id);
    });
    run();
  }

  recomputeRulesForArticle(articleId: number): void {
    this.recomputeRulesForArticles([articleId]);
  }

  recomputeRulesForArticles(articleIds: Iterable<number>): void {
    this.recomputeRules(articleIds);
  }

  recomputeRulesForAccountArticles(userId: number, articleIds: Iterable<number>): void {
    this.recomputeRules(articleIds, { userId });
  }

  recomputeRulesForFeedArticles(
    userId: number,
    feedId: number,
    articleIds: Iterable<number>,
  ): void {
    this.recomputeRules(articleIds, { userId, feedId });
  }

  recomputeRulesForAllArticles(userId: number): void {
    const articles = this.sqlite
      .prepare(
        `SELECT DISTINCT articles.id
         FROM feed_articles
         JOIN articles ON articles.id = feed_articles.article_id
         JOIN feeds ON feeds.id = feed_articles.feed_id
         WHERE feeds.user_id = ?`,
      )
      .all(userId) as Array<{ id: number }>;
    this.recomputeRulesForAccountArticles(
      userId,
      articles.map((article) => article.id),
    );
  }

  private recomputeRules(
    articleIds: Iterable<number>,
    scope?: { userId: number; feedId?: number },
  ): void {
    const deleteMatches =
      scope?.feedId !== undefined
        ? this.sqlite.prepare(
            "DELETE FROM article_rule_matches WHERE article_id = ? AND feed_id = ?",
          )
        : scope
          ? this.sqlite.prepare(
              `DELETE FROM article_rule_matches
             WHERE article_id = ? AND rule_id IN (SELECT id FROM rules WHERE user_id = ?)`,
            )
          : this.sqlite.prepare("DELETE FROM article_rule_matches WHERE article_id = ?");
    const deliveries =
      scope?.feedId !== undefined
        ? this.sqlite.prepare(
            `SELECT rules.id, feeds.id AS feedId
           FROM rules
           JOIN feeds ON feeds.user_id = rules.user_id
           JOIN feed_articles ON feed_articles.feed_id = feeds.id
           WHERE feed_articles.article_id = ? AND feeds.user_id = ? AND feeds.id = ?`,
          )
        : scope
          ? this.sqlite.prepare(
              `SELECT rules.id, feeds.id AS feedId
             FROM rules
             JOIN feeds ON feeds.user_id = rules.user_id
             JOIN feed_articles ON feed_articles.feed_id = feeds.id
             WHERE feed_articles.article_id = ? AND rules.user_id = ?`,
            )
          : this.sqlite.prepare(
              `SELECT rules.id, feeds.id AS feedId
             FROM rules
             JOIN feeds ON feeds.user_id = rules.user_id
             JOIN feed_articles ON feed_articles.feed_id = feeds.id
             WHERE feed_articles.article_id = ?`,
            );
    let recomputed = false;
    for (const articleId of articleIds) {
      recomputed = true;
      if (scope?.feedId !== undefined) deleteMatches.run(articleId, scope.feedId);
      else if (scope) deleteMatches.run(articleId, scope.userId);
      else deleteMatches.run(articleId);
      const matchingDeliveries = (
        scope?.feedId !== undefined
          ? deliveries.all(articleId, scope.userId, scope.feedId)
          : scope
            ? deliveries.all(articleId, scope.userId)
            : deliveries.all(articleId)
      ) as Array<{ id: number; feedId: number }>;
      for (const delivery of matchingDeliveries) {
        this.applyRuleToArticle(delivery.id, delivery.feedId, articleId);
      }
    }
    if (!recomputed) return;
    const updateMatchedCounts = scope
      ? this.sqlite.prepare(
          `UPDATE rules
           SET matched_count = (
             SELECT COUNT(*) FROM article_rule_matches WHERE rule_id = rules.id
           )
           WHERE user_id = ?`,
        )
      : this.sqlite.prepare(
          `UPDATE rules
           SET matched_count = (
             SELECT COUNT(*) FROM article_rule_matches WHERE rule_id = rules.id
           )`,
        );
    if (scope) updateMatchedCounts.run(scope.userId);
    else updateMatchedCounts.run();
  }

  private applyRuleToArticle(ruleId: number, feedId: number, articleId: number): void {
    const rule = this.sqlite.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as
      | Row
      | undefined;
    const article = this.sqlite
      .prepare(
        `SELECT articles.*, feeds.id AS feedId, feeds.folder_id, feeds.user_id AS userId
         FROM feed_articles
         JOIN articles ON articles.id = feed_articles.article_id
         JOIN feeds ON feeds.id = feed_articles.feed_id
         WHERE articles.id = ? AND feeds.id = ?`,
      )
      .get(articleId, feedId) as Row | undefined;
    if (!rule || !article) return;
    if (Number(rule.user_id) !== Number(article.userId)) return;
    if (rule.feed_id !== null && Number(rule.feed_id) !== Number(article.feedId)) return;
    if (rule.folder_id !== null) {
      const inScope = this.sqlite
        .prepare(
          `WITH RECURSIVE folder_tree(id) AS (
             SELECT id FROM folders WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT folders.id FROM folders JOIN folder_tree ON folders.parent_id = folder_tree.id
             WHERE folders.user_id = ?
           )
           SELECT 1 FROM folder_tree WHERE id = ?`,
        )
        .get(rule.folder_id, rule.user_id, rule.user_id, article.folder_id);
      if (!inScope) return;
    }
    const mediaText = articleMediaRuleText(parseArticleMedia(article.media_json));
    const values: Record<RuleField, string> = {
      title: String(article.title ?? ""),
      author: String(article.author ?? ""),
      summary: String(article.summary ?? ""),
      content: `${String(article.feed_content_html ?? "")} ${String(article.content_html ?? "")}`,
      media: mediaText,
      any: `${String(article.title ?? "")} ${String(article.author ?? "")} ${String(
        article.summary ?? "",
      )} ${String(article.feed_content_html ?? "")} ${String(
        article.content_html ?? "",
      )} ${mediaText}`,
    };
    const conditions = JSON.parse(String(rule.conditions_json)) as RuleCondition[];
    const matchesCondition = (condition: RuleCondition) =>
      values[condition.field].toLocaleLowerCase().includes(condition.pattern.toLocaleLowerCase());
    const matched =
      rule.condition_operator === "and"
        ? conditions.every(matchesCondition)
        : conditions.some(matchesCondition);
    if (!matched) return;
    const inserted = this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO article_rule_matches (feed_id, article_id, rule_id)
         VALUES (?, ?, ?)`,
      )
      .run(feedId, articleId, ruleId);
    if (inserted.changes === 0) return;
    this.sqlite
      .prepare("UPDATE rules SET matched_count = matched_count + 1 WHERE id = ?")
      .run(ruleId);
    if (rule.enabled === 1 && rule.action === "mark_read") {
      this.sqlite
        .prepare("UPDATE feed_articles SET is_read = 1 WHERE feed_id = ? AND article_id = ?")
        .run(feedId, articleId);
    }
  }
}
