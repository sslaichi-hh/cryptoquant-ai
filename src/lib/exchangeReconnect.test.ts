import { describe, expect, it } from "vitest";

import {
  createReconnectSchedule,
  getDataRetryDelayMs,
  getReconnectDelayMs,
  isExchangeConnectivityErrorDetails,
} from "./exchangeReconnect";

describe("exchange reconnect helpers", () => {
  it("backs off auto-trading reconnect attempts and caps at five minutes", () => {
    expect(getReconnectDelayMs(1)).toBe(30_000);
    expect(getReconnectDelayMs(2)).toBe(60_000);
    expect(getReconnectDelayMs(3)).toBe(120_000);
    expect(getReconnectDelayMs(4)).toBe(300_000);
    expect(getReconnectDelayMs(12)).toBe(300_000);
  });

  it("uses the configured data retry delays", () => {
    expect(getDataRetryDelayMs(0)).toBe(2_000);
    expect(getDataRetryDelayMs(1)).toBe(5_000);
    expect(getDataRetryDelayMs(2)).toBe(10_000);
    expect(getDataRetryDelayMs(10)).toBe(10_000);
  });

  it("creates a deterministic next retry timestamp", () => {
    expect(createReconnectSchedule(2, 1_000)).toEqual({
      delayMs: 60_000,
      nextRetryAt: 61_000,
    });
  });

  it("recognizes OKX timeout and private account connectivity failures", () => {
    expect(isExchangeConnectivityErrorDetails("okx GET https://www.okx.com/api/v5/account/balance request timed out (10000 ms)")).toBe(true);
    expect(isExchangeConnectivityErrorDetails("connect ETIMEDOUT 1.2.3.4:443")).toBe(true);
    expect(isExchangeConnectivityErrorDetails("Invalid order: insufficient margin")).toBe(false);
  });
});
