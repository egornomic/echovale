import type { BootstrapData } from "../../../shared/types.js";
import type { DeploymentPolicy } from "../../deployment-policy.js";
import type { ArticleRepository } from "../articles/repository.js";
import type { FeedService } from "../feeds/service.js";
import type { FolderService } from "../folders/service.js";
import type { SettingsService } from "../settings/service.js";

export class BootstrapService {
  constructor(
    private readonly articles: ArticleRepository,
    private readonly feeds: FeedService,
    private readonly folders: FolderService,
    private readonly settings: SettingsService,
    private readonly deploymentPolicy: DeploymentPolicy,
  ) {}

  getBootstrap(userId: number): Omit<BootstrapData, "aiSettings"> {
    return {
      folders: this.folders.listFolders(userId),
      feeds: this.feeds.listFeeds(userId),
      settings: this.settings.getSettings(userId),
      counts: this.articles.getCounts(userId),
      capabilities: { manualRefresh: this.deploymentPolicy.manualRefresh },
    };
  }
}
