import { describe, expect, it } from "vitest";

import { runRegimeEngine, runStrategyAnalysis, type StrategyContext } from "./strategyEngine";

function baseContext(prices: number[]): StrategyContext {
  const last = prices[prices.length - 1];
  return {
    symbol: "BTC/USDT:USDT",
    ticker: { last, high: last, low: last, percentage: 0.5, volume: 1000 },
    strategyId: "trend-breakout",
    prices,
    indicators: { rsi: 55, sma20: last - 1, stdDev: 1, isRealData: true },
    market: {
      sentiment: 50,
      volatility: 0.01,
      fundingRate: 0,
      openInterestChange: 0,
      macroRiskScore: 0,
      onChainData: { exchangeInflow: 0, whaleActivity: 50, activeAddresses: 1000, mvrvRatio: 1.8 },
    },
    risk: { estimatedFeeRate: 0.05, stopLoss: 2, takeProfit: 6 },
  };
}

describe("strategyEngine backtest options", () => {
  it("can lower trend regime threshold for walk-forward diagnostics without changing the default", () => {
    const prices = [
      ...Array.from({ length: 20 }, () => 100),
      ...Array.from({ length: 19 }, () => 107),
      108,
    ];
    const context = baseContext(prices);

    expect(runRegimeEngine(context).regime).toBe("RANGE");
    expect(runRegimeEngine({ ...context, strategyOptions: { trendRegimeThreshold: 0.25 } }).regime).toBe("TREND_UP");
  });

  it("blocks mean-reversion shorts in an obvious higher-timeframe uptrend", () => {
    const prices = Array.from({ length: 40 }, () => 100);
    const analysis = runStrategyAnalysis({
      ...baseContext(prices),
      strategyId: "mean-reversion",
      indicators: { rsi: 80, sma20: 95, stdDev: 2, isRealData: true },
      strategyOptions: {
        higherTimeframeTrend: { direction: "up", fourHourChangePct: 2, dailyChangePct: 3 },
      },
    });

    expect(analysis.signal).toBe("HOLD");
    expect(analysis.reasoning).toContain("higher timeframe uptrend blocks short");
  });
});
