import React from "react";
import clsx from "clsx";

import type { ResearchStat, ResearchWeekly, TradeRow } from "../api";
import {
  formatDateTime,
  formatPct,
  formatPrice,
  formatUsd,
  groupTotals,
  type AuditDrilldownMode,
} from "../utils";
import { normalizeDisplaySymbol } from "../../lib/tradingRuntime";
import { cardClassName } from "../utils";
import { Drawer, MetricCard } from "./common";

export function AuditDrilldownDrawer({
  open,
  mode,
  selectedKey,
  onClose,
  onSelect,
  researchWeekly,
  auditTrades,
  loading,
  error,
}: {
  open: boolean;
  mode: AuditDrilldownMode;
  selectedKey: string | null;
  onClose: () => void;
  onSelect: (value: string | null) => void;
  researchWeekly: ResearchWeekly | null;
  auditTrades: TradeRow[];
  loading: boolean;
  error: string;
}) {
  const source = mode === "regime" ? researchWeekly?.byRegime || {} : researchWeekly?.bySymbol || {};
  const stats = groupTotals(source, selectedKey);
  const groups = Object.entries(source);
  const filteredTrades = auditTrades.filter((row) => {
    if (!selectedKey) return true;
    if (mode === "regime") return String(row.regime || "UNKNOWN") === selectedKey;
    return normalizeDisplaySymbol(String(row.symbol || "")) === selectedKey;
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={mode === "regime" ? "按 Regime 复盘" : "按币种复盘"}
      subtitle={selectedKey ? `当前选择：${selectedKey}` : "当前选择：全部"}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="交易数" value={String(stats.trades)} />
        <MetricCard
          label="总 PnL"
          value={formatUsd(stats.pnl)}
          trend={stats.pnl > 0 ? "up" : stats.pnl < 0 ? "down" : "neutral"}
        />
        <MetricCard label="胜率" value={formatPct(stats.winRate)} />
        <MetricCard
          label={mode === "regime" ? "Profit Factor" : "Expectancy"}
          value={mode === "regime" ? formatPrice(stats.profitFactor, 2) : formatUsd(stats.expectancy, 3)}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className={cardClassName("p-4")}>
          <div className="mb-3 text-sm font-medium text-zinc-300">分组列表</div>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={clsx(
                "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition",
                selectedKey === null
                  ? "bg-indigo-500/15 text-indigo-200"
                  : "bg-zinc-950 text-zinc-300 hover:bg-zinc-900"
              )}
            >
              <span>全部</span>
              <span>{Object.keys(source).length}</span>
            </button>
            {groups.map(([key, stat]) => (
              <button
                type="button"
                key={key}
                onClick={() => onSelect(key)}
                className={clsx(
                  "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition",
                  selectedKey === key
                    ? "bg-indigo-500/15 text-indigo-200"
                    : "bg-zinc-950 text-zinc-300 hover:bg-zinc-900"
                )}
              >
                <span>{key}</span>
                <span>{stat.trades}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={cardClassName("p-4")}>
          <div className="mb-3 text-sm font-medium text-zinc-300">已平仓样本</div>
          {loading ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
              加载交易样本中...
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-8 text-center text-sm text-rose-200">
              {error}
            </div>
          ) : filteredTrades.length === 0 ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
              当前筛选下暂无已平仓样本
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-zinc-800">
              <div className="grid grid-cols-[140px_100px_1fr_80px_100px_100px_110px_110px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
                <span>时间</span>
                <span>标的</span>
                <span>策略</span>
                <span>方向</span>
                <span>入场价</span>
                <span>平仓价</span>
                <span>PnL</span>
                <span>退出原因</span>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                {filteredTrades.slice(0, 100).map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[140px_100px_1fr_80px_100px_100px_110px_110px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200"
                  >
                    <span className="text-zinc-400">{formatDateTime(row.closed_at || row.created_at)}</span>
                    <span>{normalizeDisplaySymbol(String(row.symbol || ""))}</span>
                    <span>{String(row.strategy_id || "—")}</span>
                    <span>{String(row.side || "—").toUpperCase()}</span>
                    <span>{formatPrice(Number(row.entry_price || 0), 2)}</span>
                    <span>{formatPrice(Number(row.exit_price || 0), 2)}</span>
                    <span className={clsx(Number(row.realized_pnl || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                      {formatUsd(Number(row.realized_pnl || 0), 3)}
                    </span>
                    <span>{String(row.exit_reason || "—")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
