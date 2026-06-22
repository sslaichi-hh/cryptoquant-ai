import React from "react";
import { Activity, Play, Square } from "lucide-react";

import type { AutoTradingConfig, AutoTradingStatus, BalanceResponse, PositionRow, RealizedPnlResponse } from "../api";
import { ScanProfilesPanel } from "../components/ScanProfilesPanel";
import { MetricCard, PageLoading, SectionTitle } from "../components/common";
import { cardClassName, formatDateTime, formatUsd } from "../utils";

const DashboardPriceChart = React.lazy(() =>
  import("../components/DashboardPriceChart").then((module) => ({ default: module.DashboardPriceChart }))
);

function connectionLabel(value: boolean | null | undefined) {
  if (value === true) return "可用";
  if (value === false) return "异常";
  return "未检查";
}

function connectionClassName(value: boolean | null | undefined) {
  if (value === true) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (value === false) return "border-rose-500/30 bg-rose-500/10 text-rose-200";
  return "border-zinc-800 bg-zinc-950/70 text-zinc-400";
}

function formatRetryDistance(value?: number | null) {
  if (!value) return null;
  const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000));
  if (seconds <= 0) return "即将重试";
  if (seconds < 60) return `${seconds}s 后重试`;
  return `${Math.ceil(seconds / 60)}m 后重试`;
}

export function DashboardPage({
  balance,
  positions,
  realizedPnl,
  autoStatus,
  autoConfig,
  autoLogs,
  autoActionPending,
  handleAutoAction,
  selectedSymbol,
  chartTimeframe,
  setChartTimeframe,
  chartData,
  scanProfilesSaving,
  handleSaveScanProfiles,
}: {
  balance: BalanceResponse | null;
  positions: PositionRow[];
  realizedPnl: RealizedPnlResponse | null;
  autoStatus: AutoTradingStatus | null;
  autoConfig: AutoTradingConfig | null;
  autoLogs: string[];
  autoActionPending: null | "start" | "stop" | "run";
  handleAutoAction: (action: "start" | "stop" | "run") => Promise<void>;
  selectedSymbol: string;
  chartTimeframe: "15m" | "1h";
  setChartTimeframe: React.Dispatch<React.SetStateAction<"15m" | "1h">>;
  chartData: Array<{ time: string; price: number; volume: number }>;
  scanProfilesSaving: boolean;
  handleSaveScanProfiles: (profiles: AutoTradingConfig["scanProfiles"]) => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <SectionTitle title="仪表盘" subtitle="账户摘要、运行控制和自动交易扫描配置。" />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="账户权益" value={formatUsd(balance?.equityUSDT || 0)} />
        <MetricCard label="可用余额" value={formatUsd(balance?.availableUSDT || 0)} />
        <MetricCard label="持仓数量" value={String(positions.length)} />
        <MetricCard
          label="今日盈亏"
          value={formatUsd(realizedPnl?.dailyPnL || 0)}
          trend={
            (realizedPnl?.dailyPnL || 0) > 0
              ? "up"
              : (realizedPnl?.dailyPnL || 0) < 0
                ? "down"
                : "neutral"
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <section className={cardClassName()}>
          <SectionTitle
            title="运行控制"
            subtitle="启动、停止或立即触发一轮自动交易扫描。"
            action={
              <div className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400">
                {autoStatus?.state || "stopped"}
              </div>
            }
          />
          {autoStatus?.state === "error" && autoStatus.lastError ? (
            <div className="mb-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {autoStatus.lastError}
            </div>
          ) : null}
          <div className="mb-5 grid gap-3 md:grid-cols-3">
            <div className={`rounded-2xl border px-4 py-3 text-sm ${connectionClassName(autoStatus?.exchangeConnectivity?.okxPublic)}`}>
              <div className="text-xs text-zinc-400">OKX 公共接口</div>
              <div className="mt-1 font-medium">{connectionLabel(autoStatus?.exchangeConnectivity?.okxPublic)}</div>
            </div>
            <div className={`rounded-2xl border px-4 py-3 text-sm ${connectionClassName(autoStatus?.exchangeConnectivity?.okxPrivate)}`}>
              <div className="text-xs text-zinc-400">OKX 私有账户</div>
              <div className="mt-1 font-medium">{connectionLabel(autoStatus?.exchangeConnectivity?.okxPrivate)}</div>
            </div>
            <div className={`rounded-2xl border px-4 py-3 text-sm ${connectionClassName(autoStatus?.exchangeConnectivity?.proxy?.reachable)}`}>
              <div className="text-xs text-zinc-400">代理链路</div>
              <div className="mt-1 font-medium">
                {autoStatus?.exchangeConnectivity?.proxy?.configured
                  ? connectionLabel(autoStatus.exchangeConnectivity.proxy.reachable)
                  : "未配置"}
              </div>
            </div>
          </div>
          {autoStatus?.exchangeConnectivity?.nextRetryAt ? (
            <div className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
              正在自动尝试恢复 OKX 数据链路：{formatRetryDistance(autoStatus.exchangeConnectivity.nextRetryAt)}
              {autoStatus.exchangeConnectivity.consecutiveFailures ? `，连续失败 ${autoStatus.exchangeConnectivity.consecutiveFailures} 次` : ""}
              {autoStatus.exchangeConnectivity.lastError ? `。最近错误：${autoStatus.exchangeConnectivity.lastError}` : ""}
            </div>
          ) : null}
          <div className="mb-5 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={autoActionPending !== null}
              onClick={() => void handleAutoAction("start")}
              className="inline-flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-900"
            >
              <Play className="h-4 w-4" />
              启动
            </button>
            <button
              type="button"
              disabled={autoActionPending !== null}
              onClick={() => void handleAutoAction("stop")}
              className="inline-flex items-center gap-2 rounded-2xl bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-900"
            >
              <Square className="h-4 w-4" />
              停止
            </button>
            <button
              type="button"
              disabled={autoActionPending !== null}
              onClick={() => void handleAutoAction("run")}
              className="inline-flex items-center gap-2 rounded-2xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-100 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Activity className="h-4 w-4" />
              立即扫描
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard label="影子模式" value={autoConfig?.shadowMode ? "开启" : "关闭"} />
            <MetricCard label="触发阈值" value={`${autoConfig?.riskConfigSnapshot.autoTradeThreshold ?? 0}%`} />
            <MetricCard
              label="最近周期"
              value={autoStatus?.recentCycleSummary?.cycleId || "—"}
              hint={autoStatus?.recentCycleSummary ? formatDateTime(autoStatus.recentCycleSummary.completedAt) : undefined}
            />
          </div>

          <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-800">
            <div className="border-b border-zinc-800 bg-zinc-950/70 px-4 py-3 text-sm font-medium text-zinc-200">
              AI 代理活动日志
            </div>
            <div className="max-h-72 overflow-y-auto">
              {autoLogs.length === 0 ? (
                <div className="px-4 py-6 text-sm text-zinc-500">暂无自动交易日志。</div>
              ) : (
                autoLogs.map((line) => (
                  <div key={line} className="border-b border-zinc-900 px-4 py-3 text-sm text-zinc-300 last:border-b-0">
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className={cardClassName()}>
          <SectionTitle title="价格概览" subtitle={`${selectedSymbol} ${chartTimeframe} 价格曲线`} />
          <div className="mb-4 flex gap-2">
            {(["15m", "1h"] as const).map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => setChartTimeframe(value)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  chartTimeframe === value
                    ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-100"
                    : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <React.Suspense fallback={<PageLoading title="正在加载价格图..." />}>
            <DashboardPriceChart chartData={chartData} />
          </React.Suspense>
        </section>
      </div>

      <ScanProfilesPanel config={autoConfig} saving={scanProfilesSaving} onSave={handleSaveScanProfiles} />
    </div>
  );
}
