import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialCipher } from "./ai/credential-cipher.js";
import { createApp } from "./app.js";
import { AppDatabase } from "./database.js";
import { deploymentPolicy, registrationAccountCap } from "./deployment-policy.js";
import { ExtractionQueue } from "./extraction.js";
import { AiService } from "./features/ai/service.js";
import { AuthService } from "./features/auth/service.js";
import { productionListenMessage, productionLogger } from "./logging.js";
import { closePublicNetwork } from "./public-network.js";
import { FeedRefreshService } from "./refresh.js";
import { WebFeedService } from "./web-feed.js";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function configuredPublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = new URL(value);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("FEEDFOLD_PUBLIC_ORIGIN must be an http(s) origin without a path");
  }
  if (
    origin.protocol !== "https:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "127.0.0.1" &&
    origin.hostname !== "::1"
  ) {
    throw new Error("FEEDFOLD_PUBLIC_ORIGIN must use HTTPS unless it is localhost");
  }
  return origin.origin;
}

const host = process.env.HOST ?? "127.0.0.1";
const port = positiveInteger(process.env.PORT, 3000, "PORT");
const configuredDatabasePath = process.env.DATABASE_PATH;
const databasePath = resolve(configuredDatabasePath ?? "./data/feedfold.db");
const pollIntervalMinutes = positiveInteger(
  process.env.POLL_INTERVAL_MINUTES,
  20,
  "POLL_INTERVAL_MINUTES",
);
const feedFetchTimeoutMs = positiveInteger(
  process.env.FEED_FETCH_TIMEOUT_MS,
  15_000,
  "FEED_FETCH_TIMEOUT_MS",
);
const webFeedLoadTimeoutMs = positiveInteger(
  process.env.WEB_FEED_LOAD_TIMEOUT_MS,
  30_000,
  "WEB_FEED_LOAD_TIMEOUT_MS",
);
const articleFetchTimeoutMs = positiveInteger(
  process.env.ARTICLE_FETCH_TIMEOUT_MS,
  20_000,
  "ARTICLE_FETCH_TIMEOUT_MS",
);
const aiRequestTimeoutMs = positiveInteger(
  process.env.AI_REQUEST_TIMEOUT_MS,
  60_000,
  "AI_REQUEST_TIMEOUT_MS",
);
const staticDir = fileURLToPath(new URL("../client", import.meta.url));
const publicOrigin = configuredPublicOrigin(process.env.FEEDFOLD_PUBLIC_ORIGIN);
const policy = deploymentPolicy(process.env.FEEDFOLD_DEPLOYMENT_MODE);
const registrationCooldownMinutes = positiveInteger(
  process.env.FEEDFOLD_REGISTRATION_COOLDOWN_MINUTES,
  60,
  "FEEDFOLD_REGISTRATION_COOLDOWN_MINUTES",
);
const loginCooldownMinutes = positiveInteger(
  process.env.FEEDFOLD_LOGIN_COOLDOWN_MINUTES,
  15,
  "FEEDFOLD_LOGIN_COOLDOWN_MINUTES",
);
const stepUpCooldownMinutes = positiveInteger(
  process.env.FEEDFOLD_STEP_UP_COOLDOWN_MINUTES,
  15,
  "FEEDFOLD_STEP_UP_COOLDOWN_MINUTES",
);

mkdirSync(dirname(databasePath), { recursive: true });
const database = new AppDatabase(databasePath, pollIntervalMinutes, policy);
const authService = new AuthService(database.auth, pollIntervalMinutes, {
  maxAccounts: registrationAccountCap(policy, process.env.FEEDFOLD_MAX_ACCOUNTS),
  recentAuthenticationSeconds: positiveInteger(
    process.env.FEEDFOLD_RECENT_AUTH_SECONDS,
    300,
    "FEEDFOLD_RECENT_AUTH_SECONDS",
  ),
  rateLimits: {
    registrationPerIp: {
      attempts: positiveInteger(
        process.env.FEEDFOLD_REGISTRATION_IP_LIMIT,
        10,
        "FEEDFOLD_REGISTRATION_IP_LIMIT",
      ),
      windowMs: registrationCooldownMinutes * 60_000,
    },
    registrationGlobal: {
      attempts: positiveInteger(
        process.env.FEEDFOLD_REGISTRATION_GLOBAL_LIMIT,
        100,
        "FEEDFOLD_REGISTRATION_GLOBAL_LIMIT",
      ),
      windowMs: registrationCooldownMinutes * 60_000,
    },
    loginPerIp: {
      attempts: positiveInteger(process.env.FEEDFOLD_LOGIN_IP_LIMIT, 50, "FEEDFOLD_LOGIN_IP_LIMIT"),
      windowMs: loginCooldownMinutes * 60_000,
    },
    loginPerAccount: {
      attempts: positiveInteger(
        process.env.FEEDFOLD_LOGIN_ACCOUNT_LIMIT,
        10,
        "FEEDFOLD_LOGIN_ACCOUNT_LIMIT",
      ),
      windowMs: loginCooldownMinutes * 60_000,
    },
    stepUp: {
      attempts: positiveInteger(process.env.FEEDFOLD_STEP_UP_LIMIT, 10, "FEEDFOLD_STEP_UP_LIMIT"),
      windowMs: stepUpCooldownMinutes * 60_000,
    },
  },
});
const extractionQueue = new ExtractionQueue(database.extractions, 2, articleFetchTimeoutMs);
const webFeedService = new WebFeedService({ timeoutMs: webFeedLoadTimeoutMs });
const refreshService = new FeedRefreshService(
  database.feeds,
  3,
  feedFetchTimeoutMs,
  webFeedService,
);
const aiService = new AiService(database, {
  credentialCipher: CredentialCipher.fromHex(process.env.AI_CREDENTIALS_KEY),
  requestTimeoutMs: aiRequestTimeoutMs,
});
const app = await createApp({
  database,
  authService,
  extractionQueue,
  refreshService,
  webFeedService,
  aiService,
  feedDiscoveryTimeoutMs: feedFetchTimeoutMs,
  staticDir,
  logger: process.env.NODE_ENV === "production" ? productionLogger() : false,
  publicOrigin,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Stopping feedfold");
  try {
    await app.close();
    await Promise.all([refreshService.stop(), extractionQueue.stop()]);
    await webFeedService.close();
    await closePublicNetwork();
    database.close();
  } catch {
    app.log.error({ event: "shutdown_failed" }, "feedfold did not shut down cleanly");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  extractionQueue.start();
  refreshService.start();
  await app.listen({ host, port, listenTextResolver: productionListenMessage });
} catch {
  app.log.error({ event: "startup_failed" }, "feedfold failed to start");
  await Promise.all([refreshService.stop(), extractionQueue.stop()]);
  await webFeedService.close();
  await closePublicNetwork();
  database.close();
  process.exitCode = 1;
}
