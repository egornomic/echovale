export type DeploymentMode = "private" | "public";

export interface ResourceQuotas {
  feedDiscoveriesPerDay: number | null;
  webAnalysesPerDay: number | null;
  chromiumConcurrent: number | null;
  articleExtractionsPerDay: number | null;
  articleExtractionsConcurrent: number | null;
  mediaProxyRequestsPerDay: number | null;
  opmlUploadBytes: number | null;
  opmlFeedsPerImport: number | null;
  articlesPerAccount: number | null;
  storedBytesPerAccount: number | null;
  outboundRequestsConcurrent: number | null;
  outboundRequestsPerDay: number | null;
  registeredAccounts: number | null;
  globalStoredBytes: number | null;
}

export interface DeploymentPolicy {
  mode: DeploymentMode;
  manualRefresh: boolean;
  accountActivityWindowDays: number | null;
  maxFeedsPerAccount: number | null;
  maxPendingRefreshes: number | null;
  quotas: ResourceQuotas;
}

const UNLIMITED_QUOTAS: ResourceQuotas = {
  feedDiscoveriesPerDay: null,
  webAnalysesPerDay: null,
  chromiumConcurrent: null,
  articleExtractionsPerDay: null,
  articleExtractionsConcurrent: null,
  mediaProxyRequestsPerDay: null,
  opmlUploadBytes: null,
  opmlFeedsPerImport: null,
  articlesPerAccount: null,
  storedBytesPerAccount: null,
  outboundRequestsConcurrent: null,
  outboundRequestsPerDay: null,
  registeredAccounts: null,
  globalStoredBytes: null,
};

export const PUBLIC_RESOURCE_QUOTAS: ResourceQuotas = {
  feedDiscoveriesPerDay: 100,
  webAnalysesPerDay: 20,
  chromiumConcurrent: 2,
  articleExtractionsPerDay: 200,
  articleExtractionsConcurrent: 4,
  mediaProxyRequestsPerDay: 1_000,
  opmlUploadBytes: 1_048_576,
  opmlFeedsPerImport: 300,
  articlesPerAccount: 50_000,
  storedBytesPerAccount: 536_870_912,
  outboundRequestsConcurrent: 20,
  outboundRequestsPerDay: 50_000,
  registeredAccounts: 1_000,
  globalStoredBytes: 21_474_836_480,
};

export const PRIVATE_DEPLOYMENT_POLICY: DeploymentPolicy = {
  mode: "private",
  manualRefresh: true,
  accountActivityWindowDays: null,
  maxFeedsPerAccount: null,
  maxPendingRefreshes: null,
  quotas: UNLIMITED_QUOTAS,
};

export const PUBLIC_DEPLOYMENT_POLICY: DeploymentPolicy = {
  mode: "public",
  manualRefresh: false,
  accountActivityWindowDays: 7,
  maxFeedsPerAccount: 300,
  maxPendingRefreshes: 2_000,
  quotas: PUBLIC_RESOURCE_QUOTAS,
};

export function deploymentPolicy(
  value: string | undefined,
  quotaOverrides: Partial<ResourceQuotas> = {},
): DeploymentPolicy {
  if (value === undefined || value === "private") return PRIVATE_DEPLOYMENT_POLICY;
  if (value === "public") {
    if (Object.keys(quotaOverrides).length === 0) return PUBLIC_DEPLOYMENT_POLICY;
    return {
      ...PUBLIC_DEPLOYMENT_POLICY,
      quotas: { ...PUBLIC_RESOURCE_QUOTAS, ...quotaOverrides },
    };
  }
  throw new Error("FEEDFOLD_DEPLOYMENT_MODE must be private or public");
}

export function registrationAccountCap(
  policy: DeploymentPolicy,
  value: string | undefined,
): number {
  if (policy.mode === "private") return 1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
