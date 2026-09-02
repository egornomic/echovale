import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { SqliteError } from "better-sqlite3";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import { ZodError } from "zod";
import { AiError } from "./ai/errors.js";
import type { AppDatabase } from "./database.js";
import { InvalidRequestError } from "./errors.js";
import type { ExtractionQueue } from "./extraction.js";
import { aiRoutes } from "./features/ai/routes.js";
import { AiService } from "./features/ai/service.js";
import { articleRoutes } from "./features/articles/routes.js";
import { authRoutes } from "./features/auth/routes.js";
import { type AuthService, sessionToken } from "./features/auth/service.js";
import { bootstrapRoutes } from "./features/bootstrap/routes.js";
import { feedRoutes } from "./features/feeds/routes.js";
import { folderRoutes } from "./features/folders/routes.js";
import { opmlRoutes } from "./features/opml/routes.js";
import { refreshRoutes } from "./features/refresh/routes.js";
import { ruleRoutes } from "./features/rules/routes.js";
import { settingsRoutes } from "./features/settings/routes.js";
import { registerOperationalLogging } from "./logging.js";
import type { FeedRefreshService } from "./refresh.js";
import { TelegramMediaService } from "./telegram-media.js";
import { WebFeedError, type WebFeedService } from "./web-feed.js";
import { XMediaService } from "./x-media.js";

export interface AppServices {
  database: AppDatabase;
  authService: AuthService;
  extractionQueue: ExtractionQueue;
  refreshService: FeedRefreshService;
  webFeedService?: WebFeedService;
  aiService?: AiService;
  telegramMediaService?: TelegramMediaService;
  xMediaService?: XMediaService;
  feedDiscoveryTimeoutMs?: number;
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  publicOrigin?: string;
}

export async function createApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: services.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: ["loopback", "linklocal", "uniquelocal"],
  });
  registerOperationalLogging(app);
  const ai =
    services.aiService ??
    new AiService(services.database, {
      credentialCipher: null,
    });
  const telegramMedia =
    services.telegramMediaService ??
    new TelegramMediaService(services.feedDiscoveryTimeoutMs ?? 15_000);
  const xMedia =
    services.xMediaService ?? new XMediaService(services.feedDiscoveryTimeoutMs ?? 15_000);
  const requestUsers = new WeakMap<FastifyRequest, { id: number; username: string }>();
  const userId = (request: FastifyRequest): number => {
    const user = requestUsers.get(request);
    if (!user) throw new Error("Authenticated user is missing");
    return user.id;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AiError) {
      reply.code(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof WebFeedError) {
      reply.code(422).send({ error: error.message, code: error.kind });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues[0]?.message ?? "The request is invalid." });
      return;
    }
    if (error instanceof InvalidRequestError) {
      reply.code(400).send({ error: error.message });
      return;
    }
    if (error instanceof SqliteError) {
      if (
        error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      ) {
        reply.code(409).send({ error: "This item already exists." });
        return;
      }
      if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        reply
          .code(400)
          .send({ error: "That feed or folder no longer exists. Reload and try again." });
        return;
      }
    }
    request.log.error({ event: "request_handler_failed" }, "request handler failed");
    reply.code(500).send({ error: "The server could not complete the request. Try again." });
  });

  app.get("/health", async () => {
    services.database.connection.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: http: https:",
        "media-src 'self' blob: http: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self' https://www.youtube.com",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self)",
    );
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    if (request.protocol === "https" || services.publicOrigin?.startsWith("https://")) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const path = request.url.split("?", 1)[0];
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const expectedOrigin =
        services.publicOrigin ??
        `${request.protocol}://${request.headers.host ?? request.hostname}`;
      if (request.headers.origin && request.headers.origin !== new URL(expectedOrigin).origin) {
        return reply.code(403).send({ error: "This request is not allowed." });
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        return reply.code(403).send({ error: "This request is not allowed." });
      }
    }
    if (
      path === "/api/auth/config" ||
      path === "/api/auth/login" ||
      path === "/api/auth/register" ||
      path === "/api/auth/register/passkey/options" ||
      path === "/api/auth/register/passkey" ||
      path === "/api/auth/session" ||
      path === "/api/auth/passkey/options" ||
      path === "/api/auth/passkey"
    )
      return;
    const user = services.authService.userForToken(sessionToken(request.headers.cookie));
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    requestUsers.set(request, user);
    const sensitive =
      (request.method === "POST" &&
        (path === "/api/auth/passkeys/options" || path === "/api/auth/passkeys")) ||
      (request.method === "DELETE" && path.startsWith("/api/auth/passkeys/")) ||
      (["PUT", "DELETE"].includes(request.method) && path === "/api/auth/password") ||
      (["PUT", "DELETE"].includes(request.method) &&
        /^\/api\/ai\/providers\/[^/]+\/key$/.test(path));
    if (sensitive) {
      const recent = services.authService.beginSensitiveOperation(
        sessionToken(request.headers.cookie),
      );
      if (!recent) return reply.code(401).send({ error: "Sign in to continue." });
      if (recent.required) {
        return reply.code(428).send({
          error: "Authenticate again to continue.",
          code: "RECENT_AUTH_REQUIRED",
          operationId: recent.operationId,
        });
      }
    }
  });

  await app.register(authRoutes, {
    authService: services.authService,
    configuredOrigin: services.publicOrigin,
  });
  await app.register(bootstrapRoutes, {
    bootstrap: services.database.bootstrap,
    ai,
    userId,
  });
  await app.register(articleRoutes, {
    articles: services.database.articles,
    extractions: services.database.extractions,
    extractionQueue: services.extractionQueue,
    ai,
    telegramMedia,
    xMedia,
    userId,
  });
  await app.register(feedRoutes, {
    feeds: services.database.feeds,
    refreshService: services.refreshService,
    webFeedService: services.webFeedService,
    feedDiscoveryTimeoutMs: services.feedDiscoveryTimeoutMs,
    userId,
  });
  await app.register(folderRoutes, { folders: services.database.folders, userId });
  await app.register(ruleRoutes, { rules: services.database.rules, userId });
  await app.register(settingsRoutes, { settings: services.database.settings, userId });
  await app.register(aiRoutes, { ai, userId });
  await app.register(refreshRoutes, {
    feeds: services.database.feeds,
    refreshService: services.refreshService,
    authService: services.authService,
    userId,
  });
  await app.register(opmlRoutes, {
    opml: services.database.opml,
    refreshService: services.refreshService,
    userId,
  });

  if (services.staticDir && existsSync(join(services.staticDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: services.staticDir,
      wildcard: false,
      setHeaders(response, path) {
        if (path.endsWith("sw.js")) response.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send({ error: "This page does not exist." });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
