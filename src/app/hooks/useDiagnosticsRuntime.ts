import React from "react";

import {
  apiFetch,
  type AutoTradingCycleSummary,
  type AutoTradingTrace,
  type ShadowOrder,
  type ShadowSummary,
} from "../api";
import { usePollingTask } from "./usePollingTask";

export function useDiagnosticsRuntime({
  token,
  enabled,
}: {
  token: string;
  enabled: boolean;
}) {
  const [diagnosticsTraces, setDiagnosticsTraces] = React.useState<AutoTradingTrace[]>([]);
  const [diagnosticsCycles, setDiagnosticsCycles] = React.useState<AutoTradingCycleSummary[]>([]);
  const [shadowSummary, setShadowSummary] = React.useState<ShadowSummary | null>(null);
  const [shadowOpenOrders, setShadowOpenOrders] = React.useState<ShadowOrder[]>([]);
  const [shadowClosedOrders, setShadowClosedOrders] = React.useState<ShadowOrder[]>([]);

  const refreshDiagnostics = React.useCallback(
    async (signal?: AbortSignal) => {
      const [cyclesPayload, tracesPayload, summaryPayload, openPayload, closedPayload] = await Promise.all([
        apiFetch<AutoTradingCycleSummary[]>("/api/auto-trading/cycles?limit=50", { token, signal }),
        apiFetch<AutoTradingTrace[]>("/api/auto-trading/traces?limit=200", { token, signal }),
        apiFetch<ShadowSummary>("/api/shadow/summary", { token, signal }),
        apiFetch<ShadowOrder[]>("/api/shadow/orders?status=open&limit=100", { token, signal }),
        apiFetch<ShadowOrder[]>("/api/shadow/orders?status=closed&limit=100", { token, signal }),
      ]);

      setDiagnosticsCycles(cyclesPayload);
      setDiagnosticsTraces(tracesPayload);
      setShadowSummary(summaryPayload);
      setShadowOpenOrders(openPayload);
      setShadowClosedOrders(closedPayload);
    },
    [token]
  );

  usePollingTask(
    React.useCallback(async (signal) => {
      await refreshDiagnostics(signal);
    }, [refreshDiagnostics]),
    enabled,
    [token],
    15_000,
    60_000
  );

  return {
    diagnosticsTraces,
    diagnosticsCycles,
    shadowSummary,
    shadowOpenOrders,
    shadowClosedOrders,
    refreshDiagnostics,
  };
}
