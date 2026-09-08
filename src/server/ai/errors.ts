export type AiErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_KEY_MISSING"
  | "AI_CREDENTIAL_STORAGE_UNAVAILABLE"
  | "AI_CREDENTIAL_UNREADABLE"
  | "AI_KEY_REJECTED"
  | "AI_MODEL_UNAVAILABLE"
  | "AI_REGION_UNSUPPORTED"
  | "AI_RATE_LIMITED"
  | "AI_PROVIDER_FAILED"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_RESPONSE_REFUSED"
  | "AI_RESPONSE_INVALID"
  | "ARTICLE_HAS_NO_TEXT"
  | "ARTICLE_CHANGED"
  | "CUSTOM_PROMPT_NOT_FOUND";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
