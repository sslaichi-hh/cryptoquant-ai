import { describe, expect, it } from 'vitest';

import {
  buildMarketRuntimeContext,
  calculateRiskManagedAmount,
  createDefaultMarketAnalysis,
  normalizeDisplaySymbol,
  normalizeTicker,
} from './tradingRuntime';

describe('tradingRuntime', () => {
  it('normalizes exchange symbols to display symbols', () => {
    expect(normalizeDisplaySymbol('BTC-USDT-SWAP')).toBe('BTC/USDT');
    expect(normalizeDisplaySymbol('eth/usdt:usdt')).toBe('ETH/USDT');
  });

  it('builds runtime context with real indicators when enough ohlcv points exist', () => {
    const previous = createDefaultMarketAnalysis();
    previous.onChainData.dxy = 101.25;
    previous.onChainData.m2 = 22667.3;
    previous.onChainData.dxySource = 'live';
    const now = Date.now();
    const rows = Array.from({ length: 30 }, (_, index) => [
      now + index * 60_000,
      100 + index,
      102 + index,
      99 + index,
      101 + index,
      1000 + index * 10,
    ]);
    const ticker = normalizeTicker('BTC/USDT', {
      last: 130,
      open24h: 120,
      high24h: 132,
      low24h: 118,
      vol24h: 50000,
    });
    const context = buildMarketRuntimeContext(
      'BTC/USDT',
      ticker,
      { fundingRate: 0.0001 },
      {
        bids: [[129, 5], [128, 4]],
        asks: [[130, 6], [131, 4]],
      },
      rows,
      previous,
      '1h'
    );

    expect(context.chartData).toHaveLength(30);
    expect(context.marketAnalysis.realIndicators.isRealData).toBe(true);
    expect(context.marketAnalysis.sentiment).toBeGreaterThan(0);
    expect(context.marketAnalysis.onChainData.dxy).toBe(101.25);
    expect(context.marketAnalysis.onChainData.m2).toBe(22667.3);
    expect(context.marketAnalysis.onChainData.dxySource).toBe('live');
  });

  it('calculates a bounded risk-managed amount', () => {
    const sizing = calculateRiskManagedAmount({
      balanceTotal: 1000,
      currentPrice: 100,
      stopLossPrice: 98,
      riskConfig: {
        stopLoss: 2,
        takeProfit: 6,
        maxPosition: 5,
        leverage: 3,
        dailyLossLimit: 3,
        maxConsecutiveLosses: 3,
        maxPositionPerSymbol: 15,
        maxTotalLeverage: 10,
        maxRiskPerSignal: 0.5,
        volatilityThreshold: 2,
        fundingRateThreshold: 0.08,
        autoTradeThreshold: 85,
        shadowMode: true,
        debugForceSignal: false,
        estimatedFeeRate: 0.05,
      },
      sizeMultiplier: 1,
    });

    expect(sizing.stopDistancePct).toBeCloseTo(0.02, 4);
    expect(sizing.amount).toBeGreaterThan(0);
    expect(sizing.amount).toBeLessThanOrEqual(50);
  });
});
