import React from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { AutoTradingCycleSummary, AutoTradingTrace, ShadowOrder, ShadowSummary } from "../api";
import { MetricCard, SectionTitle } from "../components/common";
import {
  cardClassName,
  exitReasonLabel,
  formatDateTime,
  formatPrice,
  formatUsd,
  parseJsonSafely,
  stageLabel,
} from "../utils";

function abbreviateCycleId(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "—";
  if (text.length <= 20) return text;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

export function DiagnosticsPage({
  diagnosticsCycles,
  diagnosticsDate,
  setDiagnosticsDate,
  diagnosticsPage,
  setDiagnosticsPage,
  tracePageCount,
  filteredTraces,
  visibleTraces,
  selectedTraceId,
  setSelectedTraceId,
  selectedTrace,
  shadowSummary,
  shadowOpenOrders,
  shadowClosedOrders,
  selectedShadowOrderId,
  setSelectedShadowOrderId,
  selectedShadowOrder,
  embedded = false,
}: {
  diagnosticsCycles: AutoTradingCycleSummary[];
  diagnosticsDate: string;
  setDiagnosticsDate: React.Dispatch<React.SetStateAction<string>>;
  diagnosticsPage: number;
  setDiagnosticsPage: React.Dispatch<React.SetStateAction<number>>;
  tracePageCount: number;
  filteredTraces: AutoTradingTrace[];
  visibleTraces: AutoTradingTrace[];
  selectedTraceId: string | null;
  setSelectedTraceId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedTrace: AutoTradingTrace | null;
  shadowSummary: ShadowSummary | null;
  shadowOpenOrders: ShadowOrder[];
  shadowClosedOrders: ShadowOrder[];
  selectedShadowOrderId: string | null;
  setSelectedShadowOrderId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedShadowOrder: ShadowOrder | null;
  embedded?: boolean;
}) {
  return (
    <div className="space-y-6">
      <SectionTitle title="策略诊断" subtitle="最近周期漏斗、阻断明细、影子持仓与平仓记录。" />
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard
          label="最近周期"
          value={abbreviateCycleId(diagnosticsCycles[0]?.cycleId)}
          valueTitle={diagnosticsCycles[0]?.cycleId || undefined}
          hint={formatDateTime(diagnosticsCycles[0]?.startedAt)}
        />
        <MetricCard label="扫描标的" value={String(diagnosticsCycles[0]?.scannedSymbols || 0)} />
        <MetricCard label="扫描目标" value={String(diagnosticsCycles[0]?.scannedTargets || 0)} />
        <MetricCard label="耗时" value={`${diagnosticsCycles[0]?.durationMs || 0} ms`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_420px]">
        <section className={cardClassName()}>
          <SectionTitle
            title="阻断明细表"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-200">
                  默认每页 10 条
                </div>
                <input
                  type="date"
                  value={diagnosticsDate}
                  onChange={(event) => {
                    setDiagnosticsDate(event.target.value);
                    setDiagnosticsPage(1);
                  }}
                  className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDiagnosticsDate("");
                    setDiagnosticsPage(1);
                  }}
                  className="rounded-xl border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200"
                >
                  全部日期
                </button>
              </div>
            }
          />
          <div className="overflow-hidden rounded-2xl border border-zinc-800">
            <div className="grid grid-cols-[150px_90px_70px_1fr_90px_90px_100px_140px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
              <span>时间</span>
              <span>标的</span>
              <span>周期</span>
              <span>策略</span>
              <span>信号</span>
              <span>置信度</span>
              <span>阻断阶段</span>
              <span>原因</span>
            </div>
            <div className="max-h-[520px] overflow-y-auto">
              {visibleTraces.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无诊断记录</div>
              ) : (
                visibleTraces.map((trace) => (
                  <button
                    type="button"
                    key={trace.id}
                    onClick={() => setSelectedTraceId(trace.id)}
                    className={clsx(
                      "grid w-full grid-cols-[150px_90px_70px_1fr_90px_90px_100px_140px] gap-3 border-b border-zinc-900 px-4 py-3 text-left text-sm transition last:border-b-0",
                      selectedTraceId === trace.id ? "bg-indigo-500/10 text-indigo-100" : "text-zinc-200 hover:bg-zinc-950/70"
                    )}
                  >
                    <span className="text-zinc-400">{formatDateTime(trace.createdAt)}</span>
                    <span>{trace.symbol}</span>
                    <span>{trace.timeframe}</span>
                    <span>{trace.strategyId}</span>
                    <span>{trace.signal}</span>
                    <span>{trace.confidence} / {trace.requiredConfidence}</span>
                    <span className="text-amber-300">{stageLabel(trace.blockedAt)}</span>
                    <span className="truncate text-zinc-400">{trace.blockedReason || "—"}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 text-sm text-zinc-400">
            <div>共 {filteredTraces.length} 条，当前第 {Math.min(diagnosticsPage, tracePageCount)} / {tracePageCount} 页</div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={diagnosticsPage <= 1}
                onClick={() => setDiagnosticsPage((current) => Math.max(1, current - 1))}
                className="inline-flex items-center gap-1 rounded-xl border border-zinc-700 px-3 py-1.5 text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </button>
              <button
                type="button"
                disabled={diagnosticsPage >= tracePageCount}
                onClick={() => setDiagnosticsPage((current) => Math.min(tracePageCount, current + 1))}
                className="inline-flex items-center gap-1 rounded-xl border border-zinc-700 px-3 py-1.5 text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        <section
          className={cardClassName(
            embedded ? "self-start" : "xl:sticky xl:top-6 self-start max-h-[calc(100vh-96px)] overflow-hidden"
          )}
        >
          <SectionTitle title="步骤详情" />
          {selectedTrace ? (
            <div
              className={clsx(
                "space-y-4 pr-1",
                embedded ? "" : "max-h-[calc(100vh-176px)] overflow-y-auto"
              )}
            >
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="text-sm text-zinc-400">交易上下文</div>
                <div className="mt-2 space-y-1 text-sm text-zinc-200">
                  <div>标的：{selectedTrace.symbol}</div>
                  <div>周期：{selectedTrace.timeframe}</div>
                  <div>策略：{selectedTrace.strategyId}</div>
                  <div>阻断阶段：<span className="text-amber-300">{stageLabel(selectedTrace.blockedAt)}</span></div>
                  <div>原因：{selectedTrace.blockedReason || "—"}</div>
                </div>
              </div>

              <div className="space-y-3">
                {selectedTrace.steps.map((step) => (
                  <div key={`${selectedTrace.id}-${step.name}-${step.at}`} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="font-medium text-zinc-100">{stageLabel(step.name)}</div>
                      <div
                        className={clsx(
                          "rounded-full px-3 py-1 text-xs font-medium",
                          step.status === "pass"
                            ? "bg-emerald-500/15 text-emerald-200"
                            : step.status === "fail"
                              ? "bg-rose-500/15 text-rose-200"
                              : "bg-zinc-800 text-zinc-300"
                    )}
                  >
                    {step.status}
                  </div>
                </div>
                {step.reason ? <div className="mt-2 text-sm text-zinc-400">{step.reason}</div> : null}
                {step.metrics ? (
                      <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-400">
                        {JSON.stringify(step.metrics, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
              选择一条阻断记录以查看步骤详情。
            </div>
          )}
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="开放持仓数" value={String(shadowSummary?.openCount || 0)} />
        <MetricCard label="已平仓数" value={String(shadowSummary?.closedCount || 0)} />
        <MetricCard label="当前浮盈亏" value={formatUsd(shadowSummary?.unrealizedPnl || 0, 3)} trend={(shadowSummary?.unrealizedPnl || 0) >= 0 ? "up" : "down"} />
        <MetricCard label="已实现盈亏" value={formatUsd(shadowSummary?.realizedPnl || 0, 3)} trend={(shadowSummary?.realizedPnl || 0) >= 0 ? "up" : "down"} />
        <MetricCard label="胜率" value={formatPrice(shadowSummary?.winRate || 0, 2) + "%"} />
        <MetricCard label="估算单数" value={String(shadowSummary?.estimatedCount || 0)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_420px]">
        <div className="space-y-6">
          <section className={cardClassName()}>
            <SectionTitle title="影子持仓" />
            <div className="overflow-hidden rounded-2xl border border-zinc-800">
              <div className="grid grid-cols-[100px_70px_70px_100px_100px_100px_110px_90px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
                <span>标的</span>
                <span>周期</span>
                <span>方向</span>
                <span>开仓价</span>
                <span>标记价</span>
                <span>止盈 / 止损</span>
                <span>浮盈亏</span>
                <span>来源</span>
              </div>
              <div className="max-h-[320px] overflow-y-auto">
                {shadowOpenOrders.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无影子持仓</div>
                ) : (
                  shadowOpenOrders.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      onClick={() => setSelectedShadowOrderId(row.id)}
                      className={clsx(
                        "grid w-full grid-cols-[100px_70px_70px_100px_100px_100px_110px_90px] gap-3 border-b border-zinc-900 px-4 py-3 text-left text-sm transition last:border-b-0",
                        selectedShadowOrderId === row.id ? "bg-indigo-500/10 text-indigo-100" : "text-zinc-200 hover:bg-zinc-950/70"
                      )}
                    >
                      <span>{row.symbol}</span>
                      <span>{row.timeframe || "—"}</span>
                      <span>{row.side}</span>
                      <span>{formatPrice(row.entry_price, 2)}</span>
                      <span>{formatPrice(row.mark_price, 2)}</span>
                      <span>{formatPrice(row.tp_price, 2)} / {formatPrice(row.sl_price, 2)}</span>
                      <span className={clsx(Number(row.unrealized_pnl || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                        {formatUsd(row.unrealized_pnl, 3)}
                      </span>
                      <span>{row.is_estimated ? "估算" : "实时"}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className={cardClassName()}>
            <SectionTitle title="影子平仓记录" />
            <div className="overflow-hidden rounded-2xl border border-zinc-800">
              <div className="grid grid-cols-[100px_70px_70px_100px_100px_110px_110px_90px] gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 text-xs uppercase tracking-wide text-zinc-500">
                <span>标的</span>
                <span>周期</span>
                <span>方向</span>
                <span>开仓价</span>
                <span>平仓价</span>
                <span>已实现盈亏</span>
                <span>退出原因</span>
                <span>来源</span>
              </div>
              <div className="max-h-[320px] overflow-y-auto">
                {shadowClosedOrders.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无影子平仓记录</div>
                ) : (
                  shadowClosedOrders.map((row) => (
                    <button
                      type="button"
                      key={row.id}
                      onClick={() => setSelectedShadowOrderId(row.id)}
                      className={clsx(
                        "grid w-full grid-cols-[100px_70px_70px_100px_100px_110px_110px_90px] gap-3 border-b border-zinc-900 px-4 py-3 text-left text-sm transition last:border-b-0",
                        selectedShadowOrderId === row.id ? "bg-indigo-500/10 text-indigo-100" : "text-zinc-200 hover:bg-zinc-950/70"
                      )}
                    >
                      <span>{row.symbol}</span>
                      <span>{row.timeframe || "—"}</span>
                      <span>{row.side}</span>
                      <span>{formatPrice(row.entry_price, 2)}</span>
                      <span>{formatPrice(row.exit_price, 2)}</span>
                      <span className={clsx(Number(row.realized_pnl || 0) >= 0 ? "text-emerald-300" : "text-rose-300")}>
                        {formatUsd(row.realized_pnl, 3)}
                      </span>
                      <span>{exitReasonLabel(row.exit_reason)}</span>
                      <span>{row.is_estimated ? "估算" : "实时"}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>

        <section
          className={cardClassName(
            embedded ? "self-start" : "xl:sticky xl:top-6 self-start max-h-[calc(100vh-96px)] overflow-hidden"
          )}
        >
          <SectionTitle title="影子订单详情" />
          {selectedShadowOrder ? (
            <div
              className={clsx(
                "space-y-4 pr-1",
                embedded ? "" : "max-h-[calc(100vh-176px)] overflow-y-auto"
              )}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <MetricCard label="理论价" value={formatPrice(selectedShadowOrder.theoretical_price, 2)} />
                <MetricCard label="可成交价" value={formatPrice(selectedShadowOrder.executable_price, 2)} />
                <MetricCard label="Spread" value={`${formatPrice(selectedShadowOrder.spread_bps, 2)} bps`} />
                <MetricCard label="滑点" value={`${formatPrice(selectedShadowOrder.slippage_bps, 2)} bps`} />
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-200">signal_json</div>
                <pre className="max-h-72 overflow-auto text-xs text-zinc-400">
                  {JSON.stringify(parseJsonSafely(selectedShadowOrder.signal_json), null, 2)}
                </pre>
              </div>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-200">orderbook_json</div>
                <pre className="max-h-72 overflow-auto text-xs text-zinc-400">
                  {JSON.stringify(parseJsonSafely(selectedShadowOrder.orderbook_json), null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-8 text-center text-sm text-zinc-500">
              选择一条影子记录以查看详情。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
