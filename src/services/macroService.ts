import axios from 'axios';
import YahooFinance from 'yahoo-finance2';

import { evaluateMacroGate, type MacroGateDecision } from '../lib/strategyEngine';

export interface MacroData {
  dxy: number;
  m2: number;
  m2Change3mPct: number;
  dxyChange30dPct: number;
  btcCorrelation: number;
  dxySource: 'live' | 'stale' | 'unavailable';
  macroRiskScore: number;
  macroGate: MacroGateDecision;
  timestamp: number;
}

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
});

const DXY_SYMBOL = 'DX-Y.NYB';
const DXY_LOOKBACK_DAYS = 40;
const DXY_CHANGE_LOOKBACK = 30;

const compactError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 180);
};

const calculatePercentChange = (latest: number, reference: number) => (
  Number.isFinite(latest) && Number.isFinite(reference) && reference > 0
    ? ((latest - reference) / reference) * 100
    : 0
);

async function fetchDxySnapshot() {
  const chart = await yahooFinance.chart(DXY_SYMBOL, {
    period1: new Date(Date.now() - DXY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    interval: '1d',
  });
  const closes = (chart.quotes || [])
    .map(point => Number(point.close))
    .filter((value): value is number => Number.isFinite(value) && value > 0);

  if (closes.length === 0) {
    throw new Error(`No daily closes returned for ${DXY_SYMBOL}`);
  }

  const latest = closes[closes.length - 1];
  const referenceIndex = Math.max(0, closes.length - DXY_CHANGE_LOOKBACK);
  const reference = closes[referenceIndex] ?? closes[0];

  return {
    dxy: latest,
    dxyChange30dPct: calculatePercentChange(latest, reference),
  };
}

export async function fetchMacroData(
  fredApiKey: string,
  previous: MacroData | null = null
): Promise<MacroData> {
  let dxyPrice = 0;
  let dxyChange30dPct = 0;
  let dxySource: MacroData['dxySource'] = 'unavailable';
  const btcCorrelation = 0;

  try {
    const nextDxy = await fetchDxySnapshot();
    dxyPrice = nextDxy.dxy;
    dxyChange30dPct = nextDxy.dxyChange30dPct;
    dxySource = 'live';
  } catch (error) {
    if (previous && Number.isFinite(previous.dxy) && previous.dxy > 0) {
      dxyPrice = previous.dxy;
      dxyChange30dPct = previous.dxyChange30dPct;
      dxySource = 'stale';
      console.warn('[Macro] DXY live fetch failed, using stale snapshot:', compactError(error));
    } else {
      console.warn('[Macro] DXY unavailable:', compactError(error));
    }
  }

  // Fetch M2 from FRED. M2SL is the series ID for M2 Money Stock.
  let m2Value = 0;
  let m2Change3mPct = 0;
  if (fredApiKey) {
    try {
      const fredRes = await axios.get(`https://api.stlouisfed.org/fred/series/observations`, {
        params: {
          series_id: 'M2SL',
          api_key: fredApiKey,
          file_type: 'json',
          sort_order: 'desc',
          limit: 4
        }
      });
      const observations = Array.isArray(fredRes.data.observations) ? fredRes.data.observations : [];
      const latest = parseFloat(observations[0]?.value);
      const older = parseFloat(observations[3]?.value ?? observations[observations.length - 1]?.value);
      m2Value = Number.isFinite(latest) ? latest : 0;
      m2Change3mPct = calculatePercentChange(latest, older);
    } catch (e) {
      console.warn("FRED API unavailable, using fallback:", compactError(e));
    }
  }

  const liquidityScore = m2Value > 0 ? Math.max(-0.35, Math.min(0.35, m2Change3mPct / 3)) : 0;
  const macroRiskScore = Math.max(-1, Math.min(1, liquidityScore));
  const macroGate = evaluateMacroGate({ macroRiskScore });

  return {
    dxy: dxyPrice,
    m2: m2Value,
    m2Change3mPct,
    dxyChange30dPct,
    btcCorrelation,
    dxySource,
    macroRiskScore,
    macroGate,
    timestamp: Date.now()
  };
}
