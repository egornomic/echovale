export type AddFeedSourceType = "rss" | "web" | "telegram" | "x";

export const TELEGRAM_HANDLE_PATTERN = "@?[A-Za-z0-9_]{5,32}";
export const X_HANDLE_PATTERN = "@?[A-Za-z0-9_]{1,15}";

const telegramHandle = new RegExp(`^${TELEGRAM_HANDLE_PATTERN}$`);
const xHandle = new RegExp(`^${X_HANDLE_PATTERN}$`);

export function feedSourceUrl(sourceType: AddFeedSourceType, input: string): string {
  const value = input.trim();
  const handle = value.replace(/^@/, "");

  if (sourceType === "telegram") {
    if (!telegramHandle.test(value)) {
      throw new Error("Enter a Telegram handle with 5–32 letters, numbers, or underscores.");
    }
    return `https://t.me/${handle}`;
  }

  if (sourceType === "x") {
    if (!xHandle.test(value)) {
      throw new Error("Enter an X handle with 1–15 letters, numbers, or underscores.");
    }
    return `https://x.com/${handle}`;
  }

  return value;
}
