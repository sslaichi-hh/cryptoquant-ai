import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import fsp from "fs/promises";
import net from "net";
import crypto from "crypto";
// @ts-ignore Node 24 ships node:sqlite; TypeScript typings may lag behind.
import { DatabaseSync } from "node:sqlite";
import ccxt from "ccxt";
import axios from "axios";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fetchMacroData, type MacroData } from "./src/services/macroService";
import { calculateRSI, calculateSMA, calculateStandardDeviation } from "./src/lib/indicators";
import { evaluateMacroGate, runStrategyAnalysis as evaluateStrategy } from "./src/lib/strategyEngine";
import {
  AUTO_TRADING_ALLOWED_SYMBOLS,
  AUTO_TRADING_ALLOWED_TIMEFRAMES,
  DEFAULT_AUTO_TRADING_RISK_CONFIG,
  buildMarketRuntimeContext,
  calculateRiskManagedAmount,
  createDefaultMarketAnalysis,
  deriveMacroRiskScoreFromIndicators,
  estimateShadowExecution,
  normalizeDisplaySymbol,
  normalizeTicker,
  type AutoTradingRiskConfig,
  type OrderBook as RuntimeOrderBook,
  type Ticker as RuntimeTicker,
} from "./src/lib/tradingRuntime";
import {
  buildPortfolioReturnAnalytics,
  type PortfolioReturnBillInput,
  type PortfolioReturnMode,
  type PortfolioReturnRange,
} from "./src/lib/portfolioReturns";
import {
  buildStrictFactorAudit,
  buildValidationSlice,
  createWalkForwardWindows,
  groupWalkForwardRounds,
  normalizeBacktestSymbols,
  normalizeInitialEquity,
  normalizePositiveNumber,
  normalizeStrategyIds,
  summarizeWalkForwardRounds,
} from "./src/lib/walkForwardBacktest";
import {
  calculateOhlcvStartSince,
  nextOhlcvSince,
  normalizeOhlcvHistory,
} from "./src/lib/ohlcvHistory";
import {
  buildHigherTimeframeTrend,
  calculateRiskSizedQuantity,
  categorizeNoEntryReason,
  classifyValidationStatus,
  createBacktestDiagnostics,
  normalizeMinTrainTrades,
  normalizeRiskPerTradePct,
} from "./src/lib/backtestValidation";
import {
  OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
  createReconnectSchedule,
  getDataRetryDelayMs,
  isExchangeConnectivityErrorDetails,
} from "./src/lib/exchangeReconnect";
import {
  PORTFOLIO_RETURNS_CACHE_TTL_MS,
  PORTFOLIO_RETURNS_STALE_MAX_AGE_MS,
  PORTFOLIO_RETURNS_TIMEOUT_MS,
  createPortfolioReturnRequestKey,
  createPortfolioReturnStaleStatus,
  isFreshPortfolioReturnCache,
  isUsableStalePortfolioReturnCache,
  withPortfolioReturnSourceStatus,
  withTimeout,
  type PortfolioReturnCacheEntry,
} from "./src/lib/portfolioReturnStability";

dotenv.config();

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit-store.json");
const APP_STORE_FILE = path.join(DATA_DIR, "app-store.json");
const TRADING_DB_FILE = path.join(DATA_DIR, "trading.sqlite");
const CREDENTIALS_FILE = path.join(DATA_DIR, "credentials.enc.json");
const LOCAL_SECRET_FILE = path.join(DATA_DIR, ".local-secret");
const LOCAL_ADMIN_PASSWORD_FILE = path.join(DATA_DIR, ".admin-password");
const EXCHANGE_PROXY_URL = process.env.EXCHANGE_PROXY_URL || "";
const EXCHANGE_PROXY_MATCH_TOKENS = (() => {
  const tokens = new Set<string>();
  if (EXCHANGE_PROXY_URL) tokens.add(EXCHANGE_PROXY_URL);
  try {
    if (EXCHANGE_PROXY_URL) {
      const parsed = new URL(EXCHANGE_PROXY_URL);
      if (parsed.host) tokens.add(parsed.host);
      if (parsed.hostname) tokens.add(parsed.hostname);
      if (parsed.port) tokens.add(parsed.port);
    }
  } catch {}
  return Array.from(tokens).filter(Boolean);
})();
let exchangeProxyBypassed = false;
let exchangeProxyAvailability: Promise<boolean> | null = null;

type ExchangeProxyStatus = {
  configured: boolean;
  url: string | null;
  local: boolean;
  reachable: boolean | null;
  bypassed: boolean;
  reason?: string | null;
};

type ExchangeConnectivityStatus = {
  checkedAt: number | null;
  lastCheckedAt: number | null;
  okxPublic: boolean | null;
  okxPrivate: boolean | null;
  error: string | null;
  lastError: string | null;
  nextRetryAt: number | null;
  consecutiveFailures: number;
  proxy: ExchangeProxyStatus;
};

let lastExchangeConnectivityStatus: ExchangeConnectivityStatus | null = null;

function redactProxyUrlForStatus(url: string) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

function getExchangeProxyStatus(reachable: boolean | null = null, reason: string | null = null): ExchangeProxyStatus {
  return {
    configured: Boolean(EXCHANGE_PROXY_URL),
    url: redactProxyUrlForStatus(EXCHANGE_PROXY_URL),
    local: Boolean(EXCHANGE_PROXY_URL && isLocalProxyUrl()),
    reachable,
    bypassed: exchangeProxyBypassed,
    reason,
  };
}

function getExchangeConnectivityStatus() {
  return lastExchangeConnectivityStatus || {
    checkedAt: null,
    lastCheckedAt: null,
    okxPublic: null,
    okxPrivate: null,
    error: null,
    lastError: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    proxy: getExchangeProxyStatus(),
  };
}

function updateExchangeConnectivityStatus(patch: Partial<ExchangeConnectivityStatus>) {
  const previous = getExchangeConnectivityStatus();
  const checkedAt = patch.checkedAt ?? Date.now();
  lastExchangeConnectivityStatus = {
    ...previous,
    ...patch,
    checkedAt,
    lastCheckedAt: patch.lastCheckedAt ?? checkedAt,
    proxy: patch.proxy ?? previous.proxy ?? getExchangeProxyStatus(),
  };
  return lastExchangeConnectivityStatus;
}

function markExchangeConnectivitySuccess(patch: Partial<Pick<ExchangeConnectivityStatus, "okxPublic" | "okxPrivate" | "proxy">> = {}) {
  return updateExchangeConnectivityStatus({
    ...patch,
    error: null,
    lastError: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
  });
}

function markExchangeConnectivityFailure(error: any, patch: Partial<Pick<ExchangeConnectivityStatus, "okxPublic" | "okxPrivate" | "proxy">> = {}) {
  const previous = getExchangeConnectivityStatus();
  const message = formatExchangeConnectivityError(error);
  const consecutiveFailures = Math.max(1, Number(previous.consecutiveFailures || 0) + 1);
  const schedule = createReconnectSchedule(consecutiveFailures);
  return updateExchangeConnectivityStatus({
    ...patch,
    error: message,
    lastError: message,
    consecutiveFailures,
    nextRetryAt: schedule.nextRetryAt,
  });
}

function applyExchangeProxy(exchange: any) {
  if (!EXCHANGE_PROXY_URL || exchangeProxyBypassed) return;
  if (EXCHANGE_PROXY_URL.startsWith("socks")) {
    exchange.socksProxy = EXCHANGE_PROXY_URL;
    exchange.wsSocksProxy = EXCHANGE_PROXY_URL;
  } else if (EXCHANGE_PROXY_URL.startsWith("http://") || EXCHANGE_PROXY_URL.startsWith("https://")) {
    exchange.httpsProxy = EXCHANGE_PROXY_URL;
    exchange.wssProxy = EXCHANGE_PROXY_URL;
  } else {
    console.warn(`[Proxy] Unsupported EXCHANGE_PROXY_URL format: ${EXCHANGE_PROXY_URL}`);
  }
}

const exchangeProxyReady = new WeakMap<object, Promise<void>>();

function clearExchangeProxy(exchange: any) {
  if (!exchange) return;
  for (const key of ["httpProxy", "httpsProxy", "socksProxy", "wsProxy", "wssProxy", "wsSocksProxy"]) {
    if (key in exchange) {
      exchange[key] = undefined;
    }
  }
}

function isLocalProxyUrl() {
  try {
    const parsed = new URL(EXCHANGE_PROXY_URL);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function canConnectToProxy(host: string, port: number, timeoutMs = 800) {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function isProxyConnectivityError(error: any) {
  if (!EXCHANGE_PROXY_URL || exchangeProxyBypassed) return false;
  const details = [
    error?.message,
    error?.cause?.message,
    error?.stack,
    error?.cause?.stack,
  ].filter(Boolean).join(" ");
  if (!details) return false;
  if (isExchangeConnectivityErrorDetails(details)) return true;
  return EXCHANGE_PROXY_MATCH_TOKENS.some(token => details.includes(token));
}

function disableExchangeProxy(error?: any) {
  if (!EXCHANGE_PROXY_URL || exchangeProxyBypassed) return;
  exchangeProxyBypassed = true;
  exchangeProxyAvailability = Promise.resolve(false);
  clearExchangeProxy(publicExchange);
  for (const exchange of privateExchanges.values()) {
    clearExchangeProxy(exchange);
  }
  const message = error?.cause?.message || error?.message || String(error || "unknown proxy error");
  console.warn(`[Proxy] ${EXCHANGE_PROXY_URL} unavailable, falling back to direct OKX requests. ${message}`);
}

function restoreExchangeProxy(reason?: string) {
  if (!EXCHANGE_PROXY_URL || !exchangeProxyBypassed) return;
  exchangeProxyBypassed = false;
  exchangeProxyAvailability = null;
  applyExchangeProxy(publicExchange);
  for (const exchange of privateExchanges.values()) {
    applyExchangeProxy(exchange);
  }
  console.warn(
    `[Proxy] ${redactProxyUrlForStatus(EXCHANGE_PROXY_URL)} restored${reason ? `: ${reason}` : ""}`
  );
}

async function ensureExchangeProxyAvailable() {
  if (!EXCHANGE_PROXY_URL || exchangeProxyBypassed) return false;
  if (!isLocalProxyUrl()) return true;
  if (!exchangeProxyAvailability) {
    exchangeProxyAvailability = (async () => {
      try {
        const parsed = new URL(EXCHANGE_PROXY_URL);
        const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
        const reachable = await canConnectToProxy(parsed.hostname, port);
        if (!reachable) {
          disableExchangeProxy(`Proxy listener ${parsed.host} is not reachable`);
          return false;
        }
        return true;
      } catch {
        return true;
      }
    })();
  }
  return await exchangeProxyAvailability;
}

async function prepareExchange(exchange: any) {
  if (!EXCHANGE_PROXY_URL || exchangeProxyBypassed || typeof exchange.loadProxyModules !== "function") return;
  if (!(await ensureExchangeProxyAvailable())) {
    clearExchangeProxy(exchange);
    return;
  }
  if (!exchangeProxyReady.has(exchange)) {
    exchangeProxyReady.set(exchange, exchange.loadProxyModules().then(() => {
      console.log(`[Proxy] Exchange traffic routed through ${EXCHANGE_PROXY_URL}`);
    }));
  }
  await exchangeProxyReady.get(exchange);
}

async function runWithExchangeProxyFallback<T>(exchange: any, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    if (!isProxyConnectivityError(error)) throw error;
    disableExchangeProxy(error);
    clearExchangeProxy(exchange);
    return await operation();
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function restoreLocalExchangeProxyIfReachable(reason: string) {
  if (!EXCHANGE_PROXY_URL || !exchangeProxyBypassed || !isLocalProxyUrl()) return;
  try {
    const parsed = new URL(EXCHANGE_PROXY_URL);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const reachable = await canConnectToProxy(parsed.hostname, port);
    if (reachable) {
      restoreExchangeProxy(reason);
    }
  } catch {}
}

async function withAutoTradingDataRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      await restoreLocalExchangeProxyIfReachable(`retrying ${label}`);
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (!isExchangeConnectivityFailure(error) || attempt >= 3) throw error;
      const delayMs = getDataRetryDelayMs(attempt);
      pushAutoTradingLog(`${label} connection failed, retrying in ${Math.round(delayMs / 1000)}s: ${error?.message || String(error)}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

const publicMarketCache = new Map<string, { expiresAt: number; data: any }>();
const fileWriteQueue = new Map<string, Promise<void>>();

// --- Backtest async job store (avoid Render proxy timeout for long-running walk-forward) ---
type BacktestJob = {
  id: string;
  status: "processing" | "done" | "error";
  createdAt: number;
  result?: any;
  error?: string;
};
const backtestJobs = new Map<string, BacktestJob>();
const BACKTEST_JOB_TTL_MS = 10 * 60 * 1000; // 10 min

function createBacktestJob(): BacktestJob {
  const id = `bt_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const job: BacktestJob = { id, status: "processing", createdAt: Date.now() };
  backtestJobs.set(id, job);
  return job;
}

// Cleanup expired jobs every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - BACKTEST_JOB_TTL_MS;
  for (const [id, job] of backtestJobs) {
    if (job.createdAt < cutoff) backtestJobs.delete(id);
  }
}, 5 * 60 * 1000);

async function cachedPublicMarket<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = publicMarketCache.get(key);
  if (cached && cached.expiresAt > now) return cached.data as T;
  const data = await fetcher();
  publicMarketCache.set(key, { data, expiresAt: now + ttlMs });
  return data;
}

async function writeFileAtomic(filePath: string, contents: string, options?: { mode?: number }) {
  const previous = fileWriteQueue.get(filePath) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fsp.writeFile(tmpFile, contents, options);
      await fsp.rename(tmpFile, filePath);
    });
  fileWriteQueue.set(filePath, next);
  try {
    await next;
  } finally {
    if (fileWriteQueue.get(filePath) === next) {
      fileWriteQueue.delete(filePath);
    }
  }
}

// --- Global Exchange Instances (for reuse) ---

function getPrivateExchange(apiKey: string, secret: string, password: string, sandbox: boolean) {
  const key = `${apiKey}_${secret}_${password}_${sandbox}`;
  if (!privateExchanges.has(key)) {
    const exchange = new (ccxt as any).okx({
      apiKey,
      secret,
      password,
      enableRateLimit: true,
      timeout: OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
      options: {
        defaultType: "swap",
        fetchMarkets: { types: ["swap", "spot"] },
      },
    });
    applyExchangeProxy(exchange);
    if (sandbox) {
      try {
        exchange.setSandboxMode(true);
      } catch (e) {}
      exchange.headers = { ...(exchange.headers || {}), 'x-simulated-trading': '1' };
      exchange.options.defaultHeaders = { ...(exchange.options.defaultHeaders || {}), 'x-simulated-trading': '1' };
    }
    privateExchanges.set(key, exchange);
  }
  return privateExchanges.get(key)!;
}

// --- Utility: Retry Wrapper ---
async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries <= 0) throw error;
    // Don't retry on certain errors (e.g. Insufficient Funds)
    if (error.message.includes('Insufficient funds') || error.message.includes('Invalid order')) {
      throw error;
    }
    console.warn(`Operation failed, retrying... (${retries} left). Error: ${error.message}`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(fn, retries - 1, delay * 2);
  }
}

// --- Utility: Symbol Converter ---
function toCcxtSymbol(symbol: string): string {
  if (!symbol) return "BTC/USDT:USDT";
  let s = String(symbol).toUpperCase();
  // If it's already a CCXT unified symbol for swap (contains :)
  if (s.includes(':')) return s;
  if (s.endsWith("-SWAP")) {
    // Convert OKX native ID (e.g. BTC-USDT-SWAP) to CCXT unified symbol (e.g. BTC/USDT:USDT)
    const base = s.replace("-SWAP", "");
    const parts = base.split("-");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}:USDT`;
    }
    return base.replace("-", "/") + ":USDT";
  }
  // This app trades USDT-margined perpetual swaps by default.
  const unified = s.replace("-", "/");
  const [base, quote = "USDT"] = unified.split("/");
  return `${base}/${quote}:${quote}`;
}

function toOkxSwapInstId(symbol: string): string {
  if (!symbol) return "BTC-USDT-SWAP";
  const upper = String(symbol).toUpperCase();
  if (upper.endsWith("-SWAP")) return upper;
  const clean = upper.includes(":") ? upper.split(":")[0] : upper;
  return `${clean.replace("/", "-")}-SWAP`;
}

function toCcxtLikeSwapSymbol(instId: string): string {
  const [base, quote] = String(instId || "BTC-USDT-SWAP").replace("-SWAP", "").split("-");
  return `${base}/${quote}:USDT`;
}

type OkxResolvedSwapMarket = {
  requestedSymbol: string;
  displaySymbol: string;
  instId: string;
  resolvedMarketId: string;
  resolvedMarketSymbol: string;
  base: string;
  quote: string;
  settleCcy: string;
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
  leverageCap: number | null;
  state: string;
};

const okxSwapMarketCache = new Map<string, { expiresAt: number; value: OkxResolvedSwapMarket }>();
const OKX_SWAP_MARKET_CACHE_TTL_MS = 5 * 60 * 1000;

function ceilToStep(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number((Math.ceil(value / step) * step).toFixed(decimals));
}

function formatToStepString(value: number, step: number) {
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number(value).toFixed(decimals);
}

function findLoadedOkxSwapMarket(exchange: any, instId: string, displaySymbol: string) {
  const markets = Object.values(exchange?.markets || {}) as any[];
  return markets.find((market) => {
    const marketDisplaySymbol = normalizeDisplaySymbol(String(market?.symbol || market?.id || ""));
    const marketInstId = String(market?.id || market?.info?.instId || "").toUpperCase();
    const settle = String(market?.settle || market?.info?.settleCcy || "").toUpperCase();
    return (
      marketInstId === instId.toUpperCase() ||
      (
        marketDisplaySymbol === displaySymbol &&
        (market?.swap || market?.type === "swap" || marketInstId.endsWith("-SWAP")) &&
        (!settle || settle === "USDT")
      )
    );
  }) || null;
}

async function resolveOkxSwapMarket(symbol: string, exchange?: any): Promise<OkxResolvedSwapMarket> {
  const requestedSymbol = String(symbol || "BTC/USDT");
  const displaySymbol = normalizeDisplaySymbol(requestedSymbol);
  const instId = toOkxSwapInstId(displaySymbol);
  const cached = okxSwapMarketCache.get(instId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const loadedMarket = findLoadedOkxSwapMarket(exchange, instId, displaySymbol);
  const [base = "BTC", quote = "USDT"] = displaySymbol.split("/");
  const rawMarket = loadedMarket
    ? loadedMarket.info || {}
    : (await okxPublicGet("/api/v5/public/instruments", { instType: "SWAP", instId }))[0];

  if (!rawMarket) {
    throw requestError(400, `Resolved OKX swap instrument ${instId} not found`, {
      error: `Resolved OKX swap instrument ${instId} not found`,
      requestedSymbol,
      displaySymbol,
      instId,
    });
  }

  const resolved: OkxResolvedSwapMarket = {
    requestedSymbol,
    displaySymbol,
    instId: String(rawMarket.instId || loadedMarket?.id || instId),
    resolvedMarketId: String(rawMarket.instId || loadedMarket?.id || instId),
    resolvedMarketSymbol: normalizeDisplaySymbol(String(loadedMarket?.symbol || rawMarket.instId || displaySymbol)),
    base: String(rawMarket.baseCcy || base || "BTC").toUpperCase(),
    quote: String(rawMarket.quoteCcy || quote || "USDT").toUpperCase(),
    settleCcy: String(rawMarket.settleCcy || loadedMarket?.settle || "USDT").toUpperCase(),
    ctVal: firstNumber(rawMarket.ctVal, loadedMarket?.contractSize, 1),
    lotSz: firstNumber(rawMarket.lotSz, loadedMarket?.info?.lotSz, loadedMarket?.limits?.amount?.min, 0.01),
    minSz: firstNumber(rawMarket.minSz, loadedMarket?.limits?.amount?.min, rawMarket.lotSz, 0.01),
    tickSz: firstNumber(rawMarket.tickSz, loadedMarket?.precision?.price, 0.1),
    leverageCap: firstNumber(rawMarket.lever, null),
    state: String(rawMarket.state || "live"),
  };
  okxSwapMarketCache.set(instId, {
    value: resolved,
    expiresAt: Date.now() + OKX_SWAP_MARKET_CACHE_TTL_MS,
  });
  return resolved;
}

function normalizeOkxOrderStatus(state: string | undefined | null) {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "filled") return "closed";
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "mmp_canceled") return "canceled";
  if (normalized === "partially_filled" || normalized === "live" || normalized === "effective") return "open";
  return normalized || "unknown";
}

function normalizeOkxRawOrder(rawOrder: any, resolvedMarket: OkxResolvedSwapMarket) {
  const amount = firstNumber(rawOrder?.sz);
  const filled = firstNumber(rawOrder?.accFillSz, rawOrder?.fillSz);
  const price = firstNumber(rawOrder?.px, rawOrder?.avgPx);
  const average = firstNumber(rawOrder?.avgPx, rawOrder?.fillPx, price);
  const remaining = Number.isFinite(amount) && Number.isFinite(filled)
    ? Math.max(0, amount - filled)
    : undefined;
  const feeCost = firstNumber(rawOrder?.fee);
  return {
    id: String(rawOrder?.ordId || rawOrder?.algoId || rawOrder?.clOrdId || "").trim() || undefined,
    clientOrderId: String(rawOrder?.clOrdId || "").trim() || undefined,
    symbol: resolvedMarket.displaySymbol,
    instId: resolvedMarket.instId,
    type: rawOrder?.ordType || "market",
    side: rawOrder?.side,
    price,
    average,
    amount,
    filled,
    remaining,
    status: normalizeOkxOrderStatus(rawOrder?.state),
    fee: feeCost !== null ? {
      currency: rawOrder?.feeCcy || resolvedMarket.settleCcy,
      cost: Math.abs(feeCost),
    } : undefined,
    info: rawOrder,
  };
}

function normalizeOkxHistoryOrder(rawOrder: any, resolvedMarket: OkxResolvedSwapMarket) {
  const normalized = normalizeOkxRawOrder(rawOrder, resolvedMarket);
  const timestamp = firstNumber(rawOrder?.uTime, rawOrder?.cTime, rawOrder?.fillTime, Date.now());
  const lastTradeTimestamp = firstNumber(rawOrder?.fillTime, rawOrder?.uTime, rawOrder?.cTime);
  const average = firstNumber(normalized.average, normalized.price);
  const filled = firstNumber(normalized.filled);
  const cost = average > 0 && filled > 0 ? average * filled : undefined;
  return {
    ...normalized,
    timestamp,
    datetime: new Date(timestamp).toISOString(),
    lastTradeTimestamp: lastTradeTimestamp > 0 ? lastTradeTimestamp : undefined,
    cost,
  };
}

function unwrapOkxApiRow(response: any) {
  const code = String(response?.code ?? "0");
  if (code !== "0") {
    throw requestError(502, response?.msg || "OKX request failed", {
      error: response?.msg || "OKX request failed",
      code,
      response,
    });
  }
  return Array.isArray(response?.data) ? response.data[0] || null : null;
}

function unwrapOkxApiRows(response: any) {
  const code = String(response?.code ?? "0");
  if (code !== "0") {
    throw requestError(502, response?.msg || "OKX request failed", {
      error: response?.msg || "OKX request failed",
      code,
      response,
    });
  }
  return Array.isArray(response?.data) ? response.data : [];
}

async function fetchOkxTradeOrderRaw(
  exchange: any,
  exchangeCall: <T>(fn: () => Promise<T>) => Promise<T>,
  instId: string,
  identifiers: { ordId?: string | null; clOrdId?: string | null }
) {
  const request: Record<string, any> = { instId };
  if (identifiers.ordId) request.ordId = identifiers.ordId;
  else if (identifiers.clOrdId) request.clOrdId = identifiers.clOrdId;
  else throw new Error("Main order identifier is unavailable");
  return unwrapOkxApiRow(await retry(() => exchangeCall(() => (exchange as any).privateGetTradeOrder(request))));
}

function buildOkxAttachAlgoOrds(options: { tpPrice?: any; slPrice?: any }) {
  const attachAlgo: Record<string, any> = {};
  if (options.tpPrice !== undefined && options.tpPrice !== null && String(options.tpPrice).trim() !== "") {
    attachAlgo.tpTriggerPx = String(options.tpPrice);
    attachAlgo.tpOrdPx = "-1";
    attachAlgo.tpTriggerPxType = "last";
  }
  if (options.slPrice !== undefined && options.slPrice !== null && String(options.slPrice).trim() !== "") {
    attachAlgo.slTriggerPx = String(options.slPrice);
    attachAlgo.slOrdPx = "-1";
    attachAlgo.slTriggerPxType = "last";
  }
  if (!attachAlgo.tpTriggerPx && !attachAlgo.slTriggerPx) return [];
  attachAlgo.attachAlgoClOrdId = `tp${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`.slice(0, 32);
  return [attachAlgo];
}

function parseOkxErrorDetails(errorOrResponse: any) {
  const candidates = [
    errorOrResponse?.response?.data,
    errorOrResponse?.response,
    errorOrResponse?.payload?.response,
    errorOrResponse,
  ];
  const message = String(errorOrResponse?.message || errorOrResponse?.msg || "");
  const jsonStart = message.indexOf("{");
  const jsonEnd = message.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      candidates.push(JSON.parse(message.slice(jsonStart, jsonEnd + 1)));
    } catch {}
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = Array.isArray(candidate?.data) ? candidate.data[0] : candidate?.data;
    const okxCode = candidate?.code !== undefined ? String(candidate.code) : undefined;
    const okxMsg = candidate?.msg !== undefined ? String(candidate.msg) : undefined;
    const okxSCode = row?.sCode !== undefined ? String(row.sCode) : undefined;
    const okxSMsg = row?.sMsg !== undefined ? String(row.sMsg) : undefined;
    if (okxCode || okxMsg || okxSCode || okxSMsg) {
      return {
        okxCode,
        okxMsg,
        okxSCode,
        okxSMsg,
        okxResponse: candidate,
      };
    }
  }

  return {
    okxCode: undefined,
    okxMsg: undefined,
    okxSCode: undefined,
    okxSMsg: undefined,
    okxResponse: undefined,
  };
}

function okxBar(timeframe: string) {
  const normalized = String(timeframe || "1h").toLowerCase();
  if (normalized === "1d") return "1D";
  if (normalized === "1w") return "1W";
  if (normalized === "4h") return "4H";
  if (normalized === "15m") return "15m";
  return "1H";
}

async function okxPublicGet(pathname: string, params: Record<string, any>) {
  const request = async (useProxy: boolean) => axios.get(`https://www.okx.com${pathname}`, {
    params,
    timeout: 10000,
    headers: { "User-Agent": "CryptoQuantAI/1.0" },
    ...(useProxy && EXCHANGE_PROXY_URL.startsWith("http")
      ? { httpsAgent: new HttpsProxyAgent(EXCHANGE_PROXY_URL), proxy: false }
      : {}),
  });

  let response;
  try {
    const useProxy = Boolean(
      EXCHANGE_PROXY_URL &&
      !exchangeProxyBypassed &&
      EXCHANGE_PROXY_URL.startsWith("http") &&
      await ensureExchangeProxyAvailable()
    );
    response = await request(useProxy);
  } catch (error: any) {
    if (!isProxyConnectivityError(error)) throw error;
    disableExchangeProxy(error);
    response = await request(false);
  }

  if (response.data?.code && response.data.code !== "0") {
    throw new Error(response.data?.msg || JSON.stringify(response.data));
  }
  return response.data?.data || [];
}

async function probeOkxPublicApiForAutoTrading() {
  const requestOptions: any = {
    timeout: 8000,
    headers: { "User-Agent": "CryptoQuantAI/1.0" },
  };

  if (EXCHANGE_PROXY_URL && !exchangeProxyBypassed && EXCHANGE_PROXY_URL.startsWith("http")) {
    requestOptions.httpsAgent = new HttpsProxyAgent(EXCHANGE_PROXY_URL);
    requestOptions.proxy = false;
  }

  const response = await axios.get("https://www.okx.com/api/v5/public/time", requestOptions);
  if (response.data?.code && String(response.data.code) !== "0") {
    throw new Error(response.data?.msg || "OKX public API returned an error");
  }
  return true;
}

function formatExchangeConnectivityError(error: any) {
  return error?.cause?.message || error?.message || String(error || "OKX connectivity check failed");
}

function isExchangeConnectivityFailure(error: any) {
  const details = [
    error?.message,
    error?.cause?.message,
    error?.stack,
    error?.cause?.stack,
  ].filter(Boolean).join(" ");
  return isExchangeConnectivityErrorDetails(details);
}

function buildAutoTradingPreflightPayload(message: string, code: string) {
  return {
    error: message,
    code,
    exchangeConnectivity: getExchangeConnectivityStatus(),
  };
}

function failAutoTradingPreflight(message: string, code: string) {
  updateAutoTradingStore({
    state: "stopped",
    nextRunAt: null,
    lastError: message,
  });
  pushAutoTradingLog(`Auto-trading preflight failed: ${message}`);
  throw requestError(503, message, buildAutoTradingPreflightPayload(message, code));
}

async function assertAutoTradingExchangeReady(credentials?: Required<OkxCredentials>, sandbox = false) {
  let proxyReachable: boolean | null = null;
  let proxyReason: string | null = null;

  if (EXCHANGE_PROXY_URL && isLocalProxyUrl()) {
    try {
      const parsed = new URL(EXCHANGE_PROXY_URL);
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      proxyReachable = await canConnectToProxy(parsed.hostname, port);
      if (!proxyReachable) {
        proxyReason = `Proxy listener ${parsed.host} is not reachable`;
        markExchangeConnectivityFailure(proxyReason, {
          okxPublic: false,
          okxPrivate: false,
          proxy: getExchangeProxyStatus(false, proxyReason),
        });
        failAutoTradingPreflight(
          `EXCHANGE_PROXY_URL points to ${redactProxyUrlForStatus(EXCHANGE_PROXY_URL)}, but that local proxy is not reachable. Start the proxy and try again, or clear EXCHANGE_PROXY_URL and restart this server.`,
          "EXCHANGE_PROXY_UNREACHABLE"
        );
      }
      restoreExchangeProxy("local proxy is reachable during auto-trading preflight");
    } catch (error: any) {
      if (error?.statusCode) throw error;
      proxyReason = `Invalid EXCHANGE_PROXY_URL: ${formatExchangeConnectivityError(error)}`;
      markExchangeConnectivityFailure(proxyReason, {
        okxPublic: false,
        okxPrivate: false,
        proxy: getExchangeProxyStatus(false, proxyReason),
      });
      failAutoTradingPreflight(proxyReason, "EXCHANGE_PROXY_INVALID");
    }
  } else if (EXCHANGE_PROXY_URL && exchangeProxyBypassed) {
    restoreExchangeProxy("retrying configured proxy during auto-trading preflight");
  }

  try {
    await withAutoTradingDataRetry("OKX public API preflight", () => probeOkxPublicApiForAutoTrading());
    markExchangeConnectivitySuccess({
      okxPublic: true,
      proxy: getExchangeProxyStatus(proxyReachable, proxyReason),
    });
  } catch (error: any) {
    const reason = formatExchangeConnectivityError(error);
    markExchangeConnectivityFailure(error, {
      okxPublic: false,
      okxPrivate: false,
      proxy: getExchangeProxyStatus(proxyReachable, proxyReason),
    });
    failAutoTradingPreflight(
      `OKX public API is not reachable before auto-trading start: ${reason}`,
      "OKX_PUBLIC_UNREACHABLE"
    );
  }

  if (!credentials) return;

  try {
    await fetchPrivateBalance(credentials, sandbox, true);
    markExchangeConnectivitySuccess({
      okxPublic: true,
      okxPrivate: true,
      proxy: getExchangeProxyStatus(proxyReachable, proxyReason),
    });
  } catch (error: any) {
    const reason = formatExchangeConnectivityError(error);
    markExchangeConnectivityFailure(error, {
      okxPublic: true,
      okxPrivate: false,
      proxy: getExchangeProxyStatus(proxyReachable, proxyReason),
    });
    failAutoTradingPreflight(
      `OKX private account API is not reachable before auto-trading start: ${reason}`,
      "OKX_PRIVATE_UNREACHABLE"
    );
  }
}

// --- Audit & Monitoring Store ---
const STRATEGY_VERSION = "v2.1.0-reliability-risk-audit";
const auditStore = {
  aiSnapshots: [] as any[],
  orderReceipts: [] as any[],
  riskEvents: [] as any[],
  positionChanges: [] as any[],
};

// Helper to add to audit store with limit
function addToAudit<T>(list: T[], item: T, limit = 100) {
  list.unshift({ ...item, timestamp: Date.now() });
  if (list.length > limit) list.pop();
  persistAuditStore().catch(error => console.error("[Audit] Persist failed:", error));
}

async function loadAuditStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AUDIT_FILE)) return;
    const raw = await fsp.readFile(AUDIT_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    for (const key of Object.keys(auditStore) as Array<keyof typeof auditStore>) {
      if (Array.isArray(parsed[key])) {
        auditStore[key] = parsed[key].slice(0, 500);
      }
    }
    console.log("[Audit] Persistent audit store loaded.");
  } catch (error) {
    console.warn("[Audit] Failed to load persistent audit store:", error);
  }
}

async function persistAuditStore() {
  await writeFileAtomic(AUDIT_FILE, JSON.stringify(auditStore, null, 2));
}

// --- Local Operations Store: auth sessions, security events, order lifecycle ---
type OperatorSession = {
  tokenHash: string;
  username: string;
  role: "admin";
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
};

type SecurityEvent = {
  id: string;
  type: string;
  username?: string;
  path?: string;
  method?: string;
  ip?: string;
  userAgent?: string;
  details?: any;
  timestamp: number;
};

type OrderLifecycleEvent = {
  id: string;
  requestId: string;
  clientOrderId?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  amount?: number;
  amountType?: string;
  status:
    | "accepted"
    | "prepared"
    | "submitted"
    | "verified"
    | "failed"
    | "tp_managed"
    | "tp_amended"
    | "tp_skipped"
    | "tp_failed"
    | "tp_closed";
  source?: string;
  strategyId?: string;
  sandbox?: boolean;
  operator?: string;
  details?: any;
  timestamp: number;
};

type PersistentRiskState = {
  date: string;
  dailyPnL: number;
  consecutiveStopLosses: number;
  macroGate: string;
  macroScore: number;
  newRiskBlocked: boolean;
  killSwitchActive: boolean;
  lastKillSwitchReason?: string;
  cooldownUntil: number;
  updatedAt: number;
};

type AutoTradingEngineState = "stopped" | "starting" | "running" | "stopping" | "error";

type AutoTradingScanProfile = {
  symbol: string;
  timeframes: string[];
};

type AutoTradingConfig = {
  sandbox: boolean;
  scanProfilesVersion: number;
  scanProfiles: AutoTradingScanProfile[];
  strategyIds: string[];
  riskConfigSnapshot: AutoTradingRiskConfig;
  shadowMode: boolean;
};

type AutoTradingCycleSummary = {
  cycleId: string;
  trigger: "scheduled" | "manual";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  scannedSymbols: number;
  scannedTargets: number;
  strategiesEvaluated: number;
  candidates: number;
  selected: number;
  ordersPlaced: number;
  shadowOrders: number;
  skippedReason?: string;
  macroGate: string;
  macroScore: number;
  error?: string | null;
};

type AutoTradingDecisionStage =
  | "market_data"
  | "strategy_signal"
  | "confidence_gate"
  | "macro_gate"
  | "persistent_risk"
  | "portfolio_limit"
  | "correlation_filter"
  | "timeframe_conflict"
  | "position_sizing"
  | "account_risk_check"
  | "shadow_mode"
  | "order_submit";

type AutoTradingDecisionStep = {
  name: AutoTradingDecisionStage;
  status: "pass" | "fail" | "skip";
  reason?: string;
  metrics?: Record<string, any>;
  at: number;
};

type AutoTradingDecisionTrace = {
  id: string;
  cycleId: string;
  trigger: "scheduled" | "manual";
  symbol: string;
  timeframe: string;
  strategyId: string;
  signal: string;
  confidence: number;
  requiredConfidence: number;
  shadowMode: boolean;
  macroGate: string;
  blockedAt: AutoTradingDecisionStage | null;
  blockedReason: string | null;
  steps: AutoTradingDecisionStep[];
  createdAt: number;
};

type AutoTradingStore = {
  state: AutoTradingEngineState;
  config: AutoTradingConfig | null;
  recentLogs: string[];
  recentCycleSummaries: AutoTradingCycleSummary[];
  decisionTraces: AutoTradingDecisionTrace[];
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  engineStartedAt: number | null;
};

type ShadowOrderStatus = "open" | "closed" | "estimated_skipped";

type ShadowExitReason = "take_profit" | "stop_loss" | "reverse_signal" | null;

type ShadowOrderRow = {
  id: string;
  symbol: string;
  side: string;
  strategy_id: string | null;
  theoretical_price: number | null;
  executable_price: number | null;
  spread_bps: number | null;
  slippage_bps: number | null;
  latency_ms: number | null;
  amount: number | null;
  amount_type: string | null;
  regime: string | null;
  macro_gate: string | null;
  orderbook_json: string | null;
  signal_json: string | null;
  status: ShadowOrderStatus;
  timeframe: string | null;
  leverage: number | null;
  tp_price: number | null;
  sl_price: number | null;
  entry_price: number | null;
  mark_price: number | null;
  qty_estimate: number | null;
  unrealized_pnl: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
  exit_reason: ShadowExitReason;
  closed_at: number | null;
  last_evaluated_at: number | null;
  is_estimated: number;
  estimated_timeframe: string | null;
  estimation_note: string | null;
  created_at: number;
};

type ShadowSummary = {
  openCount: number;
  closedCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  winRate: number;
  avgHoldMinutes: number;
  estimatedCount: number;
};

type TakeProfitManagerSource = "auto" | "manual";

type TakeProfitManagerStatus = "active" | "pending_lookup" | "closed" | "skipped";

type ManagedTakeProfitOrder = {
  id: string;
  tradeId: string;
  requestId: string;
  clientOrderId?: string;
  orderId?: string;
  symbol: string;
  side: "buy" | "sell";
  sandbox: boolean;
  source: TakeProfitManagerSource;
  strategyId?: string;
  entryPrice: number;
  initialTpPrice: number;
  currentTpPrice: number;
  slPrice: number;
  tpAmendCount: number;
  tpManagerStatus: TakeProfitManagerStatus;
  attachedTpAlgoId?: string | null;
  attachedTpAlgoClOrdId?: string | null;
  lastCheckedAt: number | null;
  lastAmendedAt: number | null;
  lastTpManagerReason: string | null;
  createdAt: number;
};

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createDefaultRiskState(): PersistentRiskState {
  return {
    date: todayKey(),
    dailyPnL: 0,
    consecutiveStopLosses: 0,
    macroGate: "ALLOW_FULL",
    macroScore: 0,
    newRiskBlocked: false,
    killSwitchActive: false,
    cooldownUntil: 0,
    updatedAt: Date.now(),
  };
}

function createDefaultAutoTradingStore(): AutoTradingStore {
  return {
    state: "stopped",
    config: null,
    recentLogs: [],
    recentCycleSummaries: [],
    decisionTraces: [],
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    engineStartedAt: null,
  };
}

function sanitizeAutoTradingLogEntry(line: unknown) {
  if (typeof line !== "string") return "";
  const prefixMatch = line.match(/^(\[[^\]]+\]\s*)/);
  const prefix = prefixMatch?.[1] || "";
  const message = line.slice(prefix.length);

  // Fix corrupted Chinese text from encoding bugs (mojibake)
  // Pattern: "寮€濮嬫壂鎻?(瀹氭椂" -> "开始扫描(定时"
  const corruptedScanMatch = message.match(/^寮€濮嬫壂鎻?\((\S+),\s*(\S+)\)$/);
  if (corruptedScanMatch) {
    const trigger = corruptedScanMatch[1] === "鎵嬪姩" ? "手动" : "定时";
    return `${prefix}开始扫描(${corruptedScanMatch[1] === "manual" ? "手动" : trigger}, ${corruptedScanMatch[2]})`;
  }
  if (message.includes("寮€濮嬫壂鎻?")) {
    return `${prefix}开始扫描${message.replace(/寮€濮嬫壂鎻?/, "")}`;
  }
  if (message.includes("褰卞瓙鎸佷粨宸插紑浠?")) {
    return `${prefix}影子持仓已经平仓${message.replace(/[^閉拷]*褰卞瓙鎸佷粨宸插紑浠?/, "")}`;
  }
  if (message.includes("褰卞瓙鎸佷粨宸插弽鎵?")) {
    return `${prefix}影子持仓已经反转${message.replace(/[^閉拷]*褰卞瓙鎸佷粨宸插弽鎵?/, "")}`;
  }
  if (message.includes("褰卞瓙鎸佷粨宸插埛鏂?")) {
    return `${prefix}影子持仓已经更新${message.replace(/[^閉拷]*褰卞瓙鎸佷粨宸插埛鏂?/, "")}`;
  }

  const modeMatch = message.match(/\((DEMO|LIVE)\)/);

  if (message.includes("自动交易引擎已启动") && modeMatch) {
    return `${prefix}自动交易引擎已启动 (${modeMatch[1]})`;
  }

  if (message === "No auto-trading candidates passed the filters in this cycle") {
    return `${prefix}本轮没有候选信号通过筛选`;
  }

  if (message === "All candidates were filtered out before execution") {
    return `${prefix}所有候选信号都在执行前被过滤`;
  }

  if (message === "Manual auto-trading cycle requested") {
    return `${prefix}已触发手动自动交易扫描`;
  }

  if (message === "Auto-trading engine stopped") {
    return `${prefix}自动交易引擎已停止`;
  }

  if (message === "Stop requested; the current cycle will finish before shutdown") {
    return `${prefix}已请求停止，当前周期完成后关闭`;
  }

  const scanMatch = message.match(/^Scan started \((scheduled|manual), (.+)\)$/);
  if (scanMatch) {
    return `${prefix}开始扫描 (${scanMatch[1] === "manual" ? "手动" : "定时"}, ${scanMatch[2]})`;
  }

  const configMatch = message.match(/^Auto-trading config updated \((DEMO|LIVE), shadow=(on|off)\)$/);
  if (configMatch) {
    return `${prefix}自动交易配置已更新 (${configMatch[1]}, shadow=${configMatch[2]})`;
  }

  return line;
}

const appStore = {
  sessions: [] as OperatorSession[],
  securityEvents: [] as SecurityEvent[],
  orderLifecycle: [] as OrderLifecycleEvent[],
  riskState: createDefaultRiskState(),
  autoTrading: createDefaultAutoTradingStore(),
};

let adminPasswordHash = "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

function hashSecret(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getRequestIp(req: express.Request) {
  const forwarded = req.headers["x-forwarded-for"];
  return Array.isArray(forwarded) ? forwarded[0] : String(forwarded || req.socket.remoteAddress || "");
}

function addSecurityEvent(type: string, req?: express.Request, details?: any, username?: string) {
  appStore.securityEvents.unshift({
    id: `sec_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    type,
    username,
    path: req?.path,
    method: req?.method,
    ip: req ? getRequestIp(req) : undefined,
    userAgent: req ? String(req.headers["user-agent"] || "") : undefined,
    details,
    timestamp: Date.now(),
  });
  if (appStore.securityEvents.length > 1000) appStore.securityEvents.length = 1000;
  persistAppStore().catch(error => console.error("[OpsStore] Persist failed:", error));
}

function addOrderLifecycle(event: Omit<OrderLifecycleEvent, "id" | "timestamp">) {
  appStore.orderLifecycle.unshift({
    ...event,
    id: `ordlife_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    timestamp: Date.now(),
  });
  if (appStore.orderLifecycle.length > 2000) appStore.orderLifecycle.length = 2000;
  persistAppStore().catch(error => console.error("[OpsStore] Persist failed:", error));
}

function normalizeRiskStateDate() {
  const today = todayKey();
  if (appStore.riskState.date !== today) {
    appStore.riskState = {
      ...appStore.riskState,
      date: today,
      dailyPnL: 0,
      consecutiveStopLosses: 0,
      killSwitchActive: false,
      newRiskBlocked: false,
      lastKillSwitchReason: undefined,
      cooldownUntil: 0,
      updatedAt: Date.now(),
    };
  }
}

function updatePersistentRiskState(patch: Partial<PersistentRiskState> & { event?: string; reason?: string }) {
  normalizeRiskStateDate();
  appStore.riskState = {
    ...appStore.riskState,
    ...patch,
    updatedAt: Date.now(),
  };
  if (patch.reason) appStore.riskState.lastKillSwitchReason = patch.reason;
  if (patch.event === "stop_loss") appStore.riskState.consecutiveStopLosses += 1;
  if (patch.event === "profit") appStore.riskState.consecutiveStopLosses = 0;
  const cooldownActive = appStore.riskState.cooldownUntil > Date.now();
  appStore.riskState.newRiskBlocked = Boolean(appStore.riskState.killSwitchActive || cooldownActive || appStore.riskState.macroGate === "BLOCK_NEW_RISK");
  persistAppStore().catch(error => console.error("[OpsStore] Persist failed:", error));
  return appStore.riskState;
}

async function loadAppStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    let appStoreSanitized = false;
    if (fs.existsSync(APP_STORE_FILE)) {
      const raw = await fsp.readFile(APP_STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const recentLogs = Array.isArray(parsed.autoTrading?.recentLogs)
        ? parsed.autoTrading.recentLogs
            .slice(0, 200)
            .map((entry: unknown) => sanitizeAutoTradingLogEntry(entry))
            .filter(Boolean)
        : [];
      appStoreSanitized = Array.isArray(parsed.autoTrading?.recentLogs)
        && recentLogs.some((entry: string, index: number) => entry !== parsed.autoTrading.recentLogs[index]);
      appStore.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      appStore.securityEvents = Array.isArray(parsed.securityEvents) ? parsed.securityEvents.slice(0, 1000) : [];
      appStore.orderLifecycle = Array.isArray(parsed.orderLifecycle) ? parsed.orderLifecycle.slice(0, 2000) : [];
      appStore.riskState = { ...createDefaultRiskState(), ...(parsed.riskState || {}) };
      appStore.autoTrading = {
        ...createDefaultAutoTradingStore(),
        ...(parsed.autoTrading || {}),
        recentLogs,
        recentCycleSummaries: Array.isArray(parsed.autoTrading?.recentCycleSummaries) ? parsed.autoTrading.recentCycleSummaries.slice(0, 50) : [],
        decisionTraces: Array.isArray(parsed.autoTrading?.decisionTraces) ? parsed.autoTrading.decisionTraces.slice(0, 500) : [],
      };
    } else {
      // Render 免费实例无持久磁盘，从环境变量恢复配置
      const envArenaMode = process.env.AUTO_TRADING_CONFIG;
      if (envArenaMode !== undefined && envArenaMode !== null && envArenaMode.trim() !== "") {
        try {
          const mode = parseInt(envArenaMode.trim(), 10);
          if (!isNaN(mode) && mode >= 0 && mode <= 2) {
            const cfg = sanitizeAutoTradingConfig({
              sandbox: mode !== 2,       // 0,1 = sandbox; 2 = live
              shadowMode: mode === 0,    // 0 = shadow; 1,2 = no shadow
              scanProfilesVersion: 0,
              scanProfiles: [],
              strategyIds: [],
              riskConfigSnapshot: {},
            });
            appStore.autoTrading = {
              ...createDefaultAutoTradingStore(),
              config: cfg,
            };
            console.log(`[OpsStore] Auto-trading mode restored from AUTO_TRADING_CONFIG=${mode} (${mode === 0 ? "影子" : mode === 1 ? "模拟盘" : "实盘"})`);
          } else {
            console.warn(`[OpsStore] Invalid AUTO_TRADING_CONFIG value: "${envArenaMode}". Expected 0 (影子), 1 (模拟盘), or 2 (实盘).`);
          }
        } catch (e) {
          console.warn("[OpsStore] Failed to read AUTO_TRADING_CONFIG env var:", e);
        }
      }
    }

    const password = await getAdminPassword();
    adminPasswordHash = hashSecret(password);
    const now = Date.now();
    appStore.sessions = appStore.sessions.filter(session => session.expiresAt > now);
    if (appStoreSanitized) {
      await persistAppStore();
    }
    console.log("[OpsStore] Local operations store loaded.");
  } catch (error) {
    console.warn("[OpsStore] Failed to load local operations store:", error);
  }
}

async function persistAppStore() {
  await writeFileAtomic(APP_STORE_FILE, JSON.stringify(appStore, null, 2), { mode: 0o600 });
}

const AUTO_TRADING_LOG_LIMIT = 200;
const AUTO_TRADING_SUMMARY_LIMIT = 50;
const AUTO_TRADING_TRACE_LIMIT = 500;
const AUTO_TRADING_MIN_DELAY_MS = 60_000;
const AUTO_TRADING_MAX_DELAY_MS = 15 * 60_000;
const AUTO_TRADING_BASE_DELAY_MS = 5 * 60_000;
const TP_MANAGER_INTERVAL_MS = 60_000;
const TP_MANAGER_COOLDOWN_MS = 120_000;
const TP_MANAGER_MAX_AMENDS = 5;
const TP_MANAGER_MIN_PRICE_PCT = 0.002;
const TP_MANAGER_MIN_R_MULTIPLIER = 0.25;

function sanitizeAutoTradingRiskConfig(input: Partial<AutoTradingRiskConfig> | undefined): AutoTradingRiskConfig {
  return {
    ...DEFAULT_AUTO_TRADING_RISK_CONFIG,
    ...(input || {}),
  };
}

const DEFAULT_AUTO_TRADING_SCAN_PROFILES: AutoTradingScanProfile[] = [
  { symbol: "BTC/USDT", timeframes: ["15m", "1h"] },
  { symbol: "ETH/USDT", timeframes: ["15m", "1h"] },
  { symbol: "SOL/USDT", timeframes: ["1h"] },
  { symbol: "DOGE/USDT", timeframes: ["1h"] },
];
const AUTO_TRADING_SCAN_PROFILES_VERSION = 2;

const DEFAULT_TIMEFRAME_BY_SYMBOL = new Map(
  DEFAULT_AUTO_TRADING_SCAN_PROFILES.map((profile) => [profile.symbol, profile.timeframes[0] || "1h"])
);

function normalizeScanProfiles(input: any): AutoTradingScanProfile[] {
  const allowedSymbols = new Set<string>(AUTO_TRADING_ALLOWED_SYMBOLS as readonly string[]);
  const allowedTimeframes = new Set<string>(AUTO_TRADING_ALLOWED_TIMEFRAMES as readonly string[]);
  const sourceProfiles = shouldMigrateLegacyScanProfiles(input)
    ? DEFAULT_AUTO_TRADING_SCAN_PROFILES
    : Array.isArray(input?.scanProfiles)
    ? input.scanProfiles
    : DEFAULT_AUTO_TRADING_SCAN_PROFILES;

  const normalized = new Map<string, Set<string>>();
  for (const profile of sourceProfiles) {
    const symbol = normalizeDisplaySymbol(profile?.symbol || "");
    if (!allowedSymbols.has(symbol)) continue;
    const timeframes = Array.isArray(profile?.timeframes) ? profile.timeframes : [];
    const validTimeframes = timeframes
      .map((value) => String(value || "").trim())
      .filter((value) => allowedTimeframes.has(value));
    const nextTimeframes = validTimeframes.length
      ? validTimeframes
      : [DEFAULT_TIMEFRAME_BY_SYMBOL.get(symbol) || "1h"];
    if (!normalized.has(symbol)) normalized.set(symbol, new Set<string>());
    for (const timeframe of nextTimeframes) {
      normalized.get(symbol)!.add(timeframe);
    }
  }

  return Array.from(normalized.entries()).map(([symbol, timeframes]) => ({
    symbol,
    timeframes: Array.from(timeframes).sort((left, right) => left.localeCompare(right)),
  }));
}

function shouldMigrateLegacyScanProfiles(input: any) {
  if (!input || Number(input.scanProfilesVersion || 0) >= AUTO_TRADING_SCAN_PROFILES_VERSION) return false;
  if (!Array.isArray(input.scanProfiles) || input.scanProfiles.length === 0) return true;

  const profiles = input.scanProfiles
    .map((profile: any) => ({
      symbol: normalizeDisplaySymbol(profile?.symbol || ""),
      timeframes: Array.isArray(profile?.timeframes)
        ? profile.timeframes.map((value: unknown) => String(value || "").trim()).filter(Boolean)
        : [],
    }))
    .filter((profile: AutoTradingScanProfile) => profile.symbol);
  const bySymbol = new Map(profiles.map((profile: AutoTradingScanProfile) => [profile.symbol, profile.timeframes]));
  const hasAllDefaultSymbols = DEFAULT_AUTO_TRADING_SCAN_PROFILES.every((profile) => bySymbol.has(profile.symbol));
  const everyProfileSingleOneHour = profiles.length > 0 && profiles.every((profile: AutoTradingScanProfile) => (
    profile.timeframes.length === 1 && profile.timeframes[0] === "1h"
  ));

  return !hasAllDefaultSymbols && everyProfileSingleOneHour;
}

function getScanSymbols(config: AutoTradingConfig) {
  return config.scanProfiles.map((profile) => profile.symbol);
}

function getDefaultTimeframeForSymbol(config: AutoTradingConfig | null | undefined, symbol: string) {
  const normalizedSymbol = normalizeDisplaySymbol(symbol);
  const matched = config?.scanProfiles.find((profile) => profile.symbol === normalizedSymbol);
  return matched?.timeframes[0] || DEFAULT_TIMEFRAME_BY_SYMBOL.get(normalizedSymbol) || "1h";
}

function serializeAutoTradingConfig(config: AutoTradingConfig | null) {
  if (!config) return null;
  const scanProfiles = config.scanProfiles.map((profile) => ({
    symbol: profile.symbol,
    timeframes: [...profile.timeframes],
  }));
  const allTimeframes = Array.from(new Set(scanProfiles.flatMap((profile) => profile.timeframes)));
  return {
    ...config,
    scanProfilesVersion: AUTO_TRADING_SCAN_PROFILES_VERSION,
    scanProfiles,
    symbols: getScanSymbols(config),
    chartTimeframe: allTimeframes.length === 1 ? allTimeframes[0] : "multi",
  };
}

function getCorrelationGroup(symbol: string) {
  const normalizedSymbol = normalizeDisplaySymbol(symbol);
  if (normalizedSymbol === "BTC/USDT" || normalizedSymbol === "ETH/USDT") return "majors";
  if (normalizedSymbol === "SOL/USDT") return "sol";
  if (normalizedSymbol === "DOGE/USDT") return "doge";
  return normalizedSymbol;
}

function sanitizeAutoTradingConfig(input: Partial<AutoTradingConfig> | null | undefined): AutoTradingConfig | null {
  if (!input) return null;
  const normalizedScanProfiles = normalizeScanProfiles(input);
  const normalizedStrategies = Array.from(new Set((Array.isArray(input.strategyIds) ? input.strategyIds : [])
    .map(value => String(value || "").trim())
    .filter(Boolean)));
  if (normalizedScanProfiles.length === 0 || normalizedStrategies.length === 0) return null;
  return {
    sandbox: Boolean(input.sandbox),
    scanProfilesVersion: AUTO_TRADING_SCAN_PROFILES_VERSION,
    scanProfiles: normalizedScanProfiles,
    strategyIds: normalizedStrategies,
    riskConfigSnapshot: sanitizeAutoTradingRiskConfig(input.riskConfigSnapshot),
    shadowMode: input.shadowMode ?? input.riskConfigSnapshot?.shadowMode ?? DEFAULT_AUTO_TRADING_RISK_CONFIG.shadowMode,
  };
}

function updateAutoTradingStore(patch: Partial<AutoTradingStore>) {
  appStore.autoTrading = {
    ...appStore.autoTrading,
    ...patch,
    recentLogs: patch.recentLogs ?? appStore.autoTrading.recentLogs,
    recentCycleSummaries: patch.recentCycleSummaries ?? appStore.autoTrading.recentCycleSummaries,
    decisionTraces: patch.decisionTraces ?? appStore.autoTrading.decisionTraces,
  };
  persistAppStore().catch(error => console.error("[AutoTrading] Persist failed:", error));
  return appStore.autoTrading;
}

function pushAutoTradingLog(message: string) {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}] ${message}`;
  const recentLogs = [line, ...appStore.autoTrading.recentLogs].slice(0, AUTO_TRADING_LOG_LIMIT);
  updateAutoTradingStore({ recentLogs });
  return line;
}

function pushAutoTradingSummary(summary: AutoTradingCycleSummary) {
  const recentCycleSummaries = [summary, ...appStore.autoTrading.recentCycleSummaries].slice(0, AUTO_TRADING_SUMMARY_LIMIT);
  updateAutoTradingStore({
    recentCycleSummaries,
    lastRunAt: summary.completedAt,
    lastError: summary.error || null,
  });
  return summary;
}

function pushAutoTradingTrace(trace: Omit<AutoTradingDecisionTrace, "id" | "createdAt">) {
  const entry: AutoTradingDecisionTrace = {
    ...trace,
    id: `trace_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    createdAt: Date.now(),
  };
  const decisionTraces = [entry, ...appStore.autoTrading.decisionTraces].slice(0, AUTO_TRADING_TRACE_LIMIT);
  updateAutoTradingStore({ decisionTraces });
  return entry;
}

// --- Local Trading Database ---
let tradingDb: any = null;

function normalizeNumber(value: any): number | null {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse<T>(value: any, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeBooleanInt(value: any, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value ? 1 : 0;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return 1;
  if (["0", "false", "no", "off"].includes(normalized)) return 0;
  return fallback;
}

function stringifyJson(value: any) {
  if (value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    const normalized = normalizeNumber(value);
    if (normalized !== null) return normalized;
  }
  return 0;
}

function floorToStep(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

function normalizeOkxBalance(balance: any) {
  const account = balance?.info?.data?.[0] || {};
  const details = Array.isArray(account.details) ? account.details : [];
  const usdt = details.find((item: any) => String(item?.ccy || "").toUpperCase() === "USDT") || {};
  const totalUSDT = firstNumber(
    usdt.eq,
    usdt.cashBal,
    usdt.eqUsd,
    account.totalEq,
    account.adjEq,
    balance?.total?.USDT,
    balance?.USDT?.total
  );
  const freeUSDT = firstNumber(
    usdt.availBal,
    usdt.availEq,
    account.availEq,
    balance?.free?.USDT,
    balance?.USDT?.free
  );
  const usedUSDT = firstNumber(
    balance?.used?.USDT,
    balance?.USDT?.used,
    usdt.frozenBal,
    Math.max(totalUSDT - freeUSDT, 0)
  );

  return {
    ...balance,
    total: { ...(balance?.total || {}), USDT: totalUSDT },
    free: { ...(balance?.free || {}), USDT: freeUSDT },
    used: { ...(balance?.used || {}), USDT: usedUSDT },
    equityUSDT: totalUSDT,
    availableUSDT: freeUSDT,
    usedUSDT,
  };
}

function normalizeOkxPosition(position: any) {
  const info = position?.info || {};
  const rawContracts = [position?.contracts, info.pos, info.availPos]
    .map(normalizeNumber)
    .find((value) => value !== null && value !== 0) ?? 0;
  const contracts = Math.abs(rawContracts);
  const posSide = String(info.posSide || position?.side || "").toLowerCase();
  const side = posSide === "short"
    ? "short"
    : posSide === "long"
      ? "long"
      : rawContracts < 0 ? "short" : "long";
  const entryPrice = firstNumber(position?.entryPrice, info.avgPx);
  const markPrice = firstNumber(position?.markPrice, info.markPx, entryPrice);
  const unrealizedPnl = firstNumber(position?.unrealizedPnl, info.upl, info.uplRatio);
  const leverage = firstNumber(position?.leverage, info.lever);
  const notionalUsd = Math.abs(firstNumber(position?.notionalUsd, position?.notional, info.notionalUsd, contracts * markPrice));

  return {
    ...position,
    symbol: normalizeDisplaySymbol(position?.symbol || info.instId || ""),
    side,
    contracts,
    entryPrice,
    markPrice,
    unrealizedPnl,
    leverage,
    notionalUsd,
  };
}

function getAccountTotalUSDT(balance: any) {
  return firstNumber(
    balance?.equityUSDT,
    balance?.availableUSDT,
    balance?.total?.USDT,
    balance?.free?.USDT,
    balance?.USDT?.total,
    balance?.USDT?.free,
    typeof balance?.total === "number" ? balance?.total : undefined,
    typeof balance?.free === "number" ? balance?.free : undefined
  );
}

function countActivePositions(positions: any[]) {
  return positions.filter(pos => Math.abs(firstNumber(pos.contracts, pos.info?.pos, pos.info?.availPos)) > 0).length;
}

function toModeLabel(sandbox: boolean) {
  return sandbox ? "okx-demo" : "okx-live";
}

async function fetchPublicTickerSnapshot(symbol: string) {
  const instId = toOkxSwapInstId(symbol);
  return cachedPublicMarket(`ticker:${instId}`, 3000, async () => {
    const [raw] = await okxPublicGet("/api/v5/market/ticker", { instId });
    const last = Number(raw?.last || 0);
    const open = Number(raw?.open24h || last);
    return {
      symbol: normalizeDisplaySymbol(symbol),
      timestamp: Number(raw?.ts || Date.now()),
      datetime: new Date(Number(raw?.ts || Date.now())).toISOString(),
      high: Number(raw?.high24h || last),
      low: Number(raw?.low24h || last),
      bid: Number(raw?.bidPx || 0),
      bidVolume: Number(raw?.bidSz || 0),
      ask: Number(raw?.askPx || 0),
      askVolume: Number(raw?.askSz || 0),
      open,
      close: last,
      last,
      change: last - open,
      percentage: open ? ((last - open) / open) * 100 : 0,
      baseVolume: Number(raw?.vol24h || 0),
      volume: Number(raw?.vol24h || 0),
      info: raw
    };
  });
}

async function fetchPublicOrderBookSnapshot(symbol: string) {
  const instId = toOkxSwapInstId(symbol);
  return cachedPublicMarket(`orderbook:${instId}`, 3000, async () => {
    const [raw] = await okxPublicGet("/api/v5/market/books", { instId, sz: 20 });
    return {
      symbol: normalizeDisplaySymbol(symbol),
      timestamp: Number(raw?.ts || Date.now()),
      datetime: new Date(Number(raw?.ts || Date.now())).toISOString(),
      bids: (raw?.bids || []).map((row: string[]) => [Number(row[0]), Number(row[1])]),
      asks: (raw?.asks || []).map((row: string[]) => [Number(row[0]), Number(row[1])]),
      info: raw
    } as RuntimeOrderBook & { symbol: string; timestamp: number; datetime: string; info: any };
  });
}

async function fetchPublicFundingSnapshot(symbol: string) {
  const instId = toOkxSwapInstId(symbol);
  return cachedPublicMarket(`funding:${instId}`, 60000, async () => {
    const [raw] = await okxPublicGet("/api/v5/public/funding-rate", { instId });
    return {
      symbol: normalizeDisplaySymbol(symbol),
      fundingRate: Number(raw?.fundingRate || 0),
      nextFundingRate: Number(raw?.nextFundingRate || 0),
      fundingTimestamp: Number(raw?.fundingTime || 0),
      nextFundingTime: Number(raw?.nextFundingTime || 0),
      timestamp: Date.now(),
      info: raw
    };
  });
}

async function fetchPublicOhlcvSnapshot(symbol: string, timeframe = "1h", limit = 120) {
  const instId = toOkxSwapInstId(symbol);
  return cachedPublicMarket(`ohlcv:${instId}:${timeframe}:${limit}`, 60000, async () => {
    const rows = await okxPublicGet("/api/v5/market/candles", { instId, bar: okxBar(timeframe), limit });
    return rows
      .map((row: string[]) => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])])
      .sort((a: number[], b: number[]) => a[0] - b[0]);
  });
}

async function fetchPublicMarketBundle(symbol: string, timeframe: string, limit = 120) {
  const [ticker, funding, orderBook, ohlcv] = await Promise.all([
    fetchPublicTickerSnapshot(symbol),
    fetchPublicFundingSnapshot(symbol),
    fetchPublicOrderBookSnapshot(symbol),
    fetchPublicOhlcvSnapshot(symbol, timeframe, limit),
  ]);
  return { ticker, funding, orderBook, ohlcv };
}

async function fetchPublicMarketBundleWithAutoRetry(symbol: string, timeframe: string, limit = 120) {
  return withAutoTradingDataRetry(
    `OKX market data ${symbol} ${timeframe}`,
    () => fetchPublicMarketBundle(symbol, timeframe, limit)
  );
}

async function fetchPrivateBalance(credentials: Required<OkxCredentials>, sandbox: boolean, autoRetry = false) {
  const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, sandbox);
  await prepareExchange(exchange);
  const operation = () => runWithExchangeProxyFallback(exchange, () => exchange.fetchBalance());
  const balance = autoRetry
    ? await withAutoTradingDataRetry("OKX private balance", operation)
    : await operation();
  if (autoRetry) markExchangeConnectivitySuccess({ okxPrivate: true });
  return normalizeOkxBalance(balance);
}

async function fetchPrivatePositions(credentials: Required<OkxCredentials>, sandbox: boolean, autoRetry = false) {
  const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, sandbox);
  await prepareExchange(exchange);
  const operation = () => runWithExchangeProxyFallback<any[]>(exchange, () => exchange.fetchPositions(undefined, { instType: "SWAP" }));
  const positions = autoRetry
    ? await withAutoTradingDataRetry("OKX private positions", operation)
    : await operation();
  if (autoRetry) markExchangeConnectivitySuccess({ okxPrivate: true });
  return positions.map(normalizeOkxPosition).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
}

function normalizeTimestamp(value: any) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

async function initTradingDatabase() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  tradingDb = new DatabaseSync(TRADING_DB_FILE);
  tradingDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      exchange_order_id TEXT,
      client_order_id TEXT,
      parent_id TEXT,
      request_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT,
      strategy_id TEXT,
      amount REAL,
      amount_type TEXT,
      price REAL,
      entry_price REAL,
      mark_price REAL,
      realized_pnl REAL,
      fee REAL,
      margin REAL,
      notional REAL,
      leverage REAL,
      order_type TEXT,
      tp_price REAL,
      sl_price REAL,
      initial_tp_price REAL,
      current_tp_price REAL,
      tp_amend_count INTEGER,
      tp_manager_status TEXT,
      last_tp_manager_reason TEXT,
      attached_tp_algo_id TEXT,
      attached_tp_algo_cl_ord_id TEXT,
      regime TEXT,
      regime_score REAL,
      macro_gate TEXT,
      macro_score REAL,
      entry_reason TEXT,
      feature_json TEXT,
      stop_distance REAL,
      exit_reason TEXT,
      rule_compliant INTEGER,
      ai_verdict TEXT,
      raw_json TEXT,
      opened_at INTEGER,
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

    CREATE TABLE IF NOT EXISTS strategy_signals (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL,
      confidence REAL,
      reasoning TEXT,
      price REAL,
      tp_price REAL,
      sl_price REAL,
      mode TEXT,
      source TEXT,
      regime TEXT,
      regime_score REAL,
      macro_gate TEXT,
      macro_score REAL,
      feature_json TEXT,
      raw_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_strategy_signals_created_at ON strategy_signals(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_strategy_signals_strategy ON strategy_signals(strategy_id);

    CREATE TABLE IF NOT EXISTS shadow_orders (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      strategy_id TEXT,
      theoretical_price REAL,
      executable_price REAL,
      spread_bps REAL,
      slippage_bps REAL,
      latency_ms REAL,
      amount REAL,
      amount_type TEXT,
      regime TEXT,
      macro_gate TEXT,
      orderbook_json TEXT,
      signal_json TEXT,
      status TEXT,
      timeframe TEXT,
      leverage REAL,
      tp_price REAL,
      sl_price REAL,
      entry_price REAL,
      mark_price REAL,
      qty_estimate REAL,
      unrealized_pnl REAL,
      exit_price REAL,
      realized_pnl REAL,
      exit_reason TEXT,
      closed_at INTEGER,
      last_evaluated_at INTEGER,
      is_estimated INTEGER,
      estimated_timeframe TEXT,
      estimation_note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shadow_orders_created_at ON shadow_orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shadow_orders_symbol ON shadow_orders(symbol);
  `);
  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = tradingDb!.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!columns.some((item) => item.name === column)) {
      tradingDb!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  [
    ["regime", "TEXT"],
    ["regime_score", "REAL"],
    ["macro_gate", "TEXT"],
    ["macro_score", "REAL"],
    ["entry_reason", "TEXT"],
    ["feature_json", "TEXT"],
    ["stop_distance", "REAL"],
    ["exit_reason", "TEXT"],
    ["rule_compliant", "INTEGER"],
    ["ai_verdict", "TEXT"],
    ["initial_tp_price", "REAL"],
    ["current_tp_price", "REAL"],
    ["tp_amend_count", "INTEGER"],
    ["tp_manager_status", "TEXT"],
    ["last_tp_manager_reason", "TEXT"],
    ["attached_tp_algo_id", "TEXT"],
    ["attached_tp_algo_cl_ord_id", "TEXT"],
  ].forEach(([column, definition]) => ensureColumn("trades", column, definition));
  [
    ["regime", "TEXT"],
    ["regime_score", "REAL"],
    ["macro_gate", "TEXT"],
    ["macro_score", "REAL"],
    ["feature_json", "TEXT"],
  ].forEach(([column, definition]) => ensureColumn("strategy_signals", column, definition));
  [
    ["status", "TEXT"],
    ["timeframe", "TEXT"],
    ["leverage", "REAL"],
    ["tp_price", "REAL"],
    ["sl_price", "REAL"],
    ["entry_price", "REAL"],
    ["mark_price", "REAL"],
    ["qty_estimate", "REAL"],
    ["unrealized_pnl", "REAL"],
    ["exit_price", "REAL"],
    ["realized_pnl", "REAL"],
    ["exit_reason", "TEXT"],
    ["closed_at", "INTEGER"],
    ["last_evaluated_at", "INTEGER"],
    ["is_estimated", "INTEGER"],
    ["estimated_timeframe", "TEXT"],
    ["estimation_note", "TEXT"],
  ].forEach(([column, definition]) => ensureColumn("shadow_orders", column, definition));
  tradingDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_shadow_orders_status ON shadow_orders(status);
    CREATE INDEX IF NOT EXISTS idx_shadow_orders_symbol_strategy_status ON shadow_orders(symbol, strategy_id, status);
  `);
  await hydrateLegacyShadowOrders();
  console.log(`[TradingDB] SQLite database ready at ${TRADING_DB_FILE}`);
}

function recordTrade(row: any) {
  if (!tradingDb) return null;
  const now = Date.now();
  const id = String(row.id || row.clientOrderId || row.client_order_id || row.exchangeOrderId || row.exchange_order_id || `trade_${now}_${crypto.randomBytes(4).toString("hex")}`);
  const openedAt = normalizeTimestamp(row.openedAt || row.opened_at || row.timestamp || row.datetime || now);
  const closedAt = row.closedAt || row.closed_at || row.realizedPnl !== undefined || row.status === "closed"
    ? normalizeTimestamp(row.closedAt || row.closed_at || row.timestamp || row.datetime || now)
    : null;

  const payload = {
    id,
    exchange_order_id: row.exchangeOrderId || row.exchange_order_id || row.orderId || row.order_id || null,
    client_order_id: row.clientOrderId || row.client_order_id || null,
    parent_id: row.parentId || row.parent_id || null,
    request_id: row.requestId || row.request_id || null,
    symbol: String(row.symbol || "UNKNOWN"),
    side: String(row.side || "UNKNOWN").toUpperCase(),
    status: String(row.status || "open").toLowerCase(),
    mode: String(row.mode || (row.sandbox ? "okx-demo" : "okx-live")),
    source: row.source || null,
    strategy_id: row.strategyId || row.strategy_id || row.strategy || null,
    amount: normalizeNumber(row.amount ?? row.contracts),
    amount_type: row.amountType || row.amount_type || null,
    price: normalizeNumber(row.price),
    entry_price: normalizeNumber(row.entryPrice ?? row.entry_price),
    mark_price: normalizeNumber(row.markPrice ?? row.mark_price),
    realized_pnl: normalizeNumber(row.realizedPnl ?? row.realized_pnl),
    fee: normalizeNumber(row.fee?.cost ?? row.fee),
    margin: normalizeNumber(row.margin),
    notional: normalizeNumber(row.notional ?? row.notionalUsd),
    leverage: normalizeNumber(row.leverage),
    order_type: row.type || row.orderType || row.order_type || null,
    tp_price: normalizeNumber(row.tpPrice ?? row.tp_price ?? row.tp),
    sl_price: normalizeNumber(row.slPrice ?? row.sl_price ?? row.sl),
    initial_tp_price: normalizeNumber(row.initialTpPrice ?? row.initial_tp_price ?? row.tpPrice ?? row.tp_price ?? row.tp),
    current_tp_price: normalizeNumber(row.currentTpPrice ?? row.current_tp_price ?? row.tpPrice ?? row.tp_price ?? row.tp),
    tp_amend_count: normalizeNumber(row.tpAmendCount ?? row.tp_amend_count),
    tp_manager_status: row.tpManagerStatus || row.tp_manager_status || null,
    last_tp_manager_reason: row.lastTpManagerReason || row.last_tp_manager_reason || null,
    attached_tp_algo_id: row.attachedTpAlgoId || row.attached_tp_algo_id || null,
    attached_tp_algo_cl_ord_id: row.attachedTpAlgoClOrdId || row.attached_tp_algo_cl_ord_id || null,
    regime: row.regime || row.marketRegime || row.raw?.regime || null,
    regime_score: normalizeNumber(row.regimeScore ?? row.regime_score ?? row.raw?.regimeScore),
    macro_gate: row.macroGate?.state || row.macroGate || row.macro_gate || row.raw?.macroGate?.state || null,
    macro_score: normalizeNumber(row.macroScore ?? row.macro_score ?? row.raw?.macroGate?.score),
    entry_reason: row.entryReason || row.entry_reason || row.reasoning || row.raw?.reasoning || null,
    feature_json: typeof (row.features ?? row.featureJson ?? row.feature_json) === "string"
      ? (row.features ?? row.featureJson ?? row.feature_json)
      : JSON.stringify(row.features ?? row.featureJson ?? row.feature_json ?? null),
    stop_distance: normalizeNumber(row.stopDistance ?? row.stop_distance),
    exit_reason: row.exitReason || row.exit_reason || null,
    rule_compliant: row.ruleCompliant === undefined && row.rule_compliant === undefined ? null : (row.ruleCompliant ?? row.rule_compliant ? 1 : 0),
    ai_verdict: row.aiVerdict || row.ai_verdict || null,
    raw_json: JSON.stringify(row.raw ?? row),
    opened_at: openedAt,
    closed_at: closedAt,
    created_at: row.createdAt || row.created_at || openedAt || now,
    updated_at: now,
  };

  tradingDb.prepare(`
    INSERT INTO trades (
      id, exchange_order_id, client_order_id, parent_id, request_id, symbol, side, status, mode,
      source, strategy_id, amount, amount_type, price, entry_price, mark_price, realized_pnl,
      fee, margin, notional, leverage, order_type, tp_price, sl_price,
      initial_tp_price, current_tp_price, tp_amend_count, tp_manager_status, last_tp_manager_reason,
      attached_tp_algo_id, attached_tp_algo_cl_ord_id,
      regime, regime_score, macro_gate, macro_score, entry_reason, feature_json, stop_distance,
      exit_reason, rule_compliant, ai_verdict, raw_json, opened_at, closed_at, created_at, updated_at
    ) VALUES (
      @id, @exchange_order_id, @client_order_id, @parent_id, @request_id, @symbol, @side, @status, @mode,
      @source, @strategy_id, @amount, @amount_type, @price, @entry_price, @mark_price, @realized_pnl,
      @fee, @margin, @notional, @leverage, @order_type, @tp_price, @sl_price,
      @initial_tp_price, @current_tp_price, @tp_amend_count, @tp_manager_status, @last_tp_manager_reason,
      @attached_tp_algo_id, @attached_tp_algo_cl_ord_id,
      @regime, @regime_score, @macro_gate, @macro_score, @entry_reason, @feature_json, @stop_distance,
      @exit_reason, @rule_compliant, @ai_verdict, @raw_json, @opened_at, @closed_at, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      exchange_order_id = COALESCE(excluded.exchange_order_id, trades.exchange_order_id),
      client_order_id = COALESCE(excluded.client_order_id, trades.client_order_id),
      parent_id = COALESCE(excluded.parent_id, trades.parent_id),
      request_id = COALESCE(excluded.request_id, trades.request_id),
      symbol = excluded.symbol,
      side = excluded.side,
      status = excluded.status,
      mode = excluded.mode,
      source = COALESCE(excluded.source, trades.source),
      strategy_id = COALESCE(excluded.strategy_id, trades.strategy_id),
      amount = COALESCE(excluded.amount, trades.amount),
      amount_type = COALESCE(excluded.amount_type, trades.amount_type),
      price = COALESCE(excluded.price, trades.price),
      entry_price = COALESCE(excluded.entry_price, trades.entry_price),
      mark_price = COALESCE(excluded.mark_price, trades.mark_price),
      realized_pnl = COALESCE(excluded.realized_pnl, trades.realized_pnl),
      fee = COALESCE(excluded.fee, trades.fee),
      margin = COALESCE(excluded.margin, trades.margin),
      notional = COALESCE(excluded.notional, trades.notional),
      leverage = COALESCE(excluded.leverage, trades.leverage),
      order_type = COALESCE(excluded.order_type, trades.order_type),
      tp_price = COALESCE(excluded.tp_price, trades.tp_price),
      sl_price = COALESCE(excluded.sl_price, trades.sl_price),
      initial_tp_price = COALESCE(excluded.initial_tp_price, trades.initial_tp_price),
      current_tp_price = COALESCE(excluded.current_tp_price, trades.current_tp_price),
      tp_amend_count = COALESCE(excluded.tp_amend_count, trades.tp_amend_count),
      tp_manager_status = COALESCE(excluded.tp_manager_status, trades.tp_manager_status),
      last_tp_manager_reason = COALESCE(excluded.last_tp_manager_reason, trades.last_tp_manager_reason),
      attached_tp_algo_id = COALESCE(excluded.attached_tp_algo_id, trades.attached_tp_algo_id),
      attached_tp_algo_cl_ord_id = COALESCE(excluded.attached_tp_algo_cl_ord_id, trades.attached_tp_algo_cl_ord_id),
      regime = COALESCE(excluded.regime, trades.regime),
      regime_score = COALESCE(excluded.regime_score, trades.regime_score),
      macro_gate = COALESCE(excluded.macro_gate, trades.macro_gate),
      macro_score = COALESCE(excluded.macro_score, trades.macro_score),
      entry_reason = COALESCE(excluded.entry_reason, trades.entry_reason),
      feature_json = COALESCE(excluded.feature_json, trades.feature_json),
      stop_distance = COALESCE(excluded.stop_distance, trades.stop_distance),
      exit_reason = COALESCE(excluded.exit_reason, trades.exit_reason),
      rule_compliant = COALESCE(excluded.rule_compliant, trades.rule_compliant),
      ai_verdict = COALESCE(excluded.ai_verdict, trades.ai_verdict),
      raw_json = excluded.raw_json,
      closed_at = COALESCE(excluded.closed_at, trades.closed_at),
      updated_at = excluded.updated_at
  `).run(payload);

  return payload;
}

function recordStrategySignal(row: any) {
  if (!tradingDb) return null;
  const now = Date.now();
  const payload = {
    id: String(row.id || `sig_${now}_${crypto.randomBytes(4).toString("hex")}`),
    strategy_id: String(row.strategyId || row.strategy_id || "unknown"),
    symbol: String(row.symbol || "UNKNOWN"),
    signal: String(row.signal || "HOLD").toUpperCase(),
    confidence: normalizeNumber(row.confidence),
    reasoning: row.reasoning || null,
    price: normalizeNumber(row.price),
    tp_price: normalizeNumber(row.tpPrice ?? row.tp_price),
    sl_price: normalizeNumber(row.slPrice ?? row.sl_price),
    mode: row.mode || null,
    source: row.source || null,
    regime: row.regime || row.raw?.regime || null,
    regime_score: normalizeNumber(row.regimeScore ?? row.regime_score ?? row.raw?.regimeScore),
    macro_gate: row.macroGate?.state || row.macroGate || row.macro_gate || row.raw?.macroGate?.state || null,
    macro_score: normalizeNumber(row.macroScore ?? row.macro_score ?? row.raw?.macroGate?.score),
    feature_json: typeof (row.features ?? row.featureJson ?? row.feature_json) === "string"
      ? (row.features ?? row.featureJson ?? row.feature_json)
      : JSON.stringify(row.features ?? row.featureJson ?? row.feature_json ?? row.raw?.features ?? null),
    raw_json: JSON.stringify(row.raw ?? row),
    created_at: row.createdAt || row.created_at || now,
  };

  tradingDb.prepare(`
    INSERT INTO strategy_signals (
      id, strategy_id, symbol, signal, confidence, reasoning, price, tp_price, sl_price,
      mode, source, regime, regime_score, macro_gate, macro_score, feature_json, raw_json, created_at
    ) VALUES (
      @id, @strategy_id, @symbol, @signal, @confidence, @reasoning, @price, @tp_price, @sl_price,
      @mode, @source, @regime, @regime_score, @macro_gate, @macro_score, @feature_json, @raw_json, @created_at
    )
  `).run(payload);

  return payload;
}

function normalizeShadowStatus(value: any, fallback: ShadowOrderStatus = "open"): ShadowOrderStatus {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (normalized === "closed") return "closed";
  if (normalized === "estimated_skipped") return "estimated_skipped";
  return "open";
}

function normalizeShadowExitReason(value: any): ShadowExitReason {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "take_profit") return "take_profit";
  if (normalized === "stop_loss") return "stop_loss";
  if (normalized === "reverse_signal") return "reverse_signal";
  return null;
}

function timeframeToMs(timeframe: string) {
  const normalized = String(timeframe || "1h").trim().toLowerCase();
  if (normalized.endsWith("m")) return Math.max(60_000, Number(normalized.slice(0, -1)) * 60_000);
  if (normalized.endsWith("h")) return Math.max(3_600_000, Number(normalized.slice(0, -1)) * 3_600_000);
  if (normalized === "1d") return 86_400_000;
  if (normalized === "1w") return 7 * 86_400_000;
  return 3_600_000;
}

function calculateShadowQtyEstimate(input: {
  amount?: number | null;
  amountType?: string | null;
  leverage?: number | null;
  entryPrice?: number | null;
}) {
  const amount = Number(input.amount || 0);
  const entryPrice = Number(input.entryPrice || 0);
  const leverage = Math.max(1, Number(input.leverage || 1));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (String(input.amountType || "usdt").toLowerCase() === "coin") return amount;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  return (amount * leverage) / entryPrice;
}

function calculateShadowPnl(side: string, qtyEstimate: number | null, entryPrice: number | null, markPrice: number | null) {
  const qty = Number(qtyEstimate || 0);
  const entry = Number(entryPrice || 0);
  const mark = Number(markPrice || 0);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(mark) || mark <= 0) return 0;
  return String(side || "").toUpperCase() === "BUY"
    ? qty * (mark - entry)
    : qty * (entry - mark);
}

function getShadowOrderById(id: string) {
  if (!tradingDb || !id) return null;
  return tradingDb.prepare("SELECT * FROM shadow_orders WHERE id = ?").get(id) as ShadowOrderRow | null;
}

function listShadowOrders(status: "open" | "closed" | "all" = "all", limit = 200) {
  if (!tradingDb) return [] as ShadowOrderRow[];
  const boundedLimit = Math.min(1000, Math.max(1, limit));
  if (status === "all") {
    return tradingDb.prepare("SELECT * FROM shadow_orders ORDER BY created_at DESC LIMIT ?").all(boundedLimit) as ShadowOrderRow[];
  }
  return tradingDb.prepare("SELECT * FROM shadow_orders WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, boundedLimit) as ShadowOrderRow[];
}

function loadOpenShadowOrders(limit = 1000) {
  return listShadowOrders("open", limit);
}

function findOpenShadowOrder(symbol: string, strategyId?: string | null) {
  if (!tradingDb) return null;
  const normalizedSymbol = normalizeDisplaySymbol(symbol);
  const normalizedStrategyId = strategyId ? String(strategyId) : "";
  return tradingDb.prepare(`
    SELECT *
    FROM shadow_orders
    WHERE symbol = ?
      AND COALESCE(strategy_id, '') = ?
      AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(normalizedSymbol, normalizedStrategyId) as ShadowOrderRow | null;
}

function normalizeShadowOrderRow(row: any, existing?: Partial<ShadowOrderRow> | null): ShadowOrderRow {
  const now = Date.now();
  const existingSignal = safeJsonParse<any>(existing?.signal_json, null);
  const incomingSignal = row.signal ?? safeJsonParse<any>(row.signal_json, null);
  const signalPayload = incomingSignal ?? existingSignal ?? null;
  const orderbookPayload = row.orderbook ?? row.orderBook ?? safeJsonParse<any>(row.orderbook_json, null) ?? safeJsonParse<any>(existing?.orderbook_json, null);
  const side = String(row.side ?? existing?.side ?? "UNKNOWN").toUpperCase();
  const executablePrice = normalizeNumber(row.executablePrice ?? row.executable_price ?? existing?.executable_price);
  const entryPrice = normalizeNumber(row.entryPrice ?? row.entry_price ?? existing?.entry_price ?? executablePrice);
  const amount = normalizeNumber(row.amount ?? existing?.amount);
  const amountType = row.amountType ?? row.amount_type ?? existing?.amount_type ?? "usdt";
  const leverage = normalizeNumber(row.leverage ?? signalPayload?.leverage ?? existing?.leverage ?? 1) ?? 1;
  const qtyEstimate = normalizeNumber(row.qtyEstimate ?? row.qty_estimate ?? existing?.qty_estimate)
    ?? calculateShadowQtyEstimate({ amount, amountType, leverage, entryPrice });
  const markPrice = normalizeNumber(row.markPrice ?? row.mark_price ?? existing?.mark_price ?? entryPrice);
  const exitPrice = normalizeNumber(row.exitPrice ?? row.exit_price ?? existing?.exit_price);
  const realizedPnlInput = normalizeNumber(row.realizedPnl ?? row.realized_pnl ?? existing?.realized_pnl);
  const unrealizedPnlInput = normalizeNumber(row.unrealizedPnl ?? row.unrealized_pnl ?? existing?.unrealized_pnl);
  const status = normalizeShadowStatus(row.status ?? existing?.status ?? "open");
  const closedAt = row.closedAt ?? row.closed_at ?? existing?.closed_at ?? null;
  const realizedPnl = realizedPnlInput ?? (status === "closed"
    ? calculateShadowPnl(side, qtyEstimate, entryPrice, exitPrice)
    : null);
  const unrealizedPnl = unrealizedPnlInput ?? (status === "open"
    ? calculateShadowPnl(side, qtyEstimate, entryPrice, markPrice)
    : 0);

  return {
    id: String(row.id || existing?.id || `shadow_${now}_${crypto.randomBytes(4).toString("hex")}`),
    symbol: normalizeDisplaySymbol(String(row.symbol || existing?.symbol || "UNKNOWN")),
    side,
    strategy_id: row.strategyId || row.strategy_id || existing?.strategy_id || null,
    theoretical_price: normalizeNumber(row.theoreticalPrice ?? row.theoretical_price ?? existing?.theoretical_price),
    executable_price: executablePrice,
    spread_bps: normalizeNumber(row.spreadBps ?? row.spread_bps ?? existing?.spread_bps),
    slippage_bps: normalizeNumber(row.slippageBps ?? row.slippage_bps ?? existing?.slippage_bps),
    latency_ms: normalizeNumber(row.latencyMs ?? row.latency_ms ?? existing?.latency_ms),
    amount,
    amount_type: amountType,
    regime: row.regime || signalPayload?.regime || existing?.regime || null,
    macro_gate: row.macroGate?.state || row.macroGate || signalPayload?.macroGate?.state || signalPayload?.macroGate || existing?.macro_gate || null,
    orderbook_json: stringifyJson(orderbookPayload),
    signal_json: stringifyJson(signalPayload ?? row.raw ?? safeJsonParse(existing?.signal_json, null)),
    status,
    timeframe: row.timeframe || existing?.timeframe || null,
    leverage,
    tp_price: normalizeNumber(row.tpPrice ?? row.tp_price ?? signalPayload?.tp_price ?? existing?.tp_price),
    sl_price: normalizeNumber(row.slPrice ?? row.sl_price ?? signalPayload?.sl_price ?? existing?.sl_price),
    entry_price: entryPrice,
    mark_price: status === "closed" ? (exitPrice ?? markPrice) : markPrice,
    qty_estimate: qtyEstimate,
    unrealized_pnl: status === "closed" ? 0 : unrealizedPnl,
    exit_price: exitPrice,
    realized_pnl: realizedPnl,
    exit_reason: normalizeShadowExitReason(row.exitReason ?? row.exit_reason ?? existing?.exit_reason),
    closed_at: closedAt ? normalizeTimestamp(closedAt) : null,
    last_evaluated_at: normalizeTimestamp(row.lastEvaluatedAt ?? row.last_evaluated_at ?? existing?.last_evaluated_at ?? row.createdAt ?? row.created_at ?? existing?.created_at ?? now),
    is_estimated: normalizeBooleanInt(row.isEstimated ?? row.is_estimated ?? existing?.is_estimated, 0),
    estimated_timeframe: row.estimatedTimeframe || row.estimated_timeframe || existing?.estimated_timeframe || null,
    estimation_note: row.estimationNote || row.estimation_note || existing?.estimation_note || null,
    created_at: normalizeTimestamp(row.createdAt ?? row.created_at ?? existing?.created_at ?? now),
  };
}

function hasMeaningfulAutoTradingConfigInput(input: Partial<AutoTradingConfig> | null | undefined) {
  return Boolean(input && typeof input === "object" && Object.keys(input).length > 0);
}

function persistShadowOrder(row: any) {
  if (!tradingDb) return null;
  const existing = row.id ? getShadowOrderById(String(row.id)) : null;
  const payload = normalizeShadowOrderRow(row, existing);
  tradingDb.prepare(`
    INSERT INTO shadow_orders (
      id, symbol, side, strategy_id, theoretical_price, executable_price, spread_bps,
      slippage_bps, latency_ms, amount, amount_type, regime, macro_gate,
      orderbook_json, signal_json, status, timeframe, leverage, tp_price, sl_price,
      entry_price, mark_price, qty_estimate, unrealized_pnl, exit_price, realized_pnl,
      exit_reason, closed_at, last_evaluated_at, is_estimated, estimated_timeframe, estimation_note, created_at
    ) VALUES (
      @id, @symbol, @side, @strategy_id, @theoretical_price, @executable_price, @spread_bps,
      @slippage_bps, @latency_ms, @amount, @amount_type, @regime, @macro_gate,
      @orderbook_json, @signal_json, @status, @timeframe, @leverage, @tp_price, @sl_price,
      @entry_price, @mark_price, @qty_estimate, @unrealized_pnl, @exit_price, @realized_pnl,
      @exit_reason, @closed_at, @last_evaluated_at, @is_estimated, @estimated_timeframe, @estimation_note, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      symbol = excluded.symbol,
      side = excluded.side,
      strategy_id = excluded.strategy_id,
      theoretical_price = excluded.theoretical_price,
      executable_price = excluded.executable_price,
      spread_bps = excluded.spread_bps,
      slippage_bps = excluded.slippage_bps,
      latency_ms = excluded.latency_ms,
      amount = excluded.amount,
      amount_type = excluded.amount_type,
      regime = excluded.regime,
      macro_gate = excluded.macro_gate,
      orderbook_json = excluded.orderbook_json,
      signal_json = excluded.signal_json,
      status = excluded.status,
      timeframe = excluded.timeframe,
      leverage = excluded.leverage,
      tp_price = excluded.tp_price,
      sl_price = excluded.sl_price,
      entry_price = excluded.entry_price,
      mark_price = excluded.mark_price,
      qty_estimate = excluded.qty_estimate,
      unrealized_pnl = excluded.unrealized_pnl,
      exit_price = excluded.exit_price,
      realized_pnl = excluded.realized_pnl,
      exit_reason = excluded.exit_reason,
      closed_at = excluded.closed_at,
      last_evaluated_at = excluded.last_evaluated_at,
      is_estimated = excluded.is_estimated,
      estimated_timeframe = excluded.estimated_timeframe,
      estimation_note = excluded.estimation_note
  `).run(payload);
  return payload;
}

function updateTradeTakeProfitMetadata(row: {
  id: string;
  tpPrice?: number | null;
  slPrice?: number | null;
  initialTpPrice?: number | null;
  currentTpPrice?: number | null;
  tpAmendCount?: number | null;
  tpManagerStatus?: string | null;
  lastTpManagerReason?: string | null;
  attachedTpAlgoId?: string | null;
  attachedTpAlgoClOrdId?: string | null;
}) {
  if (!tradingDb || !row?.id) return;
  const payload = {
    id: String(row.id),
    tp_price: normalizeNumber(row.tpPrice),
    sl_price: normalizeNumber(row.slPrice),
    initial_tp_price: normalizeNumber(row.initialTpPrice),
    current_tp_price: normalizeNumber(row.currentTpPrice),
    tp_amend_count: normalizeNumber(row.tpAmendCount),
    tp_manager_status: row.tpManagerStatus || null,
    last_tp_manager_reason: row.lastTpManagerReason || null,
    attached_tp_algo_id: row.attachedTpAlgoId || null,
    attached_tp_algo_cl_ord_id: row.attachedTpAlgoClOrdId || null,
    updated_at: Date.now(),
  };

  tradingDb.prepare(`
    UPDATE trades
    SET
      tp_price = COALESCE(@tp_price, tp_price),
      sl_price = COALESCE(@sl_price, sl_price),
      initial_tp_price = COALESCE(@initial_tp_price, initial_tp_price),
      current_tp_price = COALESCE(@current_tp_price, current_tp_price),
      tp_amend_count = COALESCE(@tp_amend_count, tp_amend_count),
      tp_manager_status = COALESCE(@tp_manager_status, tp_manager_status),
      last_tp_manager_reason = COALESCE(@last_tp_manager_reason, last_tp_manager_reason),
      attached_tp_algo_id = COALESCE(@attached_tp_algo_id, attached_tp_algo_id),
      attached_tp_algo_cl_ord_id = COALESCE(@attached_tp_algo_cl_ord_id, attached_tp_algo_cl_ord_id),
      updated_at = @updated_at
    WHERE id = @id
  `).run(payload);
}

function recordShadowOrder(row: any) {
  return persistShadowOrder({
    ...row,
    status: row.status || "open",
  });
}

function updateShadowOrderMark(order: ShadowOrderRow, markPrice: number, evaluatedAt = Date.now()) {
  return persistShadowOrder({
    ...order,
    markPrice,
    unrealizedPnl: calculateShadowPnl(order.side, order.qty_estimate, order.entry_price, markPrice),
    lastEvaluatedAt: evaluatedAt,
  });
}

function closeShadowOrderPosition(
  order: ShadowOrderRow,
  input: {
    referencePrice: number;
    reason: Exclude<ShadowExitReason, null>;
    bar?: any;
    closedAt?: number;
    isEstimated?: boolean;
    estimatedTimeframe?: string | null;
    estimationNote?: string | null;
  }
) {
  const closeSide = String(order.side || "").toUpperCase() === "BUY" ? "sell" : "buy";
  const execution = executionPenaltyModel({
    symbol: order.symbol,
    side: closeSide,
    referencePrice: input.referencePrice,
    bar: input.bar,
    reason: input.reason,
  });
  const exitPrice = execution.expectedFill;
  return persistShadowOrder({
    ...order,
    status: "closed",
    markPrice: exitPrice,
    exitPrice,
    realizedPnl: calculateShadowPnl(order.side, order.qty_estimate, order.entry_price, exitPrice),
    unrealizedPnl: 0,
    exitReason: input.reason,
    closedAt: input.closedAt || Date.now(),
    lastEvaluatedAt: input.closedAt || Date.now(),
    isEstimated: input.isEstimated ?? order.is_estimated,
    estimatedTimeframe: input.estimatedTimeframe ?? order.estimated_timeframe,
    estimationNote: input.estimationNote ?? order.estimation_note,
  });
}

function determineShadowExitFromOhlcv(order: ShadowOrderRow, ohlcv: any[]) {
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) return null;
  const startAt = Number(order.last_evaluated_at || order.created_at || 0);
  const side = String(order.side || "").toUpperCase();
  for (const bar of ohlcv) {
    const barTs = Number(bar?.[0] || 0);
    if (!Number.isFinite(barTs) || barTs <= startAt) continue;
    const open = Number(bar?.[1] || 0);
    const high = Number(bar?.[2] || 0);
    const low = Number(bar?.[3] || 0);
    if (side === "BUY") {
      if (Number(order.sl_price || 0) > 0 && low <= Number(order.sl_price)) {
        return { reason: "stop_loss" as const, referencePrice: Math.min(Number(order.sl_price), open || Number(order.sl_price)), bar, closedAt: barTs };
      }
      if (Number(order.tp_price || 0) > 0 && high >= Number(order.tp_price)) {
        return { reason: "take_profit" as const, referencePrice: Math.max(Number(order.tp_price), open || Number(order.tp_price)), bar, closedAt: barTs };
      }
    } else if (side === "SELL") {
      if (Number(order.sl_price || 0) > 0 && high >= Number(order.sl_price)) {
        return { reason: "stop_loss" as const, referencePrice: Math.max(Number(order.sl_price), open || Number(order.sl_price)), bar, closedAt: barTs };
      }
      if (Number(order.tp_price || 0) > 0 && low <= Number(order.tp_price)) {
        return { reason: "take_profit" as const, referencePrice: Math.min(Number(order.tp_price), open || Number(order.tp_price)), bar, closedAt: barTs };
      }
    }
  }
  return null;
}

async function maintainOpenShadowOrders(config: AutoTradingConfig) {
  const openOrders = loadOpenShadowOrders();
  if (!openOrders.length) return;

  await ensureFreshMacroData();
  const grouped = new Map<string, ShadowOrderRow[]>();
  for (const order of openOrders) {
    const timeframe = order.timeframe || getDefaultTimeframeForSymbol(config, order.symbol);
    const key = `${order.symbol}::${timeframe}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(order);
  }

  const baseMarketAnalysis = createDefaultMarketAnalysis();
  const { macroData, macroRiskScore, macroGate } = currentMacroSnapshot();
  baseMarketAnalysis.macroIndicators = {
    dxyCorrelation: (macroData as any).btcCorrelation ?? baseMarketAnalysis.macroIndicators.dxyCorrelation,
    usdtPremium: baseMarketAnalysis.macroIndicators.usdtPremium,
    globalLiquidity: (macroData as any).m2 ? ((macroData as any).m2 / 20000) * 100 : baseMarketAnalysis.macroIndicators.globalLiquidity,
    macroRiskScore,
    macroGate,
  };
  if ((macroData as any).dxy !== undefined) baseMarketAnalysis.onChainData.dxy = (macroData as any).dxy;
  if ((macroData as any).m2 !== undefined) baseMarketAnalysis.onChainData.m2 = (macroData as any).m2;

  for (const [key, orders] of grouped.entries()) {
    const [symbol, timeframe] = key.split("::");
    let marketBundle: Awaited<ReturnType<typeof fetchPublicMarketBundle>>;
    try {
      marketBundle = await fetchPublicMarketBundleWithAutoRetry(symbol, timeframe, 180);
    } catch (error: any) {
      pushAutoTradingLog(`影子持仓维护失败 ${symbol}: ${error?.message || String(error)}`);
      continue;
    }

    const scanTicker = normalizeTicker(symbol, marketBundle.ticker);
    if (!scanTicker) continue;

    const runtimeContext = buildMarketRuntimeContext(
      symbol,
      scanTicker,
      marketBundle.funding,
      marketBundle.orderBook,
      Array.isArray(marketBundle.ohlcv) ? marketBundle.ohlcv : [],
      {
        ...baseMarketAnalysis,
        correlations: baseMarketAnalysis.correlations.map(item => ({ ...item })),
        trends: baseMarketAnalysis.trends.map(item => ({ ...item })),
      },
      timeframe
    );

    const actionableSignals = new Map<string, { analysis: any; requiredConfidence: number }>();
    const strategyIds = Array.from(new Set(orders.map(order => order.strategy_id).filter(Boolean) as string[]));
    for (const strategyId of strategyIds) {
      const analysis = evaluateStrategy({
        symbol,
        ticker: scanTicker,
        strategyId,
        prices: runtimeContext.prices,
        indicators: runtimeContext.marketAnalysis.realIndicators,
        market: {
          sentiment: runtimeContext.marketAnalysis.sentiment,
          volatility: runtimeContext.marketAnalysis.volatility,
          fundingRate: runtimeContext.fundingRate?.fundingRate ?? 0,
          macroRiskScore,
          macroGate,
          onChainData: runtimeContext.marketAnalysis.onChainData,
        },
        risk: {
          estimatedFeeRate: config.riskConfigSnapshot.estimatedFeeRate,
          stopLoss: config.riskConfigSnapshot.stopLoss,
          takeProfit: config.riskConfigSnapshot.takeProfit,
        },
        allowSyntheticData: false,
      });
      const requiredConfidence = config.riskConfigSnapshot.autoTradeThreshold + (analysis?.macroGate?.entryThresholdAdjustment || 0);
      if ((analysis.signal === "BUY" || analysis.signal === "SELL") && Number(analysis.confidence || 0) >= requiredConfidence) {
        actionableSignals.set(strategyId, { analysis, requiredConfidence });
      }
    }

    const lastBar = Array.isArray(marketBundle.ohlcv) && marketBundle.ohlcv.length > 0
      ? marketBundle.ohlcv[marketBundle.ohlcv.length - 1]
      : null;
    const evaluatedAt = Number(lastBar?.[0] || Date.now());

    for (const order of orders) {
      const exitHit = determineShadowExitFromOhlcv(order, marketBundle.ohlcv);
      if (exitHit) {
        const closed = closeShadowOrderPosition(order, exitHit);
        pushAutoTradingLog(`影子持仓已平仓 ${closed.symbol} ${closed.strategy_id || "--"} ${closed.exit_reason || "take_profit"} ${Number(closed.realized_pnl || 0).toFixed(2)} USDT`);
        continue;
      }

      const actionable = order.strategy_id ? actionableSignals.get(order.strategy_id) : undefined;
      if (actionable && actionable.analysis.signal !== order.side) {
        const closed = closeShadowOrderPosition(order, {
          referencePrice: scanTicker.last || Number(lastBar?.[4] || order.entry_price || 0),
          reason: "reverse_signal",
          bar: lastBar,
          closedAt: evaluatedAt,
        });
        pushAutoTradingLog(`影子持仓反向平仓 ${closed.symbol} ${closed.strategy_id || "--"} ${order.side} -> ${actionable.analysis.signal}`);
        continue;
      }

      const shadowExecution = actionable
        ? estimateShadowExecution(String(order.side || "BUY").toLowerCase() as "buy" | "sell", scanTicker, marketBundle.orderBook, 0)
        : null;

      persistShadowOrder({
        ...order,
        theoreticalPrice: shadowExecution?.theoreticalPrice ?? order.theoretical_price,
        executablePrice: shadowExecution?.executablePrice ?? order.executable_price,
        spreadBps: shadowExecution?.spreadBps ?? order.spread_bps,
        slippageBps: shadowExecution?.slippageBps ?? order.slippage_bps,
        latencyMs: shadowExecution?.latencyMs ?? order.latency_ms,
        markPrice: scanTicker.last,
        unrealizedPnl: calculateShadowPnl(order.side, order.qty_estimate, order.entry_price, scanTicker.last),
        lastEvaluatedAt: evaluatedAt,
        orderbook: actionable ? marketBundle.orderBook : undefined,
        signal: actionable ? actionable.analysis : undefined,
      });
    }
  }
}

async function hydrateLegacyShadowOrders() {
  if (!tradingDb) return;
  const legacyRows = tradingDb.prepare(`
    SELECT *
    FROM shadow_orders
    WHERE status IS NULL OR TRIM(COALESCE(status, '')) = ''
    ORDER BY created_at ASC
  `).all() as ShadowOrderRow[];
  if (!legacyRows.length) return;

  const ohlcvCache = new Map<string, any[]>();

  for (const row of legacyRows) {
    const signal = safeJsonParse<any>(row.signal_json, null);
    const timeframe = row.timeframe || getDefaultTimeframeForSymbol(appStore.autoTrading.config, row.symbol);
    const normalized = normalizeShadowOrderRow({
      ...row,
      timeframe,
      estimatedTimeframe: timeframe,
      isEstimated: 1,
    }, row);
    const entryPrice = normalized.entry_price;
    const qtyEstimate = normalized.qty_estimate;
    const tpPrice = normalized.tp_price;
    const slPrice = normalized.sl_price;

    if (!entryPrice || !qtyEstimate || (!tpPrice && !slPrice)) {
      persistShadowOrder({
        ...normalized,
        status: "estimated_skipped",
        timeframe,
        estimatedTimeframe: timeframe,
        isEstimated: 1,
        estimationNote: "缺少 entry/tp/sl 等关键字段，无法回放估算",
      });
      continue;
    }

    try {
      const cacheKey = `${normalized.symbol}::${timeframe}`;
      let ohlcv = ohlcvCache.get(cacheKey);
      if (!ohlcv) {
        const elapsedBars = Math.ceil((Date.now() - normalized.created_at) / timeframeToMs(timeframe)) + 20;
        ohlcv = await fetchBacktestOhlcv(normalized.symbol, timeframe, Math.min(5000, Math.max(120, elapsedBars))) as any[];
        ohlcvCache.set(cacheKey, ohlcv);
      }

      const exitHit = determineShadowExitFromOhlcv({
        ...normalized,
        last_evaluated_at: normalized.created_at,
      }, ohlcv);

      if (exitHit) {
        closeShadowOrderPosition({
          ...normalized,
          timeframe,
          estimated_timeframe: timeframe,
          is_estimated: 1,
        }, {
          ...exitHit,
          isEstimated: true,
          estimatedTimeframe: timeframe,
          estimationNote: "历史影子单按当前系统周期回放估算",
        });
        continue;
      }

      const lastBar = Array.isArray(ohlcv) && ohlcv.length > 0 ? ohlcv[ohlcv.length - 1] : null;
      const markPrice = Number(lastBar?.[4] || entryPrice);
      persistShadowOrder({
        ...normalized,
        status: "open",
        timeframe,
        markPrice,
        unrealizedPnl: calculateShadowPnl(normalized.side, qtyEstimate, entryPrice, markPrice),
        lastEvaluatedAt: Number(lastBar?.[0] || Date.now()),
        isEstimated: 1,
        estimatedTimeframe: timeframe,
        estimationNote: "历史影子单按当前系统周期回放估算",
        signal: signal,
      });
    } catch (error: any) {
      persistShadowOrder({
        ...normalized,
        status: "estimated_skipped",
        timeframe,
        estimatedTimeframe: timeframe,
        isEstimated: 1,
        estimationNote: `历史估算失败: ${error?.message || String(error)}`,
      });
    }
  }
}

function buildShadowSummary() {
  const rows = listShadowOrders("all", 1000);
  const openOrders = rows.filter(row => row.status === "open");
  const closedOrders = rows.filter(row => row.status === "closed");
  const estimatedCount = rows.filter(row => Number(row.is_estimated || 0) === 1).length;
  const realizedPnl = closedOrders.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const unrealizedPnl = openOrders.reduce((sum, row) => sum + Number(row.unrealized_pnl || 0), 0);
  const wins = closedOrders.filter(row => Number(row.realized_pnl || 0) > 0).length;
  const totalHoldMinutes = closedOrders.reduce((sum, row) => {
    if (!row.closed_at || !row.created_at) return sum;
    return sum + Math.max(0, (Number(row.closed_at) - Number(row.created_at)) / 60_000);
  }, 0);
  return {
    openCount: openOrders.length,
    closedCount: closedOrders.length,
    realizedPnl,
    unrealizedPnl,
    winRate: closedOrders.length ? (wins / closedOrders.length) * 100 : 0,
    avgHoldMinutes: closedOrders.length ? totalHoldMinutes / closedOrders.length : 0,
    estimatedCount,
  } satisfies ShadowSummary;
}

function normalizePortfolioReturnMode(value: any): PortfolioReturnMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "demo" || normalized === "paper" || normalized === "sim") return "demo";
  if (normalized === "shadow") return "shadow";
  return "live";
}

function normalizePortfolioReturnRange(value: any): PortfolioReturnRange {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "7d" || normalized === "30d" || normalized === "90d" || normalized === "all") {
    return normalized as PortfolioReturnRange;
  }
  return "30d";
}

const portfolioReturnCache = new Map<string, PortfolioReturnCacheEntry>();

function portfolioCredentialError(mode: PortfolioReturnMode) {
  return mode === "demo"
    ? "OKX 模拟盘凭据缺失，无法读取真实账单收益。请先在设置中配置 OKX 模拟盘 API。"
    : "OKX 实盘凭据缺失，无法读取真实账单收益。请先在设置中配置 OKX 实盘 API。";
}

function normalizeOkxPortfolioBill(row: any, mode: PortfolioReturnMode): PortfolioReturnBillInput {
  const timestamp = firstNumber(row.ts, row.uTime, row.cTime);
  return {
    ...row,
    id: row.billId || row.ordId || `${timestamp}_${row.type || ""}_${row.subType || ""}`,
    mode,
    timestamp,
    pnl: firstNumber(row.pnl),
    fee: firstNumber(row.fee),
    balanceChange: firstNumber(row.balChg),
    type: row.type,
    subType: row.subType,
    ccy: row.ccy,
    symbol: row.instId,
    rawJson: JSON.stringify(row),
  };
}

async function fetchPortfolioAccountBills(
  credentials: Required<OkxCredentials>,
  sandbox: boolean,
  mode: PortfolioReturnMode,
  limit: number
) {
  const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, sandbox);
  await prepareExchange(exchange);
  const response = await runWithExchangeProxyFallback<any>(exchange, () => (exchange as any).privateGetAccountBills({
    ccy: "USDT",
    limit: String(Math.min(100, Math.max(1, limit))),
  }));
  const rawRows = Array.isArray(response?.data) ? response.data : [];
  return rawRows
    .map((row: any) => normalizeOkxPortfolioBill(row, mode))
    .filter((row: any) => Number.isFinite(Number(row.timestamp)) && Number(row.timestamp) > 0);
}

async function fetchPortfolioExchangeReturns(mode: PortfolioReturnMode, limit: number) {
  const sandbox = mode === "demo";
  const credentials = resolveOkxCredentials({}, sandbox);
  if (!credentials) {
    const error = new Error(portfolioCredentialError(mode)) as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const [balance, bills] = await Promise.all([
    fetchPrivateBalance(credentials, sandbox),
    fetchPortfolioAccountBills(credentials, sandbox, mode, limit),
  ]);
  const capitalBase = getAccountTotalUSDT(balance);
  return {
    capitalBase: capitalBase > 0 ? capitalBase : null,
    bills,
  };
}

function formatPortfolioReturnSourceError(error: any) {
  return error?.message || String(error || "OKX 账单读取失败");
}

function getFreshPortfolioReturnCachedResponse(requestKey: string, now: number) {
  const cached = portfolioReturnCache.get(requestKey);
  if (!isFreshPortfolioReturnCache(cached, now, PORTFOLIO_RETURNS_CACHE_TTL_MS)) return null;
  return withPortfolioReturnSourceStatus(cached!.analytics, {
    state: "fresh",
    fetchedAt: cached!.analytics.sourceStatus?.fetchedAt || cached!.analytics.generatedAt,
  });
}

function getStalePortfolioReturnCachedResponse(requestKey: string, error: any, now: number) {
  const cached = portfolioReturnCache.get(requestKey);
  if (!isUsableStalePortfolioReturnCache(cached, now, PORTFOLIO_RETURNS_STALE_MAX_AGE_MS)) return null;
  const message = `OKX 账单刷新失败，当前显示上次成功快照：${formatPortfolioReturnSourceError(error)}`;
  return withPortfolioReturnSourceStatus(
    cached!.analytics,
    createPortfolioReturnStaleStatus(cached!.analytics, message, now)
  );
}

function syncShadowPositionFromCandidate(input: {
  symbol: string;
  strategyId: string;
  side: "buy" | "sell";
  timeframe: string;
  leverage: number;
  amount: number;
  amountType: string;
  regime?: string | null;
  macroGate?: any;
  orderBook?: RuntimeOrderBook | null;
  signal: any;
  shadowExecution: ReturnType<typeof estimateShadowExecution>;
  ticker: RuntimeTicker;
  ohlcv?: any[];
}) {
  const existing = findOpenShadowOrder(input.symbol, input.strategyId);
  if (existing) {
    if (existing.side === input.side.toUpperCase()) {
      const refreshed = persistShadowOrder({
        ...existing,
        theoreticalPrice: input.shadowExecution.theoreticalPrice,
        executablePrice: input.shadowExecution.executablePrice,
        spreadBps: input.shadowExecution.spreadBps,
        slippageBps: input.shadowExecution.slippageBps,
        latencyMs: input.shadowExecution.latencyMs,
        markPrice: input.ticker.last,
        unrealizedPnl: calculateShadowPnl(existing.side, existing.qty_estimate, existing.entry_price, input.ticker.last),
        lastEvaluatedAt: Date.now(),
        orderbook: input.orderBook,
        signal: input.signal,
      });
      return { action: "refreshed" as const, order: refreshed, closed: null };
    }

    const lastBar = Array.isArray(input.ohlcv) && input.ohlcv.length > 0 ? input.ohlcv[input.ohlcv.length - 1] : null;
    const closed = closeShadowOrderPosition(existing, {
      referencePrice: input.ticker.last || Number(lastBar?.[4] || existing.entry_price || 0),
      reason: "reverse_signal",
      bar: lastBar,
      closedAt: Number(lastBar?.[0] || Date.now()),
    });
    const opened = persistShadowOrder({
      symbol: input.symbol,
      side: input.side,
      strategyId: input.strategyId,
      theoreticalPrice: input.shadowExecution.theoreticalPrice,
      executablePrice: input.shadowExecution.executablePrice,
      spreadBps: input.shadowExecution.spreadBps,
      slippageBps: input.shadowExecution.slippageBps,
      latencyMs: input.shadowExecution.latencyMs,
      amount: input.amount,
      amountType: input.amountType,
      regime: input.regime,
      macroGate: input.macroGate,
      orderbook: input.orderBook,
      signal: input.signal,
      status: "open",
      timeframe: input.timeframe,
      leverage: input.leverage,
      tpPrice: input.signal?.tp_price,
      slPrice: input.signal?.sl_price,
      entryPrice: input.shadowExecution.executablePrice,
      markPrice: input.ticker.last || input.shadowExecution.executablePrice,
      qtyEstimate: calculateShadowQtyEstimate({
        amount: input.amount,
        amountType: input.amountType,
        leverage: input.leverage,
        entryPrice: input.shadowExecution.executablePrice,
      }),
      unrealizedPnl: 0,
      lastEvaluatedAt: Date.now(),
      isEstimated: 0,
      estimatedTimeframe: null,
      estimationNote: null,
    });
    return { action: "reversed" as const, order: opened, closed };
  }

  const opened = persistShadowOrder({
    symbol: input.symbol,
    side: input.side,
    strategyId: input.strategyId,
    theoreticalPrice: input.shadowExecution.theoreticalPrice,
    executablePrice: input.shadowExecution.executablePrice,
    spreadBps: input.shadowExecution.spreadBps,
    slippageBps: input.shadowExecution.slippageBps,
    latencyMs: input.shadowExecution.latencyMs,
    amount: input.amount,
    amountType: input.amountType,
    regime: input.regime,
    macroGate: input.macroGate,
    orderbook: input.orderBook,
    signal: input.signal,
    status: "open",
    timeframe: input.timeframe,
    leverage: input.leverage,
    tpPrice: input.signal?.tp_price,
    slPrice: input.signal?.sl_price,
    entryPrice: input.shadowExecution.executablePrice,
    markPrice: input.ticker.last || input.shadowExecution.executablePrice,
    qtyEstimate: calculateShadowQtyEstimate({
      amount: input.amount,
      amountType: input.amountType,
      leverage: input.leverage,
      entryPrice: input.shadowExecution.executablePrice,
    }),
    unrealizedPnl: 0,
    lastEvaluatedAt: Date.now(),
    isEstimated: 0,
    estimatedTimeframe: null,
    estimationNote: null,
  });
  return { action: "opened" as const, order: opened, closed: null };
}

async function getAdminPassword() {
  if (hasText(process.env.ADMIN_PASSWORD)) return process.env.ADMIN_PASSWORD;

  try {
    const existingPassword = await fsp.readFile(LOCAL_ADMIN_PASSWORD_FILE, "utf-8");
    if (hasText(existingPassword)) return existingPassword.trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("[Auth] Failed to read local admin password:", error.message);
    }
  }

  const generatedPassword = crypto.randomBytes(18).toString("base64url");
  await fsp.writeFile(LOCAL_ADMIN_PASSWORD_FILE, generatedPassword, { mode: 0o600 });
  console.warn(`[Auth] ADMIN_PASSWORD is not set. Generated local admin password in ${LOCAL_ADMIN_PASSWORD_FILE}`);
  return generatedPassword;
}

function getBearerToken(req: express.Request) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  const tokenHeader = req.headers["x-admin-token"];
  return Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
}

function getSession(req: express.Request) {
  const token = getBearerToken(req);
  if (!token) return null;
  const tokenHash = hashSecret(token);
  const now = Date.now();
  const session = appStore.sessions.find(item => item.tokenHash === tokenHash && item.expiresAt > now);
  if (!session) return null;
  session.lastSeenAt = now;
  (req as any).operator = { username: session.username, role: session.role };
  return session;
}

function isPublicApi(req: express.Request) {
  if (req.path.startsWith("/auth/")) return true;
  if (req.method === "GET" && req.path === "/config/status") return true;
  if (req.method === "GET" && req.path === "/macro") return true;
  if (req.method === "GET" && (
    req.path.startsWith("/okx/ticker/") ||
    req.path.startsWith("/okx/orderbook/") ||
    req.path === "/okx/tickers" ||
    req.path.startsWith("/okx/ohlcv/") ||
    req.path.startsWith("/okx/funding/")
  )) return true;
  return false;
}

function requireOperator(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isPublicApi(req)) return next();
  const session = getSession(req);
  if (!session) {
    addSecurityEvent("auth.denied", req, { reason: "missing_or_expired_session" });
    return res.status(401).json({ error: "Authentication required" });
  }
  session.lastSeenAt = Date.now();
  next();
}

// --- Encrypted Credential Store ---
type OkxCredentials = {
  apiKey?: string;
  secret?: string;
  password?: string;
};

type AiProxyCredentials = {
  proxyUrl?: string;
  proxyKey?: string;
  decisionModel?: string;
  summaryModel?: string;
  visionModel?: string;
};

type CredentialStore = {
  okx?: OkxCredentials;
  okxDemo?: OkxCredentials;
  ai?: AiProxyCredentials;
};

let credentialStore: CredentialStore = {};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOkxCredentials(credentials?: OkxCredentials) {
  return !!(hasText(credentials?.apiKey) && hasText(credentials?.secret) && hasText(credentials?.password));
}

function hasAiCredentials(credentials?: AiProxyCredentials) {
  return !!(hasText(credentials?.proxyUrl) && hasText(credentials?.proxyKey));
}

function envText(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (hasText(value)) return value.trim();
  }
  return undefined;
}

function getOkxEnvCredentials(sandbox: boolean): OkxCredentials {
  return sandbox
    ? {
        apiKey: envText("OKX_DEMO_API_KEY", "OKX_SIM_API_KEY", "OKX_PAPER_API_KEY"),
        secret: envText("OKX_DEMO_SECRET_KEY", "OKX_DEMO_SECRET", "OKX_SIM_SECRET_KEY", "OKX_PAPER_SECRET_KEY"),
        password: envText("OKX_DEMO_PASSPHRASE", "OKX_DEMO_PASSWORD", "OKX_DEMO_PASS", "OKX_SIM_PASSPHRASE", "OKX_PAPER_PASSPHRASE"),
      }
    : {
        apiKey: envText("OKX_API_KEY", "OKX_LIVE_API_KEY"),
        secret: envText("OKX_SECRET_KEY", "OKX_SECRET", "OKX_LIVE_SECRET_KEY"),
        password: envText("OKX_PASSPHRASE", "OKX_PASSWORD", "OKX_PASS", "OKX_LIVE_PASSPHRASE"),
      };
}

function getZhipuConfig(task: "decision" | "summary" | "vision" = "decision", body: any = {}) {
  const storedAi = credentialStore.ai || {};
  const baseUrl = body.proxyUrl || body.zhipuBaseUrl || process.env.ZHIPU_BASE_URL || storedAi.proxyUrl || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const apiKey = body.proxyKey || body.zhipuApiKey || process.env.ZHIPU_API_KEY || storedAi.proxyKey;
  const decisionModel = body.model || process.env.ZHIPU_DECISION_MODEL || storedAi.decisionModel || "glm-4.5-air";
  const summaryModel = body.model || process.env.ZHIPU_SUMMARY_MODEL || storedAi.summaryModel || decisionModel;
  const visionModel = body.model || process.env.ZHIPU_VISION_MODEL || storedAi.visionModel || "glm-4.6v";
  const model = task === "summary" ? summaryModel : task === "vision" ? visionModel : decisionModel;
  const endpoint = String(baseUrl).includes("/chat/completions")
    ? String(baseUrl)
    : `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

  return { endpoint, apiKey, model, baseUrl, decisionModel, summaryModel, visionModel };
}

async function getCredentialSecret() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const configuredSecret = process.env.APP_SECRET || process.env.CREDENTIALS_SECRET;
  if (hasText(configuredSecret)) return configuredSecret;

  try {
    const existingSecret = await fsp.readFile(LOCAL_SECRET_FILE, "utf-8");
    if (hasText(existingSecret)) return existingSecret.trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("[Credentials] Failed to read local secret:", error.message);
    }
  }

  const generatedSecret = crypto.randomBytes(32).toString("hex");
  await fsp.writeFile(LOCAL_SECRET_FILE, generatedSecret, { mode: 0o600 });
  console.warn("[Credentials] APP_SECRET is not set; generated a local development secret under data/.");
  return generatedSecret;
}

async function getCredentialKey() {
  const secret = await getCredentialSecret();
  return crypto.scryptSync(secret, "cryptoquant-ai-credential-store-v1", 32);
}

async function encryptCredentials(data: CredentialStore) {
  const key = await getCredentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf-8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

async function decryptCredentials(payload: any): Promise<CredentialStore> {
  const key = await getCredentialKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf-8"));
}

async function loadCredentialStore() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CREDENTIALS_FILE)) return;
    const raw = await fsp.readFile(CREDENTIALS_FILE, "utf-8");
    credentialStore = await decryptCredentials(JSON.parse(raw));
    console.log("[Credentials] Encrypted credential store loaded.");
  } catch (error) {
    credentialStore = {};
    console.warn("[Credentials] Failed to load encrypted credential store:", error);
  }
}

async function persistCredentialStore() {
  const encrypted = await encryptCredentials(credentialStore);
  await writeFileAtomic(CREDENTIALS_FILE, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

function sanitizedCredentialStatus() {
  const envOkxLive = hasOkxCredentials(getOkxEnvCredentials(false));
  const envOkxDemo = hasOkxCredentials(getOkxEnvCredentials(true));
  const envZhipu = !!hasText(process.env.ZHIPU_API_KEY);
  const storedOkxLive = hasOkxCredentials(credentialStore.okx);
  const storedOkxDemo = hasOkxCredentials(credentialStore.okxDemo);
  const storedAiProxy = hasAiCredentials(credentialStore.ai);

  return {
    okx: envOkxLive || storedOkxLive || envOkxDemo || storedOkxDemo,
    okxLive: envOkxLive || storedOkxLive,
    okxDemo: envOkxDemo || storedOkxDemo,
    ai: envZhipu || storedAiProxy,
    aiProxy: envZhipu || storedAiProxy,
    zhipu: envZhipu || storedAiProxy,
    smtp: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    sources: {
      okxLive: envOkxLive ? "env" : storedOkxLive ? "vault" : null,
      okxDemo: envOkxDemo ? "env" : storedOkxDemo ? "vault" : null,
      aiProxy: envZhipu ? "env" : storedAiProxy ? "vault" : null,
      smtp: process.env.SMTP_USER && process.env.SMTP_PASS ? "env" : null,
    },
  };
}

function resolveOkxCredentials(body: any, sandbox: boolean): Required<OkxCredentials> | null {
  const env = getOkxEnvCredentials(sandbox);
  const stored = sandbox ? credentialStore.okxDemo : credentialStore.okx;
  const credentials = {
    apiKey: body?.apiKey || env.apiKey || stored?.apiKey,
    secret: body?.secret || env.secret || stored?.secret,
    password: body?.password || env.password || stored?.password,
  };

  if (!hasOkxCredentials(credentials)) return null;
  return credentials as Required<OkxCredentials>;
}

function mergeText<T extends Record<string, any>>(current: T | undefined, next: Partial<T>) {
  const merged: T = { ...(current || {}) } as T;
  for (const [key, value] of Object.entries(next)) {
    if (hasText(value)) {
      (merged as any)[key] = value.trim();
    }
  }
  return merged;
}

const publicExchange = new (ccxt as any).okx({
  enableRateLimit: true,
  timeout: OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
  options: {
    defaultType: "swap",
    fetchMarkets: { types: ["swap", "spot"] },
  },
});
applyExchangeProxy(publicExchange);
const privateExchanges = new Map<string, any>();

// --- Macro Data Cache ---
let cachedMacroData: MacroData | null = null;
const FRED_API_KEY = process.env.FRED_API_KEY || "";
const MACRO_CACHE_TTL_MS = 5 * 60 * 1000;
let macroRefreshPromise: Promise<MacroData | null> | null = null;

async function updateMacroCache(force = false) {
  if (!force && cachedMacroData && Date.now() - cachedMacroData.timestamp <= MACRO_CACHE_TTL_MS) {
    return cachedMacroData;
  }
  if (macroRefreshPromise) return macroRefreshPromise;

  macroRefreshPromise = (async () => {
    try {
      console.log("[Macro] Updating macro data cache...");
      const nextMacroData = await fetchMacroData(FRED_API_KEY, cachedMacroData);
      cachedMacroData = nextMacroData;
      console.log("[Macro] Cache updated successfully.");
      return cachedMacroData;
    } catch (e) {
      console.error("[Macro] Failed to update macro cache:", e);
      return cachedMacroData;
    } finally {
      macroRefreshPromise = null;
    }
  })();

  return macroRefreshPromise;
}

async function ensureFreshMacroData(maxAgeMs = MACRO_CACHE_TTL_MS) {
  if (cachedMacroData && Date.now() - cachedMacroData.timestamp <= maxAgeMs) {
    return cachedMacroData;
  }
  return updateMacroCache(true);
}

function buildFallbackMacroData(): MacroData {
  const macroRiskScore = 0;
  return {
    dxy: 0,
    m2: 0,
    m2Change3mPct: 0,
    dxyChange30dPct: 0,
    btcCorrelation: 0,
    dxySource: "unavailable",
    macroRiskScore,
    macroGate: evaluateMacroGate({ macroRiskScore }),
    timestamp: Date.now(),
  };
}

type BacktestRunOptions = {
  symbol: string;
  strategy: string;
  stopLoss: number;
  takeProfit: number;
  estimatedFeeRate: number;
  timeframe?: string;
  fundingRatePer8h?: number;
  initialEquity?: number;
  macroRiskScore?: number;
  tradeStartTime?: number;
  riskPerTradePct?: number;
  trendRegimeThreshold?: number;
  enableHigherTimeframeTrendFilter?: boolean;
};

function symbolExecutionProfile(symbol: string) {
  const upper = String(symbol || "").toUpperCase();
  if (upper.includes("BTC")) return { spreadBps: 1.2, slippageBaseBps: 1.8, depthScore: 1 };
  if (upper.includes("ETH")) return { spreadBps: 1.6, slippageBaseBps: 2.2, depthScore: 0.85 };
  if (upper.includes("SOL")) return { spreadBps: 3.5, slippageBaseBps: 4.5, depthScore: 0.55 };
  return { spreadBps: 5, slippageBaseBps: 7, depthScore: 0.35 };
}

function executionPenaltyModel(args: {
  symbol: string;
  side: "buy" | "sell";
  referencePrice: number;
  bar?: any;
  volatility?: number;
  reason?: string;
}) {
  const profile = symbolExecutionProfile(args.symbol);
  const referencePrice = Number(args.referencePrice || 0);
  const open = Number(args.bar?.[1] || referencePrice);
  const high = Number(args.bar?.[2] || referencePrice);
  const low = Number(args.bar?.[3] || referencePrice);
  const volume = Number(args.bar?.[5] || 0);
  const barVolatility = referencePrice > 0 ? Math.max(0, (high - low) / referencePrice) : 0;
  const volatility = Math.max(args.volatility || 0, barVolatility);
  const spreadPenaltyBps = profile.spreadBps / 2;
  const volumePenaltyBps = volume > 0 ? Math.min(10, 30000 / Math.sqrt(volume + 1)) * (1 - profile.depthScore) : 8;
  const volatilityPenaltyBps = Math.min(40, volatility * 10000 * 0.08);
  const latencyPenaltyBps = Math.min(20, volatility * 10000 * 0.035 + 0.8);
  const extremePenaltyBps = volatility > 0.06 ? (volatility - 0.06) * 10000 * 0.25 : 0;
  const gapPenaltyBps = args.reason === "stop_loss" && Math.abs(open - referencePrice) / referencePrice > 0.003
    ? Math.min(35, Math.abs(open - referencePrice) / referencePrice * 10000)
    : 0;
  const totalPenaltyBps = spreadPenaltyBps
    + profile.slippageBaseBps
    + volumePenaltyBps
    + volatilityPenaltyBps
    + latencyPenaltyBps
    + extremePenaltyBps
    + gapPenaltyBps;
  const direction = args.side === "buy" ? 1 : -1;
  const expectedFill = referencePrice * (1 + direction * totalPenaltyBps / 10000);
  const partialFillRatio = volatility > 0.08 ? 0.75 : volatility > 0.05 ? 0.9 : 1;
  const failureRisk = volatility > 0.10 ? "high" : volatility > 0.06 ? "elevated" : "normal";

  return {
    expectedFill,
    totalPenaltyBps,
    spreadPenaltyBps,
    slippagePenaltyBps: profile.slippageBaseBps + volumePenaltyBps + volatilityPenaltyBps,
    latencyPenaltyBps,
    extremePenaltyBps,
    gapPenaltyBps,
    makerTaker: args.reason === "take_profit" ? "maker_or_limit" : "taker",
    partialFillRatio,
    failureRisk,
    referencePrice,
  };
}

function calculateRobustSelectionScore(result: any, perturbations: any[] = []) {
  const medianNetReturn = result.totalReturn || 0;
  const profitFactorScore = Math.min(3, result.profitFactor || 0);
  const expectancyScore = Math.max(-10, Math.min(10, result.expectancy || 0)) / 10;
  const perturbReturns = perturbations.map(item => item.totalReturn).filter(Number.isFinite);
  const worstPerturbReturn = perturbReturns.length ? Math.min(...perturbReturns) : medianNetReturn;
  const stabilityScore = medianNetReturn === 0
    ? 0
    : Math.max(-1, Math.min(1, 1 - Math.abs(medianNetReturn - worstPerturbReturn) / Math.max(1, Math.abs(medianNetReturn))));
  const maxDrawdownPenalty = Math.max(0, result.maxDrawdown || 0);

  return (medianNetReturn * 0.30)
    + (profitFactorScore * 10 * 0.20)
    + (expectancyScore * 10 * 0.20)
    + (stabilityScore * 10 * 0.20)
    - (maxDrawdownPenalty * 0.10);
}

function timeframeBarsPerDay(timeframe: string) {
  const normalized = String(timeframe || "1h").toLowerCase();
  if (normalized.endsWith("m")) return Math.max(1, Math.floor(1440 / Number(normalized.replace("m", ""))));
  if (normalized.endsWith("h")) return Math.max(1, Math.floor(24 / Number(normalized.replace("h", ""))));
  if (normalized === "1d") return 1;
  return 24;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runBacktestOnOhlcv(ohlcv: any[], options: BacktestRunOptions) {
  const feeRate = Number(options.estimatedFeeRate) / 100;
  const initialEquity = options.initialEquity || 10000;
  const riskPerTradePct = normalizeRiskPerTradePct(options.riskPerTradePct);
  const macroGate = evaluateMacroGate({ macroRiskScore: options.macroRiskScore || 0 });
  let cash = initialEquity;
  let totalFees = 0;
  let totalExecutionCost = 0;
  let totalFunding = 0;
  let position: null | {
    side: "long" | "short";
    qty: number;
    entryPrice: number;
    entryEquity: number;
    entryRegime: string;
    entryReason: string;
    entryExecution: any;
    tpPrice?: number;
    slPrice?: number;
  } = null;
  let winTrades = 0;
  let closedTrades = 0;
  const trades: any[] = [];
  const equityCurve = [cash];
  const tradePnls: number[] = [];
  const noEntryReasonCounts: Record<string, number> = {};
  const exitReasonCounts: Record<string, number> = {};
  const regimePerformance: Record<string, { pnl: number; trades: number }> = {
    TREND_UP: { pnl: 0, trades: 0 },
    TREND_DOWN: { pnl: 0, trades: 0 },
    RANGE: { pnl: 0, trades: 0 },
    RISK_OFF: { pnl: 0, trades: 0 },
  };

  const average = (values: number[]) => values.length ? values.reduce((acc, val) => acc + val, 0) / values.length : 0;
  const stdev = (values: number[]) => {
    if (values.length < 2) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map(value => Math.pow(value - mean, 2))));
  };
  const barsPer8h = Math.max(1, Math.round(timeframeBarsPerDay(options.timeframe || "1h") / 3));
  const fundingPerBar = Number(options.fundingRatePer8h || 0) / barsPer8h;
  const applyFunding = (markPrice: number) => {
    if (!position || !Number.isFinite(markPrice) || markPrice <= 0 || fundingPerBar === 0) return;
    const notional = position.qty * markPrice;
    const signedFunding = position.side === "long"
      ? -notional * fundingPerBar
      : notional * fundingPerBar;
    cash += signedFunding;
    totalFunding += signedFunding;
  };
  const markEquity = (price: number) => {
    if (!position) return cash;
    const pnl = position.side === "long"
      ? position.qty * (price - position.entryPrice)
      : position.qty * (position.entryPrice - price);
    return cash + pnl;
  };
  const closePosition = (price: number, time: number, reason: string, bar?: any) => {
    if (!position) return;
    const exitSide = position.side === "long" ? "sell" : "buy";
    const execution = executionPenaltyModel({
      symbol: options.symbol,
      side: exitSide,
      referencePrice: price,
      bar,
      reason,
    });
    const fillPrice = execution.expectedFill;
    totalExecutionCost += Math.abs(fillPrice - price) * position.qty;
    const grossPnl = position.side === "long"
      ? position.qty * (fillPrice - position.entryPrice)
      : position.qty * (position.entryPrice - fillPrice);
    const closeFee = position.qty * fillPrice * feeRate;
    totalFees += closeFee;
    cash += grossPnl - closeFee;
    const tradePnl = cash - position.entryEquity;
    tradePnls.push(tradePnl);
    exitReasonCounts[reason] = (exitReasonCounts[reason] || 0) + 1;
    if (tradePnl > 0) winTrades += 1;
    closedTrades += 1;
    if (!regimePerformance[position.entryRegime]) regimePerformance[position.entryRegime] = { pnl: 0, trades: 0 };
    regimePerformance[position.entryRegime].pnl += tradePnl;
    regimePerformance[position.entryRegime].trades += 1;
    trades.push({
      type: "close",
      side: position.side,
      price: fillPrice,
      time,
      pnl: tradePnl,
      entryPrice: position.entryPrice,
      entryReason: position.entryReason,
      exitReason: reason,
      regime: position.entryRegime,
      execution,
    });
    position = null;
  };
  const openPosition = (side: "long" | "short", price: number, time: number, analysis: any, bar?: any) => {
    const execution = executionPenaltyModel({
      symbol: options.symbol,
      side: side === "long" ? "buy" : "sell",
      referencePrice: price,
      bar,
    });
    const fillPrice = execution.expectedFill;
    const entryEquity = cash;
    const sizing = calculateRiskSizedQuantity({
      equity: entryEquity,
      entryPrice: fillPrice,
      stopPrice: analysis.sl_price,
      riskPerTradePct,
      maxCash: cash,
      partialFillRatio: execution.partialFillRatio,
    });
    if (sizing.qty <= 0 || sizing.notional <= 0) {
      noEntryReasonCounts.risk_sizing_invalid = (noEntryReasonCounts.risk_sizing_invalid || 0) + 1;
      return;
    }
    const filledCash = sizing.notional;
    const openFee = filledCash * feeRate;
    totalFees += openFee;
    cash -= openFee;
    totalExecutionCost += Math.abs(fillPrice - price) * (filledCash / fillPrice);
    position = {
      side,
      qty: filledCash / fillPrice,
      entryPrice: fillPrice,
      entryEquity,
      entryRegime: analysis.regime || "UNKNOWN",
      entryReason: analysis.reasoning,
      entryExecution: execution,
      tpPrice: analysis.tp_price,
      slPrice: analysis.sl_price,
    };
    trades.push({
      type: "open",
      side,
      price: fillPrice,
      time,
      regime: analysis.regime,
      macroGate: analysis.macroGate?.state,
      reason: analysis.reasoning,
      tpPrice: analysis.tp_price,
      slPrice: analysis.sl_price,
      riskPerTradePct,
      riskBudget: sizing.riskBudget,
      stopDistance: sizing.stopDistance,
      notional: filledCash,
      cappedByCash: sizing.cappedByCash,
      execution,
    });
  };

  for (let i = 41; i < ohlcv.length; i++) {
    const current = ohlcv[i];
    const currentOpen = Number(current[1]);
    const currentHigh = Number(current[2]);
    const currentLow = Number(current[3]);
    const currentClose = Number(current[4]);
    if (![currentOpen, currentHigh, currentLow, currentClose].every(value => Number.isFinite(value) && value > 0)) continue;

    const history = ohlcv.slice(0, i);
    const previous = history[history.length - 1];
    const previous2 = history[history.length - 2];
    const signalPrice = Number(previous?.[4]);
    const previousPrice = Number(previous2?.[4]);
    if (!Number.isFinite(signalPrice) || !Number.isFinite(previousPrice) || signalPrice <= 0 || previousPrice <= 0) continue;

    const recent = history.slice(-24);
    const prices = history.map(candle => Number(candle[4])).filter(Number.isFinite);
    const highs = recent.map(candle => Number(candle[2])).filter(Number.isFinite);
    const lows = recent.map(candle => Number(candle[3])).filter(Number.isFinite);
    const pct = ((signalPrice - previousPrice) / previousPrice) * 100;
    const sma20 = calculateSMA(prices, 20);
    const higherTimeframeTrend = options.enableHigherTimeframeTrendFilter
      ? buildHigherTimeframeTrend(history, options.timeframe || "1h")
      : undefined;
    const analysis = evaluateStrategy({
      symbol: options.symbol,
      ticker: {
        last: signalPrice,
        high: Math.max(...highs, signalPrice),
        low: Math.min(...lows, signalPrice),
        percentage: pct,
        volume: Number(previous?.[5] || 0),
      },
      strategyId: options.strategy,
      prices,
      indicators: {
        rsi: calculateRSI(prices),
        sma20,
        stdDev: calculateStandardDeviation(prices, 20),
        isRealData: true,
      },
      market: {
        sentiment: 50 + Math.max(-20, Math.min(20, pct * 5)),
        volatility: (Math.max(...highs, signalPrice) - Math.min(...lows, signalPrice)) / signalPrice,
        fundingRate: 0,
        macroRiskScore: options.macroRiskScore || 0,
        macroGate,
        onChainData: {
          exchangeInflow: 0,
          whaleActivity: 50,
          activeAddresses: Number(previous?.[5] || 0),
          mvrvRatio: 1.8,
        },
      },
      risk: { estimatedFeeRate: options.estimatedFeeRate, stopLoss: options.stopLoss, takeProfit: options.takeProfit },
      allowSyntheticData: false,
      strategyOptions: {
        trendRegimeThreshold: options.trendRegimeThreshold,
        higherTimeframeTrend,
      },
    });

    if (position?.side === "long") {
      if (position.slPrice && currentLow <= position.slPrice) closePosition(Math.min(position.slPrice, currentOpen), current[0], "stop_loss", current);
      else if (position.tpPrice && currentHigh >= position.tpPrice) closePosition(Math.max(position.tpPrice, currentOpen), current[0], "take_profit", current);
      else if (analysis.signal === "SELL") closePosition(currentOpen, current[0], "opposite_signal", current);
    } else if (position?.side === "short") {
      if (position.slPrice && currentHigh >= position.slPrice) closePosition(Math.max(position.slPrice, currentOpen), current[0], "stop_loss", current);
      else if (position.tpPrice && currentLow <= position.tpPrice) closePosition(Math.min(position.tpPrice, currentOpen), current[0], "take_profit", current);
      else if (analysis.signal === "BUY") closePosition(currentOpen, current[0], "opposite_signal", current);
    }

    const afterTradeStart = !options.tradeStartTime || Number(current[0]) >= options.tradeStartTime;
    if (!position && cash > 0 && afterTradeStart) {
      if (analysis.signal === "BUY") openPosition("long", currentOpen, current[0], analysis, current);
      else if (analysis.signal === "SELL") openPosition("short", currentOpen, current[0], analysis, current);
      else {
        const reason = categorizeNoEntryReason(options.strategy, analysis.reasoning || "");
        noEntryReasonCounts[reason] = (noEntryReasonCounts[reason] || 0) + 1;
      }
    }

    applyFunding(currentClose);
    equityCurve.push(markEquity(currentClose));
  }

  const last = ohlcv[ohlcv.length - 1];
  const lastPrice = Number(last?.[4] || 0);
  if (position && lastPrice > 0) closePosition(lastPrice, Number(last[0]), "end", last);
  equityCurve[equityCurve.length - 1] = cash;

  const totalReturn = ((cash - initialEquity) / initialEquity) * 100;
  let maxEquity = initialEquity;
  let maxDD = 0;
  for (const equity of equityCurve) {
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity > 0 ? (maxEquity - equity) / maxEquity : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const equityReturns = equityCurve.slice(1).map((equity, idx) => {
    const prev = equityCurve[idx] || equity;
    return prev > 0 ? (equity - prev) / prev : 0;
  }).filter(value => Number.isFinite(value));
  const meanReturn = average(equityReturns);
  const returnStd = stdev(equityReturns);
  const grossProfit = tradePnls.filter(pnl => pnl > 0).reduce((acc, pnl) => acc + pnl, 0);
  const grossLoss = Math.abs(tradePnls.filter(pnl => pnl < 0).reduce((acc, pnl) => acc + pnl, 0));
  const lossTrades = closedTrades - winTrades;
  const avgWin = winTrades > 0 ? grossProfit / winTrades : 0;
  const avgLoss = lossTrades > 0 ? grossLoss / lossTrades : 0;
  const diagnostics = createBacktestDiagnostics({
    noEntryReasonCounts,
    exitReasonCounts,
    winPnls: tradePnls.filter(pnl => pnl > 0),
    lossPnls: tradePnls.filter(pnl => pnl < 0),
    totalFees,
    totalExecutionCost,
    validationTrades: closedTrades,
  });

  return {
    strategy: options.strategy,
    symbol: options.symbol,
    initialEquity,
    totalReturn,
    winRate: closedTrades > 0 ? (winTrades / closedTrades) * 100 : 0,
    maxDrawdown: maxDD * 100,
    trades: closedTrades,
    totalTrades: closedTrades,
    finalBalance: cash,
    equityCurve,
    regimePerformance,
    sharpe: returnStd > 0 ? (meanReturn / returnStd) * Math.sqrt(365) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? grossProfit : 0),
    plRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    expectancy: tradePnls.length ? average(tradePnls) : 0,
    avgTradePnl: tradePnls.length ? average(tradePnls) : 0,
    feeRatio: (grossProfit + grossLoss) > 0 ? (totalFees / (grossProfit + grossLoss)) * 100 : 0,
    totalFees,
    totalExecutionCost,
    totalFunding,
    diagnostics,
    riskPerTradePct,
    executionPenaltyModel: {
      enabled: true,
      includes: ["spread", "slippage", "maker_taker", "funding", "partial_fill", "latency", "gap_stop", "extreme_volatility"],
      symbolProfile: symbolExecutionProfile(options.symbol),
      fundingRatePer8h: options.fundingRatePer8h || 0,
    },
    tradeLog: trades.slice(-100),
    openPosition: null,
    timeConsistency: {
      signalData: "bar t-1 close and earlier",
      execution: "bar t open",
      highLow: "only used after execution for stop/take-profit simulation",
      orderbook: "not used in historical OHLCV backtest",
      fundingOi: "neutral unless time-aligned data is supplied",
      fred: "not applied to historical bars without vintage/real-time data",
    },
  };
}

async function fetchBacktestOhlcv(symbol: string, timeframe: string, limit: number) {
  await prepareExchange(publicExchange);
  const ccxtSymbol = toCcxtSymbol(symbol);
  const targetLimit = Math.min(10000, Math.max(60, Math.floor(Number(limit) || 60)));
  const pageLimit = Math.min(300, targetLimit);
  const cacheKey = `backtest-ohlcv:${ccxtSymbol}:${timeframe}:${targetLimit}`;

  return cachedPublicMarket(cacheKey, 60000, async () => {
    const batches: any[][] = [];
    let since = calculateOhlcvStartSince({ timeframe, limit: targetLimit });
    const maxPages = Math.ceil(targetLimit / pageLimit) + 8;

    for (let page = 0; page < maxPages; page += 1) {
      const batch = await runWithExchangeProxyFallback(
        publicExchange,
        () => publicExchange.fetchOHLCV(ccxtSymbol, timeframe, since, pageLimit)
      );
      if (!Array.isArray(batch) || batch.length === 0) break;

      batches.push(batch);
      const normalized = normalizeOhlcvHistory(batches, targetLimit);
      if (normalized.length >= targetLimit) return normalized;

      const nextSince = nextOhlcvSince(batch, since);
      if (!nextSince || nextSince > Date.now()) break;
      since = nextSince;
    }

    return normalizeOhlcvHistory(batches, targetLimit);
  });
}

type RequestError = Error & {
  statusCode?: number;
  payload?: any;
};

function requestError(statusCode: number, message: string, payload?: any) {
  const error = new Error(message) as RequestError;
  error.statusCode = statusCode;
  error.payload = payload;
  return error;
}

async function submitOkxOrder(orderRequest: any, operator = "unknown") {
  const {
    symbol,
    side,
    amount,
    type = "market",
    price,
    leverage = 1,
    clientOrderId,
    tpPrice,
    slPrice,
    sandbox = false,
    strategyId,
    source,
    regime,
    regimeScore,
    macroGate,
    macroScore,
    entryReason,
    features,
    stopDistance,
    ruleCompliant,
    aiVerdict,
  } = orderRequest;
  const isSandbox = String(sandbox) === "true" || sandbox === true;
  const requestId = `ordreq_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const amountType = orderRequest.amountType || "coin";
  const targetSymbol = symbol || "BTC/USDT";
  const displaySymbol = normalizeDisplaySymbol(targetSymbol);
  const decisionContext = {
    regime,
    regimeScore,
    macroGate,
    macroScore,
    entryReason,
    features,
    stopDistance,
    ruleCompliant,
    aiVerdict,
  };
  let orderDiagnostics: Record<string, any> = {};

  addOrderLifecycle({
    requestId,
    clientOrderId,
    symbol: displaySymbol,
    side,
    amount,
    amountType,
    status: "accepted",
    source,
    strategyId,
    sandbox: isSandbox,
    operator,
    details: { type, leverage, tpPrice, slPrice, decisionContext },
  });
  recordTrade({
    id: clientOrderId || requestId,
    requestId,
    clientOrderId,
    symbol: displaySymbol,
    side,
    amount,
    amountType,
    status: "accepted",
    mode: toModeLabel(isSandbox),
    source,
    strategyId,
    ...decisionContext,
    leverage,
    orderType: type,
    tpPrice,
    slPrice,
    raw: { request: orderRequest, operator },
  });

  const credentials = resolveOkxCredentials(orderRequest, isSandbox);
  if (!credentials) {
    addOrderLifecycle({
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount,
      amountType,
      status: "failed",
      source,
      strategyId,
      sandbox: isSandbox,
      operator,
      details: { reason: "missing_okx_credentials" },
    });
    recordTrade({
      id: clientOrderId || requestId,
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount,
      amountType,
      status: "failed",
      mode: toModeLabel(isSandbox),
      source,
      strategyId,
      ...decisionContext,
      leverage,
      orderType: type,
      tpPrice,
      slPrice,
      raw: { error: "missing_okx_credentials" },
    });
    throw requestError(400, "Missing OKX credentials", { error: "Missing OKX credentials" });
  }

  try {
    const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, isSandbox);
    await prepareExchange(exchange);
    const exchangeCall = <T,>(fn: () => Promise<T>) => runWithExchangeProxyFallback(exchange, fn);
    await exchangeCall(() => exchange.loadMarkets());
    const resolvedMarket = await resolveOkxSwapMarket(targetSymbol, exchange);
    const minContracts = Math.max(resolvedMarket.minSz, resolvedMarket.lotSz);
    const requestedAmountUsdt = amountType === "usdt" ? Number(amount || 0) : null;
    let effectiveAmountUsdt = requestedAmountUsdt;
    let minRequiredUsdt: number | null = null;
    let autoUpsizedToMinimum = false;
    let preciseAmount: number;
    let livePriceForSizing: number | null = null;
    let isHedgeMode = false; // detected if OKX returns 51000 (posSide required)

    try {
      // OKX leverage setup:
      //   Net mode  : mgnMode=isolated|cross, no posSide
      //   Hedge mode: mgnMode=isolated|cross, posSide=long + posSide=short both required
      // We set leverage for both mgnMode values to tolerate accounts that switch modes.
      // If 51000 is returned (posSide required), the account is in hedge mode.
      const setLeverageCall = async (mgnMode: string, posSide?: string) => {
        const body: any = {
          instId: resolvedMarket.instId,
          lever: String(leverage),
          mgnMode,
        };
        if (posSide) body.posSide = posSide;
        return exchangeCall(() => (exchange as any).privatePostAccountSetLeverage(body));
      };

      let leverageResponse: any;
      try {
        // Try isolated first, then cross (ignore errors from cross — account may only support one)
        leverageResponse = await retry(() => setLeverageCall("isolated"));
        try { await retry(() => setLeverageCall("cross")); } catch { /* ignore */ }
      } catch (firstError: any) {
        // If error is 51000 (posSide required), account is in hedge mode
        const errMsg = firstError?.message || String(firstError);
        if (errMsg.includes("51000") || errMsg.includes("posSide")) {
          isHedgeMode = true;
          pushAutoTradingLog(`OKX 账号为对冲模式，改为按 posSide 设置杠杆 ${leverage}x`);
          await retry(() => setLeverageCall("isolated", "long"));
          await retry(() => setLeverageCall("isolated", "short"));
          try { await retry(() => setLeverageCall("cross", "long")); } catch { /* ignore */ }
          try { await retry(() => setLeverageCall("cross", "short")); } catch { /* ignore */ }
          leverageResponse = { code: "0", msg: "ok (hedge mode)" };
        } else {
          throw firstError;
        }
      }

      const leverageRow = unwrapOkxApiRow(leverageResponse);
      const leverageCode = String(leverageRow?.sCode ?? leverageResponse?.code ?? "0");
      if (leverageCode !== "0") {
        throw new Error(leverageRow?.sMsg || leverageResponse?.msg || "Unknown leverage error");
      }
    } catch (levError: any) {
      throw requestError(500, `Failed to set leverage: ${levError.message}`, {
        error: `Failed to set leverage: ${levError.message}`,
        code: levError.constructor?.name || "Error",
        resolvedMarketId: resolvedMarket.resolvedMarketId,
        resolvedMarketSymbol: resolvedMarket.resolvedMarketSymbol,
      });
    }

    if (amountType === "usdt") {
      const ticker = await fetchPublicTickerSnapshot(displaySymbol);
      const livePrice = ticker.last || 0;
      if (livePrice === 0) throw requestError(500, "Could not fetch current price for amount calculation", {
        error: "Could not fetch current price for amount calculation",
        resolvedMarketId: resolvedMarket.resolvedMarketId,
        resolvedMarketSymbol: resolvedMarket.resolvedMarketSymbol,
      });
      livePriceForSizing = livePrice;
      minRequiredUsdt = (livePrice * resolvedMarket.ctVal * minContracts) / Math.max(1, leverage);
      effectiveAmountUsdt = requestedAmountUsdt;
      if (source === "auto" && Number.isFinite(effectiveAmountUsdt) && Number.isFinite(minRequiredUsdt) && effectiveAmountUsdt! < minRequiredUsdt!) {
        effectiveAmountUsdt = minRequiredUsdt;
        autoUpsizedToMinimum = true;
      }
      const rawSz = (Number(effectiveAmountUsdt || 0) * leverage) / (livePrice * resolvedMarket.ctVal);
      preciseAmount = floorToStep(rawSz, resolvedMarket.lotSz);
      if (source === "auto" && preciseAmount > 0 && preciseAmount < minContracts) {
        preciseAmount = minContracts;
        autoUpsizedToMinimum = true;
      }
      preciseAmount = Number(formatToStepString(preciseAmount, resolvedMarket.lotSz));
      if (preciseAmount <= 0 || preciseAmount < minContracts) {
        throw requestError(400, "Investment amount too small for minimum contract step", {
          error: "Investment amount too small for minimum contract step",
          requestedAmountUsdt,
          minRequiredUsdt,
          effectiveAmountUsdt,
          resolvedMarketId: resolvedMarket.resolvedMarketId,
          resolvedMarketSymbol: resolvedMarket.resolvedMarketSymbol,
        });
      }
      effectiveAmountUsdt = (preciseAmount * livePrice * resolvedMarket.ctVal) / Math.max(1, leverage);
    } else {
      const rawSz = Number(amount || 0) / resolvedMarket.ctVal;
      preciseAmount = Number(formatToStepString(floorToStep(rawSz, resolvedMarket.lotSz), resolvedMarket.lotSz));
    }

    if (preciseAmount < minContracts) {
      throw requestError(400, `Amount ${preciseAmount} is less than minimum required ${minContracts} for ${resolvedMarket.resolvedMarketId}`, {
        error: `Amount ${preciseAmount} is less than minimum required ${minContracts} for ${resolvedMarket.resolvedMarketId}`,
        requestedAmountUsdt,
        minRequiredUsdt,
        effectiveAmountUsdt,
        resolvedMarketId: resolvedMarket.resolvedMarketId,
        resolvedMarketSymbol: resolvedMarket.resolvedMarketSymbol,
      });
    }

    if (autoUpsizedToMinimum && source === "auto" && Number.isFinite(requestedAmountUsdt) && Number.isFinite(effectiveAmountUsdt)) {
      pushAutoTradingLog(`Auto order amount raised ${displaySymbol}: ${requestedAmountUsdt!.toFixed(2)} -> ${effectiveAmountUsdt!.toFixed(2)} USDT (minimum contract requirement)`);
    }

    orderDiagnostics = {
      requestedAmountUsdt,
      minRequiredUsdt,
      effectiveAmountUsdt,
      autoUpsizedToMinimum,
      contractSz: preciseAmount,
      ctVal: resolvedMarket.ctVal,
      lotSz: resolvedMarket.lotSz,
      minSz: resolvedMarket.minSz,
      resolvedMarketId: resolvedMarket.resolvedMarketId,
      resolvedMarketSymbol: resolvedMarket.resolvedMarketSymbol,
    };

    addOrderLifecycle({
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount: preciseAmount,
      amountType,
      status: "prepared",
      source,
      strategyId,
      sandbox: isSandbox,
      operator,
      details: {
        requestedAmount: amount,
        ...orderDiagnostics,
        orderType: type,
        leverage,
      },
    });
    recordTrade({
      id: clientOrderId || requestId,
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount: preciseAmount,
      amountType,
      status: "prepared",
      mode: toModeLabel(isSandbox),
      source,
      strategyId,
      ...decisionContext,
      leverage,
      orderType: type,
      tpPrice,
      slPrice,
      raw: {
        requestedAmount: amount,
        preciseAmount,
        ...orderDiagnostics,
      },
    });

    // OKX order mode detection:
    // - Net mode accounts: tdMode="isolated" or "cross", no posSide needed
    // - Hedge mode accounts: tdMode="isolated" or "cross" + posSide="long"/"short" required
    // - 51010 = account mode mismatch (isolated vs cross) → retry with other tdMode
    // - 51000 on leverage = hedge mode detected earlier (isHedgeMode=true)
    const tryModes = ["isolated", "cross"] as const;
    // For hedge mode, posSide must match the intended direction
    const hedgePosSide = isHedgeMode ? (side === "buy" ? "long" : "short") : undefined;
    let lastOrderError: any = null;
    let submitResponse: any = null;
    let submitRow: any = null;
    let submitCode = "0";
    let attachAlgoOrds: any[] = [];

    for (const tdMode of tryModes) {
      const orderPayload: Record<string, any> = {
        instId: resolvedMarket.instId,
        tdMode,
        side,
        ordType: type === "limit" ? "limit" : "market",
        sz: formatToStepString(preciseAmount, resolvedMarket.lotSz),
      };
      // Hedge mode accounts require posSide ("long"/"short") on every order
      if (hedgePosSide) orderPayload.posSide = hedgePosSide;
      if (clientOrderId) orderPayload.clOrdId = clientOrderId;
      if (type === "limit") {
        if (!Number.isFinite(Number(price))) {
          throw requestError(400, "Limit order price is required", { error: "Limit order price is required" });
        }
        orderPayload.px = String(price);
      }
      attachAlgoOrds = buildOkxAttachAlgoOrds({ tpPrice, slPrice });
      if (attachAlgoOrds.length > 0) {
        orderPayload.attachAlgoOrds = attachAlgoOrds;
      }
      orderDiagnostics = {
        ...orderDiagnostics,
        orderPayload,
        attemptedTdMode: tdMode,
        isHedgeMode,
        hedgePosSide,
      };

      try {
        submitResponse = await retry(() => exchangeCall(() => (exchange as any).privatePostTradeOrder(orderPayload)));
        submitRow = unwrapOkxApiRow(submitResponse);
        submitCode = String(submitRow?.sCode ?? "0");
        if (submitCode !== "0") {
          const okxDetails = parseOkxErrorDetails(submitResponse);
          const errMsg = String(submitRow?.sMsg || submitResponse?.msg || "OKX order rejected");
          // If 51010 (account mode mismatch) and we haven't tried "cross" yet, retry
          if (errMsg.includes("51010") && tdMode === "isolated") {
            pushAutoTradingLog(`OKX 账号保证金模式不匹配，重试 cross 模式: ${displaySymbol}`);
            lastOrderError = { code: submitCode, msg: errMsg, details: okxDetails };
            continue;
          }
          throw requestError(400, errMsg, {
            error: errMsg,
            code: submitCode,
            ...orderDiagnostics,
            ...okxDetails,
          });
        }
        // Success
        if (tdMode === "cross") {
          pushAutoTradingLog(`OKX 账号使用 cross 保证金模式下单成功: ${displaySymbol}`);
        }
        if (isHedgeMode) {
          pushAutoTradingLog(`OKX 对冲模式下单成功 (posSide=${hedgePosSide}): ${displaySymbol}`);
        }
        break;
      } catch (orderErr: any) {
        if (orderErr?.message?.includes("51010") && tdMode === "isolated") {
          pushAutoTradingLog(`OKX 账号保证金模式不匹配，重试 cross 模式: ${displaySymbol}`);
          lastOrderError = orderErr;
          continue;
        }
        throw orderErr; // re-throw if not a mode-mismatch error
      }
    }

    if (submitCode !== "0") {
      const err = lastOrderError || { code: submitCode, msg: "Unknown order error" };
      throw requestError(400, `OKX order rejected (${err.code}): ${err.msg}`, {
        error: `OKX order rejected (${err.code})`,
        code: err.code,
        ...orderDiagnostics,
      });
    }
    const orderInfo = attachAlgoOrds.length > 0
      ? { ...submitRow, attachAlgoOrds }
      : submitRow;
    const order = {
      id: String(submitRow?.ordId || "").trim() || undefined,
      clientOrderId: String(submitRow?.clOrdId || clientOrderId || "").trim() || undefined,
      symbol: displaySymbol,
      instId: resolvedMarket.instId,
      type,
      side,
      price: type === "limit" ? Number(price) : livePriceForSizing,
      average: type === "limit" ? Number(price) : livePriceForSizing,
      amount: preciseAmount,
      status: "open",
      info: orderInfo,
    };

    addOrderLifecycle({
      requestId,
      clientOrderId: order.clientOrderId || clientOrderId,
      orderId: order?.id,
      symbol: displaySymbol,
      side,
      amount: preciseAmount,
      amountType,
      status: "submitted",
      source,
      strategyId,
      sandbox: isSandbox,
      operator,
      details: {
        order,
        ...orderDiagnostics,
      },
    });
    recordTrade({
      id: clientOrderId || requestId,
      requestId,
      clientOrderId: order.clientOrderId || clientOrderId,
      exchangeOrderId: order?.id,
      symbol: displaySymbol,
      side,
      amount: preciseAmount,
      amountType,
      price: order?.price,
      status: "submitted",
      mode: toModeLabel(isSandbox),
      source,
      strategyId,
      ...decisionContext,
      leverage,
      orderType: type,
      tpPrice,
      slPrice,
      raw: {
        order,
        ...orderDiagnostics,
      },
    });

    if (order?.id || order?.clientOrderId) {
      try {
        const verifiedRaw: any = await fetchOkxTradeOrderRaw(exchange, exchangeCall, resolvedMarket.instId, {
          ordId: order.id,
          clOrdId: order.clientOrderId || clientOrderId,
        });
        const verifiedOrder = normalizeOkxRawOrder(verifiedRaw, resolvedMarket);
        addToAudit(auditStore.orderReceipts, {
          request: {
            requestId,
            symbol: displaySymbol,
            side,
            amount,
            type,
            leverage,
            clientOrderId,
            operator,
            decisionContext,
            ...orderDiagnostics,
          },
          response: order,
          verification: verifiedOrder,
          strategyVersion: STRATEGY_VERSION
        });
        addOrderLifecycle({
          requestId,
          clientOrderId: order.clientOrderId || clientOrderId,
          orderId: order.id,
          symbol: displaySymbol,
          side,
          amount: preciseAmount,
          amountType,
          status: "verified",
          source,
          strategyId,
          sandbox: isSandbox,
          operator,
          details: {
            status: verifiedOrder.status,
            filled: verifiedOrder.filled,
            remaining: verifiedOrder.remaining,
            ...orderDiagnostics,
          },
        });
        recordTrade({
          id: clientOrderId || requestId,
          requestId,
          clientOrderId: order.clientOrderId || clientOrderId,
          exchangeOrderId: order.id,
          symbol: displaySymbol,
          side,
          amount: preciseAmount,
          amountType,
          price: verifiedOrder.average || verifiedOrder.price || order.price,
          fee: verifiedOrder.fee,
          status: verifiedOrder.status || "verified",
          mode: toModeLabel(isSandbox),
          source,
          strategyId,
          ...decisionContext,
          leverage,
          orderType: type,
          tpPrice,
          slPrice,
          raw: {
            order,
            verifiedOrder,
            ...orderDiagnostics,
          },
        });
        addToAudit(auditStore.positionChanges, {
          symbol: displaySymbol,
          side,
          amount: effectiveAmountUsdt ?? amount,
          price: verifiedOrder.price || order.price,
          orderId: order.id,
          status: verifiedOrder.status,
          decisionContext,
        });
        takeProfitManager.register({
          tradeId: clientOrderId || requestId,
          requestId,
          clientOrderId: order.clientOrderId || clientOrderId,
          orderId: order.id,
          symbol: displaySymbol,
          side,
          sandbox: isSandbox,
          source,
          strategyId,
          tpPrice,
          slPrice,
          entryPrice: firstNumber(verifiedOrder.average, verifiedOrder.price, order.price),
          verifiedOrder,
          order,
        });
        return verifiedOrder;
      } catch {
        takeProfitManager.register({
          tradeId: clientOrderId || requestId,
          requestId,
          clientOrderId: order.clientOrderId || clientOrderId,
          orderId: order.id,
          symbol: displaySymbol,
          side,
          sandbox: isSandbox,
          source,
          strategyId,
          tpPrice,
          slPrice,
          entryPrice: firstNumber(order.average, order.price),
          order,
        });
        return order;
      }
    }

    return order;
  } catch (error: any) {
    const errMsg = error?.message || String(error || "Unknown Error");
    const errorPayload = error?.payload || {};
    const okxDetails = parseOkxErrorDetails(error);
    const failureDetails = {
      ...orderDiagnostics,
      ...errorPayload,
      ...okxDetails,
      error: errMsg,
      code: errorPayload.code || okxDetails.okxSCode || okxDetails.okxCode || error.constructor?.name || "Error",
      requestedAmountUsdt: errorPayload.requestedAmountUsdt ?? orderDiagnostics.requestedAmountUsdt ?? (amountType === "usdt" ? Number(amount || 0) : null),
      minRequiredUsdt: errorPayload.minRequiredUsdt ?? orderDiagnostics.minRequiredUsdt ?? null,
      effectiveAmountUsdt: errorPayload.effectiveAmountUsdt ?? orderDiagnostics.effectiveAmountUsdt ?? null,
      autoUpsizedToMinimum: errorPayload.autoUpsizedToMinimum ?? orderDiagnostics.autoUpsizedToMinimum ?? false,
      resolvedMarketId: errorPayload.resolvedMarketId ?? orderDiagnostics.resolvedMarketId ?? null,
      resolvedMarketSymbol: errorPayload.resolvedMarketSymbol ?? orderDiagnostics.resolvedMarketSymbol ?? null,
    };
    addOrderLifecycle({
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount: failureDetails.contractSz ?? amount,
      amountType,
      status: "failed",
      source,
      strategyId,
      sandbox: isSandbox,
      operator,
      details: failureDetails,
    });
    recordTrade({
      id: clientOrderId || requestId,
      requestId,
      clientOrderId,
      symbol: displaySymbol,
      side,
      amount: failureDetails.contractSz ?? amount,
      amountType,
      status: "failed",
      mode: toModeLabel(isSandbox),
      source,
      strategyId,
      ...decisionContext,
      leverage,
      orderType: type,
      tpPrice,
      slPrice,
      raw: failureDetails,
    });
    if (error?.statusCode) throw error;
    throw requestError(500, errMsg, {
      ...failureDetails,
      note: "Execution failed after retries. Please check exchange status."
    });
  }
}

function resolveEngineCredentials(sandbox: boolean) {
  return resolveOkxCredentials({}, sandbox);
}

function currentMacroSnapshot() {
  const macroData = cachedMacroData || {
    dxy: 0,
    m2: 0,
    m2Change3mPct: 0,
    dxyChange30dPct: 0,
    btcCorrelation: 0,
    dxySource: "unavailable" as const,
    macroRiskScore: 0,
  };
  const macroRiskScore = deriveMacroRiskScoreFromIndicators({
    macroRiskScore: (macroData as any).macroRiskScore,
    globalLiquidity: (macroData as any).m2 ? ((macroData as any).m2 / 20000) * 100 : undefined,
    dxyCorrelation: (macroData as any).btcCorrelation
  });
  const macroGate = (macroData as any).macroGate || evaluateMacroGate({ macroRiskScore });
  return {
    macroData,
    macroRiskScore,
    macroGate,
  };
}

function normalizeManagedOrderSide(side: string | undefined | null): "buy" | "sell" | null {
  const normalized = String(side || "").trim().toLowerCase();
  if (normalized === "buy" || normalized === "long") return "buy";
  if (normalized === "sell" || normalized === "short") return "sell";
  return null;
}

function extractAttachedTpIdentifiers(orderLike: any) {
  const info = orderLike?.info || orderLike?.verifiedOrder?.info || orderLike?.order?.info || {};
  const attached = Array.isArray(info?.attachAlgoOrds)
    ? info.attachAlgoOrds.find((item: any) => item?.attachAlgoId || item?.attachAlgoClOrdId || item?.tpTriggerPx || item?.newTpTriggerPx)
    : null;
  const linkedAlgo = info?.linkedAlgoOrd || {};
  const attachAlgoId = String(
    attached?.attachAlgoId
    || attached?.algoId
    || orderLike?.attachAlgoId
    || info?.attachAlgoId
    || linkedAlgo?.algoId
    || ""
  ).trim() || null;
  const attachAlgoClOrdId = String(
    attached?.attachAlgoClOrdId
    || attached?.algoClOrdId
    || orderLike?.attachAlgoClOrdId
    || info?.attachAlgoClOrdId
    || ""
  ).trim() || null;
  return {
    attachedTpAlgoId: attachAlgoId,
    attachedTpAlgoClOrdId: attachAlgoClOrdId,
  };
}

function buildBaseMarketAnalysisFromMacro(snapshot = currentMacroSnapshot()) {
  const { macroData, macroRiskScore, macroGate } = snapshot;
  const baseMarketAnalysis = createDefaultMarketAnalysis();
  baseMarketAnalysis.macroIndicators = {
    dxyCorrelation: (macroData as any).btcCorrelation ?? baseMarketAnalysis.macroIndicators.dxyCorrelation,
    usdtPremium: baseMarketAnalysis.macroIndicators.usdtPremium,
    globalLiquidity: (macroData as any).m2 ? ((macroData as any).m2 / 20000) * 100 : baseMarketAnalysis.macroIndicators.globalLiquidity,
    macroRiskScore,
    macroGate,
  };
  if ((macroData as any).dxy !== undefined) baseMarketAnalysis.onChainData.dxy = (macroData as any).dxy;
  if ((macroData as any).m2 !== undefined) baseMarketAnalysis.onChainData.m2 = (macroData as any).m2;
  return {
    baseMarketAnalysis,
    macroData,
    macroRiskScore,
    macroGate,
  };
}

type TakeProfitConsensusCandidate = {
  symbol: string;
  timeframe: string;
  strategyId: string;
  side: "buy" | "sell";
  analysis: any;
  requiredConfidence: number;
  score: number;
  ticker: RuntimeTicker;
};

type TakeProfitConsensusResult =
  | { status: "actionable"; candidate: TakeProfitConsensusCandidate }
  | { status: "no_signal"; reason: string }
  | { status: "timeframe_conflict"; reason: string }
  | { status: "error"; reason: string };

async function evaluateTakeProfitConsensus(
  config: AutoTradingConfig,
  symbol: string,
  snapshot = currentMacroSnapshot()
): Promise<TakeProfitConsensusResult> {
  const normalizedSymbol = normalizeDisplaySymbol(symbol);
  const profile = config.scanProfiles.find((item) => item.symbol === normalizedSymbol);
  if (!profile) {
    return { status: "no_signal", reason: `${normalizedSymbol} is not in active scan profiles` };
  }

  const { baseMarketAnalysis, macroRiskScore, macroGate } = buildBaseMarketAnalysisFromMacro(snapshot);
  const candidates: TakeProfitConsensusCandidate[] = [];
  let lastRejectedReason = `No actionable signal for ${normalizedSymbol}`;
  let marketFailureReason: string | null = null;

  for (const timeframe of profile.timeframes) {
    let marketBundle: Awaited<ReturnType<typeof fetchPublicMarketBundle>> | null = null;
    try {
      marketBundle = await fetchPublicMarketBundleWithAutoRetry(normalizedSymbol, timeframe, 120);
    } catch (error: any) {
      marketFailureReason = error?.message || String(error || "Failed to fetch market data");
      continue;
    }

    const ticker = normalizeTicker(normalizedSymbol, marketBundle.ticker);
    if (!ticker) {
      marketFailureReason = `Ticker unavailable for ${normalizedSymbol} ${timeframe}`;
      continue;
    }

    const runtimeContext = buildMarketRuntimeContext(
      normalizedSymbol,
      ticker,
      marketBundle.funding,
      marketBundle.orderBook,
      Array.isArray(marketBundle.ohlcv) ? marketBundle.ohlcv : [],
      {
        ...baseMarketAnalysis,
        correlations: baseMarketAnalysis.correlations.map(item => ({ ...item })),
        trends: baseMarketAnalysis.trends.map(item => ({ ...item })),
      },
      timeframe
    );

    for (const strategyId of config.strategyIds) {
      const analysis = evaluateStrategy({
        symbol: normalizedSymbol,
        ticker,
        strategyId,
        prices: runtimeContext.prices,
        indicators: runtimeContext.marketAnalysis.realIndicators,
        market: {
          sentiment: runtimeContext.marketAnalysis.sentiment,
          volatility: runtimeContext.marketAnalysis.volatility,
          fundingRate: runtimeContext.fundingRate?.fundingRate ?? 0,
          macroRiskScore,
          macroGate,
          onChainData: runtimeContext.marketAnalysis.onChainData,
        },
        risk: {
          estimatedFeeRate: config.riskConfigSnapshot.estimatedFeeRate,
          stopLoss: config.riskConfigSnapshot.stopLoss,
          takeProfit: config.riskConfigSnapshot.takeProfit,
        },
        allowSyntheticData: false,
      });

      const normalizedSide = normalizeManagedOrderSide(analysis.signal);
      if (!normalizedSide) {
        lastRejectedReason = `Signal rejected: ${analysis.signal}`;
        continue;
      }

      const requiredConfidence = config.riskConfigSnapshot.autoTradeThreshold + (analysis?.macroGate?.entryThresholdAdjustment || 0);
      if (Number(analysis.confidence || 0) < requiredConfidence) {
        lastRejectedReason = `Confidence ${analysis.confidence} < ${requiredConfidence}`;
        continue;
      }

      candidates.push({
        symbol: normalizedSymbol,
        timeframe,
        strategyId,
        side: normalizedSide,
        analysis,
        requiredConfidence,
        score: Number(analysis.confidence || 0) + Math.abs(Number(analysis.regimeScore || 0)) * 10,
        ticker,
      });
    }
  }

  if (!candidates.length) {
    if (marketFailureReason) return { status: "error", reason: marketFailureReason };
    return { status: "no_signal", reason: lastRejectedReason };
  }

  const directions = new Set(candidates.map((item) => item.side));
  if (directions.size > 1) {
    const conflictDetail = candidates
      .map((item) => `${item.timeframe}=${item.side.toUpperCase()}`)
      .join(", ");
    return {
      status: "timeframe_conflict",
      reason: `${normalizedSymbol} timeframe conflict: ${conflictDetail}`,
    };
  }

  const winner = [...candidates].sort((left, right) => right.score - left.score)[0];
  return { status: "actionable", candidate: winner };
}

function computeTakeProfitMinDelta(currentPrice: number, entryPrice: number, slPrice: number) {
  const currentPriceDelta = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice * TP_MANAGER_MIN_PRICE_PCT : 0;
  const riskDistance = Number.isFinite(entryPrice) && Number.isFinite(slPrice) && entryPrice > 0 && slPrice > 0
    ? Math.abs(entryPrice - slPrice) * TP_MANAGER_MIN_R_MULTIPLIER
    : 0;
  return Math.max(currentPriceDelta, riskDistance);
}

class TakeProfitManager {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private managed = new Map<string, ManagedTakeProfitOrder>();

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TP_MANAGER_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  register(input: {
    tradeId: string;
    requestId: string;
    clientOrderId?: string;
    orderId?: string;
    symbol: string;
    side: string;
    sandbox: boolean;
    source?: string;
    strategyId?: string;
    tpPrice?: number | null;
    slPrice?: number | null;
    entryPrice?: number | null;
    verifiedOrder?: any;
    order?: any;
  }) {
    const side = normalizeManagedOrderSide(input.side);
    const initialTpPrice = normalizeNumber(input.tpPrice);
    const slPrice = normalizeNumber(input.slPrice);
    if (!side || !initialTpPrice || !slPrice) return;

    const source: TakeProfitManagerSource = input.source === "auto" ? "auto" : "manual";
    const activeConfig = sanitizeAutoTradingConfig(appStore.autoTrading.config);
    const normalizedSymbol = normalizeDisplaySymbol(input.symbol);
    if (!activeConfig) {
      updateTradeTakeProfitMetadata({
        id: input.tradeId,
        tpPrice: initialTpPrice,
        slPrice,
        initialTpPrice,
        currentTpPrice: initialTpPrice,
        tpAmendCount: 0,
        tpManagerStatus: "skipped",
        lastTpManagerReason: "Auto-trading config unavailable",
      });
      addOrderLifecycle({
        requestId: input.requestId,
        clientOrderId: input.clientOrderId,
        orderId: input.orderId,
        symbol: normalizedSymbol,
        side,
        status: "tp_skipped",
        source,
        strategyId: input.strategyId,
        sandbox: input.sandbox,
        operator: "tp-manager",
        details: { reason: "Auto-trading config unavailable" },
      });
      pushAutoTradingLog(`TP manager skipped ${normalizedSymbol}: auto-trading config unavailable`);
      return;
    }
    const profileExists = Boolean(activeConfig?.scanProfiles.some((profile) => profile.symbol === normalizedSymbol));
    if (!profileExists) {
      updateTradeTakeProfitMetadata({
        id: input.tradeId,
        tpPrice: initialTpPrice,
        slPrice,
        initialTpPrice,
        currentTpPrice: initialTpPrice,
        tpAmendCount: 0,
        tpManagerStatus: "skipped",
        lastTpManagerReason: `${normalizedSymbol} is not in active scan profiles`,
      });
      addOrderLifecycle({
        requestId: input.requestId,
        clientOrderId: input.clientOrderId,
        orderId: input.orderId,
        symbol: normalizedSymbol,
        side,
        status: "tp_skipped",
        source,
        strategyId: input.strategyId,
        sandbox: input.sandbox,
        operator: "tp-manager",
        details: { reason: `${normalizedSymbol} is not in active scan profiles` },
      });
      pushAutoTradingLog(`TP manager skipped ${normalizedSymbol}: symbol not in active scan profiles`);
      return;
    }

    const attached = extractAttachedTpIdentifiers(input.verifiedOrder || input.order);
    const managedOrder: ManagedTakeProfitOrder = {
      id: `tpmgr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      tradeId: input.tradeId,
      requestId: input.requestId,
      clientOrderId: input.clientOrderId,
      orderId: input.orderId,
      symbol: normalizedSymbol,
      side,
      sandbox: input.sandbox,
      source,
      strategyId: input.strategyId,
      entryPrice: firstNumber(input.entryPrice, input.verifiedOrder?.average, input.verifiedOrder?.price, input.order?.average, input.order?.price),
      initialTpPrice,
      currentTpPrice: initialTpPrice,
      slPrice,
      tpAmendCount: 0,
      tpManagerStatus: attached.attachedTpAlgoId || attached.attachedTpAlgoClOrdId ? "active" : "pending_lookup",
      attachedTpAlgoId: attached.attachedTpAlgoId,
      attachedTpAlgoClOrdId: attached.attachedTpAlgoClOrdId,
      lastCheckedAt: null,
      lastAmendedAt: null,
      lastTpManagerReason: null,
      createdAt: Date.now(),
    };

    this.managed.set(managedOrder.tradeId, managedOrder);
    updateTradeTakeProfitMetadata({
      id: managedOrder.tradeId,
      tpPrice: managedOrder.currentTpPrice,
      slPrice: managedOrder.slPrice,
      initialTpPrice: managedOrder.initialTpPrice,
      currentTpPrice: managedOrder.currentTpPrice,
      tpAmendCount: managedOrder.tpAmendCount,
      tpManagerStatus: managedOrder.tpManagerStatus,
      lastTpManagerReason: null,
      attachedTpAlgoId: managedOrder.attachedTpAlgoId,
      attachedTpAlgoClOrdId: managedOrder.attachedTpAlgoClOrdId,
    });
    addOrderLifecycle({
      requestId: managedOrder.requestId,
      clientOrderId: managedOrder.clientOrderId,
      orderId: managedOrder.orderId,
      symbol: managedOrder.symbol,
      side: managedOrder.side,
      status: "tp_managed",
      source: managedOrder.source,
      strategyId: managedOrder.strategyId,
      sandbox: managedOrder.sandbox,
      operator: "tp-manager",
      details: {
        initialTpPrice: managedOrder.initialTpPrice,
        slPrice: managedOrder.slPrice,
        attachedTpAlgoId: managedOrder.attachedTpAlgoId,
        attachedTpAlgoClOrdId: managedOrder.attachedTpAlgoClOrdId,
      },
    });
    pushAutoTradingLog(`TP manager took over ${managedOrder.symbol} (${managedOrder.source})`);
  }

  private note(managedOrder: ManagedTakeProfitOrder, status: OrderLifecycleEvent["status"], reason: string, details: Record<string, any> = {}, force = false) {
    const nextManagerStatus = status === "tp_closed" ? "closed" : managedOrder.tpManagerStatus;
    const changed = managedOrder.lastTpManagerReason !== reason || managedOrder.tpManagerStatus !== nextManagerStatus;
    managedOrder.lastTpManagerReason = reason;
    managedOrder.tpManagerStatus = nextManagerStatus;
    if (!force && !changed) return;
    updateTradeTakeProfitMetadata({
      id: managedOrder.tradeId,
      tpPrice: managedOrder.currentTpPrice,
      slPrice: managedOrder.slPrice,
      initialTpPrice: managedOrder.initialTpPrice,
      currentTpPrice: managedOrder.currentTpPrice,
      tpAmendCount: managedOrder.tpAmendCount,
      tpManagerStatus: managedOrder.tpManagerStatus,
      lastTpManagerReason: managedOrder.lastTpManagerReason,
      attachedTpAlgoId: managedOrder.attachedTpAlgoId,
      attachedTpAlgoClOrdId: managedOrder.attachedTpAlgoClOrdId,
    });
    addOrderLifecycle({
      requestId: managedOrder.requestId,
      clientOrderId: managedOrder.clientOrderId,
      orderId: managedOrder.orderId,
      symbol: managedOrder.symbol,
      side: managedOrder.side,
      status,
      source: managedOrder.source,
      strategyId: managedOrder.strategyId,
      sandbox: managedOrder.sandbox,
      operator: "tp-manager",
      details: {
        currentTpPrice: managedOrder.currentTpPrice,
        slPrice: managedOrder.slPrice,
        tpAmendCount: managedOrder.tpAmendCount,
        tpManagerStatus: managedOrder.tpManagerStatus,
        reason,
        ...details,
      },
    });
    pushAutoTradingLog(reason);
  }

  private async refreshAttachedIdentifiers(managedOrder: ManagedTakeProfitOrder, exchange: any, exchangeCall: <T>(fn: () => Promise<T>) => Promise<T>) {
    if ((managedOrder.attachedTpAlgoId || managedOrder.attachedTpAlgoClOrdId) || !managedOrder.orderId) return;
    try {
      const resolvedMarket = await resolveOkxSwapMarket(managedOrder.symbol, exchange);
      const refreshedRaw = await fetchOkxTradeOrderRaw(exchange, exchangeCall, resolvedMarket.instId, {
        ordId: managedOrder.orderId,
        clOrdId: managedOrder.clientOrderId,
      });
      const refreshed = normalizeOkxRawOrder(refreshedRaw, resolvedMarket);
      const attached = extractAttachedTpIdentifiers(refreshed);
      if (attached.attachedTpAlgoId || attached.attachedTpAlgoClOrdId) {
        managedOrder.attachedTpAlgoId = attached.attachedTpAlgoId;
        managedOrder.attachedTpAlgoClOrdId = attached.attachedTpAlgoClOrdId;
        managedOrder.tpManagerStatus = "active";
        updateTradeTakeProfitMetadata({
          id: managedOrder.tradeId,
          attachedTpAlgoId: managedOrder.attachedTpAlgoId,
          attachedTpAlgoClOrdId: managedOrder.attachedTpAlgoClOrdId,
          tpManagerStatus: managedOrder.tpManagerStatus,
        });
      }
    } catch {
      managedOrder.tpManagerStatus = "pending_lookup";
    }
  }

  private async amendTakeProfit(managedOrder: ManagedTakeProfitOrder, newTpPrice: number, exchange: any, exchangeCall: <T>(fn: () => Promise<T>) => Promise<T>) {
    const attachPayload: Record<string, any> = {
      newTpTriggerPx: String(newTpPrice),
      newTpOrdPx: "-1",
      newTpTriggerPxType: "last",
    };
    if (managedOrder.attachedTpAlgoId) attachPayload.attachAlgoId = managedOrder.attachedTpAlgoId;
    if (managedOrder.attachedTpAlgoClOrdId) attachPayload.attachAlgoClOrdId = managedOrder.attachedTpAlgoClOrdId;
    if (!attachPayload.attachAlgoId && !attachPayload.attachAlgoClOrdId) {
      throw new Error("Attached TP algo identifier is unavailable");
    }

    const request: Record<string, any> = {
      instId: toOkxSwapInstId(managedOrder.symbol),
      reqId: `tpamend_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      cxlOnFail: false,
      attachAlgoOrds: [attachPayload],
    };
    if (managedOrder.orderId) request.ordId = managedOrder.orderId;
    else if (managedOrder.clientOrderId) request.clOrdId = managedOrder.clientOrderId;
    else throw new Error("Main order identifier is unavailable");

    return retry(() => exchangeCall(() => (exchange as any).privatePostTradeAmendOrder(request)));
  }

  private async tick() {
    if (this.inFlight || this.managed.size === 0) return;
    this.inFlight = true;
    try {
      await ensureFreshMacroData();
      const macroSnapshot = currentMacroSnapshot();
      const consensusCache = new Map<string, Promise<TakeProfitConsensusResult>>();
      const positionCache = new Map<string, Promise<any[]>>();

      for (const managedOrder of [...this.managed.values()]) {
        const credentials = resolveEngineCredentials(managedOrder.sandbox);
        if (!credentials) {
          managedOrder.tpManagerStatus = "skipped";
          this.note(
            managedOrder,
            "tp_skipped",
            `TP manager skipped ${managedOrder.symbol}: missing ${managedOrder.sandbox ? "demo" : "live"} credentials`
          );
          this.managed.delete(managedOrder.tradeId);
          continue;
        }

        const config = sanitizeAutoTradingConfig(appStore.autoTrading.config);
        if (!config) {
          this.note(managedOrder, "tp_skipped", `TP manager skipped ${managedOrder.symbol}: auto-trading config unavailable`);
          continue;
        }

        const profile = config.scanProfiles.find((item) => item.symbol === managedOrder.symbol);
        if (!profile) {
          managedOrder.tpManagerStatus = "skipped";
          this.note(managedOrder, "tp_skipped", `TP manager skipped ${managedOrder.symbol}: symbol removed from active scan profiles`);
          this.managed.delete(managedOrder.tradeId);
          continue;
        }

        const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, managedOrder.sandbox);
        await prepareExchange(exchange);
        const exchangeCall = <T,>(fn: () => Promise<T>) => runWithExchangeProxyFallback(exchange, fn);
        const positionKey = String(managedOrder.sandbox);
        if (!positionCache.has(positionKey)) {
          positionCache.set(positionKey, exchangeCall(() => exchange.fetchPositions(undefined, { instType: "SWAP" }))
            .then((positions: any[]) => positions.map(normalizeOkxPosition)));
        }
        const positions = (await positionCache.get(positionKey)!).filter((item: any) => item.symbol === managedOrder.symbol);
        const matchingPosition = positions.find((item: any) => {
          const positionSide = normalizeManagedOrderSide(item.side);
          return positionSide === managedOrder.side && Math.abs(Number(item.contracts || 0)) > 0;
        });

        if (!matchingPosition) {
          this.note(managedOrder, "tp_closed", `TP manager released ${managedOrder.symbol}: position no longer open`);
          this.managed.delete(managedOrder.tradeId);
          continue;
        }

        const positionEntryPrice = firstNumber(matchingPosition.entryPrice, managedOrder.entryPrice);
        const currentPrice = firstNumber(matchingPosition.markPrice, managedOrder.currentTpPrice, managedOrder.initialTpPrice);
        if (positionEntryPrice > 0) managedOrder.entryPrice = positionEntryPrice;
        managedOrder.lastCheckedAt = Date.now();

        if (managedOrder.tpAmendCount >= TP_MANAGER_MAX_AMENDS) {
          managedOrder.tpManagerStatus = "skipped";
          this.note(
            managedOrder,
            "tp_skipped",
            `TP manager skipped ${managedOrder.symbol}: amend limit ${TP_MANAGER_MAX_AMENDS} reached`
          );
          this.managed.delete(managedOrder.tradeId);
          continue;
        }

        if (managedOrder.lastAmendedAt && Date.now() - managedOrder.lastAmendedAt < TP_MANAGER_COOLDOWN_MS) {
          continue;
        }

        if (!managedOrder.attachedTpAlgoId && !managedOrder.attachedTpAlgoClOrdId) {
          await this.refreshAttachedIdentifiers(managedOrder, exchange, exchangeCall);
          if (!managedOrder.attachedTpAlgoId && !managedOrder.attachedTpAlgoClOrdId) {
            this.note(
              managedOrder,
              "tp_skipped",
              `TP manager skipped ${managedOrder.symbol}: attached TP identifier unavailable`
            );
            continue;
          }
        }

        const consensusKey = `${managedOrder.symbol}:${managedOrder.source}`;
        if (!consensusCache.has(consensusKey)) {
          consensusCache.set(consensusKey, evaluateTakeProfitConsensus(config, managedOrder.symbol, macroSnapshot));
        }
        const consensus = await consensusCache.get(consensusKey)!;
        if (consensus.status === "error") {
          this.note(managedOrder, "tp_failed", `TP manager failed ${managedOrder.symbol}: ${consensus.reason}`);
          continue;
        }
        if (consensus.status === "timeframe_conflict") {
          this.note(managedOrder, "tp_skipped", `TP manager skipped ${managedOrder.symbol}: ${consensus.reason}`);
          continue;
        }
        if (consensus.status === "no_signal") {
          this.note(managedOrder, "tp_skipped", `TP manager skipped ${managedOrder.symbol}: ${consensus.reason}`);
          continue;
        }

        if (consensus.candidate.side !== managedOrder.side) {
          this.note(
            managedOrder,
            "tp_skipped",
            `TP manager skipped ${managedOrder.symbol}: latest consensus turned ${consensus.candidate.side.toUpperCase()}`
          );
          continue;
        }

        const nextTpPrice = normalizeNumber(consensus.candidate.analysis?.tp_price);
        if (!nextTpPrice || nextTpPrice <= 0) {
          this.note(managedOrder, "tp_skipped", `TP manager skipped ${managedOrder.symbol}: strategy did not provide a valid TP`);
          continue;
        }

        const favorableMove = managedOrder.side === "buy"
          ? nextTpPrice > managedOrder.currentTpPrice
          : nextTpPrice < managedOrder.currentTpPrice;
        if (!favorableMove) {
          this.note(
            managedOrder,
            "tp_skipped",
            `TP manager skipped ${managedOrder.symbol}: new TP ${nextTpPrice} is not better than current ${managedOrder.currentTpPrice}`
          );
          continue;
        }

        const minDelta = computeTakeProfitMinDelta(currentPrice, managedOrder.entryPrice, managedOrder.slPrice);
        if (Math.abs(nextTpPrice - managedOrder.currentTpPrice) < minDelta) {
          this.note(
            managedOrder,
            "tp_skipped",
            `TP manager skipped ${managedOrder.symbol}: TP delta below threshold`,
            {
              nextTpPrice,
              currentTpPrice: managedOrder.currentTpPrice,
              minDelta,
            }
          );
          continue;
        }

        try {
          await this.amendTakeProfit(managedOrder, nextTpPrice, exchange, exchangeCall);
          managedOrder.currentTpPrice = nextTpPrice;
          managedOrder.tpAmendCount += 1;
          managedOrder.lastAmendedAt = Date.now();
          managedOrder.tpManagerStatus = "active";
          managedOrder.lastTpManagerReason = `TP amended to ${nextTpPrice}`;
          updateTradeTakeProfitMetadata({
            id: managedOrder.tradeId,
            tpPrice: managedOrder.currentTpPrice,
            slPrice: managedOrder.slPrice,
            initialTpPrice: managedOrder.initialTpPrice,
            currentTpPrice: managedOrder.currentTpPrice,
            tpAmendCount: managedOrder.tpAmendCount,
            tpManagerStatus: managedOrder.tpManagerStatus,
            lastTpManagerReason: managedOrder.lastTpManagerReason,
            attachedTpAlgoId: managedOrder.attachedTpAlgoId,
            attachedTpAlgoClOrdId: managedOrder.attachedTpAlgoClOrdId,
          });
          addOrderLifecycle({
            requestId: managedOrder.requestId,
            clientOrderId: managedOrder.clientOrderId,
            orderId: managedOrder.orderId,
            symbol: managedOrder.symbol,
            side: managedOrder.side,
            status: "tp_amended",
            source: managedOrder.source,
            strategyId: managedOrder.strategyId,
            sandbox: managedOrder.sandbox,
            operator: "tp-manager",
            details: {
              currentTpPrice: managedOrder.currentTpPrice,
              initialTpPrice: managedOrder.initialTpPrice,
              tpAmendCount: managedOrder.tpAmendCount,
              timeframe: consensus.candidate.timeframe,
              strategyId: consensus.candidate.strategyId,
              confidence: consensus.candidate.analysis?.confidence,
            },
          });
          pushAutoTradingLog(`TP amended ${managedOrder.symbol} -> ${nextTpPrice} (${consensus.candidate.timeframe}/${consensus.candidate.strategyId})`);
        } catch (error: any) {
          const message = error?.message || String(error || "Unknown amend error");
          this.note(managedOrder, "tp_failed", `TP manager failed ${managedOrder.symbol}: ${message}`, {
            nextTpPrice,
            currentTpPrice: managedOrder.currentTpPrice,
          }, true);
        }
      }
    } catch (error: any) {
      const message = error?.message || String(error || "Unknown TP manager error");
      pushAutoTradingLog(`TP manager cycle failed: ${message}`);
    } finally {
      this.inFlight = false;
    }
  }
}

function nextAutoTradingDelay(scanIntervalMultiplier = 1, floorMs = AUTO_TRADING_MIN_DELAY_MS) {
  return Math.max(floorMs, Math.min(AUTO_TRADING_MAX_DELAY_MS, AUTO_TRADING_BASE_DELAY_MS * Math.max(1, scanIntervalMultiplier)));
}

async function runAutoTradingCycle(config: AutoTradingConfig, trigger: "scheduled" | "manual") {
  const startedAt = Date.now();
  const cycleId = `cycle_${startedAt}_${crypto.randomBytes(4).toString("hex")}`;
  const credentials = resolveEngineCredentials(config.sandbox);
  if (!credentials) {
    throw requestError(400, `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`, {
      error: `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`
    });
  }

  await ensureFreshMacroData();
  const { macroData, macroRiskScore, macroGate } = currentMacroSnapshot();
  const cycleDelayMs = nextAutoTradingDelay(macroGate.scanIntervalMultiplier);
  const summary: AutoTradingCycleSummary = {
    cycleId,
    trigger,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    scannedSymbols: 0,
    scannedTargets: 0,
    strategiesEvaluated: 0,
    candidates: 0,
    selected: 0,
    ordersPlaced: 0,
    shadowOrders: 0,
    macroGate: macroGate.state,
    macroScore: macroRiskScore,
    error: null,
  };

  const buildStep = (
    name: AutoTradingDecisionStage,
    status: AutoTradingDecisionStep["status"],
    reason?: string,
    metrics?: Record<string, any>
  ): AutoTradingDecisionStep => ({
    name,
    status,
    reason,
    metrics,
    at: Date.now(),
  });

  type TraceDraft = Omit<AutoTradingDecisionTrace, "id" | "createdAt" | "blockedAt" | "blockedReason">;

  const createTraceDraft = (input: Partial<TraceDraft> & Pick<TraceDraft, "symbol" | "strategyId" | "steps">): TraceDraft => ({
    cycleId,
    trigger,
    symbol: input.symbol,
    timeframe: input.timeframe || getDefaultTimeframeForSymbol(config, input.symbol),
    strategyId: input.strategyId,
    signal: String(input.signal || "HOLD").toUpperCase(),
    confidence: Number(input.confidence || 0),
    requiredConfidence: Number(input.requiredConfidence || 0),
    shadowMode: input.shadowMode ?? config.shadowMode,
    macroGate: input.macroGate || macroGate.state,
    steps: input.steps,
  });

  const finalizeTrace = (
    trace: TraceDraft,
    blockedAt: AutoTradingDecisionStage | null,
    blockedReason: string | null
  ) => pushAutoTradingTrace({
    ...trace,
    blockedAt,
    blockedReason,
  });

  const normalizedRiskState = macroGate.state === "BLOCK_NEW_RISK"
    ? updatePersistentRiskState({
        macroGate: macroGate.state,
        macroScore: macroRiskScore,
        newRiskBlocked: true,
        killSwitchActive: true,
        cooldownUntil: Date.now() + cycleDelayMs,
        reason: macroGate.reason,
      })
    : updatePersistentRiskState({
        macroGate: macroGate.state,
        macroScore: macroRiskScore,
      });

  await maintainOpenShadowOrders(config);

  if (macroGate.state === "BLOCK_NEW_RISK") {
    const message = `Macro gate blocked new risk: ${macroGate.reason}`;
    pushAutoTradingLog(`Block: ${message}`);
    addToAudit(auditStore.riskEvents, {
      event: "macro_block",
      reason: macroGate.reason,
      macroGate,
      macroScore: macroRiskScore,
      killSwitchActive: true,
      cooldownUntil: normalizedRiskState.cooldownUntil
    });
    finalizeTrace(createTraceDraft({
      symbol: "*",
      strategyId: "*",
      signal: "HOLD",
      confidence: 0,
      requiredConfidence: 0,
      macroGate: macroGate.state,
      steps: [
        buildStep("macro_gate", "fail", message, {
          reason: macroGate.reason,
          score: macroRiskScore,
          cooldownUntil: normalizedRiskState.cooldownUntil,
        }),
      ],
    }), "macro_gate", message);
    summary.skippedReason = message;
    summary.completedAt = Date.now();
    summary.durationMs = summary.completedAt - startedAt;
    return { summary, nextDelayMs: cycleDelayMs };
  }

  if (normalizedRiskState.newRiskBlocked && Number(normalizedRiskState.cooldownUntil || 0) > Date.now()) {
    const message = normalizedRiskState.lastKillSwitchReason || "Persistent risk cooldown active";
    pushAutoTradingLog(`Cooldown: ${message}`);
    finalizeTrace(createTraceDraft({
      symbol: "*",
      strategyId: "*",
      signal: "HOLD",
      confidence: 0,
      requiredConfidence: 0,
      macroGate: normalizedRiskState.macroGate,
      steps: [
        buildStep("persistent_risk", "fail", message, {
          cooldownUntil: normalizedRiskState.cooldownUntil,
          dailyPnL: normalizedRiskState.dailyPnL,
          consecutiveStopLosses: normalizedRiskState.consecutiveStopLosses,
        }),
      ],
    }), "persistent_risk", message);
    summary.skippedReason = message;
    summary.completedAt = Date.now();
    summary.durationMs = summary.completedAt - startedAt;
    return { summary, nextDelayMs: cycleDelayMs };
  }

  const [balance, positions] = await Promise.all([
    fetchPrivateBalance(credentials, config.sandbox, true),
    fetchPrivatePositions(credentials, config.sandbox, true),
  ]);
  const balanceTotal = getAccountTotalUSDT(balance);
  const activePositionCount = countActivePositions(positions);
  const maxConcurrentPositions = macroGate.state === "ALLOW_REDUCED" ? 1 : 2;
  const remainingSlots = Math.max(0, maxConcurrentPositions - activePositionCount);
  if (remainingSlots <= 0) {
    const message = `Portfolio limit reached: ${activePositionCount} active positions, max ${maxConcurrentPositions}`;
    pushAutoTradingLog(`Blocked: ${message}`);
    finalizeTrace(createTraceDraft({
      symbol: "*",
      strategyId: "*",
      signal: "HOLD",
      confidence: 0,
      requiredConfidence: 0,
      steps: [
        buildStep("portfolio_limit", "fail", message, {
          activePositionCount,
          maxConcurrentPositions,
        }),
      ],
    }), "portfolio_limit", message);
    summary.skippedReason = message;
    summary.completedAt = Date.now();
    summary.durationMs = summary.completedAt - startedAt;
    return { summary, nextDelayMs: cycleDelayMs };
  }

  const baseMarketAnalysis = createDefaultMarketAnalysis();
  baseMarketAnalysis.macroIndicators = {
    dxyCorrelation: (macroData as any).btcCorrelation ?? baseMarketAnalysis.macroIndicators.dxyCorrelation,
    usdtPremium: baseMarketAnalysis.macroIndicators.usdtPremium,
    globalLiquidity: (macroData as any).m2 ? ((macroData as any).m2 / 20000) * 100 : baseMarketAnalysis.macroIndicators.globalLiquidity,
    macroRiskScore,
    macroGate,
  };
  if ((macroData as any).dxy !== undefined) baseMarketAnalysis.onChainData.dxy = (macroData as any).dxy;
  if ((macroData as any).m2 !== undefined) baseMarketAnalysis.onChainData.m2 = (macroData as any).m2;

  const candidates: Array<{
    symbol: string;
    timeframe: string;
    strategyId: string;
    ticker: RuntimeTicker;
    orderBook: RuntimeOrderBook | null;
    analysis: any;
    requiredConfidence: number;
    sizeMultiplier: number;
    trace: TraceDraft;
  }> = [];

  pushAutoTradingLog(`开始扫描(${trigger === "manual" ? "手动" : "定时"}, ${macroGate.state})`);

  const scannedSymbolSet = new Set<string>();
  for (const profile of config.scanProfiles) {
    for (const timeframe of profile.timeframes) {
      const scanSymbol = profile.symbol;
      let marketBundle: Awaited<ReturnType<typeof fetchPublicMarketBundle>> | null = null;
      try {
        marketBundle = await fetchPublicMarketBundleWithAutoRetry(scanSymbol, timeframe, 120);
      } catch (error: any) {
        const message = error?.message || String(error);
        pushAutoTradingLog(`Market data failed for ${scanSymbol} ${timeframe}: ${message}`);
        finalizeTrace(createTraceDraft({
          symbol: scanSymbol,
          timeframe,
          strategyId: "*",
          signal: "UNKNOWN",
          confidence: 0,
          requiredConfidence: 0,
          steps: [
            buildStep("market_data", "fail", message, { timeframe }),
          ],
        }), "market_data", message);
        continue;
      }

      const scanTicker = normalizeTicker(scanSymbol, marketBundle.ticker);
      if (!scanTicker) {
        const message = `Ticker unavailable for ${scanSymbol} ${timeframe}`;
        pushAutoTradingLog(message);
        finalizeTrace(createTraceDraft({
          symbol: scanSymbol,
          timeframe,
          strategyId: "*",
          signal: "UNKNOWN",
          confidence: 0,
          requiredConfidence: 0,
          steps: [
            buildStep("market_data", "fail", message, { timeframe }),
          ],
        }), "market_data", message);
        continue;
      }

      summary.scannedTargets += 1;
      scannedSymbolSet.add(scanSymbol);
      const runtimeContext = buildMarketRuntimeContext(
        scanSymbol,
        scanTicker,
        marketBundle.funding,
        marketBundle.orderBook,
        Array.isArray(marketBundle.ohlcv) ? marketBundle.ohlcv : [],
        {
          ...baseMarketAnalysis,
          correlations: baseMarketAnalysis.correlations.map(item => ({ ...item })),
          trends: baseMarketAnalysis.trends.map(item => ({ ...item })),
        },
        timeframe
      );

      for (const strategyId of config.strategyIds) {
        summary.strategiesEvaluated += 1;
        const analysis = evaluateStrategy({
          symbol: scanSymbol,
          ticker: scanTicker,
          strategyId,
          prices: runtimeContext.prices,
          indicators: runtimeContext.marketAnalysis.realIndicators,
          market: {
            sentiment: runtimeContext.marketAnalysis.sentiment,
            volatility: runtimeContext.marketAnalysis.volatility,
            fundingRate: runtimeContext.fundingRate?.fundingRate ?? 0,
            macroRiskScore,
            macroGate,
            onChainData: runtimeContext.marketAnalysis.onChainData,
          },
          risk: {
            estimatedFeeRate: config.riskConfigSnapshot.estimatedFeeRate,
            stopLoss: config.riskConfigSnapshot.stopLoss,
            takeProfit: config.riskConfigSnapshot.takeProfit,
          },
          allowSyntheticData: false,
        });

        recordStrategySignal({
          strategyId,
          symbol: scanSymbol,
          signal: analysis.signal,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning,
          price: scanTicker.last,
          tpPrice: analysis.tp_price,
          slPrice: analysis.sl_price,
          regime: analysis.regime,
          regimeScore: analysis.regimeScore,
          macroGate: analysis.macroGate || macroGate,
          macroScore: analysis.macroGate?.score ?? macroRiskScore,
          mode: toModeLabel(config.sandbox),
          source: trigger === "manual" ? "manual-auto-scan" : "engine-auto-scan",
          raw: {
            ...analysis,
            timeframe,
          },
        });

        const requiredConfidence = config.riskConfigSnapshot.autoTradeThreshold + (analysis?.macroGate?.entryThresholdAdjustment || 0);
        const trace = createTraceDraft({
          symbol: scanSymbol,
          timeframe,
          strategyId,
          signal: analysis.signal,
          confidence: Number(analysis.confidence || 0),
          requiredConfidence,
          macroGate: analysis?.macroGate?.state || macroGate.state,
          steps: [
            buildStep("market_data", "pass", "Market data ready", {
              last: scanTicker.last,
              fundingRate: runtimeContext.fundingRate?.fundingRate ?? 0,
              hasOrderBook: Boolean(marketBundle.orderBook),
              timeframe,
            }),
          ],
        });

        if (analysis.signal !== "BUY" && analysis.signal !== "SELL") {
          const reason = `Signal rejected: ${analysis.signal}`;
          trace.steps.push(buildStep("strategy_signal", "fail", reason, {
            signal: analysis.signal,
            confidence: analysis.confidence,
            timeframe,
          }));
          finalizeTrace(trace, "strategy_signal", reason);
          continue;
        }

        trace.steps.push(buildStep("strategy_signal", "pass", `Actionable signal: ${analysis.signal}`, {
          signal: analysis.signal,
          confidence: analysis.confidence,
          timeframe,
        }));

        if (analysis.confidence < requiredConfidence) {
          const reason = `Confidence ${analysis.confidence} < ${requiredConfidence}`;
          trace.steps.push(buildStep("confidence_gate", "fail", reason, {
            confidence: analysis.confidence,
            requiredConfidence,
            threshold: config.riskConfigSnapshot.autoTradeThreshold,
            entryThresholdAdjustment: analysis?.macroGate?.entryThresholdAdjustment || 0,
            timeframe,
          }));
          finalizeTrace(trace, "confidence_gate", reason);
          continue;
        }

        trace.steps.push(buildStep("confidence_gate", "pass", "Confidence gate passed", {
          confidence: analysis.confidence,
          requiredConfidence,
          timeframe,
        }));
        trace.steps.push(buildStep("macro_gate", "pass", `Macro gate ${analysis?.macroGate?.state || macroGate.state}`, {
          state: analysis?.macroGate?.state || macroGate.state,
          score: analysis?.macroGate?.score ?? macroRiskScore,
          positionSizeMultiplier: analysis?.macroGate?.positionSizeMultiplier ?? macroGate.positionSizeMultiplier,
          timeframe,
        }));

        const sizeMultiplier = analysis.macroGate?.positionSizeMultiplier ?? macroGate.positionSizeMultiplier;
        candidates.push({
          symbol: scanSymbol,
          timeframe,
          strategyId,
          ticker: scanTicker,
          orderBook: marketBundle.orderBook,
          analysis,
          requiredConfidence,
          sizeMultiplier,
          trace,
        });
        pushAutoTradingLog(`Candidate ${strategyId} ${scanSymbol} ${timeframe} ${analysis.signal} (${analysis.confidence}% / ${requiredConfidence}%)`);
      }
    }
  }
  summary.scannedSymbols = scannedSymbolSet.size;

  summary.candidates = candidates.length;
  if (candidates.length === 0) {
    pushAutoTradingLog("本轮没有候选信号通过筛选");
    summary.completedAt = Date.now();
    summary.durationMs = summary.completedAt - startedAt;
    return { summary, nextDelayMs: cycleDelayMs };
  }

  const selected: typeof candidates = [];
  const candidatesBySymbol = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!candidatesBySymbol.has(candidate.symbol)) candidatesBySymbol.set(candidate.symbol, []);
    candidatesBySymbol.get(candidate.symbol)!.push(candidate);
  }

  const symbolWinners: typeof candidates = [];
  for (const [symbol, symbolCandidates] of candidatesBySymbol.entries()) {
    const directionSet = new Set(symbolCandidates.map((item) => String(item.analysis.signal || "").toUpperCase()));
    if (directionSet.has("BUY") && directionSet.has("SELL")) {
      const conflictDetail = symbolCandidates
        .map((item) => `${item.timeframe}=${String(item.analysis.signal || "").toUpperCase()}`)
        .join(", ");
      const reason = `${symbol} timeframe conflict: ${conflictDetail}`;
      pushAutoTradingLog(reason);
      for (const candidate of symbolCandidates) {
        candidate.trace.steps.push(buildStep("timeframe_conflict", "fail", reason, {
          symbol,
          timeframe: candidate.timeframe,
          signal: candidate.analysis.signal,
          conflictDetail,
        }));
        finalizeTrace(candidate.trace, "timeframe_conflict", reason);
      }
      continue;
    }

    const rankedBySymbol = [...symbolCandidates].sort((a, b) => {
      const scoreA = a.analysis.confidence + Math.abs(a.analysis.regimeScore || 0) * 10;
      const scoreB = b.analysis.confidence + Math.abs(b.analysis.regimeScore || 0) * 10;
      return scoreB - scoreA;
    });
    const winner = rankedBySymbol[0];
    symbolWinners.push(winner);
    for (const skippedCandidate of rankedBySymbol.slice(1)) {
      const reason = `Higher-ranked timeframe selected for ${symbol}`;
      skippedCandidate.trace.steps.push(buildStep("correlation_filter", "fail", reason, {
        selectedTimeframe: winner.timeframe,
        selectedStrategyId: winner.strategyId,
        selectedConfidence: winner.analysis.confidence,
      }));
      finalizeTrace(skippedCandidate.trace, "correlation_filter", reason);
    }
  }

  const sortedCandidates = [...symbolWinners].sort((a, b) => {
    const scoreA = a.analysis.confidence + Math.abs(a.analysis.regimeScore || 0) * 10;
    const scoreB = b.analysis.confidence + Math.abs(b.analysis.regimeScore || 0) * 10;
    return scoreB - scoreA;
  });

  for (const candidate of sortedCandidates) {
    if (selected.length >= remainingSlots) {
      const reason = `No remaining portfolio slots (${remainingSlots})`;
      candidate.trace.steps.push(buildStep("portfolio_limit", "fail", reason, {
        remainingSlots,
        activePositionCount,
      }));
      finalizeTrace(candidate.trace, "portfolio_limit", reason);
      continue;
    }

    const sameDirectionCorrelated = selected.some(item =>
      getCorrelationGroup(item.symbol) === getCorrelationGroup(candidate.symbol)
      && item.analysis.signal === candidate.analysis.signal
    );
    if (sameDirectionCorrelated) {
      const previousMultiplier = candidate.sizeMultiplier;
      candidate.sizeMultiplier *= 0.5;
      candidate.trace.steps.push(buildStep("correlation_filter", "pass", "Size reduced due to same-direction correlated exposure", {
        previousMultiplier,
        adjustedMultiplier: candidate.sizeMultiplier,
      }));
      pushAutoTradingLog(`Correlation adjustment applied to ${candidate.symbol}`);
    } else {
      candidate.trace.steps.push(buildStep("correlation_filter", "pass", "Passed correlation filter"));
    }

    candidate.trace.steps.push(buildStep("portfolio_limit", "pass", "Portfolio slot reserved", {
      remainingSlots,
      selectedCount: selected.length + 1,
    }));
    selected.push(candidate);
  }

  summary.selected = selected.length;
  if (selected.length === 0) {
    pushAutoTradingLog("所有候选信号都在执行前被过滤");
    summary.completedAt = Date.now();
    summary.durationMs = summary.completedAt - startedAt;
    return { summary, nextDelayMs: cycleDelayMs };
  }

  for (const candidate of selected) {
    const side = candidate.analysis.signal.toLowerCase() as "buy" | "sell";
    if (balanceTotal <= 0) {
      const reason = "Account balance unavailable for auto-trading";
      candidate.trace.steps.push(buildStep("account_risk_check", "fail", reason, {
        balanceTotal,
      }));
      finalizeTrace(candidate.trace, "account_risk_check", reason);
      pushAutoTradingLog(reason);
      break;
    }

    candidate.trace.steps.push(buildStep("account_risk_check", "pass", "Balance available", {
      balanceTotal,
      side,
    }));

    const sizing = calculateRiskManagedAmount({
      balanceTotal,
      currentPrice: candidate.ticker.last || 0,
      stopLossPrice: candidate.analysis.sl_price,
      riskConfig: config.riskConfigSnapshot,
      sizeMultiplier: candidate.sizeMultiplier,
    });
    const amount = Number((sizing.amount || 0).toFixed(2));
    if (!Number.isFinite(amount) || amount <= 0) {
      const reason = `Position sizing returned ${amount}`;
      candidate.trace.steps.push(buildStep("position_sizing", "fail", reason, {
        amount,
        stopDistancePct: sizing.stopDistancePct,
        sizeMultiplier: candidate.sizeMultiplier,
      }));
      finalizeTrace(candidate.trace, "position_sizing", reason);
      pushAutoTradingLog(`Position sizing blocked ${candidate.symbol}`);
      continue;
    }

    candidate.trace.steps.push(buildStep("position_sizing", "pass", "Position size computed", {
      amount,
      stopDistancePct: sizing.stopDistancePct,
      sizeMultiplier: candidate.sizeMultiplier,
    }));

    if (config.shadowMode) {
      const shadowExecution = estimateShadowExecution(side, candidate.ticker, candidate.orderBook, 0);
      const shadowResult = syncShadowPositionFromCandidate({
        symbol: candidate.symbol,
        strategyId: candidate.strategyId,
        side,
        timeframe: candidate.timeframe,
        leverage: config.riskConfigSnapshot.leverage,
        amount,
        amountType: "usdt",
        regime: candidate.analysis.regime,
        macroGate: candidate.analysis.macroGate || macroGate,
        orderBook: candidate.orderBook,
        signal: candidate.analysis,
        shadowExecution,
        ticker: candidate.ticker,
      });
      if (shadowResult.action === "opened" || shadowResult.action === "reversed") {
        summary.shadowOrders += 1;
      }
      const reason = shadowResult.action === "refreshed"
        ? "Shadow mode enabled; existing shadow position refreshed"
        : "Shadow mode enabled; live order skipped";
      candidate.trace.steps.push(buildStep("shadow_mode", "fail", reason, {
        theoreticalPrice: shadowExecution.theoreticalPrice,
        executablePrice: shadowExecution.executablePrice,
        spreadBps: shadowExecution.spreadBps,
        slippageBps: shadowExecution.slippageBps,
        shadowAction: shadowResult.action,
        realizedPnl: shadowResult.closed?.realized_pnl ?? null,
      }));
      finalizeTrace(candidate.trace, "shadow_mode", reason);
      if (shadowResult.action === "opened") {
        pushAutoTradingLog(`影子持仓已经平仓 ${candidate.symbol} ${side.toUpperCase()} ${candidate.strategyId}`);
      } else if (shadowResult.action === "reversed") {
        pushAutoTradingLog(`影子持仓已经反转 ${candidate.symbol} ${candidate.strategyId}, 盈亏: ${Number(shadowResult.closed?.realized_pnl || 0).toFixed(2)} USDT`);
      } else {
        pushAutoTradingLog(`影子持仓已经更新 ${candidate.symbol} ${candidate.strategyId}`);
      }
      continue;
    }

    candidate.trace.steps.push(buildStep("shadow_mode", "skip", "Live execution enabled"));

    try {
      const result = await submitOkxOrder({
        symbol: candidate.symbol,
        side,
        amount,
        amountType: "usdt",
        type: "market",
        leverage: config.riskConfigSnapshot.leverage,
        tpPrice: candidate.analysis.tp_price,
        slPrice: candidate.analysis.sl_price,
        sandbox: config.sandbox,
        strategyId: candidate.strategyId,
        source: "auto",
        regime: candidate.analysis.regime,
        regimeScore: candidate.analysis.regimeScore,
        macroGate: candidate.analysis.macroGate || macroGate,
        macroScore: candidate.analysis.macroGate?.score ?? macroRiskScore,
        entryReason: candidate.analysis.reasoning,
        features: {
          timeframe: candidate.timeframe,
          requiredConfidence: candidate.requiredConfidence,
          positionSizeMultiplier: candidate.sizeMultiplier,
          macroGate: candidate.analysis.macroGate || macroGate,
          regime: candidate.analysis.regime,
          regimeScore: candidate.analysis.regimeScore,
          confidence: candidate.analysis.confidence,
        },
        stopDistance: sizing.stopDistancePct,
        ruleCompliant: true,
        aiVerdict: "none",
      }, "auto-engine");
      summary.ordersPlaced += 1;
      const orderId = result?.id || result?.clientOrderId || "submitted";
      candidate.trace.steps.push(buildStep("order_submit", "pass", "Live order submitted", {
        orderId,
      }));
      finalizeTrace(candidate.trace, null, null);
      pushAutoTradingLog(`Live order submitted ${candidate.symbol} ${side.toUpperCase()} (${orderId})`);
    } catch (error: any) {
      const message = error?.message || String(error);
      candidate.trace.steps.push(buildStep("order_submit", "fail", message));
      finalizeTrace(candidate.trace, "order_submit", message);
      pushAutoTradingLog(`Live order failed ${candidate.symbol}: ${message}`);
    }
  }

  summary.completedAt = Date.now();
  summary.durationMs = summary.completedAt - startedAt;
  return { summary, nextDelayMs: cycleDelayMs };
}

class AutoTradingEngine {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopRequested = false;

  hydrate() {
    const config = sanitizeAutoTradingConfig(appStore.autoTrading.config);
    updateAutoTradingStore({
      state: "stopped",
      config,
      nextRunAt: null,
      lastError: appStore.autoTrading.lastError || null,
      engineStartedAt: null,
      recentLogs: appStore.autoTrading.recentLogs.slice(0, AUTO_TRADING_LOG_LIMIT),
      recentCycleSummaries: appStore.autoTrading.recentCycleSummaries.slice(0, AUTO_TRADING_SUMMARY_LIMIT),
      decisionTraces: appStore.autoTrading.decisionTraces.slice(0, AUTO_TRADING_TRACE_LIMIT),
    });
  }

  status() {
    const config = this.ensureStoredConfig();
    return {
      state: appStore.autoTrading.state,
      config: serializeAutoTradingConfig(config),
      inFlight: this.inFlight,
      lastRunAt: appStore.autoTrading.lastRunAt,
      nextRunAt: appStore.autoTrading.nextRunAt,
      lastError: appStore.autoTrading.lastError,
      recentCycleSummary: appStore.autoTrading.recentCycleSummaries[0] || null,
      engineStartedAt: appStore.autoTrading.engineStartedAt,
      exchangeConnectivity: getExchangeConnectivityStatus(),
    };
  }

  config() {
    return serializeAutoTradingConfig(this.ensureStoredConfig());
  }

  private ensureStoredConfig() {
    const config = sanitizeAutoTradingConfig(appStore.autoTrading.config);
    if (config && JSON.stringify(config) !== JSON.stringify(appStore.autoTrading.config)) {
      updateAutoTradingStore({ config });
    }
    return config;
  }

  logs(limit = 200) {
    return appStore.autoTrading.recentLogs.slice(0, Math.min(AUTO_TRADING_LOG_LIMIT, Math.max(1, limit)));
  }

  traces(limit = 200) {
    return appStore.autoTrading.decisionTraces.slice(0, Math.min(AUTO_TRADING_TRACE_LIMIT, Math.max(1, limit)));
  }

  cycles(limit = 50) {
    return appStore.autoTrading.recentCycleSummaries.slice(0, Math.min(AUTO_TRADING_SUMMARY_LIMIT, Math.max(1, limit)));
  }

  async updateConfig(input: Partial<AutoTradingConfig>) {
    const config = sanitizeAutoTradingConfig(input);
    if (!config) throw requestError(400, "Invalid auto-trading config", { error: "Invalid auto-trading config" });
    updateAutoTradingStore({ config });
    pushAutoTradingLog(`自动交易配置已更新 (${config.sandbox ? "DEMO" : "LIVE"}, shadow=${config.shadowMode ? "on" : "off"})`);
    return {
      config: serializeAutoTradingConfig(config),
      status: this.status(),
    };
  }

  async start(input?: Partial<AutoTradingConfig>) {
    const config = sanitizeAutoTradingConfig(
      hasMeaningfulAutoTradingConfigInput(input) ? input : appStore.autoTrading.config
    );
    if (!config) throw requestError(400, "Invalid auto-trading config", { error: "Invalid auto-trading config" });
    const credentials = resolveEngineCredentials(config.sandbox);
    if (!credentials) {
      throw requestError(400, `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`, {
        error: `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`
      });
    }
    await assertAutoTradingExchangeReady(credentials, config.sandbox);

    this.stopRequested = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    updateAutoTradingStore({
      state: "starting",
      config,
      lastError: null,
      engineStartedAt: Date.now(),
      nextRunAt: Date.now(),
    });
    pushAutoTradingLog(`自动交易引擎已启动 (${config.sandbox ? "DEMO" : "LIVE"})`);
    this.schedule(0);
    return this.status();
  }

  async stop() {
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      updateAutoTradingStore({
        state: "stopping",
        nextRunAt: null,
      });
      pushAutoTradingLog("已请求停止，当前周期完成后关闭");
      return this.status();
    }

    updateAutoTradingStore({
      state: "stopped",
      nextRunAt: null,
      engineStartedAt: appStore.autoTrading.engineStartedAt,
    });
    pushAutoTradingLog("自动交易引擎已停止");
    return this.status();
  }

  async runOnce(input?: Partial<AutoTradingConfig>) {
    const providedConfig = hasMeaningfulAutoTradingConfigInput(input) ? input : undefined;
    const config = sanitizeAutoTradingConfig(providedConfig || appStore.autoTrading.config);
    if (!config) throw requestError(400, "Auto-trading config is not initialized", { error: "Auto-trading config is not initialized" });
    if (this.inFlight) throw requestError(409, "Auto-trading cycle already in progress", { error: "Auto-trading cycle already in progress" });
    const credentials = resolveEngineCredentials(config.sandbox);
    if (!credentials) {
      throw requestError(400, `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`, {
        error: `Missing OKX credentials for ${config.sandbox ? "demo" : "live"} mode`
      });
    }
    await assertAutoTradingExchangeReady(credentials, config.sandbox);

    if (providedConfig) {
      updateAutoTradingStore({ config });
    }
    pushAutoTradingLog("已触发手动自动交易扫描");
    await this.executeCycle(config, "manual", Boolean(appStore.autoTrading.config && appStore.autoTrading.state !== "stopped"));
    return this.status();
  }

  private schedule(delayMs: number) {
    if (this.stopRequested) return;
    if (this.timer) clearTimeout(this.timer);
    const boundedDelay = Math.max(0, delayMs);
    updateAutoTradingStore({
      nextRunAt: Date.now() + boundedDelay,
      state: boundedDelay === 0 ? "starting" : appStore.autoTrading.state,
    });
    this.timer = setTimeout(() => {
      const config = sanitizeAutoTradingConfig(appStore.autoTrading.config);
      if (!config) {
        updateAutoTradingStore({ state: "stopped", nextRunAt: null });
        return;
      }
      void this.executeCycle(config, "scheduled", true);
    }, boundedDelay);
  }

  private async executeCycle(config: AutoTradingConfig, trigger: "scheduled" | "manual", keepAlive: boolean) {
    if (this.inFlight) return this.status();
    this.inFlight = true;
    updateAutoTradingStore({
      state: this.stopRequested ? "stopping" : "running",
      config,
      nextRunAt: null,
      lastError: null,
    });

    try {
      const { summary, nextDelayMs } = await runAutoTradingCycle(config, trigger);
      pushAutoTradingSummary(summary);
      if (keepAlive && !this.stopRequested) {
        updateAutoTradingStore({ state: "running" });
        this.schedule(nextDelayMs);
      } else {
        updateAutoTradingStore({
          state: "stopped",
          nextRunAt: null,
        });
      }
      return this.status();
    } catch (error: any) {
      const message = error?.message || String(error);
      pushAutoTradingLog(`Auto-trading cycle failed: ${message}`);
      const fallbackSummary: AutoTradingCycleSummary = {
        cycleId: `cycle_error_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        trigger,
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        scannedSymbols: 0,
        scannedTargets: 0,
        strategiesEvaluated: 0,
        candidates: 0,
        selected: 0,
        ordersPlaced: 0,
        shadowOrders: 0,
        skippedReason: "cycle_error",
        macroGate: appStore.riskState.macroGate,
        macroScore: appStore.riskState.macroScore,
        error: message,
      };
      pushAutoTradingSummary(fallbackSummary);
      if (keepAlive && !this.stopRequested) {
        if (isExchangeConnectivityFailure(error)) {
          const connectivity = markExchangeConnectivityFailure(error, {
            okxPrivate: false,
            proxy: getExchangeProxyStatus(),
          });
          const retryDelayMs = Math.max(0, Number(connectivity.nextRetryAt || 0) - Date.now());
          pushAutoTradingLog(`OKX connection unavailable; auto-trading will retry in ${Math.max(1, Math.round(retryDelayMs / 1000))}s.`);
          updateAutoTradingStore({
            state: "error",
            nextRunAt: connectivity.nextRetryAt,
            lastError: message,
          });
          this.schedule(retryDelayMs);
          return this.status();
        }
        updateAutoTradingStore({
          state: "error",
          lastError: message,
        });
        this.schedule(AUTO_TRADING_MIN_DELAY_MS);
      } else {
        updateAutoTradingStore({
          state: "stopped",
          nextRunAt: null,
          lastError: message,
        });
      }
      throw error;
    } finally {
      this.inFlight = false;
      if (this.stopRequested) {
        updateAutoTradingStore({
          state: "stopped",
          nextRunAt: null,
        });
        this.stopRequested = false;
      }
    }
  }
}

const autoTradingEngine = new AutoTradingEngine();
const takeProfitManager = new TakeProfitManager();

async function startServer() {
  console.log("[Server] Starting initialization...");
  await loadAuditStore();
  await loadAppStore();
  await initTradingDatabase();
  await loadCredentialStore();
  autoTradingEngine.hydrate();
  takeProfitManager.start();
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(express.json());
  // Ensure UTF-8 charset for all JSON responses (Render log viewer sometimes mangles Chinese text)
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return originalJson(body);
    };
    next();
  });
  app.use("/api", requireOperator);
  console.log("[Server] Middleware registered.");

  app.post("/api/auth/login", async (req, res) => {
    const { username = ADMIN_USERNAME, password } = req.body || {};
    const normalizedUsername = String(username || ADMIN_USERNAME).trim();
    const passwordHash = hasText(password) ? hashSecret(password) : "";

    if (normalizedUsername !== ADMIN_USERNAME || !passwordHash || !timingSafeEqualString(passwordHash, adminPasswordHash)) {
      addSecurityEvent("auth.login_failed", req, { username: normalizedUsername });
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    appStore.sessions.unshift({
      tokenHash: hashSecret(token),
      username: ADMIN_USERNAME,
      role: "admin",
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
    });
    appStore.sessions = appStore.sessions.filter(session => session.expiresAt > now).slice(0, 20);
    await persistAppStore();
    addSecurityEvent("auth.login_success", req, undefined, ADMIN_USERNAME);

    res.json({
      token,
      user: { username: ADMIN_USERNAME, role: "admin" },
      expiresAt: now + SESSION_TTL_MS,
    });
  });

  app.get("/api/auth/session", (req, res) => {
    const session = getSession(req);
    if (!session) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      user: { username: session.username, role: session.role },
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = getBearerToken(req);
    if (token) {
      const tokenHash = hashSecret(token);
      appStore.sessions = appStore.sessions.filter(session => session.tokenHash !== tokenHash);
      await persistAppStore();
    }
    addSecurityEvent("auth.logout", req, undefined, (req as any).operator?.username);
    res.json({ ok: true });
  });

  // Check which keys are configured without exposing secrets.
  app.get("/api/config/status", (req, res) => {
    const session = getSession(req);
    res.json({
      ...sanitizedCredentialStatus(),
      auth: {
        required: true,
        authenticated: !!session,
        user: session ? { username: session.username, role: session.role } : null,
      },
    });
  });

  app.post("/api/config/credentials", async (req, res) => {
    try {
      const {
        okxKey,
        okxSecret,
        okxPass,
        okxDemoKey,
        okxDemoSecret,
        okxDemoPass,
        aiUrl,
        aiKey,
        aiModel,
        aiSummaryModel,
        aiVisionModel,
      } = req.body || {};

      credentialStore.okx = mergeText(credentialStore.okx, {
        apiKey: okxKey,
        secret: okxSecret,
        password: okxPass,
      });
      credentialStore.okxDemo = mergeText(credentialStore.okxDemo, {
        apiKey: okxDemoKey,
        secret: okxDemoSecret,
        password: okxDemoPass,
      });
      credentialStore.ai = mergeText(credentialStore.ai, {
        proxyUrl: aiUrl,
        proxyKey: aiKey,
        decisionModel: aiModel,
        summaryModel: aiSummaryModel,
        visionModel: aiVisionModel,
      });

      await persistCredentialStore();
      res.json({ ok: true, status: sanitizedCredentialStatus() });
    } catch (error: any) {
      console.error("[Credentials] Save failed:", error);
      res.status(500).json({ error: error.message || "Failed to save credentials" });
    }
  });

  app.delete("/api/config/credentials", async (_req, res) => {
    try {
      credentialStore = {};
      await fsp.rm(CREDENTIALS_FILE, { force: true });
      privateExchanges.clear();
      res.json({ ok: true, status: sanitizedCredentialStatus() });
    } catch (error: any) {
      console.error("[Credentials] Clear failed:", error);
      res.status(500).json({ error: error.message || "Failed to clear credentials" });
    }
  });

  // Audit Endpoints
  app.get("/api/audit/summary", (req, res) => {
    res.json({
      version: STRATEGY_VERSION,
      counts: {
        aiSnapshots: auditStore.aiSnapshots.length,
        orderReceipts: auditStore.orderReceipts.length,
        riskEvents: auditStore.riskEvents.length,
        positionChanges: auditStore.positionChanges.length,
        orderLifecycle: appStore.orderLifecycle.length,
        securityEvents: appStore.securityEvents.length,
      }
    });
  });

  app.get("/api/audit/logs/:type", (req, res) => {
    const type = req.params.type as keyof typeof auditStore;
    if (auditStore[type]) {
      res.json(auditStore[type]);
    } else {
      res.status(404).json({ error: "Invalid audit type" });
    }
  });

  app.post("/api/audit/risk-event", (req, res) => {
    const body = req.body || {};
    addToAudit(auditStore.riskEvents, body);
    if (body.reason || body.event || body.dailyPnL !== undefined || body.macroGate) {
      updatePersistentRiskState({
        reason: body.reason,
        dailyPnL: normalizeNumber(body.dailyPnL) ?? appStore.riskState.dailyPnL,
        macroGate: body.macroGate?.state || body.macroGate || appStore.riskState.macroGate,
        macroScore: normalizeNumber(body.macroScore ?? body.macroGate?.score) ?? appStore.riskState.macroScore,
        killSwitchActive: body.killSwitchActive ?? appStore.riskState.killSwitchActive,
        cooldownUntil: normalizeNumber(body.cooldownUntil) ?? appStore.riskState.cooldownUntil,
      });
    }
    res.json({ status: "ok", riskState: appStore.riskState });
  });

  app.get("/api/security/events", (req, res) => {
    res.json(appStore.securityEvents.slice(0, 500));
  });

  app.get("/api/orders/lifecycle", (req, res) => {
    res.json(appStore.orderLifecycle.slice(0, 500));
  });

  app.get("/api/risk/state", (_req, res) => {
    normalizeRiskStateDate();
    res.json(updatePersistentRiskState({}));
  });

  app.post("/api/risk/state", (req, res) => {
    const body = req.body || {};
    const state = updatePersistentRiskState({
      dailyPnL: normalizeNumber(body.dailyPnL) ?? appStore.riskState.dailyPnL,
      // Consecutive stop-loss count is server-derived from realized PnL / fills.
      // Do not trust client-sent values here, otherwise stale tabs can poison account risk state.
      consecutiveStopLosses: appStore.riskState.consecutiveStopLosses,
      macroGate: body.macroGate?.state || body.macroGate || appStore.riskState.macroGate,
      macroScore: normalizeNumber(body.macroScore ?? body.macroGate?.score) ?? appStore.riskState.macroScore,
      newRiskBlocked: body.newRiskBlocked ?? appStore.riskState.newRiskBlocked,
      killSwitchActive: body.killSwitchActive ?? appStore.riskState.killSwitchActive,
      lastKillSwitchReason: body.lastKillSwitchReason || appStore.riskState.lastKillSwitchReason,
      cooldownUntil: normalizeNumber(body.cooldownUntil) ?? appStore.riskState.cooldownUntil,
      reason: body.reason,
    });
    res.json(state);
  });

  app.post("/api/risk/kill-switch/reset", (_req, res) => {
    const state = updatePersistentRiskState({
      killSwitchActive: false,
      newRiskBlocked: false,
      cooldownUntil: 0,
      lastKillSwitchReason: undefined,
      reason: "manual_reset",
    });
    res.json(state);
  });

  app.get("/api/auto-trading/status", (_req, res) => {
    res.json(autoTradingEngine.status());
  });

  app.get("/api/auto-trading/config", (_req, res) => {
    const config = autoTradingEngine.config();
    res.json({
      config,
      envVarValue: config ? (config.shadowMode ? 0 : config.sandbox ? 1 : 2) : null,
      status: autoTradingEngine.status(),
    });
  });

  app.put("/api/auto-trading/config", async (req, res) => {
    try {
      const payload = await autoTradingEngine.updateConfig(req.body || {});
      res.json({
        ...payload,
        envVarValue: payload.config ? (payload.config.shadowMode ? 0 : payload.config.sandbox ? 1 : 2) : null,
      });
    } catch (error: any) {
      res.status(error?.statusCode || 500).json(error?.payload || { error: error?.message || "Failed to update auto-trading config" });
    }
  });

  app.get("/api/auto-trading/logs", (req, res) => {
    const limit = Math.min(AUTO_TRADING_LOG_LIMIT, Math.max(1, Number(req.query.limit || 200)));
    res.json(autoTradingEngine.logs(limit));
  });

  app.get("/api/auto-trading/traces", (req, res) => {
    const limit = Math.min(AUTO_TRADING_TRACE_LIMIT, Math.max(1, Number(req.query.limit || 200)));
    res.json(autoTradingEngine.traces(limit));
  });

  app.get("/api/auto-trading/cycles", (req, res) => {
    const limit = Math.min(AUTO_TRADING_SUMMARY_LIMIT, Math.max(1, Number(req.query.limit || 50)));
    res.json(autoTradingEngine.cycles(limit));
  });

  app.post("/api/auto-trading/start", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0 ? req.body : undefined;
      const status = await autoTradingEngine.start(body);
      res.json(status);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json(error?.payload || { error: error?.message || "Failed to start auto-trading engine" });
    }
  });

  app.post("/api/auto-trading/stop", async (_req, res) => {
    try {
      const status = await autoTradingEngine.stop();
      res.json(status);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json(error?.payload || { error: error?.message || "Failed to stop auto-trading engine" });
    }
  });

  app.post("/api/auto-trading/run-once", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0 ? req.body : undefined;
      const status = await autoTradingEngine.runOnce(body);
      res.json(status);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json(error?.payload || { error: error?.message || "Failed to run auto-trading cycle" });
    }
  });

  app.get("/api/trades", (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
    const rows = tradingDb.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?").all(limit);
    res.json(rows);
  });

  app.post("/api/trades/record", (req, res) => {
    try {
      const record = recordTrade(req.body || {});
      res.json({ ok: true, trade: record });
    } catch (error: any) {
      console.error("[TradingDB] Failed to record trade:", error);
      res.status(500).json({ error: error.message || "Failed to record trade" });
    }
  });

  app.get("/api/strategy/signals", (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
    const rows = tradingDb.prepare("SELECT * FROM strategy_signals ORDER BY created_at DESC LIMIT ?").all(limit);
    res.json(rows);
  });

  app.post("/api/strategy/signals/record", (req, res) => {
    try {
      const record = recordStrategySignal(req.body || {});
      res.json({ ok: true, signal: record });
    } catch (error: any) {
      console.error("[TradingDB] Failed to record strategy signal:", error);
      res.status(500).json({ error: error.message || "Failed to record strategy signal" });
    }
  });

  app.get("/api/shadow/orders", (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
    const status = String(req.query.status || "all").toLowerCase();
    const rows = listShadowOrders(status === "open" || status === "closed" ? status : "all", limit);
    res.json(rows);
  });

  app.get("/api/shadow/summary", (_req, res) => {
    res.json(buildShadowSummary());
  });

  app.get("/api/portfolio/returns", async (req, res) => {
    try {
      const mode = normalizePortfolioReturnMode(req.query.mode);
      const range = normalizePortfolioReturnRange(req.query.range);
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
      const requestKey = createPortfolioReturnRequestKey(mode, range, limit);
      const trades = mode === "shadow"
        ? []
        : tradingDb.prepare(`
            SELECT *
            FROM trades
            WHERE (source = 'auto' OR strategy_id IS NOT NULL)
              AND mode = ?
            ORDER BY created_at DESC
            LIMIT 2000
          `).all(mode === "demo" ? "okx-demo" : "okx-live") as any[];
      const shadowOrders = mode === "shadow"
        ? tradingDb.prepare("SELECT * FROM shadow_orders ORDER BY created_at DESC LIMIT 2000").all() as any[]
        : [];

      if (mode !== "shadow") {
        const now = Date.now();
        const freshCached = getFreshPortfolioReturnCachedResponse(requestKey, now);
        if (freshCached) {
          return res.json(freshCached);
        }

        try {
          const exchangeReturns = await withTimeout(
            fetchPortfolioExchangeReturns(mode, limit),
            PORTFOLIO_RETURNS_TIMEOUT_MS,
            `OKX ${mode === "demo" ? "模拟盘" : "实盘"}账单读取超时`
          );
          const fetchedAt = Date.now();
          const analytics = buildPortfolioReturnAnalytics({
            mode,
            range,
            limit,
            trades,
            bills: exchangeReturns.bills,
            shadowOrders,
            capitalBase: exchangeReturns.capitalBase,
            requestKey,
            sourceStatus: {
              state: "fresh",
              fetchedAt,
            },
            generatedAt: fetchedAt,
          });
          portfolioReturnCache.set(requestKey, { analytics, storedAt: fetchedAt });
          return res.json(analytics);
        } catch (sourceError: any) {
          const staleCached = getStalePortfolioReturnCachedResponse(requestKey, sourceError, Date.now());
          if (staleCached) {
            console.warn("[PortfolioReturns] Returning stale cached analytics:", formatPortfolioReturnSourceError(sourceError));
            return res.json(staleCached);
          }
          throw sourceError;
        }
      }

      res.json(buildPortfolioReturnAnalytics({
        mode,
        range,
        limit,
        trades,
        bills: undefined as PortfolioReturnBillInput[] | undefined,
        shadowOrders,
        capitalBase: null,
        requestKey,
        sourceStatus: {
          state: "fresh",
          fetchedAt: Date.now(),
        },
      }));
    } catch (error: any) {
      console.error("[PortfolioReturns] Failed to build return analytics:", error);
      res.status(error?.status || 503).json({ error: error?.message || "Failed to build portfolio returns" });
    }
  });

  app.post("/api/shadow/orders/record", (req, res) => {
    try {
      const record = recordShadowOrder(req.body || {});
      res.json({ ok: true, shadowOrder: record });
    } catch (error: any) {
      console.error("[TradingDB] Failed to record shadow order:", error);
      res.status(500).json({ error: error.message || "Failed to record shadow order" });
    }
  });

  app.get("/api/research/weekly", (_req, res) => {
    const trades = tradingDb.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT 2000").all() as any[];
    const shadowOrders = tradingDb.prepare("SELECT * FROM shadow_orders ORDER BY created_at DESC LIMIT 2000").all() as any[];
    const closedTrades = trades.filter(row => row.realized_pnl !== null && row.realized_pnl !== undefined);
    const groupStats = (keyFn: (row: any) => string) => {
      const groups = new Map<string, any[]>();
      for (const row of closedTrades) {
        const key = keyFn(row) || "UNKNOWN";
        groups.set(key, [...(groups.get(key) || []), row]);
      }
      return Object.fromEntries(Array.from(groups.entries()).map(([key, rows]) => {
        const pnls = rows.map(row => Number(row.realized_pnl || 0));
        const wins = pnls.filter(pnl => pnl > 0);
        const losses = pnls.filter(pnl => pnl < 0);
        const grossProfit = wins.reduce((acc, value) => acc + value, 0);
        const grossLoss = Math.abs(losses.reduce((acc, value) => acc + value, 0));
        return [key, {
          trades: rows.length,
          pnl: pnls.reduce((acc, value) => acc + value, 0),
          winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
          profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit,
          expectancy: rows.length ? pnls.reduce((acc, value) => acc + value, 0) / rows.length : 0,
        }];
      }));
    };

    const shadowSlippage = shadowOrders.map(row => {
      const theoretical = Number(row.theoretical_price || 0);
      const executable = Number(row.executable_price || 0);
      const side = String(row.side || "").toUpperCase();
      if (theoretical <= 0 || executable <= 0) return 0;
      const signed = side === "BUY" ? executable - theoretical : theoretical - executable;
      return (signed / theoretical) * 10000;
    }).filter(Number.isFinite);

    res.json({
      generatedAt: Date.now(),
      totals: {
        trades: closedTrades.length,
        shadowOrders: shadowOrders.length,
        shadowAvgSlippageBps: shadowSlippage.length ? shadowSlippage.reduce((acc, value) => acc + value, 0) / shadowSlippage.length : 0,
        shadowWorstSlippageBps: shadowSlippage.length ? Math.max(...shadowSlippage) : 0,
      },
      byRegime: groupStats(row => row.regime),
      bySymbol: groupStats(row => row.symbol),
      byMacroGate: groupStats(row => row.macro_gate),
      byStopDistance: groupStats(row => {
        const distance = Number(row.stop_distance || 0);
        if (distance <= 0) return "UNKNOWN";
        if (distance < 0.01) return "<1%";
        if (distance < 0.02) return "1-2%";
        if (distance < 0.04) return "2-4%";
        return ">4%";
      }),
      byEntryReason: groupStats(row => String(row.entry_reason || "UNKNOWN").slice(0, 80)),
      aiVeto: groupStats(row => row.ai_verdict || "none"),
      recentShadowOrders: shadowOrders.slice(0, 50),
    });
  });

  app.get("/api/macro", async (_req, res) => {
    try {
      const macro = await ensureFreshMacroData();
      res.json(macro || buildFallbackMacroData());
    } catch (error: any) {
      console.error("[Macro API Error]", error?.message || error);
      res.json(buildFallbackMacroData());
    }
  });

  // API Routes
  app.post("/api/okx/balance", async (req, res) => {
    const { sandbox = false } = req.body;
    
    const isSandbox = String(sandbox) === 'true' || sandbox === true;
    const credentials = resolveOkxCredentials(req.body, isSandbox);

    console.log(`[OKX Balance Request] Mode: ${isSandbox ? 'DEMO' : 'REAL'}`);
    console.log(`- API Key: ${credentials?.apiKey ? credentials.apiKey.substring(0, 5) + '...' : 'MISSING'}`);

    if (!credentials) {
      return res.status(400).json({ error: "Missing OKX credentials" });
    }

    try {
       const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, isSandbox);
       await prepareExchange(exchange);
       const balance = normalizeOkxBalance(await runWithExchangeProxyFallback(exchange, () => exchange.fetchBalance()));
       
       // Ensure we have a consistent structure for the frontend
       // OKX V5 balance is already well-mapped by CCXT, but we can log details
       if (balance.info && balance.info.data && balance.info.data[0]) {
         const details = balance.info.data[0].details || [];
         console.log(`[OKX Balance] Details count: ${details.length}`);
       }
       
       res.json(balance);
     } catch (error: any) {
      const errMsg = error?.message || String(error || "Unknown Error");
      console.error(`[OKX Balance Error] Mode: ${isSandbox ? 'DEMO' : 'REAL'}`, errMsg);
      if (error.stack) console.error('[OKX Balance Error Stack]', error.stack);
      const isEnvError = errMsg.includes('50101') || errMsg.includes('APIKey does not match');
      const hint = isEnvError ? " (API Key 可能配置错误，请检查 API Key 是否正确或是否有足够权限)" : "";
      res.status(500).json({ error: `okx ${errMsg}${hint}` });
    }
  });

  app.get("/api/okx/ticker/:symbol", async (req, res) => {
    try {
      const symbolParam = req.params.symbol || "BTC-USDT";
      const instId = toOkxSwapInstId(symbolParam);
      const ticker = await cachedPublicMarket(`ticker:${instId}`, 3000, async () => {
        const [raw] = await okxPublicGet("/api/v5/market/ticker", { instId });
        const last = Number(raw?.last || 0);
        const open = Number(raw?.open24h || last);
        return {
          symbol: toCcxtLikeSwapSymbol(instId),
          timestamp: Number(raw?.ts || Date.now()),
          datetime: new Date(Number(raw?.ts || Date.now())).toISOString(),
          high: Number(raw?.high24h || last),
          low: Number(raw?.low24h || last),
          bid: Number(raw?.bidPx || 0),
          bidVolume: Number(raw?.bidSz || 0),
          ask: Number(raw?.askPx || 0),
          askVolume: Number(raw?.askSz || 0),
          open,
          close: last,
          last,
          change: last - open,
          percentage: open ? ((last - open) / open) * 100 : 0,
          baseVolume: Number(raw?.vol24h || 0),
          volume: Number(raw?.vol24h || 0),
          info: raw
        };
      });
      res.json(ticker);
    } catch (error: any) {
      console.error('[Ticker Error]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/okx/orderbook/:symbol", async (req, res) => {
    try {
      const symbolParam = req.params.symbol || "BTC-USDT";
      const instId = toOkxSwapInstId(symbolParam);
      const orderbook = await cachedPublicMarket(`orderbook:${instId}`, 3000, async () => {
        const [raw] = await okxPublicGet("/api/v5/market/books", { instId, sz: 20 });
        return {
          symbol: toCcxtLikeSwapSymbol(instId),
          timestamp: Number(raw?.ts || Date.now()),
          datetime: new Date(Number(raw?.ts || Date.now())).toISOString(),
          bids: (raw?.bids || []).map((row: string[]) => [Number(row[0]), Number(row[1])]),
          asks: (raw?.asks || []).map((row: string[]) => [Number(row[0]), Number(row[1])]),
          info: raw
        };
      });
      res.json(orderbook);
    } catch (error: any) {
      console.error('[Orderbook Error]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/okx/tickers", async (req, res) => {
    try {
      const coreInstIds = new Set(["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "DOGE-USDT-SWAP"]);
      const tickers = await cachedPublicMarket("tickers:core", 10000, async () => {
        const rows = await okxPublicGet("/api/v5/market/tickers", { instType: "SWAP" });
        return Object.fromEntries(rows
          .filter((raw: any) => coreInstIds.has(raw.instId))
          .map((raw: any) => {
            const last = Number(raw.last || 0);
            const open = Number(raw.open24h || last);
            return [toCcxtLikeSwapSymbol(raw.instId), {
              symbol: toCcxtLikeSwapSymbol(raw.instId),
              timestamp: Number(raw.ts || Date.now()),
              datetime: new Date(Number(raw.ts || Date.now())).toISOString(),
              high: Number(raw.high24h || last),
              low: Number(raw.low24h || last),
              bid: Number(raw.bidPx || 0),
              ask: Number(raw.askPx || 0),
              open,
              close: last,
              last,
              percentage: open ? ((last - open) / open) * 100 : 0,
              baseVolume: Number(raw.vol24h || 0),
              info: raw
            }];
          }));
      });
      res.json(tickers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/okx/ohlcv/:symbol", async (req, res) => {
    try {
      const symbolParam = req.params.symbol || "BTC-USDT";
      const instId = toOkxSwapInstId(symbolParam);
      const timeframe = (req.query.t as string) || "1h";
      const limit = Math.min(300, Math.max(24, Number(req.query.limit || 120)));
      const ohlcv = await cachedPublicMarket(`ohlcv:${instId}:${timeframe}:${limit}`, 60000, async () => {
        const rows = await okxPublicGet("/api/v5/market/candles", { instId, bar: okxBar(timeframe), limit });
        return rows
          .map((row: string[]) => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])])
          .sort((a: number[], b: number[]) => a[0] - b[0]);
      });
      res.json(ohlcv);
    } catch (error: any) {
      console.error('[OHLCV Error]', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/okx/funding/:symbol", async (req, res) => {
    try {
      const symbolParam = req.params.symbol || "BTC-USDT";
      const instId = toOkxSwapInstId(symbolParam);
      const funding = await cachedPublicMarket(`funding:${instId}`, 60000, async () => {
        const [raw] = await okxPublicGet("/api/v5/public/funding-rate", { instId });
        return {
          symbol: toCcxtLikeSwapSymbol(instId),
          fundingRate: Number(raw?.fundingRate || 0),
          nextFundingRate: Number(raw?.nextFundingRate || 0),
          fundingTimestamp: Number(raw?.fundingTime || 0),
          nextFundingTime: Number(raw?.nextFundingTime || 0),
          timestamp: Date.now(),
          info: raw
        };
      });
      res.json(funding);
    } catch (error: any) {
      const finalErrMsg = error?.message || "Funding rate fetch failed";
      console.error('[Funding Error]', finalErrMsg);
      res.status(500).json({ error: finalErrMsg });
    }
  });

  app.post("/api/backtest", async (req, res) => {
    const {
      symbol,
      timeframe = "1h",
      period = 500,
      strategy = "trend-breakout",
      stopLoss = 2,
      takeProfit = 6,
      estimatedFeeRate = 0.05,
      initialEquity = 10000,
      riskPerTradePct = 0.5,
    } = req.body;
    try {
      const symbolParam = symbol || "BTC-USDT";
      const ccxtSymbol = toCcxtSymbol(symbolParam);
      const limit = Math.min(1000, Math.max(60, Number(period || 500)));
      const ohlcv = await fetchBacktestOhlcv(symbolParam, timeframe, limit);
      if (!Array.isArray(ohlcv) || ohlcv.length < 60) {
        return res.status(400).json({ error: "Not enough OHLCV data for backtest" });
      }
      res.json(runBacktestOnOhlcv(ohlcv, {
        symbol: ccxtSymbol,
        strategy,
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        estimatedFeeRate: Number(estimatedFeeRate),
        timeframe,
        fundingRatePer8h: Number(req.body?.fundingRatePer8h || 0),
        initialEquity: normalizeInitialEquity(initialEquity),
        riskPerTradePct: normalizeRiskPerTradePct(riskPerTradePct),
        trendRegimeThreshold: 0.25,
        enableHigherTimeframeTrendFilter: true,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Walk-forward backtest — async processing to avoid Render proxy timeout (~100 s).
  // POST returns a jobId immediately; the client polls GET /api/backtest/walk-forward/:jobId.

  async function executeWalkForwardBacktest(job: BacktestJob, params: {
    symbols: string[];
    strategyIds: string[];
    timeframe: string;
    fetchLimit: number;
    normalizedTrainDays: number;
    normalizedValidationDays: number;
    normalizedStepDays: number;
    normalizedFeeRate: number;
    normalizedInitialEquity: number;
    normalizedMinTrainTrades: number;
    normalizedRiskPerTradePct: number;
    baseStopLoss: number;
    baseTakeProfit: number;
    requestedTrainBars: number;
    requestedValidationBars: number;
    fundingRatePer8h: number;
  }) {
    const {
      symbols: targetSymbols,
      strategyIds: targetStrategies,
      timeframe,
      fetchLimit,
      normalizedTrainDays,
      normalizedValidationDays,
      normalizedStepDays,
      normalizedFeeRate,
      normalizedInitialEquity,
      normalizedMinTrainTrades,
      normalizedRiskPerTradePct,
      baseStopLoss,
      baseTakeProfit,
      requestedTrainBars,
      requestedValidationBars,
      fundingRatePer8h,
    } = params;

    try {
      const parameterGrid = [
        { stopLoss: Number((baseStopLoss * 0.75).toFixed(4)), takeProfit: Number((baseTakeProfit * 0.67).toFixed(4)) },
        { stopLoss: baseStopLoss, takeProfit: baseTakeProfit },
        { stopLoss: Number((baseStopLoss * 1.25).toFixed(4)), takeProfit: Number((baseTakeProfit * 1.33).toFixed(4)) },
      ];
      const factorAudit = buildStrictFactorAudit();

      const allRounds: any[] = [];
      const bySymbol: Record<string, any> = {};

      for (const targetSymbol of targetSymbols) {
        const ccxtSymbol = toCcxtSymbol(targetSymbol);
        const ohlcv = await fetchBacktestOhlcv(targetSymbol, timeframe, fetchLimit);
        if (!Array.isArray(ohlcv) || ohlcv.length < 120) {
          bySymbol[ccxtSymbol] = {
            error: "Not enough OHLCV data for walk-forward",
            availableBars: Array.isArray(ohlcv) ? ohlcv.length : 0,
            requiredBars: requestedTrainBars + requestedValidationBars,
          };
          continue;
        }

        const windowPlan = createWalkForwardWindows(ohlcv, {
          timeframe,
          trainDays: normalizedTrainDays,
          validationDays: normalizedValidationDays,
          stepDays: normalizedStepDays,
          warmupBars: 80,
        });

        if (!windowPlan.windows.length) {
          bySymbol[ccxtSymbol] = {
            error: "Not enough OHLCV data for requested train/validation windows",
            availableBars: ohlcv.length,
            requiredBars: windowPlan.trainBars + windowPlan.validationBars,
            trainBars: windowPlan.trainBars,
            validationBars: windowPlan.validationBars,
          };
          continue;
        }

        bySymbol[ccxtSymbol] = {
          availableBars: ohlcv.length,
          trainBars: windowPlan.trainBars,
          validationBars: windowPlan.validationBars,
          stepBars: windowPlan.stepBars,
          byStrategy: {},
        };

        for (const strategyId of targetStrategies) {
          const rounds: any[] = [];
          for (const window of windowPlan.windows) {
            const trainSlice = ohlcv.slice(window.trainStart, window.trainEnd + 1);
            const { validationWarmup, tradeStartTime } = buildValidationSlice(ohlcv, window);

            const trainResults = parameterGrid.map((pg) => ({
              params: pg,
              result: runBacktestOnOhlcv(trainSlice, {
                symbol: ccxtSymbol,
                strategy: strategyId,
                stopLoss: pg.stopLoss,
                takeProfit: pg.takeProfit,
                estimatedFeeRate: normalizedFeeRate,
                timeframe,
                fundingRatePer8h,
                initialEquity: normalizedInitialEquity,
                riskPerTradePct: normalizedRiskPerTradePct,
                trendRegimeThreshold: 0.25,
                enableHigherTimeframeTrendFilter: true,
              }),
            }));
            const trainResultsWithStability = trainResults.map((item) => {
              const perturbations = [0.9, 1.1].flatMap((multiplier) => [
                { stopLoss: item.params.stopLoss * multiplier, takeProfit: item.params.takeProfit },
                { stopLoss: item.params.stopLoss, takeProfit: item.params.takeProfit * multiplier },
              ]).map((pg) => runBacktestOnOhlcv(trainSlice, {
                symbol: ccxtSymbol,
                strategy: strategyId,
                stopLoss: pg.stopLoss,
                takeProfit: pg.takeProfit,
                estimatedFeeRate: normalizedFeeRate,
                timeframe,
                fundingRatePer8h,
                initialEquity: normalizedInitialEquity,
                riskPerTradePct: normalizedRiskPerTradePct,
                trendRegimeThreshold: 0.25,
                enableHigherTimeframeTrendFilter: true,
              }));
              const score = calculateRobustSelectionScore(item.result, perturbations);
              const worstPerturbReturn = Math.min(...perturbations.map((r) => r.totalReturn));
              const trainTrades = Number(item.result.totalTrades || item.result.trades || 0);
              const insufficientTrades = trainTrades < normalizedMinTrainTrades;
              const failsRiskFloor = item.result.maxDrawdown > 25 || worstPerturbReturn < -8;
              return {
                ...item,
                trainPerturbations: perturbations,
                selectionScore: score,
                trainTrades,
                insufficientTrades,
                failsRiskFloor,
                selectedParamsRejectedReason: insufficientTrades
                  ? `train trades ${trainTrades} < min ${normalizedMinTrainTrades}`
                  : failsRiskFloor
                    ? "training risk floor failed"
                    : "",
                failsHardFloor: insufficientTrades || failsRiskFloor,
              };
            });
            const selected = trainResultsWithStability.sort((a, b) => {
              if (a.failsHardFloor !== b.failsHardFloor) return a.failsHardFloor ? 1 : -1;
              return b.selectionScore - a.selectionScore;
            })[0];

            const validation = runBacktestOnOhlcv(validationWarmup, {
              symbol: ccxtSymbol,
              strategy: strategyId,
              stopLoss: selected.params.stopLoss,
              takeProfit: selected.params.takeProfit,
              estimatedFeeRate: normalizedFeeRate,
              timeframe,
              fundingRatePer8h,
              initialEquity: normalizedInitialEquity,
              riskPerTradePct: normalizedRiskPerTradePct,
              trendRegimeThreshold: 0.25,
              enableHigherTimeframeTrendFilter: true,
              tradeStartTime,
            });

            const perturbations = [0.8, 1.2].flatMap((multiplier) => [
              { stopLoss: selected.params.stopLoss * multiplier, takeProfit: selected.params.takeProfit },
              { stopLoss: selected.params.stopLoss, takeProfit: selected.params.takeProfit * multiplier },
            ]).map((pg) => runBacktestOnOhlcv(validationWarmup, {
              symbol: ccxtSymbol,
              strategy: strategyId,
              stopLoss: pg.stopLoss,
              takeProfit: pg.takeProfit,
              estimatedFeeRate: normalizedFeeRate,
              timeframe,
              fundingRatePer8h,
              initialEquity: normalizedInitialEquity,
              riskPerTradePct: normalizedRiskPerTradePct,
              trendRegimeThreshold: 0.25,
              enableHigherTimeframeTrendFilter: true,
              tradeStartTime,
            }));
            const perturbReturns = perturbations.map((r) => Number(r.totalReturn || 0));
            const worstPerturbReturn = Math.min(...perturbReturns);
            const validationTrades = Number(validation.totalTrades || validation.trades || 0);
            const fragile = worstPerturbReturn < validation.totalReturn - Math.max(5, Math.abs(validation.totalReturn) * 0.5);
            const validationStatus = classifyValidationStatus({
              trainTrades: selected.trainTrades,
              validationTrades,
              minTrainTrades: normalizedMinTrainTrades,
              fragile,
            });
            const insufficientReason = validationStatus === "insufficient_trades"
              ? selected.selectedParamsRejectedReason
              : validationStatus === "no_validation_trades"
                ? "validation produced 0 trades"
                : "";
            const diagnostics = {
              ...(validation.diagnostics || {}),
              trainTrades: selected.trainTrades,
              validationTrades,
            };

            rounds.push({
              strategy: strategyId,
              symbol: ccxtSymbol,
              trainStart: window.trainStartTime,
              trainEnd: window.trainEndTime,
              validationStart: window.validationStartTime,
              validationEnd: window.validationEndTime,
              validationTradeStart: tradeStartTime,
              warmupStart: Number(ohlcv[window.warmupStart]?.[0] || window.validationStartTime),
              selectedParams: selected.params,
              train: {
                totalReturn: selected.result.totalReturn,
                maxDrawdown: selected.result.maxDrawdown,
                profitFactor: selected.result.profitFactor,
                winRate: selected.result.winRate,
                expectancy: selected.result.expectancy,
                totalTrades: selected.result.totalTrades,
                selectionScore: selected.selectionScore,
                failsHardFloor: selected.failsHardFloor,
                insufficientTrades: selected.insufficientTrades,
                selectedParamsRejectedReason: selected.selectedParamsRejectedReason,
              },
              validation,
              validationStatus,
              insufficientReason,
              selectedParamsRejectedReason: selected.selectedParamsRejectedReason,
              diagnostics,
              perturbation: {
                medianReturn: median(perturbReturns),
                worstReturn: worstPerturbReturn,
                fragile,
              },
              dataMode: "strict_price_only",
            });
          }

          bySymbol[ccxtSymbol].byStrategy[strategyId] = {
            rounds,
            summary: summarizeWalkForwardRounds(rounds),
          };
          allRounds.push(...rounds);
        }
      }

      if (!allRounds.length) {
        job.status = "done";
        job.result = {
          error: "Not enough OHLCV data for requested walk-forward windows",
          walkForward: true,
          initialEquity: normalizedInitialEquity,
          timeframe,
          config: {
            trainDays: normalizedTrainDays,
            validationDays: normalizedValidationDays,
            stepDays: normalizedStepDays,
            requestedTrainBars,
            requestedValidationBars,
            fetchLimit,
            minTrainTrades: normalizedMinTrainTrades,
            riskPerTradePct: normalizedRiskPerTradePct,
          },
          strategies: targetStrategies,
          symbols: targetSymbols,
          bySymbol,
          factorAudit,
        };
        return;
      }

      job.status = "done";
      job.result = {
        walkForward: true,
        dataMode: "strict_price_only",
        initialEquity: normalizedInitialEquity,
        timeframe,
        config: {
          trainDays: normalizedTrainDays,
          validationDays: normalizedValidationDays,
          stepDays: normalizedStepDays,
          period: fetchLimit,
          estimatedFeeRate: normalizedFeeRate,
          minTrainTrades: normalizedMinTrainTrades,
          riskPerTradePct: normalizedRiskPerTradePct,
          parameterGrid,
          requestedTrainBars,
          requestedValidationBars,
        },
        strategies: targetStrategies,
        symbols: targetSymbols.map((s) => toCcxtSymbol(s)),
        rounds: allRounds,
        byStrategy: groupWalkForwardRounds(allRounds),
        bySymbol,
        summary: summarizeWalkForwardRounds(allRounds),
        factorAudit,
        timeConsistency: {
          training: "Train windows only use older OHLCV bars.",
          validation: "Validation windows are strictly later than their training windows; no random split is used.",
          warmup: "Validation may include pre-validation warmup bars for indicators, but tradeStartTime blocks trades before validationStart.",
          signalExecution: "Signals use bar t-1 close and earlier history, then execute on bar t open.",
          nonPriceFactors: "Macro, on-chain, and news factors are disabled until point-in-time timestamps are available.",
        },
      };
    } catch (error: any) {
      job.status = "error";
      job.error = error?.message || String(error || "Unknown backtest error");
    }
  }

  app.post("/api/backtest/walk-forward", (req, res) => {
    const {
      symbol,
      symbols,
      timeframe = "1h",
      strategy = "trend-breakout",
      strategyIds,
      trainDays = 180,
      validationDays = 30,
      stepDays = 30,
      period = 6000,
      estimatedFeeRate = 0.05,
      stopLoss = 2,
      takeProfit = 6,
      initialEquity = 10000,
      minTrainTrades = 5,
      riskPerTradePct = 0.5,
    } = req.body || {};

    const targetSymbols = normalizeBacktestSymbols(symbols || symbol, "BTC-USDT", 3);
    const targetStrategies = normalizeStrategyIds(strategyIds || strategy);
    const normalizedInitialEquity = normalizeInitialEquity(initialEquity);
    const normalizedTrainDays = normalizePositiveNumber(trainDays, 180, 1, 3650);
    const normalizedValidationDays = normalizePositiveNumber(validationDays, 30, 1, 3650);
    const normalizedStepDays = normalizePositiveNumber(stepDays, 30, 1, 3650);
    const normalizedFeeRate = normalizePositiveNumber(estimatedFeeRate, 0.05, 0, 5);
    const baseStopLoss = normalizePositiveNumber(stopLoss, 2, 0.1, 80);
    const baseTakeProfit = normalizePositiveNumber(takeProfit, 6, 0.1, 200);
    const normalizedMinTrainTrades = normalizeMinTrainTrades(minTrainTrades);
    const normalizedRiskPerTradePct = normalizeRiskPerTradePct(riskPerTradePct);
    const fundingRatePer8h = Number(req.body?.fundingRatePer8h || 0);
    const barsPerDay = timeframeBarsPerDay(timeframe);
    const requestedTrainBars = Math.max(60, Math.round(normalizedTrainDays * barsPerDay));
    const requestedValidationBars = Math.max(30, Math.round(normalizedValidationDays * barsPerDay));
    const requestedPeriod = normalizePositiveNumber(period, 6000, 120, 10000);
    const fetchLimit = Math.min(10000, Math.max(requestedPeriod, requestedTrainBars + requestedValidationBars + 80));

    const job = createBacktestJob();

    // Fire-and-forget: run backtest in background
    executeWalkForwardBacktest(job, {
      symbols: targetSymbols,
      strategyIds: targetStrategies,
      timeframe,
      fetchLimit,
      normalizedTrainDays,
      normalizedValidationDays,
      normalizedStepDays,
      normalizedFeeRate,
      normalizedInitialEquity,
      normalizedMinTrainTrades,
      normalizedRiskPerTradePct,
      baseStopLoss,
      baseTakeProfit,
      requestedTrainBars,
      requestedValidationBars,
      fundingRatePer8h,
    });

    res.status(202).json({ jobId: job.id, status: "processing" });
  });

  app.get("/api/backtest/walk-forward/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = backtestJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found or expired" });
    }
    if (job.status === "done") {
      return res.json({ status: "done", result: job.result });
    }
    if (job.status === "error") {
      return res.json({ status: "error", error: job.error });
    }
    res.json({ status: "processing" });
  });

  app.post("/api/ai/analyze", async (req, res) => {
    const { prompt, task = "decision" } = req.body;
    const { endpoint, apiKey, model } = getZhipuConfig(task === "summary" ? "summary" : task === "vision" ? "vision" : "decision", req.body);

    if (!endpoint || !apiKey) {
      return res.status(400).json({ error: "Missing Zhipu AI configuration" });
    }

    try {
      const body: any = {
        model,
        messages: [
          {
            role: "system",
            content: task === "summary"
              ? "You are a market summary assistant. Return valid JSON only and keep the output concise and machine-readable."
              : `You are the Core Decision Engine of the CryptoQuant AI Trading Harness.
                 You must output valid JSON only, respect the supplied risk constraints, and cite quantitative evidence.`
          },
          { role: "user", content: prompt }
        ],
      };

      if (String(model).startsWith("glm-")) {
        body.thinking = { type: "enabled" };
      }

      const response = await axios.post(endpoint, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
      const content = response.data.choices?.[0]?.message?.content || "";

      let parsed = null;
      if (task !== "summary") {
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        } catch (e) {
          console.warn("Failed to parse AI content as JSON:", e.message);
        }
      }

      // Audit Snapshot
      addToAudit(auditStore.aiSnapshots, {
        input: prompt,
        output: parsed || content,
        rawResponse: { provider: "zhipu", model, response: response.data },
        strategyVersion: STRATEGY_VERSION
      });

      res.json(response.data);
    } catch (error: any) {
      const errorData = error.response?.data || error.message;
      console.error("Zhipu AI Error:", JSON.stringify(errorData));
      res.status(500).json({ error: errorData });
    }
  });

  app.post("/api/okx/positions", async (req, res) => {
    const { sandbox = false } = req.body;
    const isSandbox = String(sandbox) === 'true' || sandbox === true;
    const credentials = resolveOkxCredentials(req.body, isSandbox);

    if (!credentials) {
      return res.status(400).json({ error: "Missing OKX credentials" });
    }

    try {
      const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, isSandbox);
      await prepareExchange(exchange);
      console.log(`[OKX Positions Request] Mode: ${isSandbox ? 'DEMO' : 'REAL'}`);
      
      // For OKX, we might want to fetch positions for swap specifically if needed
      const positions = await runWithExchangeProxyFallback<any[]>(exchange, () => exchange.fetchPositions(undefined, { instType: "SWAP" }));
      
      const activePositions = positions
        .map(normalizeOkxPosition)
        .filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      
      console.log(`[OKX Positions] Found ${activePositions.length} active positions`);
      res.json(activePositions);
    } catch (error: any) {
      const errMsg = error?.message || String(error || "Unknown Error");
      console.error(`[OKX Positions Error] Mode: ${isSandbox ? 'DEMO' : 'REAL'}`, errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  app.post("/api/okx/history", async (req, res) => {
    const { symbol, sandbox = false } = req.body;
    const isSandbox = String(sandbox) === 'true' || sandbox === true;
    const credentials = resolveOkxCredentials(req.body, isSandbox);

    if (!credentials) {
      return res.status(400).json({ error: "Missing OKX credentials" });
    }

    try {
      const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, isSandbox);
      await prepareExchange(exchange);
      const targetSymbol = symbol || "BTC/USDT";
      const exchangeCall = <T,>(fn: () => Promise<T>) => runWithExchangeProxyFallback(exchange, fn);
      await exchangeCall(() => exchange.loadMarkets());
      const resolvedMarket = await resolveOkxSwapMarket(targetSymbol, exchange);
      console.log(
        `[OKX History Request] Symbol: ${targetSymbol}, Resolved: ${resolvedMarket.instId}, Mode: ${isSandbox ? 'DEMO' : 'REAL'}`
      );
      
      try {
        const instId = resolvedMarket.instId;
        const instType = "SWAP";

        const [openOrdersResponse, historyOrdersResponse, archivedOrdersResponse] = await Promise.all([
          retry(() => exchangeCall(() => (exchange as any).privateGetTradeOrdersPending({ instType, instId, limit: "100" }))),
          retry(() => exchangeCall(() => (exchange as any).privateGetTradeOrdersHistory({ instType, instId, limit: "100" }))).catch(() => ({ code: "0", data: [] })),
          retry(() => exchangeCall(() => (exchange as any).privateGetTradeOrdersHistoryArchive({ instType, instId, limit: "100" }))).catch(() => ({ code: "0", data: [] })),
        ]);

        const allOrders = [
          ...unwrapOkxApiRows(openOrdersResponse),
          ...unwrapOkxApiRows(historyOrdersResponse),
          ...unwrapOkxApiRows(archivedOrdersResponse),
        ].map((row: any) => normalizeOkxHistoryOrder(row, resolvedMarket));

        const uniqueOrders = Array.from(new Map(allOrders.map((item: any) => [item.id || item.clientOrderId, item])).values())
          .filter((item: any) => item?.id || item?.clientOrderId);
        uniqueOrders.sort((a, b) => b.timestamp - a.timestamp);

        res.json(uniqueOrders);
      } catch (e) {
        console.warn("[OKX History] Primary fetch failed, trying fallback:", e);
        const fallbackResponse = await retry(() => exchangeCall(() => (exchange as any).privateGetTradeOrdersPending({
          instType: "SWAP",
          instId: resolvedMarket.instId,
          limit: "100",
        })));
        const orders = unwrapOkxApiRows(fallbackResponse).map((row: any) => normalizeOkxHistoryOrder(row, resolvedMarket));
        res.json(orders);
      }
    } catch (error: any) {
      const errMsg = error?.message || String(error || "Unknown Error");
      console.error(`[OKX History Error] Symbol: ${symbol || 'BTC/USDT'}, Mode: ${isSandbox ? 'DEMO' : 'REAL'}`, errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  app.post("/api/okx/realized-pnl", async (req, res) => {
    const { sandbox = false } = req.body;
    const isSandbox = String(sandbox) === 'true' || sandbox === true;
    const credentials = resolveOkxCredentials(req.body, isSandbox);

    if (!credentials) {
      return res.status(400).json({ error: "Missing OKX credentials" });
    }

    try {
      const exchange = getPrivateExchange(credentials.apiKey, credentials.secret, credentials.password, isSandbox);
      await prepareExchange(exchange);
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayStartMs = dayStart.getTime();
      const response = await runWithExchangeProxyFallback<any>(exchange, () => (exchange as any).privateGetAccountBills({
        ccy: "USDT",
        limit: "100",
      }));
      const rawRows = Array.isArray(response?.data) ? response.data : [];
      const rows = rawRows.map((row: any) => {
        const timestamp = firstNumber(row.ts, row.uTime, row.cTime);
        const pnl = firstNumber(row.pnl);
        return {
          id: row.billId || row.ordId || `${timestamp}_${row.type || ""}_${row.subType || ""}`,
          timestamp,
          pnl,
          fee: firstNumber(row.fee),
          balanceChange: firstNumber(row.balChg),
          type: row.type,
          subType: row.subType,
          ccy: row.ccy,
          symbol: row.instId,
        };
      }).filter((row: any) => Number.isFinite(row.timestamp) && row.timestamp > 0);

      const realizedRows = rows
        .filter((row: any) => row.pnl !== 0)
        .sort((a: any, b: any) => b.timestamp - a.timestamp);
      const riskCountRows = realizedRows.filter((row: any) => {
        const type = String(row.type || "");
        const subType = String(row.subType || "");
        // Funding-fee bills are realized balance changes, but they are not losing trades.
        return type !== "8" && subType !== "173" && subType !== "174";
      });
      const dailyPnL = realizedRows
        .filter((row: any) => row.timestamp >= dayStartMs)
        .reduce((acc: number, row: any) => acc + row.pnl, 0);
      let consecutiveLosses = 0;
      for (const row of riskCountRows) {
        if (row.pnl < 0) consecutiveLosses += 1;
        else if (row.pnl > 0) break;
      }
      const riskState = updatePersistentRiskState({
        dailyPnL,
        consecutiveStopLosses: consecutiveLosses,
      });

      res.json({
        date: todayKey(dayStart),
        dailyPnL,
        consecutiveLosses,
        riskState,
        rows: realizedRows.slice(0, 100),
      });
    } catch (error: any) {
      const errMsg = error?.message || String(error || "Unknown Error");
      console.error(`[OKX Realized PnL Error] Mode: ${isSandbox ? 'DEMO' : 'REAL'}`, errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  app.post("/api/okx/order", async (req, res) => {
    try {
      const result = await submitOkxOrder(req.body || {}, (req as any).operator?.username || "unknown");
      return res.json(result);
    } catch (error: any) {
      return res.status(error?.statusCode || 500).json(error?.payload || {
        error: error?.message || "Execution failed after retries. Please check exchange status."
      });
    }
  });

  app.post("/api/notify", async (req, res) => {
    const { subject, message } = req.body;
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn("SMTP not configured, skipping email notification");
      return res.json({ success: false, message: "SMTP not configured" });
    }

    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.qq.com",
        port: 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.SMTP_TO || process.env.SMTP_USER,
        subject: subject || "量化交易通知",
        text: message,
      });
      res.json({ success: true });
    } catch (error: any) {
      console.error("Email notification failed:", error);
      res.status(500).json({ success: false, error: error.message || "Email notification failed" });
    }
  });

  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      try {
        const url = req.originalUrl;
        const templatePath = path.join(__dirname, "index.html");
        const template = await fsp.readFile(templatePath, "utf-8");
        const html = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (error: any) {
        vite.ssrFixStacktrace(error);
        next(error);
      }
    });
  }

  const server = app.listen(PORT, () => {
    console.log(`[Server] Listening on http://127.0.0.1:${PORT} (${process.env.NODE_ENV || "development"})`);
  });

  // Disable Node.js HTTP timeout — backtest / long-running endpoints manage their own lifecycles.
  // Render's proxy timeout is ~100 s, so long-running jobs must use async+ polling (see backtest route).
  server.timeout = 0;
}

startServer().catch((error) => {
  console.error("[Server] Failed to start:", error);
  process.exit(1);
});
