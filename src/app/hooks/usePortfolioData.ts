import React from "react";

import {
  apiFetch,
  postJson,
  type BalanceResponse,
  type HistoryOrderRow,
  type PositionRow,
  type RealizedPnlResponse,
  type TradeRow,
} from "../api";
import { usePollingTask } from "./usePollingTask";
import { usePortfolioReturnAnalytics } from "./usePortfolioReturnAnalytics";

export function usePortfolioData({
  token,
  enabled,
  page,
  selectedSymbol,
  sandbox,
}: {
  token: string;
  enabled: boolean;
  page: string;
  selectedSymbol: string;
  sandbox: boolean;
}) {
  const [balance, setBalance] = React.useState<BalanceResponse | null>(null);
  const [positions, setPositions] = React.useState<PositionRow[]>([]);
  const [historyOrders, setHistoryOrders] = React.useState<HistoryOrderRow[]>([]);
  const [localTrades, setLocalTrades] = React.useState<TradeRow[]>([]);
  const [realizedPnl, setRealizedPnl] = React.useState<RealizedPnlResponse | null>(null);
  const returnAnalyticsRuntime = usePortfolioReturnAnalytics({
    token,
    enabled: enabled && page === "portfolio",
    limit: 200,
  });

  const refreshPortfolio = React.useCallback(async () => {
    const [balancePayload, positionsPayload, pnlPayload] = await Promise.all([
      postJson<BalanceResponse>("/api/okx/balance", { sandbox }, { token }),
      postJson<PositionRow[]>("/api/okx/positions", { sandbox }, { token }),
      postJson<RealizedPnlResponse>("/api/okx/realized-pnl", { sandbox }, { token }),
    ]);
    setBalance(balancePayload);
    setPositions(positionsPayload);
    setRealizedPnl(pnlPayload);
  }, [sandbox, token]);

  const refreshHistory = React.useCallback(async () => {
    const [historyPayload, tradesPayload] = await Promise.all([
      postJson<HistoryOrderRow[]>("/api/okx/history", { symbol: selectedSymbol, sandbox }, { token }),
      apiFetch<TradeRow[]>("/api/trades?limit=200", { token }),
    ]);
    setHistoryOrders(historyPayload);
    setLocalTrades(tradesPayload);
  }, [sandbox, selectedSymbol, token]);

  usePollingTask(
    React.useCallback(async () => {
      await refreshPortfolio();
    }, [refreshPortfolio]),
    enabled && (page === "dashboard" || page === "portfolio"),
    [page, sandbox],
    20_000,
    60_000
  );

  usePollingTask(
    React.useCallback(async () => {
      await refreshHistory();
    }, [refreshHistory]),
    enabled && page === "history",
    [page, selectedSymbol, sandbox],
    20_000,
    60_000
  );

  return {
    balance,
    positions,
    historyOrders,
    localTrades,
    realizedPnl,
    ...returnAnalyticsRuntime,
    refreshPortfolio,
    refreshHistory,
  };
}
