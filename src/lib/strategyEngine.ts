import { calculateMACD, calculateSMA } from './indicators';
import type { HigherTimeframeTrend } from './backtestValidation';

export type StrategySignal = 'BUY' | 'SELL' | 'HOLD';
export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'RISK_OFF' | 'UNKNOWN';
export type MacroRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
export type MacroGateState = 'ALLOW_FULL' | 'ALLOW_REDUCED' | 'BLOCK_NEW_RISK';

export interface MacroGateDecision {
  state: MacroGateState;
  regime: MacroRegime;
  score: number;
  reason: string;
  positionSizeMultiplier: number;
  confidencePenalty: number;
  entryThresholdAdjustment: number;
  scanIntervalMultiplier: number;
}

export interface StrategyTicker {
  last: number;
  high: number;
  low: number;
  percentage: number;
  volume?: number;
}

export interface StrategyIndicators {
  rsi: number;
  sma20: number;
  stdDev: number;
  volumeSMA?: number;
  isRealData: boolean;
}

export interface StrategyMarketData {
  sentiment: number;
  volatility: number;
  fundingRate?: number;
  openInterestChange?: number;
  macroRiskScore?: number;
  macroGate?: MacroGateDecision;
  onChainData: {
    exchangeInflow: number;
    whaleActivity: number;
    activeAddresses: number;
    mvrvRatio: number;
  };
}

export interface StrategyRiskConfig {
  estimatedFeeRate: number;
  stopLoss: number;
  takeProfit: number;
}

export interface StrategyContext {
  symbol: string;
  ticker: StrategyTicker | null;
  strategyId: string;
  prices?: number[];
  indicators: StrategyIndicators;
  market: StrategyMarketData;
  risk: StrategyRiskConfig;
  allowSyntheticData?: boolean;
  strategyOptions?: {
    trendRegimeThreshold?: number;
    higherTimeframeTrend?: HigherTimeframeTrend;
  };
}

export interface StrategyAnalysis {
  signal: StrategySignal;
  confidence: number;
  reasoning: string;
  regime?: MarketRegime;
  regimeScore?: number;
  macroGate?: MacroGateDecision;
  tp_price?: number;
  sl_price?: number;
  indicators?: { name: string; value: string; impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' }[];
  onChainMetrics?: { name: string; value: string; impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' }[];
}

type NormalizedStrategy = 'trend-breakout' | 'mean-reversion' | 'regime-engine' | 'risk-kill-switch';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function average(values: number[]) {
  return values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : 0;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map(value => Math.pow(value - mean, 2))));
}

function pctChange(current: number, previous: number) {
  return previous > 0 ? (current - previous) / previous : 0;
}

function safePrices(prices?: number[]) {
  return (prices || []).map(Number).filter(value => Number.isFinite(value) && value > 0);
}

function trendSlope(prices: number[], lookback = 20) {
  if (prices.length < lookback * 2) return 0;
  const previous = average(prices.slice(-lookback * 2, -lookback));
  const recent = average(prices.slice(-lookback));
  return pctChange(recent, previous);
}

function momentum(prices: number[], lookback = 4) {
  if (prices.length <= lookback) return 0;
  return pctChange(prices[prices.length - 1], prices[prices.length - 1 - lookback]);
}

function realizedVolatility(prices: number[], lookback = 24) {
  if (prices.length < lookback + 1) return 0;
  const slice = prices.slice(-lookback - 1);
  const returns = slice.slice(1).map((price, index) => pctChange(price, slice[index]));
  return stdev(returns) * Math.sqrt(lookback);
}

function normalizeStrategyId(strategyId: string): NormalizedStrategy {
  if (strategyId === 'trend-breakout' || strategyId === 'hft' || strategyId === 'ml-pred') return 'trend-breakout';
  if (strategyId === 'mean-reversion' || strategyId === 'stat-arb') return 'mean-reversion';
  if (strategyId === 'regime-engine' || strategyId === 'factor') return 'regime-engine';
  if (strategyId === 'risk-kill-switch') return 'risk-kill-switch';
  return 'regime-engine';
}

function hold(confidence: number, reasoning: string, regime: MarketRegime, regimeScore = 0): StrategyAnalysis {
  return { signal: 'HOLD', confidence, reasoning, regime, regimeScore, indicators: [], onChainMetrics: [] };
}

export const MACRO_GATE_THRESHOLDS = {
  blockNewRisk: -0.30,
  allowReduced: -0.10,
  riskOn: 0.20,
} as const;

export function evaluateMacroGate(market?: Partial<StrategyMarketData>): MacroGateDecision {
  if (market?.macroGate) return market.macroGate;

  const score = clamp(market?.macroRiskScore ?? 0, -1, 1);
  if (score <= MACRO_GATE_THRESHOLDS.blockNewRisk) {
    return {
      state: 'BLOCK_NEW_RISK',
      regime: 'RISK_OFF',
      score,
      reason: `宏观风险灯为 RISK_OFF (${score.toFixed(2)})，禁止新开风险仓位。`,
      positionSizeMultiplier: 0,
      confidencePenalty: 100,
      entryThresholdAdjustment: 100,
      scanIntervalMultiplier: 3,
    };
  }

  if (score <= MACRO_GATE_THRESHOLDS.allowReduced) {
    return {
      state: 'ALLOW_REDUCED',
      regime: 'NEUTRAL',
      score,
      reason: `宏观风险灯偏谨慎 (${score.toFixed(2)})，阈值+8、最多1仓、仓位减半，趋势多单禁开。`,
      positionSizeMultiplier: 0.5,
      confidencePenalty: 8,
      entryThresholdAdjustment: 8,
      scanIntervalMultiplier: 2,
    };
  }

  return {
    state: 'ALLOW_FULL',
    regime: score >= MACRO_GATE_THRESHOLDS.riskOn ? 'RISK_ON' : 'NEUTRAL',
    score,
    reason: `宏观风险灯允许交易 (${score.toFixed(2)})。`,
    positionSizeMultiplier: 1,
    confidencePenalty: 0,
    entryThresholdAdjustment: 0,
    scanIntervalMultiplier: 1,
  };
}

function withMacroGate(analysis: StrategyAnalysis, macroGate: MacroGateDecision): StrategyAnalysis {
  if (analysis.macroGate) return analysis;
  const confidence = analysis.signal === 'HOLD'
    ? analysis.confidence
    : Math.max(0, analysis.confidence - macroGate.confidencePenalty);
  return {
    ...analysis,
    confidence,
    macroGate,
    reasoning: macroGate.state === 'ALLOW_FULL'
      ? analysis.reasoning
      : `${macroGate.reason} ${analysis.reasoning}`,
  };
}

function missingDataHold(regime: MarketRegime, regimeScore: number): StrategyAnalysis {
  return hold(100, '⚠️ [风险阻断] 实盘模式下未检测到有效的实时技术指标。策略已挂起，等待真实 K 线和指标同步。', regime, regimeScore);
}

function marketFeatures(context: StrategyContext) {
  const prices = safePrices(context.prices);
  const last = context.ticker?.last || prices[prices.length - 1] || 0;
  const trend = trendSlope(prices);
  const mom = momentum(prices);
  const realizedVol = realizedVolatility(prices);
  const marketVol = Number.isFinite(context.market?.volatility) ? context.market.volatility : 0;
  const volatility = Math.max(realizedVol, marketVol);
  const orderbookImbalance = clamp(-(context.market?.onChainData?.exchangeInflow || 0) / 1000, -1, 1);
  const fundingRate = context.market?.fundingRate || 0;
  const openInterestChange = context.market?.openInterestChange || 0;
  const fundingOverheat = clamp(Math.abs(fundingRate) / 0.001, 0, 1);
  const volatilitySpike = clamp((volatility - 0.04) / 0.04, 0, 1);
  const trendScore = clamp(trend * 15, -1, 1);
  const momentumScore = clamp(mom * 20, -1, 1);
  const oiScore = clamp(openInterestChange * 10, -1, 1);
  const regimeScore = clamp(
    trendScore * 0.30
    + momentumScore * 0.15
    + oiScore * 0.15
    + orderbookImbalance * 0.15
    - fundingOverheat * 0.10
    - volatilitySpike * 0.10,
    -1,
    1
  );

  return {
    prices,
    last,
    trend,
    momentum: mom,
    volatility,
    orderbookImbalance,
    fundingRate,
    fundingOverheat,
    volatilitySpike,
    regimeScore,
  };
}

export function detectRegime(
  last: number,
  pct: number,
  prices?: number[],
  market?: StrategyMarketData
): MarketRegime {
  const context: StrategyContext = {
    symbol: '',
    ticker: { last, high: last, low: last, percentage: pct },
    strategyId: 'regime-engine',
    prices,
    indicators: { rsi: 50, sma20: calculateSMA(prices || [], 20), stdDev: 0, isRealData: true },
    market: market || {
      sentiment: 50,
      volatility: 0,
      onChainData: { exchangeInflow: 0, whaleActivity: 50, activeAddresses: 0, mvrvRatio: 1.8 },
    },
    risk: { estimatedFeeRate: 0.05, stopLoss: 2, takeProfit: 6 },
  };
  return runRegimeEngine(context).regime || 'UNKNOWN';
}

export function runRegimeEngine(context: StrategyContext): StrategyAnalysis {
  const features = marketFeatures(context);
  const trendThreshold = clamp(context.strategyOptions?.trendRegimeThreshold ?? 0.35, 0.05, 0.95);
  let regime: MarketRegime = 'RANGE';
  if (features.volatilitySpike > 0.85) regime = 'RISK_OFF';
  else if (features.regimeScore > trendThreshold) regime = 'TREND_UP';
  else if (features.regimeScore < -trendThreshold) regime = 'TREND_DOWN';

  return hold(
    regime === 'RISK_OFF' ? 95 : 60,
    `[Regime Engine] regime=${regime}, score=${features.regimeScore.toFixed(3)}, trend=${features.trend.toFixed(3)}, momentum=${features.momentum.toFixed(3)}, orderbook=${features.orderbookImbalance.toFixed(2)}`,
    regime,
    features.regimeScore
  );
}

function trendBreakout(context: StrategyContext, regime: MarketRegime, regimeScore: number, macroGate: MacroGateDecision): StrategyAnalysis {
  const { ticker, indicators, risk } = context;
  if (!ticker) return hold(0, 'No ticker data available.', 'UNKNOWN');
  const prices = safePrices(context.prices);
  const features = marketFeatures(context);
  const last = ticker.last;
  const history = prices.slice(0, -1);
  const high20 = history.length >= 20 ? Math.max(...history.slice(-20)) : ticker.high;
  const low20 = history.length >= 20 ? Math.min(...history.slice(-20)) : ticker.low;
  const macd = calculateMACD(prices);
  const stopDistance = Math.max(indicators.stdDev * 1.5, last * (risk.stopLoss / 100));
  const fundingOk = features.fundingOverheat < 0.75;
  const roundTripFee = risk.estimatedFeeRate * 2;

  if (regime === 'RISK_OFF') {
    return hold(95, '[Risk Kill Switch] RISK_OFF 环境，趋势策略禁止开新仓。', regime, regimeScore);
  }

  if (regime !== 'TREND_UP' && regime !== 'TREND_DOWN') {
    return hold(55, `[Trend Breakout] 当前 regime=${regime}，趋势策略等待明确方向。`, regime, regimeScore);
  }

  if (macroGate.state === 'ALLOW_REDUCED' && regime === 'TREND_UP') {
    return hold(88, '[Macro Gate] 宏观风险灯偏谨慎，禁止新开趋势多单。', regime, regimeScore);
  }

  if (macroGate.state === 'ALLOW_REDUCED' && Math.abs(regimeScore) < 0.65) {
    return hold(82, '[Macro Gate] 宏观降仓状态下，趋势策略只允许最强信号。', regime, regimeScore);
  }

  if (Math.abs(ticker.percentage) < roundTripFee * 2) {
    return hold(45, `[Trend Breakout] 当前波动不足以覆盖双边手续费，等待更强突破。`, regime, regimeScore);
  }

  if (
    regime === 'TREND_UP'
    && last > high20
    && features.momentum > 0
    && features.orderbookImbalance > -0.15
    && fundingOk
    && indicators.rsi < 78
    && macd.histogram >= 0
  ) {
    return withMacroGate({
      signal: 'BUY',
      confidence: Math.min(94, 72 + Math.abs(regimeScore) * 35),
      reasoning: `[Trend Breakout] TREND_UP 放行，收盘价突破20根高点(${high20.toFixed(2)})，动量与订单簿未冲突。`,
      regime,
      regimeScore,
      tp_price: last + stopDistance * 2,
      sl_price: last - stopDistance,
      indicators: [],
      onChainMetrics: []
    }, macroGate);
  }

  if (
    regime === 'TREND_DOWN'
    && last < low20
    && features.momentum < 0
    && features.orderbookImbalance < 0.15
    && fundingOk
    && indicators.rsi > 22
    && macd.histogram <= 0
  ) {
    return withMacroGate({
      signal: 'SELL',
      confidence: Math.min(94, 72 + Math.abs(regimeScore) * 35),
      reasoning: `[Trend Breakout] TREND_DOWN 放行，收盘价跌破20根低点(${low20.toFixed(2)})，下行动量与订单簿未冲突。`,
      regime,
      regimeScore,
      tp_price: last - stopDistance * 2,
      sl_price: last + stopDistance,
      indicators: [],
      onChainMetrics: []
    }, macroGate);
  }

  return hold(50, `[Trend Breakout] regime=${regime} 但突破、动量、资金费率或订单簿条件未共振。`, regime, regimeScore);
}

function meanReversion(context: StrategyContext, regime: MarketRegime, regimeScore: number, macroGate: MacroGateDecision): StrategyAnalysis {
  const { ticker, indicators, risk } = context;
  if (!ticker) return hold(0, 'No ticker data available.', 'UNKNOWN');
  const features = marketFeatures(context);
  const last = ticker.last;
  const upperBand = indicators.sma20 + indicators.stdDev * 2;
  const lowerBand = indicators.sma20 - indicators.stdDev * 2;
  const stopDistance = Math.max(indicators.stdDev * 1.8, last * (risk.stopLoss / 100));
  const volatilityExpanding = features.volatilitySpike > 0.55;
  const higherTimeframeTrend = context.strategyOptions?.higherTimeframeTrend;

  if (regime === 'RISK_OFF') {
    return hold(95, '[Risk Kill Switch] RISK_OFF 环境，均值回归禁止接刀或摸顶。', regime, regimeScore);
  }

  if (regime !== 'RANGE') {
    return hold(70, `[Mean Reversion] 当前 regime=${regime}，趋势环境禁止均值回归开仓。`, regime, regimeScore);
  }

  if (macroGate.state === 'ALLOW_REDUCED' && Math.abs(features.momentum) > 0.01) {
    return hold(82, '[Macro Gate] 宏观降仓状态下，禁止带明显短线动量的逆势均值回归单。', regime, regimeScore);
  }

  if (volatilityExpanding) {
    return hold(75, '[Mean Reversion] 波动率正在扩张，暂停均值回归，避免趋势突破中逆势。', regime, regimeScore);
  }

  if (last <= lowerBand && indicators.rsi < 35 && features.orderbookImbalance > -0.35) {
    if (higherTimeframeTrend?.direction === 'down') {
      return hold(78, `[Mean Reversion] higher timeframe downtrend blocks long mean-reversion (${higherTimeframeTrend.fourHourChangePct.toFixed(2)}% / ${higherTimeframeTrend.dailyChangePct.toFixed(2)}%).`, regime, regimeScore);
    }
    return withMacroGate({
      signal: 'BUY',
      confidence: 86,
      reasoning: `[Mean Reversion] RANGE 放行，价格触及下轨(${lowerBand.toFixed(2)}) 且 RSI=${indicators.rsi.toFixed(1)}，目标回归中轨。`,
      regime,
      regimeScore,
      tp_price: indicators.sma20,
      sl_price: last - stopDistance,
      indicators: [],
      onChainMetrics: []
    }, macroGate);
  }

  if (last >= upperBand && indicators.rsi > 65 && features.orderbookImbalance < 0.35) {
    if (higherTimeframeTrend?.direction === 'up') {
      return hold(78, `[Mean Reversion] higher timeframe uptrend blocks short mean-reversion (${higherTimeframeTrend.fourHourChangePct.toFixed(2)}% / ${higherTimeframeTrend.dailyChangePct.toFixed(2)}%).`, regime, regimeScore);
    }
    return withMacroGate({
      signal: 'SELL',
      confidence: 86,
      reasoning: `[Mean Reversion] RANGE 放行，价格触及上轨(${upperBand.toFixed(2)}) 且 RSI=${indicators.rsi.toFixed(1)}，目标回归中轨。`,
      regime,
      regimeScore,
      tp_price: indicators.sma20,
      sl_price: last + stopDistance,
      indicators: [],
      onChainMetrics: []
    }, macroGate);
  }

  return hold(50, '[Mean Reversion] 当前未触发布林带、RSI 与订单簿的均值回归共振。', regime, regimeScore);
}

export function runStrategyAnalysis(context: StrategyContext): StrategyAnalysis {
  const { ticker, indicators, allowSyntheticData = false } = context;
  if (!ticker) return { signal: 'HOLD', confidence: 0, reasoning: 'No ticker data available.', regime: 'UNKNOWN' };

  const macroGate = evaluateMacroGate(context.market);
  const regimeResult = runRegimeEngine(context);
  const regime = regimeResult.regime || 'UNKNOWN';
  const regimeScore = regimeResult.regimeScore || 0;
  const strategyId = normalizeStrategyId(context.strategyId);

  if (macroGate.state === 'BLOCK_NEW_RISK') {
    return withMacroGate(
      hold(100, '[Macro Gate] BLOCK_NEW_RISK 已触发，禁止新开风险仓位。', regime, regimeScore),
      macroGate
    );
  }

  if (!indicators.isRealData && !allowSyntheticData) {
    return withMacroGate(missingDataHold(regime, regimeScore), macroGate);
  }

  if (strategyId === 'regime-engine') return withMacroGate(regimeResult, macroGate);
  if (strategyId === 'risk-kill-switch') {
    const riskResult = regime === 'RISK_OFF'
      ? hold(100, '[Risk Kill Switch] 已触发 RISK_OFF，自动交易应停止。', regime, regimeScore)
      : hold(40, '[Risk Kill Switch] 未触发全局熔断。', regime, regimeScore);
    return withMacroGate(riskResult, macroGate);
  }
  if (strategyId === 'trend-breakout') return withMacroGate(trendBreakout(context, regime, regimeScore, macroGate), macroGate);
  if (strategyId === 'mean-reversion') return withMacroGate(meanReversion(context, regime, regimeScore, macroGate), macroGate);

  return withMacroGate(hold(50, `[Regime Engine] 当前市场状态 ${regime}，未配置执行策略。`, regime, regimeScore), macroGate);
}
