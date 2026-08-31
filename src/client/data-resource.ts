import type {
  BootstrapData,
  Feed,
  Folder,
  ImportResult,
  RefreshResult,
  Rule,
  WebFeedConfig,
} from "../shared/types.js";
import {
  api,
  errorMessage,
  type FeedInput,
  type FeedUpdateInput,
  type FolderInput,
  type RuleInput,
} from "./api.js";

export type ArticleReloadMode = "query" | "mutation" | "delivery";

export interface ReaderDataBinding {
  getBootstrap: () => BootstrapData | null;
  applyBootstrap: (bootstrap: BootstrapData) => void;
  setBootstrapError: (message: string | null) => void;
  reloadArticles: (signal: AbortSignal, mode: ArticleReloadMode) => Promise<void>;
  reloadRules: (signal: AbortSignal) => Promise<void>;
}

export interface RefreshMutation {
  result: RefreshResult;
  settled: Promise<void>;
}

export interface ReaderDataMutations {
  createFeed(input: FeedInput): Promise<Feed>;
  importOpml(file: File): Promise<ImportResult>;
  updateFeed(id: number, input: FeedUpdateInput): Promise<Feed>;
  deleteFeed(id: number): Promise<void>;
  updateWebFeedSelection(id: number, config: WebFeedConfig): Promise<Feed>;
  createFolder(input: FolderInput): Promise<Folder>;
  updateFolder(id: number, input: Partial<FolderInput>): Promise<Folder>;
  deleteFolder(id: number): Promise<void>;
  createRule(input: RuleInput): Promise<Rule>;
  updateRule(id: number, input: Partial<RuleInput>): Promise<Rule>;
  deleteRule(id: number): Promise<void>;
}

type ReaderDataClient = Pick<
  typeof api,
  | "bootstrap"
  | "createFeed"
  | "importOpml"
  | "updateFeed"
  | "deleteFeed"
  | "updateWebFeedSelection"
  | "createFolder"
  | "updateFolder"
  | "deleteFolder"
  | "createRule"
  | "updateRule"
  | "deleteRule"
  | "refresh"
>;

type ReaderDataInvalidationSubscriber = (listener: () => void) => () => void;
const MAX_INVALIDATION_RETRY_MS = 30_000;

class LatestRequest {
  private controller: AbortController | null = null;
  private settled: Promise<void> | null = null;

  async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.cancel();
    const controller = new AbortController();
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.controller = controller;
    this.settled = settled;
    try {
      return await request(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.settled = null;
      }
      resolveSettled();
    }
  }

  cancel(): void {
    this.controller?.abort();
  }

  isRunning(): boolean {
    return this.settled !== null;
  }

  async waitUntilIdle(): Promise<void> {
    while (this.settled) await this.settled;
  }
}

export class ReaderDataResource implements ReaderDataMutations {
  private binding: ReaderDataBinding | null = null;
  private readonly bootstrapRequest = new LatestRequest();
  private readonly articleRequest = new LatestRequest();
  private readonly deliveryArticleRequest = new LatestRequest();
  private readonly ruleRequest = new LatestRequest();
  private readonly trackedFeedIds = new Set<number>();
  private observeRefreshingFeeds = false;
  private reloadArticlesAfterTracking = false;
  private pollTask: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePollDelay: (() => void) | null = null;
  private invalidationUnsubscribe: (() => void) | null = null;
  private invalidationPending = false;
  private invalidationTask: Promise<void> | null = null;
  private invalidationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveInvalidationRetry: (() => void) | null = null;
  private invalidationRetryMs: number;
  private counterMutationCount = 0;
  private bootstrapMutationRevision = 0;
  private bootstrapRefreshDeferred = false;
  private active = true;

  constructor(
    private readonly client: ReaderDataClient = api,
    private readonly pollIntervalMs = 1_000,
    private readonly subscribeToInvalidations: ReaderDataInvalidationSubscriber = api.subscribeReaderDataInvalidations,
    private readonly initialInvalidationRetryMs = 1_000,
  ) {
    this.invalidationRetryMs = initialInvalidationRetryMs;
  }

  connect(binding: ReaderDataBinding): void {
    this.binding = binding;
  }

  resume(): void {
    this.active = true;
    if (!this.invalidationUnsubscribe) {
      this.invalidationUnsubscribe = this.subscribeToInvalidations(this.queueInvalidation);
    }
    if (this.hasTrackedWork()) this.ensurePolling();
  }

  pause(): void {
    this.active = false;
    this.invalidationUnsubscribe?.();
    this.invalidationUnsubscribe = null;
    this.invalidationPending = false;
    this.finishInvalidationRetry();
    this.invalidationRetryMs = this.initialInvalidationRetryMs;
    this.bootstrapRequest.cancel();
    this.articleRequest.cancel();
    this.deliveryArticleRequest.cancel();
    this.ruleRequest.cancel();
    this.trackedFeedIds.clear();
    this.observeRefreshingFeeds = false;
    this.reloadArticlesAfterTracking = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.resolvePollDelay?.();
    this.resolvePollDelay = null;
  }

  cancelArticles(): void {
    this.articleRequest.cancel();
  }

  cancelArticleDelivery(): void {
    this.interruptArticleDelivery();
  }

  loadBootstrap = async (): Promise<void> => {
    await this.refreshBootstrap();
  };

  loadArticles = async (mode: ArticleReloadMode = "query"): Promise<boolean> => {
    if (!this.active || !this.binding) return false;
    try {
      if (mode === "delivery") {
        await this.articleRequest.waitUntilIdle();
        const binding = this.binding;
        if (!this.active || !binding) return false;
        const completed = await this.deliveryArticleRequest.run(async (signal) => {
          await binding.reloadArticles(signal, mode);
          return true;
        });
        return completed === true;
      }
      const binding = this.binding;
      this.interruptArticleDelivery();
      await this.articleRequest.run((signal) => binding.reloadArticles(signal, mode));
      return true;
    } catch {
      // The bound reader loader owns its visible error state.
      return false;
    }
  };

  reloadReader = async (): Promise<void> => {
    await this.loadArticles();
    await this.refreshBootstrap();
  };

  requestArticles = async <T>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!this.active) return undefined;
    this.interruptArticleDelivery();
    return this.articleRequest.run(request);
  };

  private interruptArticleDelivery(): void {
    if (!this.deliveryArticleRequest.isRunning()) return;
    this.deliveryArticleRequest.cancel();
    this.queueInvalidation();
  }

  runCounterMutation = async <T>(request: () => Promise<T>): Promise<T> => {
    this.counterMutationCount += 1;
    this.bootstrapMutationRevision += 1;
    let succeeded = false;
    try {
      const result = await request();
      succeeded = true;
      return result;
    } finally {
      this.counterMutationCount -= 1;
      this.bootstrapMutationRevision += 1;
      if (
        succeeded &&
        this.counterMutationCount === 0 &&
        this.bootstrapRefreshDeferred &&
        this.active
      ) {
        await this.refreshBootstrap();
      }
    }
  };

  mutateBootstrap = (update: (bootstrap: BootstrapData) => BootstrapData): void => {
    const binding = this.binding;
    const current = binding?.getBootstrap();
    if (!binding || !current) return;
    const next = update(current);
    this.bootstrapMutationRevision += 1;
    binding.applyBootstrap(next);
  };

  loadRules = async (): Promise<void> => {
    const binding = this.binding;
    if (!this.active || !binding) return;
    try {
      await this.ruleRequest.run((signal) => binding.reloadRules(signal));
    } catch {
      // The bound rules loader owns its visible error state.
    }
  };

  reload = async ({
    articles = false,
    rules = false,
  }: {
    articles?: boolean;
    rules?: boolean;
  } = {}): Promise<void> => {
    await this.invalidateNow({ articles, rules });
  };

  createFeed = async (input: FeedInput): Promise<Feed> => {
    const feed = await this.client.createFeed(input);
    await this.invalidateRefreshing([feed.id]);
    return feed;
  };

  importOpml = async (file: File): Promise<ImportResult> => {
    const result = await this.client.importOpml(file);
    await this.invalidateRefreshing([], true);
    return result;
  };

  updateFeed = async (id: number, input: FeedUpdateInput): Promise<Feed> => {
    const feed = await this.client.updateFeed(id, input);
    await this.invalidateNow({ articles: true, rules: input.folderId !== undefined });
    return feed;
  };

  deleteFeed = async (id: number): Promise<void> => {
    await this.client.deleteFeed(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  updateWebFeedSelection = async (id: number, config: WebFeedConfig): Promise<Feed> => {
    const feed = await this.client.updateWebFeedSelection(id, config);
    await this.invalidateNow({ articles: true });
    return feed;
  };

  createFolder = async (input: FolderInput): Promise<Folder> => {
    const folder = await this.client.createFolder(input);
    await this.invalidateNow({ articles: true });
    return folder;
  };

  updateFolder = async (id: number, input: Partial<FolderInput>): Promise<Folder> => {
    const folder = await this.client.updateFolder(id, input);
    await this.invalidateNow({ articles: true });
    return folder;
  };

  deleteFolder = async (id: number): Promise<void> => {
    await this.client.deleteFolder(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  createRule = async (input: RuleInput): Promise<Rule> => {
    const rule = await this.client.createRule(input);
    await this.invalidateNow({ articles: true, rules: true });
    return rule;
  };

  updateRule = async (id: number, input: Partial<RuleInput>): Promise<Rule> => {
    const rule = await this.client.updateRule(id, input);
    await this.invalidateNow({ articles: true, rules: true });
    return rule;
  };

  deleteRule = async (id: number): Promise<void> => {
    await this.client.deleteRule(id);
    await this.invalidateNow({ articles: true, rules: true });
  };

  beginRefresh = async (
    feedIds: number[] | undefined,
    trackedFeedIds: number[],
  ): Promise<RefreshMutation> => {
    this.markRefreshing(trackedFeedIds);
    try {
      const result = await this.client.refresh(feedIds);
      const settled = this.invalidateRefreshing(
        [...trackedFeedIds, ...result.refreshingFeedIds],
        false,
        true,
      );
      return { result, settled };
    } catch (error) {
      void this.loadBootstrap();
      throw error;
    }
  };

  private async invalidateNow({
    articles,
    rules = false,
  }: {
    articles: boolean;
    rules?: boolean;
  }): Promise<void> {
    await Promise.all([
      this.refreshBootstrap(),
      articles ? this.loadArticles("mutation") : Promise.resolve(),
      rules ? this.loadRules() : Promise.resolve(),
    ]);
  }

  private async invalidateRefreshing(
    feedIds: number[],
    observeRefreshing = false,
    waitForSettlement = false,
  ): Promise<void> {
    for (const id of feedIds) this.trackedFeedIds.add(id);
    if (observeRefreshing) this.observeRefreshingFeeds = true;
    this.reloadArticlesAfterTracking = true;

    await this.refreshBootstrap();
    if (!this.hasTrackedWork()) {
      await this.flushTrackedArticleReload();
      return;
    }

    const settled = this.ensurePolling();
    if (waitForSettlement) await this.waitForTrackedSettlement(settled);
  }

  private async refreshBootstrap(): Promise<boolean> {
    if (!this.active || !this.binding) return true;
    const bootstrapMutationRevision = this.bootstrapMutationRevision;
    this.binding.setBootstrapError(null);
    try {
      const bootstrap = await this.bootstrapRequest.run((signal) => this.client.bootstrap(signal));
      if (!bootstrap) return false;
      if (!this.binding) return true;
      if (
        this.counterMutationCount > 0 ||
        bootstrapMutationRevision !== this.bootstrapMutationRevision
      ) {
        this.bootstrapRefreshDeferred = true;
        if (this.counterMutationCount === 0) this.queueInvalidation();
        return true;
      }
      this.binding.applyBootstrap(bootstrap);
      this.bootstrapRefreshDeferred = false;
      this.reconcileTrackedFeeds(bootstrap);
      return true;
    } catch (error) {
      this.binding?.setBootstrapError(errorMessage(error));
      if (this.bootstrapRefreshDeferred) this.queueInvalidation();
      return false;
    }
  }

  private reconcileTrackedFeeds(bootstrap: BootstrapData): void {
    if (this.observeRefreshingFeeds) {
      for (const feed of bootstrap.feeds) {
        if (feed.refreshing) this.trackedFeedIds.add(feed.id);
      }
      this.observeRefreshingFeeds = false;
    }

    for (const id of this.trackedFeedIds) {
      const feed = bootstrap.feeds.find((candidate) => candidate.id === id);
      if (!feed?.refreshing) this.trackedFeedIds.delete(id);
    }
  }

  private queueInvalidation = (): void => {
    if (!this.active) return;
    this.invalidationPending = true;
    this.finishInvalidationRetry();
    if (this.invalidationTask) return;
    const task = this.flushInvalidations();
    this.invalidationTask = task;
    void task.finally(() => {
      if (this.invalidationTask !== task) return;
      this.invalidationTask = null;
      if (this.active && this.invalidationPending) this.queueInvalidation();
    });
  };

  private async flushInvalidations(): Promise<void> {
    while (this.active && this.invalidationPending) {
      this.invalidationPending = false;
      if (await this.refreshBootstrap()) {
        if (await this.loadArticles("delivery")) {
          this.invalidationRetryMs = this.initialInvalidationRetryMs;
          continue;
        }
      }
      if (!this.active) return;
      this.invalidationPending = true;
      await this.waitForInvalidationRetry();
    }
  }

  private waitForInvalidationRetry(): Promise<void> {
    return new Promise((resolve) => {
      const delay = this.invalidationRetryMs;
      this.invalidationRetryMs = Math.min(delay * 2, MAX_INVALIDATION_RETRY_MS);
      this.resolveInvalidationRetry = resolve;
      this.invalidationRetryTimer = setTimeout(() => {
        this.invalidationRetryTimer = null;
        this.resolveInvalidationRetry = null;
        resolve();
      }, delay);
    });
  }

  private finishInvalidationRetry(): void {
    if (this.invalidationRetryTimer !== null) clearTimeout(this.invalidationRetryTimer);
    this.invalidationRetryTimer = null;
    const resolve = this.resolveInvalidationRetry;
    this.resolveInvalidationRetry = null;
    resolve?.();
  }

  private markRefreshing(feedIds: number[]): void {
    const ids = new Set(feedIds);
    this.mutateBootstrap((current) => ({
      ...current,
      feeds: current.feeds.map((feed) => (ids.has(feed.id) ? { ...feed, refreshing: true } : feed)),
    }));
  }

  private hasTrackedWork(): boolean {
    return this.trackedFeedIds.size > 0 || this.observeRefreshingFeeds;
  }

  private ensurePolling(): Promise<void> {
    if (this.pollTask) return this.pollTask;
    const task = this.pollRefreshing();
    this.pollTask = task;
    void task.finally(() => {
      if (this.pollTask === task) {
        this.pollTask = null;
        if (this.active && this.hasTrackedWork()) this.ensurePolling();
      }
    });
    return task;
  }

  private async waitForTrackedSettlement(initialTask: Promise<void>): Promise<void> {
    await initialTask;
    while (this.active && this.hasTrackedWork()) await this.ensurePolling();
  }

  private async pollRefreshing(): Promise<void> {
    while (this.active && this.hasTrackedWork()) {
      await this.waitForPoll();
      if (!this.active) return;
      await this.refreshBootstrap();
    }
    if (this.active) await this.flushTrackedArticleReload();
  }

  private async flushTrackedArticleReload(): Promise<void> {
    if (!this.reloadArticlesAfterTracking) return;
    this.reloadArticlesAfterTracking = false;
    await this.loadArticles("delivery");
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.resolvePollDelay = resolve;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.resolvePollDelay = null;
        resolve();
      }, this.pollIntervalMs);
    });
  }
}
