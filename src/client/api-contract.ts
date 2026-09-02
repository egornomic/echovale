import type {
  FeedSourceKind,
  FolderSortDirection,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  WebFeedConfig,
} from "../shared/types.js";

export const AUTH_REQUIRED_EVENT = "feedfold:auth-required";

const appBase =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL?.replace(/\/$/, "") ??
  "";

export function appUrl(path: string): string {
  return `${appBase}${path}`;
}

export class ApiError extends Error {
  status: number;
  code: string | null;
  operationId: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    operationId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.operationId = operationId;
  }
}

export interface FeedInput {
  title?: string;
  feedUrl: string;
  siteUrl?: string | null;
  folderId: number | null;
  sourceKind: FeedSourceKind;
  webConfig?: WebFeedConfig;
}

export type FeedUpdateInput = Partial<Omit<FeedInput, "sourceKind" | "webConfig">> & {
  paused?: boolean;
};

export interface FolderInput {
  name: string;
  parentId: number | null;
  sortDirection: FolderSortDirection;
}

export interface RuleInput {
  name: string;
  feedId: number | null;
  folderId: number | null;
  conditions: RuleCondition[];
  conditionOperator: RuleConditionOperator;
  action: RuleAction;
  enabled: boolean;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
