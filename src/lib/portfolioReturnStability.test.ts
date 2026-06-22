import { describe, expect, it } from 'vitest';

import type { PortfolioReturnAnalytics } from './portfolioReturns';
import {
  createPortfolioReturnRequestKey,
  createPortfolioReturnStaleStatus,
  isCurrentPortfolioReturnRequest,
  isFreshPortfolioReturnCache,
  isUsableStalePortfolioReturnCache,
  withPortfolioReturnSourceStatus,
  withTimeout,
} from './portfolioReturnStability';

const analytics: PortfolioReturnAnalytics = {
  mode: 'live',
  range: '30d',
  requestKey: 'live:30d:200',
  generatedAt: 1_700_000_000_000,
  capitalBase: 10_000,
  capitalBaseSource: 'equity',
  sourceStatus: {
    state: 'fresh',
    fetchedAt: 1_700_000_000_000,
  },
  summary: {
    totalPnl: 12,
    realizedPnl: 12,
    unrealizedPnl: 0,
    accountReturnPct: 0.12,
    avgTradeRoiPct: 1.2,
    winRate: 100,
    profitFactor: 12,
    maxDrawdownPct: 0,
    closedTrades: 1,
    openTrades: 0,
    totalRows: 1,
    grossProfit: 12,
    grossLoss: 0,
    fees: 0,
    avgHoldMinutes: 0,
  },
  equityCurve: [],
  bySymbol: [],
  byStrategy: [],
  history: [],
};

describe('portfolioReturnStability', () => {
  it('creates isolated request keys for mode, range, and limit', () => {
    expect(createPortfolioReturnRequestKey('live', '30d', 200)).toBe('live:30d:200');
    expect(createPortfolioReturnRequestKey('demo', '30d', 200)).toBe('demo:30d:200');
    expect(createPortfolioReturnRequestKey('live', '7d', 200)).toBe('live:7d:200');
    expect(createPortfolioReturnRequestKey('live', '30d', 50)).toBe('live:30d:50');
  });

  it('separates fresh cache hits from stale-if-error cache hits', () => {
    const entry = { analytics, storedAt: 1_000 };

    expect(isFreshPortfolioReturnCache(entry, 1_500, 1_000)).toBe(true);
    expect(isFreshPortfolioReturnCache(entry, 2_500, 1_000)).toBe(false);
    expect(isUsableStalePortfolioReturnCache(entry, 2_500, 2_000)).toBe(true);
    expect(isUsableStalePortfolioReturnCache(entry, 3_500, 2_000)).toBe(false);
  });

  it('marks cached analytics as stale without changing the original payload', () => {
    const staleStatus = createPortfolioReturnStaleStatus(analytics, 'OKX timeout', 1_700_000_060_000);
    const stale = withPortfolioReturnSourceStatus(analytics, staleStatus);

    expect(stale.sourceStatus).toEqual({
      state: 'stale',
      message: 'OKX timeout',
      fetchedAt: 1_700_000_000_000,
      staleSince: 1_700_000_060_000,
    });
    expect(analytics.sourceStatus?.state).toBe('fresh');
  });

  it('rejects late responses and mismatched response keys', () => {
    expect(isCurrentPortfolioReturnRequest(3, 3, 'live:30d:200', 'live:30d:200')).toBe(true);
    expect(isCurrentPortfolioReturnRequest(2, 3, 'live:30d:200', 'live:30d:200')).toBe(false);
    expect(isCurrentPortfolioReturnRequest(3, 3, 'live:30d:200', 'demo:30d:200')).toBe(false);
  });

  it('times out slow OKX requests', async () => {
    await expect(withTimeout(new Promise((resolve) => setTimeout(resolve, 30)), 1, 'timeout')).rejects.toThrow('timeout');
    await expect(withTimeout(Promise.resolve('ok'), 30, 'timeout')).resolves.toBe('ok');
  });
});
