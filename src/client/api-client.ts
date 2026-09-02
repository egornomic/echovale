import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
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
  BootstrapData,
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
  WebFeedConfig,
  XArticleMedia,
} from "../shared/types.js";
import type { FeedInput, FeedUpdateInput, FolderInput, RuleInput } from "./api-contract.js";

export interface ApiRuntime {
  request<T>(
    operation: DesktopOperation,
    payload: unknown,
    path: string,
    init?: RequestInit,
  ): Promise<T>;
  subscribeReaderDataInvalidations(listener: () => void): () => void;
  exportOpml(): Promise<void>;
}

export interface AuthConfig {
  registrationAvailable: boolean;
  passkeysAvailable: boolean;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

function queryString(query: ArticleQuery): string {
  const params = new URLSearchParams({ state: query.state });
  if (query.feedId !== undefined) params.set("feedId", String(query.feedId));
  if (query.folderId !== undefined) params.set("folderId", String(query.folderId));
  if (query.search) params.set("search", query.search);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.anchorId !== undefined) params.set("anchorId", String(query.anchorId));
  if (query.includeContent) params.set("includeContent", "true");
  return params.toString();
}

export function createApiClient(runtime: ApiRuntime) {
  const { request } = runtime;
  return {
    async session(): Promise<SessionUser> {
      const body = await request<{ user: SessionUser }>("session", undefined, "/api/auth/session");
      return body.user;
    },

    async login(username: string, password: string): Promise<SessionUser> {
      const body = await request<{ user: SessionUser }>(
        "login",
        { username, password },
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      return body.user;
    },

    async register(username: string, password: string): Promise<SessionUser> {
      const body = await request<{ user: SessionUser }>(
        "register",
        { username, password },
        "/api/auth/register",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      return body.user;
    },

    passkeySignupOptions: (username: string) =>
      request<{
        registrationId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>("passkeySignupOptions", { username }, "/api/auth/register/passkey/options", {
        method: "POST",
        body: JSON.stringify({ username }),
      }),

    async completePasskeySignup(
      registrationId: string,
      response: RegistrationResponseJSON,
    ): Promise<SessionUser> {
      const body = await request<{ user: SessionUser }>(
        "completePasskeySignup",
        { registrationId, response },
        "/api/auth/register/passkey",
        {
          method: "POST",
          body: JSON.stringify({ registrationId, response }),
        },
      );
      return body.user;
    },

    logout: () => request<void>("logout", undefined, "/api/auth/logout", { method: "POST" }),

    authConfig: () => request<AuthConfig>("authConfig", undefined, "/api/auth/config"),

    changePassword: (password: string) =>
      request<void>("changePassword", { password }, "/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ password }),
      }),

    removePassword: () =>
      request<void>("removePassword", undefined, "/api/auth/password", { method: "DELETE" }),

    deleteAccount: () =>
      request<void>("deleteAccount", undefined, "/api/auth/account", { method: "DELETE" }),

    async passkeys(): Promise<{ passkeys: PasskeySummary[]; hasPassword: boolean }> {
      return request<{ passkeys: PasskeySummary[]; hasPassword: boolean }>(
        "passkeys",
        undefined,
        "/api/auth/passkeys",
      );
    },

    passkeyRegistrationOptions: () =>
      request<{
        ceremonyId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>("passkeyRegistrationOptions", undefined, "/api/auth/passkeys/options", {
        method: "POST",
      }),

    registerPasskey: (ceremonyId: string, response: RegistrationResponseJSON) =>
      request<{ passkey: PasskeySummary }>(
        "registerPasskey",
        { ceremonyId, response },
        "/api/auth/passkeys",
        {
          method: "POST",
          body: JSON.stringify({ ceremonyId, response }),
        },
      ),

    renamePasskey: (id: string, name: string) =>
      request<{ passkey: PasskeySummary }>(
        "renamePasskey",
        { id, name },
        `/api/auth/passkeys/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      ),

    deletePasskey: (id: string) =>
      request<void>("deletePasskey", { id }, `/api/auth/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),

    stepUpPassword: (operationId: string, password: string) =>
      request<void>("stepUpPassword", { operationId, password }, "/api/auth/step-up/password", {
        method: "POST",
        body: JSON.stringify({ operationId, password }),
      }),

    stepUpPasskeyOptions: (operationId: string) =>
      request<{
        ceremonyId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>("stepUpPasskeyOptions", { operationId }, "/api/auth/step-up/passkey/options", {
        method: "POST",
        body: JSON.stringify({ operationId }),
      }),

    stepUpPasskey: (ceremonyId: string, response: AuthenticationResponseJSON) =>
      request<void>("stepUpPasskey", { ceremonyId, response }, "/api/auth/step-up/passkey", {
        method: "POST",
        body: JSON.stringify({ ceremonyId, response }),
      }),

    passkeyAuthenticationOptions: () =>
      request<{
        ceremonyId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>("passkeyAuthenticationOptions", undefined, "/api/auth/passkey/options", {
        method: "POST",
      }),

    async passkeyLogin(
      ceremonyId: string,
      response: AuthenticationResponseJSON,
    ): Promise<SessionUser> {
      const body = await request<{ user: SessionUser }>(
        "passkeyLogin",
        { ceremonyId, response },
        "/api/auth/passkey",
        {
          method: "POST",
          body: JSON.stringify({ ceremonyId, response }),
        },
      );
      return body.user;
    },

    bootstrap: (signal?: AbortSignal) =>
      request<BootstrapData>("bootstrap", undefined, "/api/bootstrap", { signal }),

    subscribeReaderDataInvalidations: runtime.subscribeReaderDataInvalidations,

    articles: (query: ArticleQuery, signal?: AbortSignal) =>
      request<ArticlePage>("articles", query, `/api/articles?${queryString(query)}`, { signal }),

    article: (id: number, signal?: AbortSignal) =>
      request<Article>("article", { id }, `/api/articles/${id}`, { signal }),

    telegramArticleMedia: (id: number, signal?: AbortSignal) =>
      request<TelegramArticleMedia>(
        "telegramArticleMedia",
        { id },
        `/api/articles/${id}/telegram-media`,
        { signal },
      ),

    xArticleMedia: (id: number, signal?: AbortSignal) =>
      request<XArticleMedia>("xArticleMedia", { id }, `/api/articles/${id}/x-media`, { signal }),

    loadFullContent: (id: number) =>
      request<Article>("loadFullContent", { id }, `/api/articles/${id}/extract`, {
        method: "POST",
      }),

    summarizeArticle: (id: number, promptId: string | null, regenerate = false) =>
      request<ArticleAiSummary>(
        "summarizeArticle",
        { id, promptId, regenerate },
        `/api/articles/${id}/summary`,
        {
          method: "POST",
          body: JSON.stringify({ promptId, regenerate }),
        },
      ),

    translateArticle: (id: number, sourceKind: AiArticleSourceKind) =>
      request<ArticleAiTranslation>(
        "translateArticle",
        { id, sourceKind },
        `/api/articles/${id}/translation`,
        {
          method: "POST",
          body: JSON.stringify({ sourceKind }),
        },
      ),

    updateArticleState: (id: number, state: { isRead?: boolean; isStarred?: boolean }) =>
      request<Article>("updateArticleState", { id, state }, `/api/articles/${id}/state`, {
        method: "PATCH",
        body: JSON.stringify(state),
      }),

    markRead: (body: MarkReadRequest) =>
      request<{ updated: number }>("markRead", body, "/api/articles/mark-read", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    refresh: (feedIds?: number[]) =>
      request<RefreshResult>("refresh", feedIds ? { feedIds } : {}, "/api/refresh", {
        method: "POST",
        body: JSON.stringify(feedIds ? { feedIds } : {}),
      }),

    discoverFeed: (url: string) =>
      request<FeedDiscoveryResult>("discoverFeed", { url }, "/api/feeds/discover", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),

    analyzeWebPage: (url: string) =>
      request<WebFeedAnalysis>("analyzeWebPage", { url }, "/api/web-feeds/analyze", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),

    createFeed: (input: FeedInput) =>
      request<Feed>("createFeed", input, "/api/feeds", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    feed: (id: number) => request<Feed>("feed", { id }, `/api/feeds/${id}`),

    updateFeed: (id: number, input: FeedUpdateInput) =>
      request<Feed>("updateFeed", { id, input }, `/api/feeds/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    deleteFeed: (id: number) =>
      request<void>("deleteFeed", { id }, `/api/feeds/${id}`, { method: "DELETE" }),

    analyzeWebFeed: (id: number) =>
      request<WebFeedAnalysis>("analyzeWebFeed", { id }, `/api/feeds/${id}/web-feed/analyze`, {
        method: "POST",
      }),

    updateWebFeedSelection: (id: number, config: WebFeedConfig) =>
      request<Feed>("updateWebFeedSelection", { id, config }, `/api/feeds/${id}/web-feed`, {
        method: "PATCH",
        body: JSON.stringify({ config }),
      }),

    createFolder: (input: FolderInput) =>
      request<Folder>("createFolder", input, "/api/folders", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateFolder: (id: number, input: Partial<FolderInput>) =>
      request<Folder>("updateFolder", { id, input }, `/api/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    deleteFolder: (id: number) =>
      request<void>("deleteFolder", { id }, `/api/folders/${id}`, { method: "DELETE" }),

    async rules(signal?: AbortSignal): Promise<Rule[]> {
      const body = await request<{ rules: Rule[] }>("rules", undefined, "/api/rules", {
        signal,
      });
      return body.rules;
    },

    createRule: (input: RuleInput) =>
      request<Rule>("createRule", input, "/api/rules", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateRule: (id: number, input: Partial<RuleInput>) =>
      request<Rule>("updateRule", { id, input }, `/api/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    deleteRule: (id: number) =>
      request<void>("deleteRule", { id }, `/api/rules/${id}`, { method: "DELETE" }),

    updateSettings: (input: Partial<AppSettings>) =>
      request<AppSettings>("updateSettings", input, "/api/settings", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    aiSettings: () => request<AiSettings>("aiSettings", undefined, "/api/ai/settings"),

    updateAiFeature: (feature: AiFeature, input: { provider: AiProvider; model?: string }) =>
      request<AiSettings>("updateAiFeature", { feature, input }, `/api/ai/features/${feature}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    saveAiProviderKey: (provider: AiProvider, apiKey: string) =>
      request<AiSettings>(
        "saveAiProviderKey",
        { provider, apiKey },
        `/api/ai/providers/${provider}/key`,
        {
          method: "PUT",
          body: JSON.stringify({ apiKey }),
        },
      ),

    deleteAiProviderKey: (provider: AiProvider) =>
      request<AiSettings>(
        "deleteAiProviderKey",
        { provider },
        `/api/ai/providers/${provider}/key`,
        {
          method: "DELETE",
        },
      ),

    async importOpml(file: File): Promise<ImportResult> {
      const opml = await file.text();
      return request<ImportResult>("importOpml", { opml }, "/api/opml/import", {
        method: "POST",
        body: JSON.stringify({ opml }),
      });
    },

    exportOpml: runtime.exportOpml,
  };
}
