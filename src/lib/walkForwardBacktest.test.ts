import { describe, expect, it } from "vitest";

import {
  buildStrictFactorAudit,
  buildValidationSlice,
  createWalkForwardWindows,
  groupWalkForwardRounds,
  normalizeInitialEquity,
  normalizeStrategyIds,
  summarizeWalkForwardRounds,
} from "./walkForwardBacktest";

function makeOhlcv(length: number, start = 1_700_000_000_000, step = 60 * 60 * 1000) {
  return Array.from({ length }, (_, index) => {
    const price = 100 + index;
    return [start + index * step, price, price + 1, price - 1, price + 0.5, 1000 + index];
  });
}

describe("walkForwardBacktest helpers", () => {
  it("creates strictly ordered train and validation windows without overlap", () => {
    const ohlcv = makeOhlcv(24 * 12);
    const { windows, trainBars, validationBars, stepBars } = createWalkForwardWindows(ohlcv, {
      timeframe: "1h",
      trainDays: 5,
      validationDays: 2,
      stepDays: 2,
      warmupBars: 24,
    });

    expect(trainBars).toBe(120);
    expect(validationBars).toBe(48);
    expect(stepBars).toBe(48);
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(window.trainStart).toBeLessThanOrEqual(window.trainEnd);
      expect(window.trainEnd).toBeLessThan(window.validationStart);
      expect(window.validationStart).toBeLessThanOrEqual(window.validationEnd);
      expect(window.trainEndTime).toBeLessThan(window.validationStartTime);
    }
  });

  it("allows validation warmup bars but keeps trading start at validationStart", () => {
    const ohlcv = makeOhlcv(24 * 10);
    const { windows } = createWalkForwardWindows(ohlcv, {
      timeframe: "1h",
      trainDays: 4,
      validationDays: 2,
      stepDays: 1,
      warmupBars: 12,
    });
    const first = windows[0];
    const validation = buildValidationSlice(ohlcv, first);

    expect(first.warmupStart).toBeLessThan(first.validationStart);
    expect(validation.validationWarmup[0][0]).toBeLessThan(first.validationStartTime);
    expect(validation.tradeStartTime).toBe(first.validationStartTime);
  });

  it("keeps the two supported strategies isolated", () => {
    const strategyIds = normalizeStrategyIds(["trend-breakout", "mean-reversion", "trend-breakout", "unknown"]);
    const grouped = groupWalkForwardRounds([
      { strategy: "trend-breakout", symbol: "BTC/USDT", validation: { totalReturn: 8, maxDrawdown: 3, profitFactor: 2, totalTrades: 4 } },
      { strategy: "mean-reversion", symbol: "BTC/USDT", validation: { totalReturn: -2, maxDrawdown: 6, profitFactor: 0.8, totalTrades: 2 } },
    ]);

    expect(strategyIds).toEqual(["trend-breakout", "mean-reversion"]);
    expect(Object.keys(grouped).sort()).toEqual(["mean-reversion", "trend-breakout"]);
    expect(grouped["trend-breakout"].summary.medianReturn).toBe(8);
    expect(grouped["mean-reversion"].summary.medianReturn).toBe(-2);
  });

  it("uses initial equity as a stable positive denominator", () => {
    expect(normalizeInitialEquity(undefined)).toBe(10000);
    expect(normalizeInitialEquity(-5)).toBe(1);
    expect(normalizeInitialEquity(25000)).toBe(25000);
  });

  it("marks non point-in-time factors as disabled in strict mode", () => {
    const audit = buildStrictFactorAudit();
    const price = audit.find(item => item.factor === "price");
    const macro = audit.find(item => item.factor === "macro");
    const onchain = audit.find(item => item.factor === "onchain");
    const news = audit.find(item => item.factor === "news");

    expect(price?.usedInBacktest).toBe(true);
    expect(macro?.status).toBe("latest_revision_blocked");
    expect(onchain?.usedInBacktest).toBe(false);
    expect(news?.usedInBacktest).toBe(false);
  });

  it("summarizes drawdown, win rate, perturbation, and trade counts", () => {
    const summary = summarizeWalkForwardRounds([
      {
        validation: { totalReturn: 4, maxDrawdown: 5, profitFactor: 1.5, winRate: 60, totalTrades: 3 },
        perturbation: { medianReturn: 3, worstReturn: 1, fragile: false },
        validationStatus: "stable",
      },
      {
        validation: { totalReturn: -2, maxDrawdown: 8, profitFactor: 0.7, winRate: 40, trades: 2 },
        perturbation: { medianReturn: -3, worstReturn: -5, fragile: true },
        validationStatus: "fragile",
      },
      {
        validation: { totalReturn: 0, maxDrawdown: 0, profitFactor: 0, winRate: 0, totalTrades: 0 },
        perturbation: { medianReturn: 0, worstReturn: 0, fragile: false },
        validationStatus: "no_validation_trades",
      },
      {
        validation: { totalReturn: 0, maxDrawdown: 0, profitFactor: 0, winRate: 0, totalTrades: 0 },
        perturbation: { medianReturn: 0, worstReturn: 0, fragile: false },
        validationStatus: "insufficient_trades",
      },
    ]);

    expect(summary.rounds).toBe(4);
    expect(summary.validRounds).toBe(1);
    expect(summary.fragileRounds).toBe(1);
    expect(summary.noValidationTradeRounds).toBe(1);
    expect(summary.insufficientTradeRounds).toBe(1);
    expect(summary.medianReturn).toBe(0);
    expect(summary.worstReturn).toBe(-2);
    expect(summary.worstMaxDrawdown).toBe(8);
    expect(summary.medianWinRate).toBe(20);
    expect(summary.totalTrades).toBe(5);
  });
});
