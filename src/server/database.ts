import Sqlite from "better-sqlite3";
import { normalizeFeedPollInterval } from "../shared/types.js";
import { type DeploymentPolicy, PRIVATE_DEPLOYMENT_POLICY } from "./deployment-policy.js";
import { AiRepository } from "./features/ai/repository.js";
import { ArticleRepository } from "./features/articles/repository.js";
import { AuthRepository } from "./features/auth/repository.js";
import { BootstrapService } from "./features/bootstrap/service.js";
import { ExtractionRepository } from "./features/extraction/repository.js";
import { ExtractionService } from "./features/extraction/service.js";
import { FeedRepository } from "./features/feeds/repository.js";
import { FeedService } from "./features/feeds/service.js";
import { FolderRepository } from "./features/folders/repository.js";
import { FolderService } from "./features/folders/service.js";
import { OpmlService } from "./features/opml/service.js";
import { RuleRepository } from "./features/rules/repository.js";
import { SettingsRepository } from "./features/settings/repository.js";
import { SettingsService } from "./features/settings/service.js";
import { WEB_FEED_POLL_INTERVAL_MINUTES } from "./features/shared.js";
import { migrateDatabase } from "./migrations.js";

export type { ParsedArticle, ParsedFeed } from "./features/shared.js";

export class AppDatabase {
  readonly connection: Sqlite.Database;
  readonly wasNewDatabase: boolean;
  readonly ai: AiRepository;
  readonly articles: ArticleRepository;
  readonly auth: AuthRepository;
  readonly bootstrap: BootstrapService;
  readonly extractions: ExtractionService;
  readonly feeds: FeedService;
  readonly folders: FolderService;
  readonly opml: OpmlService;
  readonly rules: RuleRepository;
  readonly settings: SettingsService;
  readonly deploymentPolicy: DeploymentPolicy;

  constructor(
    path: string,
    defaultPollIntervalMinutes = 20,
    deploymentPolicy = PRIVATE_DEPLOYMENT_POLICY,
  ) {
    this.deploymentPolicy = deploymentPolicy;
    this.connection = new Sqlite(path);
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("journal_mode = WAL");
    this.wasNewDatabase =
      this.connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .get() === undefined;
    migrateDatabase(this.connection, WEB_FEED_POLL_INTERVAL_MINUTES);
    if (this.wasNewDatabase && defaultPollIntervalMinutes !== 20) {
      this.connection
        .prepare("UPDATE settings SET poll_interval_minutes = ? WHERE user_id = 1")
        .run(normalizeFeedPollInterval(defaultPollIntervalMinutes));
    }
    this.connection.prepare("UPDATE feed_sources SET refreshing = 0 WHERE refreshing = 1").run();
    this.connection
      .prepare(
        "UPDATE articles SET extraction_status = 'pending' WHERE extraction_status = 'processing'",
      )
      .run();

    this.ai = new AiRepository(this.connection);
    this.articles = new ArticleRepository(this.connection);
    this.auth = new AuthRepository(this.connection);
    this.rules = new RuleRepository(this.connection);
    const settingsRepository = new SettingsRepository(this.connection);
    this.settings = new SettingsService(this.connection, settingsRepository, this.ai);

    const folderRepository = new FolderRepository(this.connection);
    const feedRepository = new FeedRepository(
      this.connection,
      folderRepository,
      deploymentPolicy.accountActivityWindowDays,
    );
    const extractionRepository = new ExtractionRepository(this.connection);
    this.folders = new FolderService(this.connection, folderRepository, this.rules);
    this.feeds = new FeedService(
      this.connection,
      feedRepository,
      folderRepository,
      this.articles,
      this.rules,
      deploymentPolicy,
    );
    this.extractions = new ExtractionService(this.connection, extractionRepository, this.rules);
    this.bootstrap = new BootstrapService(
      this.articles,
      this.feeds,
      this.folders,
      this.settings,
      deploymentPolicy,
    );
    this.opml = new OpmlService(this.feeds, this.folders);
  }

  close(): void {
    this.connection.close();
  }
}
