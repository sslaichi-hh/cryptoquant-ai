import React from "react";
import clsx from "clsx";

import type { FactorAuditItem, StrategyWalkForwardSummary, WalkForwardBacktestResponse, WalkForwardRound, WalkForwardValidationStatus } from "../api";
import { MetricCard, SectionTitle } from "../components/common";
import { cardClassName, DEFAULT_STRATEGIES, formatDateTime, formatPct, formatPrice, formatUsd, type BacktestForm } from "../utils";
import { AUTO_TRADING_ALLOWED_SYMBOLS } from "../../lib/tradingRuntime";

const STATUS_LABELS: Record<FactorAuditItem["status"], string> = {
  enabled: "已启用",
  disabled: "已禁用",
  unavailable: "无可用历史",
  latest_revision_blocked: "阻止最新修订",
};

function strategyLabel(strategy: string) {
  if (strategy === "trend-breakout") return "趋势突破";
  if (strategy === "mean-reversion") return "均值回归";
  return strategy;
}

function trendFor(value?: number | null): "up" | "down" | "neutral" {
  const numeric = Number(value || 0);
  if (numeric > 0) return "up";
  if (numeric < 0) return "down";
  return "neutral";
}

function summaryCards(summary: StrategyWalkForwardSummary | undefined) {
  return [
    { label: "切片数", value: String(summary?.rounds || 0), trend: "neutral" as const },
    { label: "有效切片", value: String(summary?.validRounds || 0), trend: "up" as const },
    { label: "交易不足", value: String(summary?.insufficientTradeRounds || 0), trend: summary?.insufficientTradeRounds ? "down" as const : "neutral" as const },
    { label: "无验证交易", value: String(summary?.noValidationTradeRounds || 0), trend: summary?.noValidationTradeRounds ? "down" as const : "neutral" as const },
    { label: "中位收益", value: formatPct(summary?.medianReturn || 0), trend: trendFor(summary?.medianReturn) },
    { label: "最差收益", value: formatPct(summary?.worstReturn || 0), trend: trendFor(summary?.worstReturn) },
    { label: "最差回撤", value: formatPct(summary?.worstMaxDrawdown || 0), trend: "down" as const },
    { label: "Profit Factor", value: formatPrice(summary?.medianProfitFactor || 0, 2), trend: "neutral" as const },
    { label: "脆弱切片", value: String(summary?.fragileRounds || 0), trend: summary?.fragileRounds ? "down" as const : "neutral" as const },
  ];
}

const STATUS_META: Record<WalkForwardValidationStatus, { label: string; className: string }> = {
  stable: { label: "稳定", className: "text-emerald-300" },
  fragile: { label: "脆弱", className: "text-amber-200" },
  insufficient_trades: { label: "交易不足", className: "text-rose-300" },
  no_validation_trades: { label: "无验证交易", className: "text-amber-200" },
};

const REASON_LABELS: Record<string, string> = {
  risk_off_blocked: "风险关闭",
  macro_gate_blocked: "宏观门控",
  trend_regime_not_ready: "趋势状态不足",
  trend_filters_not_aligned: "趋势过滤未共振",
  mean_reversion_wrong_regime: "非震荡环境",
  higher_timeframe_trend_blocked: "高周期趋势过滤",
  volatility_expansion_blocked: "波动扩张",
  mean_reversion_not_extreme: "未触及极值",
  risk_sizing_invalid: "风险仓位无效",
  other_hold: "其他等待",
};

function statusMeta(status?: WalkForwardValidationStatus) {
  return STATUS_META[status || "stable"] || STATUS_META.stable;
}

function topReason(round: WalkForwardRound) {
  const reason = round.diagnostics?.noEntryReasons?.[0];
  if (!reason) return "--";
  return `${REASON_LABELS[reason.reason] || reason.reason} (${reason.count})`;
}

function FormNumber({
  label,
  value,
  onChange,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label className="text-sm text-zinc-400">
      {label}
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
      />
    </label>
  );
}

function StrategyTabs({
  strategies,
  activeStrategy,
  onChange,
}: {
  strategies: string[];
  activeStrategy: string;
  onChange: (strategy: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {strategies.map((strategy) => (
        <button
          key={strategy}
          type="button"
          onClick={() => onChange(strategy)}
          className={clsx(
            "rounded-xl px-3 py-2 text-sm transition",
            activeStrategy === strategy
              ? "bg-zinc-100 text-zinc-950"
              : "border border-zinc-800 bg-zinc-950/80 text-zinc-300 hover:border-zinc-600 hover:text-white"
          )}
        >
          {strategyLabel(strategy)}
        </button>
      ))}
    </div>
  );
}

function FactorAudit({ audit }: { audit: FactorAuditItem[] }) {
  return (
    <section className={cardClassName()}>
      <SectionTitle title="数据可信度审计" subtitle="严格模式下，只有具备真实时间戳的数据会进入回测。" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {audit.map((item) => (
          <div
            key={item.factor}
            className={clsx(
              "rounded-2xl border p-4",
              item.usedInBacktest ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-zinc-100">{item.label}</div>
              <span className={clsx("text-xs", item.usedInBacktest ? "text-emerald-300" : "text-amber-200")}>
                {STATUS_LABELS[item.status]}
              </span>
            </div>
            <div className="mt-3 text-sm leading-6 text-zinc-300">{item.message}</div>
            {item.requiredTimestamp ? (
              <div className="mt-3 text-xs text-zinc-500">需要时间字段：{item.requiredTimestamp}</div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function RoundsTable({ rounds }: { rounds: WalkForwardRound[] }) {
  return (
    <section className={cardClassName()}>
      <SectionTitle title="切片明细" subtitle="训练窗口只在前，验证窗口只在后；0 交易和训练不足会明确标记，不再显示为稳定。" />
      <div className="overflow-x-auto rounded-2xl border border-zinc-800">
        <div className="min-w-[1780px]">
          <div className="grid grid-cols-[110px_150px_150px_80px_80px_95px_95px_80px_95px_110px_145px_145px_120px_130px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
            <span>标的</span>
            <span>训练区间</span>
            <span>验证区间</span>
            <span>止损</span>
            <span>止盈</span>
            <span>验证收益</span>
            <span>最大回撤</span>
            <span>胜率</span>
            <span>训练/验证</span>
            <span>状态</span>
            <span>不开仓主因</span>
            <span>退出统计</span>
            <span>均盈/均亏</span>
            <span>费用滑点/毛利</span>
          </div>
          <div>
            {rounds.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无 walk-forward 切片</div>
            ) : (
              rounds.map((round, index) => {
                const status = statusMeta(round.validationStatus);
                const diagnostics = round.diagnostics;
                return (
                  <div
                    key={`${round.strategy}-${round.symbol}-${round.validationStart}-${index}`}
                    className="grid grid-cols-[110px_150px_150px_80px_80px_95px_95px_80px_95px_110px_145px_145px_120px_130px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200 last:border-b-0"
                  >
                    <span>{round.symbol}</span>
                    <span className="text-zinc-400">
                      {formatDateTime(round.trainStart).slice(0, 10)} - {formatDateTime(round.trainEnd).slice(0, 10)}
                    </span>
                    <span className="text-zinc-400">
                      {formatDateTime(round.validationStart).slice(0, 10)} - {formatDateTime(round.validationEnd).slice(0, 10)}
                    </span>
                    <span>{formatPct(round.selectedParams.stopLoss)}</span>
                    <span>{formatPct(round.selectedParams.takeProfit)}</span>
                    <span className={clsx(trendFor(round.validation.totalReturn) === "up" ? "text-emerald-300" : "text-rose-300")}>
                      {formatPct(round.validation.totalReturn || 0)}
                    </span>
                    <span>{formatPct(round.validation.maxDrawdown || 0)}</span>
                    <span>{formatPct(round.validation.winRate || 0)}</span>
                    <span>{diagnostics?.trainTrades ?? round.train.totalTrades}/{diagnostics?.validationTrades ?? round.validation.totalTrades ?? 0}</span>
                    <span className={status.className}>{status.label}</span>
                    <span className="truncate text-zinc-400" title={round.insufficientReason || topReason(round)}>
                      {round.insufficientReason || topReason(round)}
                    </span>
                    <span className="text-zinc-400">
                      SL {diagnostics?.stopLossCount || 0} / TP {diagnostics?.takeProfitCount || 0} / 反 {diagnostics?.oppositeSignalCount || 0}
                    </span>
                    <span className="text-zinc-400">{formatUsd(diagnostics?.avgWin || 0, 2)} / {formatUsd(diagnostics?.avgLoss || 0, 2)}</span>
                    <span>{formatPct(diagnostics?.feeSlippageToGrossProfitPct || 0)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function BacktestPage({
  backtestForm,
  setBacktestForm,
  backtestResult,
  backtestLoading,
  backtestError,
  handleRunBacktest,
}: {
  backtestForm: BacktestForm;
  setBacktestForm: React.Dispatch<React.SetStateAction<BacktestForm>>;
  backtestResult: WalkForwardBacktestResponse | null;
  backtestLoading: boolean;
  backtestError: string;
  handleRunBacktest: () => Promise<void>;
}) {
  const resultStrategies = backtestResult?.strategies?.length ? backtestResult.strategies : backtestForm.strategyIds;
  const [activeStrategy, setActiveStrategy] = React.useState(resultStrategies[0] || DEFAULT_STRATEGIES[0]);

  React.useEffect(() => {
    if (resultStrategies.length && !resultStrategies.includes(activeStrategy)) {
      setActiveStrategy(resultStrategies[0]);
    }
  }, [activeStrategy, resultStrategies]);

  const activeBucket = backtestResult?.byStrategy?.[activeStrategy];
  const activeSummary = activeBucket?.summary;
  const activeRounds = activeBucket?.rounds || [];
  const selectedSymbols = backtestForm.symbols?.length ? backtestForm.symbols : [backtestForm.symbol];

  const toggleSymbol = React.useCallback((symbol: string) => {
    setBacktestForm((current) => {
      const currentSymbols = current.symbols?.length ? current.symbols : [current.symbol];
      const exists = currentSymbols.includes(symbol);
      const nextSymbols = exists ? currentSymbols.filter((item) => item !== symbol) : [...currentSymbols, symbol];
      const safeSymbols = nextSymbols.length ? nextSymbols : [symbol];
      return { ...current, symbol: safeSymbols[0], symbols: safeSymbols };
    });
  }, [setBacktestForm]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Walk-forward 策略验证"
        subtitle="默认分开验证趋势突破与均值回归；价格 K 线按时间切片回放，新闻、链上、宏观未具备 point-in-time 数据前不会参与。"
      />

      <section className={cardClassName()}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm text-zinc-400">
            周期
            <select
              value={backtestForm.timeframe}
              onChange={(event) => setBacktestForm((current) => ({ ...current, timeframe: event.target.value }))}
              className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            >
              <option value="15m">15m</option>
              <option value="1h">1h</option>
            </select>
          </label>
          <FormNumber label="初始资金" value={backtestForm.initialEquity} min={1} onChange={(value) => setBacktestForm((current) => ({ ...current, initialEquity: value }))} />
          <FormNumber label="训练窗口（天）" value={backtestForm.trainDays} min={1} onChange={(value) => setBacktestForm((current) => ({ ...current, trainDays: value }))} />
          <FormNumber label="验证窗口（天）" value={backtestForm.validationDays} min={1} onChange={(value) => setBacktestForm((current) => ({ ...current, validationDays: value }))} />
          <FormNumber label="步长（天）" value={backtestForm.stepDays} min={1} onChange={(value) => setBacktestForm((current) => ({ ...current, stepDays: value }))} />
          <FormNumber label="数据上限（bars）" value={backtestForm.period} min={120} onChange={(value) => setBacktestForm((current) => ({ ...current, period: value }))} />
          <FormNumber label="基准止损" value={backtestForm.stopLoss} min={0.1} step={0.1} onChange={(value) => setBacktestForm((current) => ({ ...current, stopLoss: value }))} />
          <FormNumber label="基准止盈" value={backtestForm.takeProfit} min={0.1} step={0.1} onChange={(value) => setBacktestForm((current) => ({ ...current, takeProfit: value }))} />
          <FormNumber label="最少训练交易数" value={backtestForm.minTrainTrades} min={0} onChange={(value) => setBacktestForm((current) => ({ ...current, minTrainTrades: value }))} />
          <FormNumber label="每笔风险（%）" value={backtestForm.riskPerTradePct} min={0.1} step={0.1} onChange={(value) => setBacktestForm((current) => ({ ...current, riskPerTradePct: value }))} />
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="text-sm text-zinc-400">验证标的</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {AUTO_TRADING_ALLOWED_SYMBOLS.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  onClick={() => toggleSymbol(symbol)}
                  className={clsx(
                    "rounded-xl px-3 py-2 text-sm transition",
                    selectedSymbols.includes(symbol)
                      ? "bg-indigo-500 text-white"
                      : "border border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600 hover:text-white"
                  )}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">验证策略</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {DEFAULT_STRATEGIES.map((strategy) => (
                <span key={strategy} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200">
                  {strategyLabel(strategy)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
          严格模式：当前只允许价格 K 线参与信号。新闻、链上、宏观数据必须有真实发布时间或 vintage 时间戳，否则只进入审计提示，不进入策略上下文。
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRunBacktest()}
            disabled={backtestLoading}
            className="rounded-2xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-indigo-900"
          >
            {backtestLoading ? "验证中..." : "运行 Walk-forward 验证"}
          </button>
          <span className="text-sm text-zinc-500">
            默认初始资金：{formatUsd(backtestForm.initialEquity, 2)}，每笔风险 {formatPct(backtestForm.riskPerTradePct)}，训练少于 {backtestForm.minTrainTrades} 笔会标记为交易不足。
          </span>
        </div>
      </section>

      {backtestError ? (
        <section className="rounded-3xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm leading-6 text-rose-100">
          <div className="font-semibold text-rose-200">Walk-forward 回测失败</div>
          <div className="mt-2 whitespace-pre-wrap break-words">{backtestError}</div>
          <div className="mt-3 text-xs text-rose-200/70">
            这里不会回退到旧单段回测或 0% 假曲线；请缩短训练/验证窗口、增加 bars 上限，或检查 OKX OHLCV 数据。
          </div>
        </section>
      ) : null}

      {backtestResult ? (
        <div className="space-y-6">
          <section className={cardClassName("space-y-5")}>
            <SectionTitle
              title="策略总览"
              subtitle={`按策略独立判断，不把 0 交易趋势突破和均值回归结果混成一个结论。每笔风险 ${formatPct(backtestResult.config.riskPerTradePct)}，训练最少 ${backtestResult.config.minTrainTrades} 笔。`}
            />
            <StrategyTabs strategies={resultStrategies} activeStrategy={activeStrategy} onChange={setActiveStrategy} />
            <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              {summaryCards(activeSummary).map((item) => (
                <React.Fragment key={item.label}>
                  <MetricCard label={item.label} value={item.value} trend={item.trend} />
                </React.Fragment>
              ))}
            </div>
          </section>

          <RoundsTable rounds={activeRounds} />

          <section className={cardClassName("space-y-4")}>
            <SectionTitle title="全部切片审计" subtitle="仅用于检查样本覆盖，不作为策略收益结论。" />
            <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              {summaryCards(backtestResult.summary).map((item) => (
                <React.Fragment key={item.label}>
                  <MetricCard label={item.label} value={item.value} trend={item.trend} />
                </React.Fragment>
              ))}
            </div>
          </section>

          <FactorAudit audit={backtestResult.factorAudit || []} />

          <section className={cardClassName()}>
            <SectionTitle title="时间一致性" />
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(backtestResult.timeConsistency || {}).map(([key, value]) => (
                <div key={key} className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
                  <div className="text-sm font-medium text-zinc-200">{key}</div>
                  <div className="mt-2 text-sm leading-6 text-zinc-400">{value}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
