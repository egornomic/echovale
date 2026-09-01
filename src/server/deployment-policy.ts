export type DeploymentMode = "private" | "public";

export interface DeploymentPolicy {
  mode: DeploymentMode;
  manualRefresh: boolean;
  accountActivityWindowDays: number | null;
  maxFeedsPerAccount: number | null;
  maxPendingRefreshes: number | null;
}

export const PRIVATE_DEPLOYMENT_POLICY: DeploymentPolicy = {
  mode: "private",
  manualRefresh: true,
  accountActivityWindowDays: null,
  maxFeedsPerAccount: null,
  maxPendingRefreshes: null,
};

export const PUBLIC_DEPLOYMENT_POLICY: DeploymentPolicy = {
  mode: "public",
  manualRefresh: false,
  accountActivityWindowDays: 7,
  maxFeedsPerAccount: 300,
  maxPendingRefreshes: 2_000,
};

export function deploymentPolicy(value: string | undefined): DeploymentPolicy {
  if (value === undefined || value === "private") return PRIVATE_DEPLOYMENT_POLICY;
  if (value === "public") return PUBLIC_DEPLOYMENT_POLICY;
  throw new Error("FEEDFOLD_DEPLOYMENT_MODE must be private or public");
}
