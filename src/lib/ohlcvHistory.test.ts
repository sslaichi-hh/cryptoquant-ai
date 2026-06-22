import { describe, expect, it } from "vitest";

import {
  calculateOhlcvStartSince,
  nextOhlcvSince,
  normalizeOhlcvHistory,
  timeframeToMilliseconds,
} from "./ohlcvHistory";

describe("ohlcvHistory helpers", () => {
  it("converts common backtest timeframes to milliseconds", () => {
    expect(timeframeToMilliseconds("15m")).toBe(15 * 60 * 1000);
    expect(timeframeToMilliseconds("1h")).toBe(60 * 60 * 1000);
    expect(timeframeToMilliseconds("4h")).toBe(4 * 60 * 60 * 1000);
    expect(timeframeToMilliseconds("1d")).toBe(24 * 60 * 60 * 1000);
  });

  it("calculates an old enough start timestamp with padding bars", () => {
    const now = 1_700_000_000_000;
    expect(calculateOhlcvStartSince({ timeframe: "1h", limit: 10, now, paddingBars: 2 }))
      .toBe(now - 12 * 60 * 60 * 1000);
  });

  it("deduplicates and sorts paged OHLCV batches before limiting", () => {
    const result = normalizeOhlcvHistory([
      [
        [3000, 3, 4, 2, 3.5, 30],
        [1000, 1, 2, 0, 1.5, 10],
      ],
      [
        [2000, 2, 3, 1, 2.5, 20],
        [3000, 33, 34, 32, 33.5, 330],
      ],
    ], 3);

    expect(result.map(row => row[0])).toEqual([1000, 2000, 3000]);
    expect(result[2][1]).toBe(33);
  });

  it("returns a forward cursor only when a batch advances", () => {
    expect(nextOhlcvSince([[1000], [2000]], 999)).toBe(2001);
    expect(nextOhlcvSince([[1000]], 1001)).toBeNull();
    expect(nextOhlcvSince([], 1000)).toBeNull();
  });
});
