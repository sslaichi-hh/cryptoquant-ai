import React from "react";
import clsx from "clsx";

import type { AuditSummary, ResearchStat, ResearchWeekly } from "../api";
import { MetricCard, SectionTitle } from "../components/common";
import { cardClassName, formatPrice } from "../utils";

export function AuditPage({
  auditSummary,
  researchWeekly,
  onOpenDrilldown,
}: {
  auditSummary: AuditSummary | null;
  researchWeekly: ResearchWeekly | null;
  onOpenDrilldown: (mode: "regime" | "symbol", selectedKey: string | null) => void;
}) {
  return (
    <div className="space-y-6">
      <SectionTitle title="监控审计" subtitle="汇总指标、影子订单统计和复盘抽屉。" />
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="策略版本" value={auditSummary?.version || "—"} />
        <MetricCard label="AI 快照数" value={String(auditSummary?.counts.aiSnapshots || 0)} />
        <MetricCard label="订单回执" value={String(auditSummary?.counts.orderReceipts || 0)} />
        <MetricCard label="风险事件" value={String(auditSummary?.counts.riskEvents || 0)} />
        <MetricCard label="影子订单" value={String(researchWeekly?.totals.shadowOrders || 0)} />
        <MetricCard label="均滑点" value={`${formatPrice(researchWeekly?.totals.shadowAvgSlippageBps || 0, 2)} bps`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section
          className={clsx(cardClassName("cursor-pointer transition hover:border-indigo-500/30"))}
          onClick={() => onOpenDrilldown("regime", null)}
        >
          <SectionTitle title="按 Regime 复盘" />
          <div className="space-y-2">
            {Object.entries((researchWeekly?.byRegime || {}) as Record<string, ResearchStat>).map(([key, stat]) => (
              <button
                type="button"
                key={key}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenDrilldown("regime", key);
                }}
                className="flex w-full items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-left text-sm text-zinc-200 transition hover:border-zinc-700"
              >
                <span>{key}</span>
                <span>{stat.trades} 笔</span>
              </button>
            ))}
          </div>
        </section>

        <section
          className={clsx(cardClassName("cursor-pointer transition hover:border-indigo-500/30"))}
          onClick={() => onOpenDrilldown("symbol", null)}
        >
          <SectionTitle title="按币种复盘" />
          <div className="space-y-2">
            {Object.entries((researchWeekly?.bySymbol || {}) as Record<string, ResearchStat>).map(([key, stat]) => (
              <button
                type="button"
                key={key}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenDrilldown("symbol", key);
                }}
                className="flex w-full items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-left text-sm text-zinc-200 transition hover:border-zinc-700"
              >
                <span>{key}</span>
                <span>{stat.trades} 笔</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
