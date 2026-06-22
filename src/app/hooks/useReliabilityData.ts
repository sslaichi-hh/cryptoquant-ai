import React from "react";

import {
  apiFetch,
  type OrderLifecycleEvent,
  type RiskState,
  type SecurityEvent,
} from "../api";
import { usePollingTask } from "./usePollingTask";

export function useReliabilityData({
  token,
  enabled,
  page,
}: {
  token: string;
  enabled: boolean;
  page: string;
}) {
  const [riskState, setRiskState] = React.useState<RiskState | null>(null);
  const [orderLifecycle, setOrderLifecycle] = React.useState<OrderLifecycleEvent[]>([]);
  const [securityEvents, setSecurityEvents] = React.useState<SecurityEvent[]>([]);

  const refreshRiskState = React.useCallback(async () => {
    const state = await apiFetch<RiskState>("/api/risk/state", { token });
    setRiskState(state);
  }, [token]);

  const refreshReliability = React.useCallback(async () => {
    const [riskPayload, lifecyclePayload, securityPayload] = await Promise.all([
      apiFetch<RiskState>("/api/risk/state", { token }),
      apiFetch<OrderLifecycleEvent[]>("/api/orders/lifecycle", { token }),
      apiFetch<SecurityEvent[]>("/api/security/events", { token }),
    ]);
    setRiskState(riskPayload);
    setOrderLifecycle(lifecyclePayload);
    setSecurityEvents(securityPayload);
  }, [token]);

  usePollingTask(
    React.useCallback(async () => {
      await refreshReliability();
    }, [refreshReliability]),
    enabled && (page === "reliability" || page === "dashboard"),
    [page],
    20_000,
    60_000
  );

  return { riskState, setRiskState, orderLifecycle, securityEvents, refreshRiskState, refreshReliability };
}
