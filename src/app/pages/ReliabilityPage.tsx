import React from "react";

import type { AutoTradingConfig, OrderLifecycleEvent, RiskState, SecurityEvent } from "../api";
import { MetricCard, SectionTitle } from "../components/common";
import { cardClassName, formatDateTime, formatPrice, formatUsd, riskStatusLabel } from "../utils";
import { normalizeDisplaySymbol } from "../../lib/tradingRuntime";

export function ReliabilityPage({
  riskState,
  autoConfig,
  orderLifecycle,
  securityEvents,
}: {
  riskState: RiskState | null;
  autoConfig: AutoTradingConfig | null;
  orderLifecycle: OrderLifecycleEvent[];
  securityEvents: SecurityEvent[];
}) {
  return (
    <div className="space-y-6">
      <SectionTitle title="执行可靠性" subtitle="账户风控、系统状态、安全事件和订单生命周期。" />
      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          label="账户风控状态"
          value={riskStatusLabel(riskState)}
          hint={riskState ? `${riskState.consecutiveStopLosses} / ${autoConfig?.riskConfigSnapshot.maxConsecutiveLosses || 0}` : undefined}
        />
        <MetricCard label="今日盈亏" value={formatUsd(riskState?.dailyPnL || 0)} trend={(riskState?.dailyPnL || 0) >= 0 ? "up" : "down"} />
        <MetricCard label="宏观门控" value={riskState?.macroGate || "—"} hint={`分数 ${formatPrice(riskState?.macroScore || 0, 2)}`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className={cardClassName()}>
          <SectionTitle title="订单生命周期" />
          <div className="overflow-hidden rounded-2xl border border-zinc-800">
            <div className="grid grid-cols-[150px_100px_80px_90px_100px_120px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
              <span>时间</span>
              <span>标的</span>
              <span>方向</span>
              <span>数量</span>
              <span>状态</span>
              <span>来源</span>
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              {orderLifecycle.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无订单生命周期记录</div>
              ) : (
                orderLifecycle.slice(0, 100).map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[150px_100px_80px_90px_100px_120px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200 last:border-b-0"
                  >
                    <span className="text-zinc-400">{formatDateTime(row.timestamp)}</span>
                    <span>{normalizeDisplaySymbol(row.symbol)}</span>
                    <span>{row.side}</span>
                    <span>{formatPrice(row.amount, 4)}</span>
                    <span>{row.status}</span>
                    <span>{row.source || "—"}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className={cardClassName()}>
          <SectionTitle title="安全事件" />
          <div className="overflow-hidden rounded-2xl border border-zinc-800">
            <div className="grid grid-cols-[160px_1fr_120px_120px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
              <span>时间</span>
              <span>类型</span>
              <span>方法</span>
              <span>来源</span>
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              {securityEvents.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无安全事件</div>
              ) : (
                securityEvents.slice(0, 100).map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[160px_1fr_120px_120px] gap-3 border-b border-zinc-900 px-4 py-3 text-sm text-zinc-200 last:border-b-0"
                  >
                    <span className="text-zinc-400">{formatDateTime(row.timestamp)}</span>
                    <span>{row.type}</span>
                    <span>{row.method || "—"}</span>
                    <span>{row.ip || "—"}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
