import React from "react";

import { getJson, postJson, type BacktestJobPollResponse, type WalkForwardBacktestResponse } from "../api";
import { DEFAULT_STRATEGIES, type BacktestForm } from "../utils";
import { AUTO_TRADING_ALLOWED_SYMBOLS } from "../../lib/tradingRuntime";

type BacktestProgress = {
  jobId: string;
  count: number;
};

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 300; // 10 minutes max

export function useBacktest({
  token,
  onToast,
}: {
  token: string;
  onToast: (toast: { kind: "success" | "error" | "info"; message: string }) => void;
}) {
  const [backtestForm, setBacktestForm] = React.useState<BacktestForm>({
    symbol: AUTO_TRADING_ALLOWED_SYMBOLS[0],
    symbols: [AUTO_TRADING_ALLOWED_SYMBOLS[0]],
    timeframe: "1h",
    strategy: DEFAULT_STRATEGIES[0],
    strategyIds: DEFAULT_STRATEGIES,
    period: 6000,
    initialEquity: 10000,
    trainDays: 180,
    validationDays: 30,
    stepDays: 30,
    stopLoss: 2,
    takeProfit: 6,
    estimatedFeeRate: 0.05,
    minTrainTrades: 5,
    riskPerTradePct: 0.5,
  });
  const [backtestResult, setBacktestResult] = React.useState<WalkForwardBacktestResponse | null>(null);
  const [backtestLoading, setBacktestLoading] = React.useState(false);
  const [backtestError, setBacktestError] = React.useState("");
  const [backtestProgress, setBacktestProgress] = React.useState<BacktestProgress | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  React.useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleRunBacktest = React.useCallback(async () => {
    // Clear previous state
    setBacktestLoading(true);
    setBacktestError("");
    setBacktestResult(null);
    setBacktestProgress(null);
    if (pollRef.current) clearInterval(pollRef.current);

    try {
      // Step 1: Submit the job
      const { jobId } = await postJson<{ jobId: string; status: string }>(
        "/api/backtest/walk-forward",
        backtestForm,
        { token }
      );

      setBacktestLoading(false);
      setBacktestProgress({ jobId, count: 0 });

      // Step 2: Poll for results
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        setBacktestProgress({ jobId, count: attempts });

        if (attempts >= POLL_MAX_ATTEMPTS) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setBacktestProgress(null);
          setBacktestError("回测超时：任务未在10分钟内完成，请缩短训练/验证窗口或减少品种数量");
          onToast({ kind: "error", message: "回测超时" });
          return;
        }

        try {
          const pollResult = await getJson<BacktestJobPollResponse>(
            `/api/backtest/walk-forward/${encodeURIComponent(jobId)}`,
            { token }
          );

          if (pollResult.status === "done" && pollResult.result) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setBacktestProgress(null);
            setBacktestResult(pollResult.result);
            onToast({ kind: "success", message: "回测完成" });
          } else if (pollResult.status === "error") {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setBacktestProgress(null);
            const msg = pollResult.error?.slice(0, 1200) || "回测服务器错误";
            setBacktestError(msg);
            onToast({ kind: "error", message: msg });
          }
          // else: still processing, continue polling
        } catch (pollErr: any) {
          // Don't stop on transient poll errors — keep trying
          if (attempts >= POLL_MAX_ATTEMPTS) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setBacktestProgress(null);
            setBacktestError("回测超时：轮询请求失败，请检查服务器状态");
          }
        }
      }, POLL_INTERVAL_MS);
    } catch (error: any) {
      setBacktestLoading(false);
      setBacktestProgress(null);
      const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
      const details = payload?.bySymbol ? ` ${JSON.stringify(payload.bySymbol)}` : "";
      const message = `${error?.message || "回测失败"}${details}`.slice(0, 1200);
      setBacktestError(message);
      onToast({ kind: "error", message: error?.message || "回测失败" });
    }
  }, [backtestForm, onToast, token]);

  return {
    backtestForm,
    setBacktestForm,
    backtestResult,
    backtestLoading,
    backtestError,
    backtestProgress,
    handleRunBacktest,
  };
}
