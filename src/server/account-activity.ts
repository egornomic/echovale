const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const ACCOUNT_ACTIVITY_WINDOW_DAYS = 7;
export const ACCOUNT_ACTIVITY_TOUCH_MINUTES = 5;

function before(at: string, milliseconds: number): string {
  return new Date(Date.parse(at) - milliseconds).toISOString();
}

export function accountActivityCutoff(at: string): string {
  return before(at, ACCOUNT_ACTIVITY_WINDOW_DAYS * DAY_MS);
}

export function accountActivityTouchBefore(at: string): string {
  return before(at, ACCOUNT_ACTIVITY_TOUCH_MINUTES * MINUTE_MS);
}
