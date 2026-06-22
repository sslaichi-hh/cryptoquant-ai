import React from "react";
import clsx from "clsx";

import type {
  BalanceResponse,
  PortfolioReturnAnalytics,
  PortfolioReturnHistoryRow,
  PortfolioReturnMode,
  PortfolioReturnRange,
  PositionRow,
  RealizedPnlResponse,
} from "../api";
import { MetricCard, SectionTitle } from "../components/common";
import {
  cardClassName,
  exitReasonLabel,
  formatDateTime,
  formatPct,
  formatPrice,
  formatUsd,
  parseJsonSafely,
} from "../utils";
import { normalizeDisplaySymbol } from "../../lib/tradingRuntime";

const PortfolioReturnCurveChart = React.lazy(() =>
  import("../components/PortfolioReturnCurveChart").then((module) => ({ default: module.PortfolioReturnCurveChart }))
);

const MODE_OPTIONS: Array<{ key: PortfolioReturnMode; label: string }> = [
  { key: "live", label: "实盘" },
  { key: "shadow", label: "影子" },
  { key: "demo", label: "OKX 模拟盘" },
];

const RANGE_OPTIONS: Array<{ key: PortfolioReturnRange; label: string }> = [
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { key: "90d", label: "90天" },
  { key: "all", label: "全部" },
];

function trendFor(value?: number | null) {
  const numeric = Number(value || 0);
  if (numeric > 0) return "up" as const;
  if (numeric < 0) return "down" as const;
  return "neutral" as const;
}

function formatNullablePct(value?: number | null, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return formatPct(value, digits);
}

function formatHoldMinutes(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value < 60) return `${formatPrice(value, 0)} 分钟`;
  return `${formatPrice(value / 60, 1)} 小时`;
}

function statusLabel(row: PortfolioReturnHistoryRow) {
  if (row.source === "exchange_bill" && row.status === "settled") return "账单结算";
  if (row.source === "shadow" && row.status === "open") return "影子持仓";
  if (row.source === "shadow" && row.status === "closed") return "影子平仓";
  if (row.status === "closed") return "已平仓";
  if (row.status === "open") return "持仓中";
  return row.status || "—";
}

function modeLabel(mode: PortfolioReturnMode) {
  return MODE_OPTIONS.find((item) => item.key === mode)?.label || mode;
}

function SegmentButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  key?: React.Key;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-xl px-3 py-1.5 text-sm transition",
        active
          ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
          : "border border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function ReturnControls({
  returnMode,
  setReturnMode,
  returnRange,
  setReturnRange,
}: {
  returnMode: PortfolioReturnMode;
  setReturnMode: React.Dispatch<React.SetStateAction<PortfolioReturnMode>>;
  returnRange: PortfolioReturnRange;
  setReturnRange: React.Dispatch<React.SetStateAction<PortfolioReturnRange>>;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <div className="flex flex-wrap gap-2">
        {MODE_OPTIONS.map((item) => (
          <SegmentButton key={item.key} active={returnMode === item.key} onClick={() => setReturnMode(item.key)}>
            {item.label}
          </SegmentButton>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {RANGE_OPTIONS.map((item) => (
          <SegmentButton key={item.key} active={returnRange === item.key} onClick={() => setReturnRange(item.key)}>
            {item.label}
          </SegmentButton>
        ))}
      </div>
    </div>
  );
}

function ReturnDetails({ row }: { row: PortfolioReturnHistoryRow | null }) {
  if (!row) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
        选择一条收益记录查看交易细节。
      </div>
    );
  }

  const detailPairs = [
    ["标的", row.symbol],
    ["方向", row.side],
    ["策略", row.strategyId || "—"],
    ["周期", row.timeframe || "—"],
    ["状态", statusLabel(row)],
    ["开仓时间", formatDateTime(row.openedAt)],
    ["平仓/更新时间", formatDateTime(row.closedAt || row.timestamp)],
    ["入场价", formatPrice(row.entryPrice, 2)],
    ["出场价", formatPrice(row.exitPrice, 2)],
    ["标记价", formatPrice(row.markPrice, 2)],
    ["止盈", formatPrice(row.tpPrice, 2)],
    ["止损", formatPrice(row.slPrice, 2)],
    ["保证金/投入", formatUsd(row.margin || row.amount || 0, 2)],
    ["名义价值", formatUsd(row.notional || 0, 2)],
    ["杠杆", row.leverage ? `${formatPrice(row.leverage, 1)}x` : "—"],
    ["持仓时长", formatHoldMinutes(row.holdMinutes)],
    ["市场状态", row.regime || "—"],
    ["宏观门控", row.macroGate || "—"],
    ["入场理由", row.entryReason || "—"],
    ["退出原因", exitReasonLabel(row.exitReason)],
    ["数据来源", row.source === "exchange_bill" ? "OKX 账单" : row.source === "shadow" ? "影子执行" : "本地交易"],
    ["账单类型", row.type || "—"],
    ["账单子类型", row.subType || "—"],
    ["币种", row.ccy || "—"],
    ["余额变动", row.balanceChange === null ? "—" : formatUsd(row.balanceChange, 3)],
    ["关联本地交易", row.localTradeId || "—"],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {detailPairs.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 break-words text-sm text-zinc-200">{value}</div>
          </div>
        ))}
      </div>

      {row.source === "shadow" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs text-zinc-500">滑点</div>
            <div className="mt-1 text-sm text-zinc-200">
              {row.slippageBps === null ? "—" : `${formatPrice(row.slippageBps, 2)} bps`}
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs text-zinc-500">估算来源</div>
            <div className="mt-1 text-sm text-zinc-200">{row.isEstimated ? "估算" : "实时"}</div>
          </div>
        </div>
      ) : null}

      {row.signalJson ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="mb-2 text-sm font-medium text-zinc-200">signal_json</div>
          <pre className="max-h-72 overflow-auto text-xs text-zinc-400">
            {JSON.stringify(parseJsonSafely(row.signalJson), null, 2)}
          </pre>
        </div>
      ) : null}

      {row.orderbookJson ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="mb-2 text-sm font-medium text-zinc-200">orderbook_json</div>
          <pre className="max-h-72 overflow-auto text-xs text-zinc-400">
            {JSON.stringify(parseJsonSafely(row.orderbookJson), null, 2)}
          </pre>
        </div>
      ) : null}

      {row.rawJson ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="mb-2 text-sm font-medium text-zinc-200">raw_json</div>
          <pre className="max-h-72 overflow-auto text-xs text-zinc-400">
            {JSON.stringify(parseJsonSafely(row.rawJson), null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

type ReturnAnalyticsTab = "overview" | "history" | "detail";

const RETURN_TABS: Array<{ key: ReturnAnalyticsTab; label: string }> = [
  { key: "overview", label: "收益概览" },
  { key: "history", label: "收益历史" },
  { key: "detail", label: "记录详情" },
];

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-xl px-3 py-2 text-sm transition",
        active
          ? "bg-zinc-100 text-zinc-950"
          : "border border-zinc-800 bg-zinc-950/80 text-zinc-300 hover:border-zinc-600 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function ReturnNotice({
  error,
  staleWarning,
}: {
  error: string;
  staleWarning: string;
}) {
  return (
    <>
      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}
      {staleWarning ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {staleWarning}
        </div>
      ) : null}
    </>
  );
}

function ReturnMetricsGrid({ summary }: { summary: PortfolioReturnAnalytics["summary"] | undefined }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="累计收益" value={formatUsd(summary?.totalPnl || 0, 3)} trend={trendFor(summary?.totalPnl)} />
      <MetricCard label="账户收益率" value={formatNullablePct(summary?.accountReturnPct)} trend={trendFor(summary?.accountReturnPct)} />
      <MetricCard label="单笔平均 ROI" value={formatNullablePct(summary?.avgTradeRoiPct)} trend={trendFor(summary?.avgTradeRoiPct)} />
      <MetricCard label="胜率" value={formatNullablePct(summary?.winRate)} />
      <MetricCard label="Profit Factor" value={formatPrice(summary?.profitFactor || 0, 2)} />
      <MetricCard label="最大回撤" value={formatNullablePct(summary?.maxDrawdownPct)} trend={trendFor(summary?.maxDrawdownPct)} />
      <MetricCard label="已平仓数" value={String(summary?.closedTrades || 0)} hint={`开放：${summary?.openTrades || 0}`} />
      <MetricCard label="未实现收益" value={formatUsd(summary?.unrealizedPnl || 0, 3)} trend={trendFor(summary?.unrealizedPnl)} />
    </div>
  );
}

function ReturnCurvePanel({
  returnAnalytics,
  refreshing,
}: {
  returnAnalytics: PortfolioReturnAnalytics | null;
  refreshing: boolean;
}) {
  return (
    <section className={cardClassName()}>
      <SectionTitle
        title="资金曲线"
        subtitle={`资金基准：${formatUsd(returnAnalytics?.capitalBase || 0, 2)}（${returnAnalytics?.capitalBaseSource === "equity" ? "账户权益" : returnAnalytics?.capitalBaseSource === "fallback" ? "本地交易投入估算" : "暂无"}）`}
        action={refreshing ? <span className="text-sm text-zinc-500">刷新中...</span> : null}
      />
      <div className="h-[320px]">
        {returnAnalytics?.equityCurve.length ? (
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60 text-sm text-zinc-500">
                正在加载资金曲线...
              </div>
            }
          >
            <PortfolioReturnCurveChart equityCurve={returnAnalytics.equityCurve} />
          </React.Suspense>
        ) : (
          <div className="flex h-full items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/60 text-sm text-zinc-500">
            暂无收益曲线数据
          </div>
        )}
      </div>
    </section>
  );
}

function ReturnHistoryTable({
  history,
  selectedId,
  onSelect,
}: {
  history: PortfolioReturnHistoryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className={cardClassName()}>
      <SectionTitle title="收益历史" subtitle="精简展示关键字段；账单字段、信号和原始 JSON 放在记录详情。" />
      <div className="overflow-x-auto rounded-2xl border border-zinc-800">
        <div className="min-w-[920px]">
          <div className="grid grid-cols-[150px_100px_70px_150px_110px_120px_100px_100px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
            <span>时间</span>
            <span>标的</span>
            <span>方向</span>
            <span>策略</span>
            <span>状态</span>
            <span>收益</span>
            <span>ROI</span>
            <span>费用/滑点</span>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无自动交易收益记录</div>
            ) : (
              history.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => onSelect(row.id)}
                  className={clsx(
                    "grid w-full grid-cols-[150px_100px_70px_150px_110px_120px_100px_100px] gap-3 border-b border-zinc-900 px-4 py-3 text-left text-sm transition last:border-b-0",
                    selectedId === row.id ? "bg-indigo-500/10 text-indigo-100" : "text-zinc-200 hover:bg-zinc-950/70"
                  )}
                >
                  <span className="text-zinc-400">{formatDateTime(row.timestamp)}</span>
                  <span>{row.symbol}</span>
                  <span>{row.side}</span>
                  <span className="truncate" title={row.strategyId || "—"}>{row.strategyId || "—"}</span>
                  <span>{statusLabel(row)}</span>
                  <span className={clsx(Number(row.totalPnl || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                    {formatUsd(row.totalPnl, 3)}
                  </span>
                  <span className={clsx(Number(row.tradeRoiPct || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                    {formatPct(row.tradeRoiPct, 2)}
                  </span>
                  <span>
                    {row.source === "shadow"
                      ? row.slippageBps === null ? "—" : `${formatPrice(row.slippageBps, 1)} bps`
                      : formatUsd(row.fee, 3)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ReturnAnalyticsModule({
  returnMode,
  setReturnMode,
  returnRange,
  setReturnRange,
  returnAnalytics,
  returnAnalyticsLoadingInitial,
  returnAnalyticsRefreshing,
  returnAnalyticsError,
  returnAnalyticsStaleWarning,
}: {
  returnMode: PortfolioReturnMode;
  setReturnMode: React.Dispatch<React.SetStateAction<PortfolioReturnMode>>;
  returnRange: PortfolioReturnRange;
  setReturnRange: React.Dispatch<React.SetStateAction<PortfolioReturnRange>>;
  returnAnalytics: PortfolioReturnAnalytics | null;
  returnAnalyticsLoadingInitial: boolean;
  returnAnalyticsRefreshing: boolean;
  returnAnalyticsError: string;
  returnAnalyticsStaleWarning: string;
}) {
  const [activeTab, setActiveTab] = React.useState<ReturnAnalyticsTab>("overview");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const history = returnAnalytics?.history || [];

  React.useEffect(() => {
    if (!history.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !history.some((row) => row.id === selectedId)) {
      setSelectedId(history[0].id);
    }
  }, [history, selectedId]);

  const selectedRow = React.useMemo(
    () => history.find((row) => row.id === selectedId) || null,
    [history, selectedId]
  );
  const summary = returnAnalytics?.summary;
  const activeRangeLabel = RANGE_OPTIONS.find((item) => item.key === returnRange)?.label || returnRange;

  const handleHistorySelect = React.useCallback((id: string) => {
    setSelectedId(id);
    setActiveTab("detail");
  }, []);

  const shell = (children: React.ReactNode) => (
    <div className="space-y-5">
      <SectionTitle
        title="自动交易收益分析"
        subtitle={`当前口径：${modeLabel(returnMode)} / ${activeRangeLabel}`}
        action={<ReturnControls returnMode={returnMode} setReturnMode={setReturnMode} returnRange={returnRange} setReturnRange={setReturnRange} />}
      />
      <div className="flex flex-wrap gap-2">
        {RETURN_TABS.map((item) => (
          <React.Fragment key={item.key}>
            <TabButton active={activeTab === item.key} onClick={() => setActiveTab(item.key)}>
              {item.label}
            </TabButton>
          </React.Fragment>
        ))}
      </div>
      <ReturnNotice error={returnAnalyticsError} staleWarning={returnAnalyticsStaleWarning} />
      {children}
    </div>
  );

  if (returnAnalyticsError && !returnAnalytics) {
    return shell(
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 py-10 text-center text-sm text-zinc-400">
        未拿到真实收益数据前不会展示 0 值收益面板。请检查 OKX 凭据、账户模式和网络连通性后重试。
      </div>
    );
  }

  if (!returnAnalytics && !returnAnalyticsError) {
    return shell(
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 py-10 text-center text-sm text-zinc-400">
        {returnAnalyticsLoadingInitial ? "正在读取真实收益数据..." : "等待收益数据刷新..."}
      </div>
    );
  }

  return shell(
    <>
      {activeTab === "overview" ? (
        <div className="space-y-5">
          <ReturnMetricsGrid summary={summary} />
          <ReturnCurvePanel returnAnalytics={returnAnalytics} refreshing={returnAnalyticsRefreshing} />
        </div>
      ) : null}

      {activeTab === "history" ? (
        <ReturnHistoryTable history={history} selectedId={selectedId} onSelect={handleHistorySelect} />
      ) : null}

      {activeTab === "detail" ? (
        <section className={cardClassName()}>
          <SectionTitle
            title="记录详情"
            subtitle={selectedRow ? `${selectedRow.symbol} / ${formatDateTime(selectedRow.timestamp)}` : "从收益历史中选择一条记录查看详情。"}
            action={
              history.length ? (
                <button
                  type="button"
                  onClick={() => setActiveTab("history")}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-600 hover:text-white"
                >
                  返回历史
                </button>
              ) : null
            }
          />
          <ReturnDetails row={selectedRow} />
        </section>
      ) : null}
    </>
  );
}

export function PortfolioPage({
  balance,
  positions,
  realizedPnl,
  returnMode,
  setReturnMode,
  returnRange,
  setReturnRange,
  returnAnalytics,
  returnAnalyticsLoadingInitial,
  returnAnalyticsRefreshing,
  returnAnalyticsError,
  returnAnalyticsStaleWarning,
}: {
  balance: BalanceResponse | null;
  positions: PositionRow[];
  realizedPnl: RealizedPnlResponse | null;
  returnMode: PortfolioReturnMode;
  setReturnMode: React.Dispatch<React.SetStateAction<PortfolioReturnMode>>;
  returnRange: PortfolioReturnRange;
  setReturnRange: React.Dispatch<React.SetStateAction<PortfolioReturnRange>>;
  returnAnalytics: PortfolioReturnAnalytics | null;
  returnAnalyticsLoadingInitial: boolean;
  returnAnalyticsRefreshing: boolean;
  returnAnalyticsError: string;
  returnAnalyticsStaleWarning: string;
}) {
  const holdingPnl = positions.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const autoTradingPnl = returnAnalytics?.summary.totalPnl || 0;

  return (
    <div className="space-y-6">
      <SectionTitle title="投资组合" subtitle="优先查看账户权益、持仓风险、今日盈亏和自动交易收益。" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="账户权益" value={formatUsd(balance?.equityUSDT || 0)} />
        <MetricCard label="可用余额" value={formatUsd(balance?.availableUSDT || 0)} />
        <MetricCard
          label="今日已实现盈亏"
          value={formatUsd(realizedPnl?.dailyPnL || 0)}
          trend={trendFor(realizedPnl?.dailyPnL)}
        />
        <MetricCard label="持仓浮盈亏" value={formatUsd(holdingPnl, 3)} trend={trendFor(holdingPnl)} />
        <MetricCard label="持仓数量" value={String(positions.length)} hint="当前开放仓位" />
        <MetricCard label="自动交易累计收益" value={formatUsd(autoTradingPnl, 3)} trend={trendFor(autoTradingPnl)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className={cardClassName()}>
          <SectionTitle title="当前持仓" subtitle="优先确认风险敞口和浮动盈亏。" />
          <div className="overflow-x-auto rounded-2xl border border-zinc-800">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[120px_80px_110px_110px_110px_120px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
                <span>标的</span>
                <span>方向</span>
                <span>合约数</span>
                <span>开仓价</span>
                <span>标记价</span>
                <span>PnL</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {positions.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无持仓</div>
                ) : (
                  positions.map((row, index) => (
                    <div
                      key={`${row.symbol}-${index}`}
                      className="grid grid-cols-[120px_80px_110px_110px_110px_120px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200 last:border-b-0"
                    >
                      <span>{normalizeDisplaySymbol(row.symbol)}</span>
                      <span>{row.side}</span>
                      <span>{formatPrice(Number(row.contracts || 0), 4)}</span>
                      <span>{formatPrice(Number(row.entryPrice || 0), 2)}</span>
                      <span>{formatPrice(Number(row.markPrice || 0), 2)}</span>
                      <span className={clsx(Number(row.pnl || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                        {formatUsd(Number(row.pnl || 0), 3)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={cardClassName()}>
          <SectionTitle title="最近已实现盈亏" subtitle="来自 OKX 账单的近期结算记录。" />
          <div className="overflow-x-auto rounded-2xl border border-zinc-800">
            <div className="min-w-[560px]">
              <div className="grid grid-cols-[160px_100px_80px_100px_100px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
                <span>时间</span>
                <span>标的</span>
                <span>类型</span>
                <span>PnL</span>
                <span>费用</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {(realizedPnl?.rows || []).length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无近期已实现盈亏</div>
                ) : (
                  (realizedPnl?.rows || []).slice(0, 30).map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[160px_100px_80px_100px_100px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200 last:border-b-0"
                    >
                      <span className="text-zinc-400">{formatDateTime(row.timestamp)}</span>
                      <span>{normalizeDisplaySymbol(row.symbol)}</span>
                      <span>{row.subType || row.type}</span>
                      <span className={clsx(row.pnl >= 0 ? "text-emerald-300" : "text-rose-300")}>
                        {formatUsd(row.pnl, 3)}
                      </span>
                      <span>{formatUsd(row.fee, 3)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <ReturnAnalyticsModule
        returnMode={returnMode}
        setReturnMode={setReturnMode}
        returnRange={returnRange}
        setReturnRange={setReturnRange}
        returnAnalytics={returnAnalytics}
        returnAnalyticsLoadingInitial={returnAnalyticsLoadingInitial}
        returnAnalyticsRefreshing={returnAnalyticsRefreshing}
        returnAnalyticsError={returnAnalyticsError}
        returnAnalyticsStaleWarning={returnAnalyticsStaleWarning}
      />
    </div>
  );
}
