export const OKX_AUTO_DATA_REQUEST_TIMEOUT_MS = 25_000;

export const AUTO_TRADING_DATA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

export const AUTO_TRADING_RECONNECT_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const;

const CONNECTIVITY_ERROR_TOKENS = [
  "fetch failed",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "timed out",
  "timeout",
  "network timeout",
  "socket hang up",
  "api/v5/asset/currencies",
  "api/v5/account/balance",
  "api/v5/account/positions",
] as const;

export function getReconnectDelayMs(consecutiveFailures: number) {
  const normalizedFailures = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
  const index = Math.min(normalizedFailures - 1, AUTO_TRADING_RECONNECT_DELAYS_MS.length - 1);
  return AUTO_TRADING_RECONNECT_DELAYS_MS[index];
}

export function getDataRetryDelayMs(retryIndex: number) {
  const index = Math.max(0, Math.min(Math.floor(Number(retryIndex) || 0), AUTO_TRADING_DATA_RETRY_DELAYS_MS.length - 1));
  return AUTO_TRADING_DATA_RETRY_DELAYS_MS[index];
}

export function createReconnectSchedule(consecutiveFailures: number, now = Date.now()) {
  const delayMs = getReconnectDelayMs(consecutiveFailures);
  return {
    delayMs,
    nextRetryAt: now + delayMs,
  };
}

export function isExchangeConnectivityErrorDetails(details: string) {
  const normalized = String(details || "");
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return CONNECTIVITY_ERROR_TOKENS.some((token) => lower.includes(token.toLowerCase()));
}
