import type { FeedInput, FeedUpdateInput, FolderInput, RuleInput } from "../client/api-contract.js";
import type { DesktopOperation } from "../shared/desktop.js";
import type {
  AiArticleSourceKind,
  AiFeature,
  AiProvider,
  AiSettings,
  AppSettings,
  Article,
  ArticleAiSummary,
  ArticleAiTranslation,
  ArticlePage,
  ArticleQuery,
  Feed,
  FeedDiscoveryResult,
  Folder,
  ImportResult,
  MarkReadRequest,
  RefreshResult,
  Rule,
  SessionUser,
  TelegramArticleMedia,
  WebFeedAnalysis,
  XArticleMedia,
} from "../shared/types.js";
import { createDemoData, DEMO_RELEASE_ARTICLE_ID, type DemoData } from "./fixtures.js";

const DEMO_USER: SessionUser = { id: "demo", username: "demo", hasPassword: false };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function idAfter(items: Array<{ id: number }>): number {
  return Math.max(0, ...items.map((item) => item.id)) + 1;
}

function titleFromUrl(value: string): string {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "");
    return hostname
      .split(".")[0]
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ");
  } catch {
    return "New feed";
  }
}

export class DemoStore {
  private readonly data: DemoData;

  constructor(now = new Date()) {
    this.data = createDemoData(now);
  }

  session(): SessionUser {
    return clone(DEMO_USER);
  }

  bootstrap() {
    const feeds = this.data.feeds.map((feed) => {
      const articles = this.data.articles.filter((article) => article.feedId === feed.id);
      const lastPostAt = articles
        .map((article) => article.publishedAt ?? article.discoveredAt)
        .sort()
        .at(-1);
      return {
        ...feed,
        unreadCount: articles.filter((article) => !article.isRead).length,
        totalCount: articles.length,
        lastPostAt: lastPostAt ?? null,
      };
    });
    const folders = this.data.folders.map((folder) => {
      const folderIds = this.folderBranchIds(folder.id);
      return {
        ...folder,
        unreadCount: this.data.articles.filter(
          (article) =>
            !article.isRead && article.folderId !== null && folderIds.has(article.folderId),
        ).length,
      };
    });

    return clone({
      feeds,
      folders,
      settings: this.data.settings,
      aiSettings: this.data.aiSettings,
      counts: {
        unread: this.data.articles.filter((article) => !article.isRead).length,
        starred: this.data.articles.filter((article) => article.isStarred).length,
        all: this.data.articles.length,
      },
    });
  }

  articles(query: ArticleQuery): ArticlePage {
    const articles = this.filteredArticles(query);
    const sortDirection =
      query.folderId === undefined
        ? "newest"
        : (this.data.folders.find((folder) => folder.id === query.folderId)?.sortDirection ??
          "newest");
    articles.sort((left, right) => {
      const leftPinned = left.id === DEMO_RELEASE_ARTICLE_ID;
      const rightPinned = right.id === DEMO_RELEASE_ARTICLE_ID;
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

      const leftTime = Date.parse(left.publishedAt ?? left.discoveredAt);
      const rightTime = Date.parse(right.publishedAt ?? right.discoveredAt);
      return sortDirection === "oldest" ? leftTime - rightTime : rightTime - leftTime;
    });

    const limit = Math.max(1, query.limit ?? 100);
    const anchorIndex =
      query.anchorId === undefined
        ? null
        : Math.max(
            0,
            articles.findIndex((article) => article.id === query.anchorId),
          );
    const cursorOffset = Number.parseInt(query.cursor ?? "0", 10);
    const requestedOffset = Number.isFinite(cursorOffset) ? Math.max(0, cursorOffset) : 0;
    const offset =
      query.anchorId === undefined || anchorIndex === null
        ? requestedOffset
        : Math.max(0, anchorIndex - Math.floor(limit / 2));
    const page = articles.slice(offset, offset + limit);
    const nextOffset = offset + page.length;

    return clone({
      articles: page,
      nextCursor: nextOffset < articles.length ? String(nextOffset) : null,
      anchorIndex:
        query.anchorId === undefined || anchorIndex === null ? null : anchorIndex - offset,
    });
  }

  article(id: number): Article {
    return clone(this.requireArticle(id));
  }

  updateArticleState(id: number, state: { isRead?: boolean; isStarred?: boolean }): Article {
    const article = this.requireArticle(id);
    if (state.isRead !== undefined) article.isRead = state.isRead;
    if (state.isStarred !== undefined) article.isStarred = state.isStarred;
    return clone(article);
  }

  markRead(request: MarkReadRequest): { updated: number } {
    const ids = request.articleIds ? new Set(request.articleIds) : null;
    const cutoff = request.olderThanDays
      ? Date.now() - request.olderThanDays * 24 * 60 * 60 * 1_000
      : null;
    const folderIds =
      request.folderId === undefined ? null : this.folderBranchIds(request.folderId);
    let updated = 0;

    for (const article of this.data.articles) {
      if (article.isRead) continue;
      if (ids && !ids.has(article.id)) continue;
      if (request.feedId !== undefined && article.feedId !== request.feedId) continue;
      if (folderIds && (article.folderId === null || !folderIds.has(article.folderId))) {
        continue;
      }
      if (cutoff !== null && Date.parse(article.publishedAt ?? article.discoveredAt) >= cutoff) {
        continue;
      }
      article.isRead = true;
      updated += 1;
    }

    return { updated };
  }

  refresh(feedIds?: number[]): RefreshResult {
    const activeFeeds = this.data.feeds.filter((feed) => !feed.paused);
    return {
      requested: feedIds
        ? activeFeeds.filter((feed) => feedIds.includes(feed.id)).length
        : activeFeeds.length,
      refreshingFeedIds: [],
    };
  }

  discoverFeed(url: string): FeedDiscoveryResult {
    const title = titleFromUrl(url);
    return {
      kind: "published",
      preview: {
        feedUrl: url,
        title,
        siteUrl: url,
        totalArticles: 3,
        articles: this.data.articles.slice(0, 3).map((article) => ({
          title: article.title,
          url: article.url,
          author: article.author,
          publishedAt: article.publishedAt,
          summary: article.summary,
          imageUrl: article.imageUrl,
        })),
      },
    };
  }

  analyzeWebPage(url: string, selectedCandidateId: string | null = null): WebFeedAnalysis {
    const candidateId = "demo-articles";
    return {
      pageUrl: url,
      title: titleFromUrl(url),
      snapshotId: "demo-snapshot",
      messageToken: "demo-message",
      candidates: [
        {
          id: candidateId,
          label: "Articles",
          itemCount: 3,
          availableFields: ["title", "link", "date", "author", "summary", "image"],
          config: {
            pageUrl: url,
            selectors: {
              item: "article",
              title: "h2",
              link: "a",
              date: "time",
              author: ".author",
              summary: "p",
              image: "img",
            },
          },
          articles: this.data.articles.slice(0, 3).map((article) => ({
            title: article.title,
            url: article.url,
            author: article.author,
            publishedAt: article.publishedAt,
            summary: article.summary,
            imageUrl: article.imageUrl,
          })),
        },
      ],
      suggestedCandidateIds: [candidateId],
      selectedCandidateId,
      savedSelectionMatched: selectedCandidateId !== null,
    };
  }

  createFeed(input: FeedInput): Feed {
    const now = new Date().toISOString();
    const title = input.title?.trim() || titleFromUrl(input.siteUrl ?? input.feedUrl);
    const feed: Feed = {
      id: idAfter(this.data.feeds),
      folderId: input.folderId,
      title,
      feedUrl: input.feedUrl,
      siteUrl: input.siteUrl ?? null,
      sourceKind: input.sourceKind,
      healthStatus: "healthy",
      lastErrorKind: null,
      lastMatchCount: input.sourceKind === "web" ? 3 : null,
      createdAt: now,
      pollIntervalMinutes: this.data.settings.pollIntervalMinutes,
      unreadCount: 0,
      totalCount: 0,
      paused: false,
      refreshing: false,
      lastPostAt: null,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastHttpStatus: 200,
      lastError: null,
      nextPollAt: null,
    };
    this.data.feeds.push(feed);
    return clone(feed);
  }

  feed(id: number): Feed {
    return clone(this.requireFeed(id));
  }

  updateFeed(id: number, input: FeedUpdateInput): Feed {
    const feed = this.requireFeed(id);
    const previousFolderId = feed.folderId;
    Object.assign(feed, input);
    if (input.folderId !== undefined && input.folderId !== previousFolderId) {
      for (const article of this.data.articles) {
        if (article.feedId === id) article.folderId = input.folderId;
      }
    }
    return clone(feed);
  }

  deleteFeed(id: number): void {
    const index = this.data.feeds.findIndex((feed) => feed.id === id);
    if (index < 0) throw new Error("The demo feed no longer exists.");
    this.data.feeds.splice(index, 1);
    this.data.articles.splice(
      0,
      this.data.articles.length,
      ...this.data.articles.filter((article) => article.feedId !== id),
    );
    this.data.rules.splice(
      0,
      this.data.rules.length,
      ...this.data.rules.filter((rule) => rule.feedId !== id),
    );
  }

  createFolder(input: FolderInput): Folder {
    const siblings = this.data.folders.filter((folder) => folder.parentId === input.parentId);
    const folder: Folder = {
      id: idAfter(this.data.folders),
      parentId: input.parentId,
      name: input.name,
      position: Math.max(-1, ...siblings.map((sibling) => sibling.position)) + 1,
      sortDirection: input.sortDirection,
      unreadCount: 0,
    };
    this.data.folders.push(folder);
    return clone(folder);
  }

  updateFolder(id: number, input: Partial<FolderInput>): Folder {
    const folder = this.requireFolder(id);
    Object.assign(folder, input);
    return clone(folder);
  }

  deleteFolder(id: number): void {
    const folder = this.requireFolder(id);
    const parentId = folder.parentId;
    this.data.folders.splice(
      0,
      this.data.folders.length,
      ...this.data.folders.filter((candidate) => candidate.id !== id),
    );
    for (const child of this.data.folders) {
      if (child.parentId === id) child.parentId = parentId;
    }
    for (const feed of this.data.feeds) {
      if (feed.folderId === id) this.updateFeed(feed.id, { folderId: parentId });
    }
    for (const rule of this.data.rules) {
      if (rule.folderId === id) rule.folderId = parentId;
    }
  }

  rules(): Rule[] {
    return clone(this.data.rules);
  }

  createRule(input: RuleInput): Rule {
    const now = new Date().toISOString();
    const rule: Rule = {
      id: idAfter(this.data.rules),
      ...input,
      matchedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.rules.push(rule);
    return clone(rule);
  }

  updateRule(id: number, input: Partial<RuleInput>): Rule {
    const rule = this.requireRule(id);
    Object.assign(rule, input, { updatedAt: new Date().toISOString() });
    return clone(rule);
  }

  deleteRule(id: number): void {
    const index = this.data.rules.findIndex((rule) => rule.id === id);
    if (index < 0) throw new Error("The demo rule no longer exists.");
    this.data.rules.splice(index, 1);
  }

  updateSettings(input: Partial<AppSettings>): AppSettings {
    Object.assign(this.data.settings, input);
    return clone(this.data.settings);
  }

  aiSettings(): AiSettings {
    return clone(this.data.aiSettings);
  }

  updateAiFeature(feature: AiFeature, input: { provider: AiProvider; model?: string }): AiSettings {
    if (feature === "article_summary") {
      const provider = this.data.aiSettings.providers.find(
        (option) => option.id === input.provider,
      );
      this.data.aiSettings.features.articleSummary = {
        provider: input.provider,
        model: input.model ?? provider?.defaultModel ?? "demo",
      };
    }
    return this.aiSettings();
  }

  setProviderConfigured(providerId: AiProvider, configured: boolean): AiSettings {
    const provider = this.data.aiSettings.providers.find((option) => option.id === providerId);
    if (provider) provider.configured = configured;
    return this.aiSettings();
  }

  summarizeArticle(id: number, promptId: string | null): ArticleAiSummary {
    const article = this.requireArticle(id);
    const text =
      promptId === "key-ideas"
        ? [
            `- **Protect attention:** ${article.summary}`,
            "- **Prefer clear boundaries:** focused systems are easier to understand and maintain.",
            "- **Design for continuity:** the next useful action should feel natural, not demanding.",
          ].join("\n")
        : `${article.summary} The article argues for focused tools, legible choices, and systems that give attention back to the reader.`;
    const summary: ArticleAiSummary = {
      text,
      promptId,
      provider: "openai",
      model: "demo",
      sourceKind: "full",
      generatedAt: new Date().toISOString(),
      usage: { inputTokens: null, outputTokens: null },
      grounding: null,
    };
    article.aiSummary = summary;
    return clone(summary);
  }

  translateArticle(id: number, sourceKind: AiArticleSourceKind): ArticleAiTranslation {
    const article = this.requireArticle(id);
    return {
      html: `<p><strong>${article.title}</strong></p><p>Cette démonstration conserve la structure de l’article tout en présentant une traduction concise de son idée principale.</p>`,
      language: this.data.settings.translationLanguage,
      provider: "openai",
      model: "demo",
      sourceKind,
      generatedAt: new Date().toISOString(),
      usage: { inputTokens: null, outputTokens: null },
    };
  }

  importOpml(_opml: string): ImportResult {
    return { imported: 0, duplicates: 0, failed: [] };
  }

  exportOpml(): string {
    const outlines = this.data.feeds
      .map(
        (feed) =>
          `<outline text="${feed.title}" title="${feed.title}" type="rss" xmlUrl="${feed.feedUrl}" />`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>feedfold demo</title></head><body>${outlines}</body></opml>`;
  }

  invoke(operation: DesktopOperation, payload: unknown): unknown {
    switch (operation) {
      case "session":
      case "login":
      case "register":
        return { user: this.session() };
      case "logout":
      case "deleteAccount":
        return undefined;
      case "bootstrap":
        return this.bootstrap();
      case "articles":
        return this.articles(payload as ArticleQuery);
      case "article":
      case "loadFullContent":
        return this.article((payload as { id: number }).id);
      case "telegramArticleMedia":
        return { items: [] } satisfies TelegramArticleMedia;
      case "xArticleMedia":
        return {
          sourceUrl: "",
          posterUrl: null,
          aspectRatio: null,
        } satisfies XArticleMedia;
      case "summarizeArticle": {
        const input = payload as { id: number; promptId: string | null };
        return this.summarizeArticle(input.id, input.promptId);
      }
      case "translateArticle": {
        const input = payload as { id: number; sourceKind: AiArticleSourceKind };
        return this.translateArticle(input.id, input.sourceKind);
      }
      case "updateArticleState": {
        const input = payload as {
          id: number;
          state: { isRead?: boolean; isStarred?: boolean };
        };
        return this.updateArticleState(input.id, input.state);
      }
      case "markRead":
        return this.markRead(payload as MarkReadRequest);
      case "refresh":
        return this.refresh((payload as { feedIds?: number[] }).feedIds);
      case "discoverFeed":
        return this.discoverFeed((payload as { url: string }).url);
      case "analyzeWebPage":
        return this.analyzeWebPage((payload as { url: string }).url);
      case "createFeed":
        return this.createFeed(payload as FeedInput);
      case "feed":
        return this.feed((payload as { id: number }).id);
      case "updateFeed": {
        const input = payload as { id: number; input: FeedUpdateInput };
        return this.updateFeed(input.id, input.input);
      }
      case "deleteFeed":
        return this.deleteFeed((payload as { id: number }).id);
      case "analyzeWebFeed": {
        const feed = this.requireFeed((payload as { id: number }).id);
        return this.analyzeWebPage(feed.siteUrl ?? feed.feedUrl, "demo-articles");
      }
      case "updateWebFeedSelection":
        return this.feed((payload as { id: number }).id);
      case "createFolder":
        return this.createFolder(payload as FolderInput);
      case "updateFolder": {
        const input = payload as { id: number; input: Partial<FolderInput> };
        return this.updateFolder(input.id, input.input);
      }
      case "deleteFolder":
        return this.deleteFolder((payload as { id: number }).id);
      case "rules":
        return { rules: this.rules() };
      case "createRule":
        return this.createRule(payload as RuleInput);
      case "updateRule": {
        const input = payload as { id: number; input: Partial<RuleInput> };
        return this.updateRule(input.id, input.input);
      }
      case "deleteRule":
        return this.deleteRule((payload as { id: number }).id);
      case "updateSettings":
        return this.updateSettings(payload as Partial<AppSettings>);
      case "aiSettings":
        return this.aiSettings();
      case "updateAiFeature": {
        const input = payload as {
          feature: AiFeature;
          input: { provider: AiProvider; model?: string };
        };
        return this.updateAiFeature(input.feature, input.input);
      }
      case "saveAiProviderKey":
        return this.setProviderConfigured((payload as { provider: AiProvider }).provider, true);
      case "deleteAiProviderKey":
        return this.setProviderConfigured((payload as { provider: AiProvider }).provider, false);
      case "importOpml":
        return this.importOpml((payload as { opml: string }).opml);
      case "exportOpml":
        return this.exportOpml();
    }
  }

  private filteredArticles(query: ArticleQuery): Article[] {
    const folderIds = query.folderId === undefined ? null : this.folderBranchIds(query.folderId);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    return this.data.articles.filter((article) => {
      if (query.state === "unread" && article.isRead) return false;
      if (query.state === "read" && !article.isRead) return false;
      if (query.state === "starred" && !article.isStarred) return false;
      if (query.feedId !== undefined && article.feedId !== query.feedId) return false;
      if (folderIds && (article.folderId === null || !folderIds.has(article.folderId))) {
        return false;
      }
      if (!search) return true;
      return [article.title, article.author, article.summary, article.feedTitle]
        .filter((value): value is string => value !== null)
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
  }

  private folderBranchIds(rootId: number): Set<number> {
    const ids = new Set([rootId]);
    let found = true;
    while (found) {
      found = false;
      for (const folder of this.data.folders) {
        if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          found = true;
        }
      }
    }
    return ids;
  }

  private requireArticle(id: number): Article {
    const article = this.data.articles.find((candidate) => candidate.id === id);
    if (!article) throw new Error("The demo article no longer exists.");
    return article;
  }

  private requireFeed(id: number): Feed {
    const feed = this.data.feeds.find((candidate) => candidate.id === id);
    if (!feed) throw new Error("The demo feed no longer exists.");
    return feed;
  }

  private requireFolder(id: number): Folder {
    const folder = this.data.folders.find((candidate) => candidate.id === id);
    if (!folder) throw new Error("The demo folder no longer exists.");
    return folder;
  }

  private requireRule(id: number): Rule {
    const rule = this.data.rules.find((candidate) => candidate.id === id);
    if (!rule) throw new Error("The demo rule no longer exists.");
    return rule;
  }
}
