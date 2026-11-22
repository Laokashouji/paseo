export type MainChatErrorClass = "transient" | "usage_limit" | "user";

const USER_PATTERNS = [
  /failed to authenticate/i,
  /oauth token has expired/i,
  /invalid api key/i,
  /not logged in/i,
  /please run \/login/i,
  /\b(400|401|403|413)\b/,
  /invalid_request_error/i,
  /prompt is too long/i,
  /context (length|window)/i,
  /model .*(not found|unavailable|does not exist)/i,
  /request was aborted/i,
];

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /usage_limit/i,
  /quota reached/i,
  /rate limit reset/i,
  /limit will reset/i,
  /resets? in \d+/i,
];

const TRANSIENT_PATTERNS = [
  /\b(408|429|500|502|503|504|529)\b/,
  /overloaded/i,
  /connection (error|lost|reset|closed)/i,
  /timed? ?out/i,
  /socket hang up/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /fetch failed/i,
  /no eligible upstream/i,
  /upstream/i,
  /network error/i,
  /stream (ended|disconnected)/i,
];

const MIN_USAGE_LIMIT_DELAY_MS = 30_000;
const MAX_USAGE_LIMIT_DELAY_MS = 4 * 60 * 60 * 1000;
const DEFAULT_USAGE_LIMIT_DELAY_MS = 10 * 60 * 1000;

/**
 * Classifies turn failure messages so the supervisor auto-continues transient hiccups,
 * schedules delayed recovery on usage limits, and never loops on auth/user errors.
 */
export function classifyMainChatTurnError(message: string): MainChatErrorClass {
  if (USER_PATTERNS.some((pattern) => pattern.test(message))) return "user";
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return "usage_limit";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "user";
}

function clampUsageLimitDelay(ms: number): number {
  return Math.min(MAX_USAGE_LIMIT_DELAY_MS, Math.max(MIN_USAGE_LIMIT_DELAY_MS, ms));
}

/**
 * Extracts a reset countdown from provider usage-limit error text (e.g. "Resets in 2h 15m",
 * "retry in 45m", "30分钟后重置") and clamps it to a safe scheduling window.
 */
export function parseUsageLimitResetDelayMs(
  message: string,
  fallbackMs: number = DEFAULT_USAGE_LIMIT_DELAY_MS,
): number {
  const hourMatch = /(\d+)\s*(?:h|hr|hrs|hour|hours|小时)/i.exec(message);
  const minuteMatch = /(\d+)\s*(?:m|min|mins|minute|minutes|分钟|分)/i.exec(message);
  const secondMatch = /(\d+)\s*(?:s|sec|secs|second|seconds|秒)/i.exec(message);

  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minuteMatch ? Number(minuteMatch[1]) : 0;
  const seconds = secondMatch ? Number(secondMatch[1]) : 0;

  const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  if (totalMs > 0) {
    return clampUsageLimitDelay(totalMs);
  }
  return clampUsageLimitDelay(fallbackMs);
}
