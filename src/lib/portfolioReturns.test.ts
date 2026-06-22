import { describe, expect, it } from 'vitest';

import { buildPortfolioReturnAnalytics } from './portfolioReturns';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('portfolioReturns', () => {
  it('builds non-zero live history from OKX account bills and enriches with local trades', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: '30d',
      capitalBase: 10_000,
      generatedAt: NOW,
      bills: [
        {
          id: 'bill-win',
          mode: 'okx-live',
          symbol: 'BTC-USDT-SWAP',
          timestamp: NOW - DAY,
          pnl: 123.45,
          fee: -0.65,
          balanceChange: 122.8,
          type: '8',
          subType: '160',
          ccy: 'USDT',
        },
      ],
      trades: [
        {
          id: 'local-match',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC-USDT-SWAP',
          side: 'buy',
          status: 'closed',
          strategy_id: 'trend-breakout',
          timeframe: '1h',
          realized_pnl: null,
          margin: 1_000,
          entry_price: 50_000,
          exit_price: 51_000,
          created_at: NOW - 2 * DAY,
          closed_at: NOW - DAY,
        },
      ],
    });

    expect(analytics.history).toHaveLength(1);
    expect(analytics.history[0]).toMatchObject({
      id: 'bill-win',
      source: 'exchange_bill',
      symbol: 'BTC/USDT',
      strategyId: 'trend-breakout',
      timeframe: '1h',
      realizedPnl: 123.45,
      fee: -0.65,
      balanceChange: 122.8,
      localTradeId: 'local-match',
    });
    expect(analytics.summary.totalPnl).toBe(123.45);
    expect(analytics.summary.accountReturnPct).toBeCloseTo(1.2345, 5);
    expect(analytics.history[0].tradeRoiPct).toBeCloseTo(12.345, 5);
  });

  it('does not turn local trades with null realized pnl into fake zero-return rows', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: '30d',
      capitalBase: 10_000,
      generatedAt: NOW,
      trades: [
        {
          id: 'local-null',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC-USDT-SWAP',
          status: 'closed',
          realized_pnl: null,
          margin: 1_000,
          created_at: NOW - DAY,
        },
      ],
    });

    expect(analytics.history).toEqual([]);
    expect(analytics.summary.totalPnl).toBe(0);
  });

  it('keeps live and demo OKX bills isolated by mode', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'demo',
      range: '30d',
      capitalBase: 2_000,
      generatedAt: NOW,
      bills: [
        {
          id: 'live-ignored',
          mode: 'okx-live',
          symbol: 'BTC-USDT-SWAP',
          timestamp: NOW - DAY,
          pnl: 100,
        },
        {
          id: 'demo-kept',
          mode: 'okx-demo',
          symbol: 'BTC-USDT-SWAP',
          timestamp: NOW - DAY,
          pnl: 20,
        },
      ],
    });

    expect(analytics.history.map((row) => row.id)).toEqual(['demo-kept']);
    expect(analytics.history[0].source).toBe('exchange_bill');
    expect(analytics.summary.totalPnl).toBe(20);
  });

  it('filters live and demo auto trades by mode', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: '30d',
      capitalBase: 10_000,
      generatedAt: NOW,
      trades: [
        {
          id: 'live-win',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC-USDT-SWAP',
          side: 'buy',
          status: 'closed',
          strategy_id: 'trend-breakout',
          realized_pnl: 100,
          margin: 1_000,
          created_at: NOW - 2 * DAY,
          closed_at: NOW - 2 * DAY,
        },
        {
          id: 'live-loss',
          mode: 'okx-live',
          symbol: 'ETH-USDT-SWAP',
          side: 'sell',
          status: 'closed',
          strategy_id: 'mean-reversion',
          realized_pnl: -40,
          margin: 500,
          created_at: NOW - DAY,
          closed_at: NOW - DAY,
        },
        {
          id: 'demo-ignored',
          mode: 'okx-demo',
          source: 'auto',
          symbol: 'SOL/USDT',
          status: 'closed',
          realized_pnl: 999,
          margin: 100,
          created_at: NOW - DAY,
        },
        {
          id: 'manual-ignored',
          mode: 'okx-live',
          source: 'manual',
          symbol: 'DOGE/USDT',
          status: 'closed',
          realized_pnl: 999,
          margin: 100,
          created_at: NOW - DAY,
        },
      ],
    });

    expect(analytics.history.map((row) => row.id)).toEqual(['live-loss', 'live-win']);
    expect(analytics.summary.totalPnl).toBe(60);
    expect(analytics.summary.accountReturnPct).toBeCloseTo(0.6, 5);
    expect(analytics.summary.avgTradeRoiPct).toBeCloseTo(1, 5);
    expect(analytics.summary.winRate).toBe(50);
    expect(analytics.summary.profitFactor).toBeCloseTo(2.5, 5);
    expect(analytics.summary.maxDrawdownPct).toBeCloseTo(-0.4, 5);
    expect(analytics.bySymbol.map((row) => row.key).sort()).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(analytics.byStrategy.map((row) => row.key).sort()).toEqual(['mean-reversion', 'trend-breakout']);
  });

  it('keeps demo trades separate from live trades', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'demo',
      range: '30d',
      capitalBase: 2_000,
      generatedAt: NOW,
      trades: [
        {
          id: 'live-ignored',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC/USDT',
          status: 'closed',
          realized_pnl: 100,
          margin: 1_000,
          created_at: NOW - DAY,
        },
        {
          id: 'demo-kept',
          mode: 'okx-demo',
          source: 'auto',
          symbol: 'BTC/USDT',
          status: 'closed',
          realized_pnl: 20,
          margin: 200,
          created_at: NOW - DAY,
        },
      ],
    });

    expect(analytics.history).toHaveLength(1);
    expect(analytics.history[0].id).toBe('demo-kept');
    expect(analytics.summary.totalPnl).toBe(20);
  });

  it('includes open shadow unrealized pnl and closed shadow realized pnl', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'shadow',
      range: '30d',
      capitalBase: 1_000,
      generatedAt: NOW,
      shadowOrders: [
        {
          id: 'shadow-open',
          symbol: 'BTC/USDT',
          side: 'BUY',
          strategy_id: 'trend-breakout',
          status: 'open',
          amount: 1_000,
          amount_type: 'usdt',
          leverage: 2,
          entry_price: 50_000,
          mark_price: 51_000,
          unrealized_pnl: 20,
          slippage_bps: 1.5,
          created_at: NOW - DAY,
          last_evaluated_at: NOW,
        },
        {
          id: 'shadow-closed',
          symbol: 'ETH/USDT',
          side: 'SELL',
          strategy_id: 'mean-reversion',
          status: 'closed',
          amount: 500,
          amount_type: 'usdt',
          entry_price: 3_000,
          exit_price: 2_900,
          realized_pnl: 50,
          created_at: NOW - 3 * DAY,
          closed_at: NOW - 2 * DAY,
        },
      ],
    });

    expect(analytics.summary.realizedPnl).toBe(50);
    expect(analytics.summary.unrealizedPnl).toBe(20);
    expect(analytics.summary.totalPnl).toBe(70);
    expect(analytics.summary.closedTrades).toBe(1);
    expect(analytics.summary.openTrades).toBe(1);
    expect(analytics.summary.accountReturnPct).toBeCloseTo(7, 5);
    expect(analytics.summary.avgTradeRoiPct).toBeCloseTo(6, 5);
    expect(analytics.history.find((row) => row.id === 'shadow-open')?.tradeRoiPct).toBeCloseTo(2, 5);
  });

  it('uses stable defaults with no equity, no margin, and empty history', () => {
    const empty = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: 'all',
      generatedAt: NOW,
      trades: [],
    });

    expect(empty.capitalBase).toBe(0);
    expect(empty.summary.totalPnl).toBe(0);
    expect(empty.summary.accountReturnPct).toBe(0);
    expect(empty.equityCurve).toEqual([]);

    const fallback = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: 'all',
      generatedAt: NOW,
      trades: [
        {
          id: 'fallback-capital',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC/USDT',
          status: 'closed',
          amount: 100,
          amount_type: 'usdt',
          realized_pnl: 10,
          created_at: NOW - DAY,
        },
      ],
    });

    expect(fallback.capitalBase).toBe(100);
    expect(fallback.capitalBaseSource).toBe('fallback');
    expect(fallback.summary.accountReturnPct).toBeCloseTo(10, 5);
  });

  it('filters rows outside the selected range', () => {
    const analytics = buildPortfolioReturnAnalytics({
      mode: 'live',
      range: '7d',
      capitalBase: 1_000,
      generatedAt: NOW,
      trades: [
        {
          id: 'recent',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC/USDT',
          status: 'closed',
          realized_pnl: 10,
          margin: 100,
          created_at: NOW - DAY,
        },
        {
          id: 'old',
          mode: 'okx-live',
          source: 'auto',
          symbol: 'BTC/USDT',
          status: 'closed',
          realized_pnl: 100,
          margin: 100,
          created_at: NOW - 20 * DAY,
        },
      ],
    });

    expect(analytics.history.map((row) => row.id)).toEqual(['recent']);
    expect(analytics.summary.totalPnl).toBe(10);
  });
});
