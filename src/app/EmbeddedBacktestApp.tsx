import React from "react";

import { apiFetch, type AuthSessionResponse, type SessionUser } from "./api";
import { PageLoading } from "./components/common";
import { useBacktest } from "./hooks/useBacktest";
import { clearToken, readStoredToken } from "./utils";

const BacktestPage = React.lazy(() =>
  import("./pages/BacktestPage").then((module) => ({ default: module.BacktestPage }))
);

function readParentToken() {
  if (typeof window === "undefined") return "";
  try {
    if (window.parent && window.parent !== window && window.parent.location.origin === window.location.origin) {
      return (
        window.parent.sessionStorage.getItem("operator_token") ||
        window.parent.sessionStorage.getItem("cq_admin_token") ||
        ""
      );
    }
  } catch {
    return "";
  }
  return "";
}

function postLegacyBacktestHeight(height: number) {
  if (typeof window === "undefined" || !window.parent || window.parent === window) return;
  window.parent.postMessage(
    {
      type: "cq-legacy-backtest-height",
      height,
    },
    window.location.origin
  );
}

export function EmbeddedBacktestApp() {
  const [token, setToken] = React.useState(() => readStoredToken() || readParentToken());
  const [sessionUser, setSessionUser] = React.useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [toastMessage, setToastMessage] = React.useState("");
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const lastSentHeightRef = React.useRef(0);

  const sessionEnabled = Boolean(sessionUser && token);
  const backtest = useBacktest({
    token,
    onToast: (toast) => setToastMessage(toast.message),
  });

  const postHeight = React.useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    const doc = window.document;
    const nextHeight = Math.ceil(Math.max(
      node.scrollHeight,
      node.getBoundingClientRect().height,
      doc.body?.scrollHeight || 0,
      doc.documentElement?.scrollHeight || 0,
      doc.body?.getBoundingClientRect().height || 0,
      doc.documentElement?.getBoundingClientRect().height || 0
    ));
    if (nextHeight <= 0) return;
    if (Math.abs(nextHeight - lastSentHeightRef.current) < 2) return;
    lastSentHeightRef.current = nextHeight;
    postLegacyBacktestHeight(nextHeight);
  }, []);

  const scheduleHeightSync = React.useCallback(() => {
    if (typeof window === "undefined") return;
    const frameId = window.requestAnimationFrame(postHeight);
    const timers = [120, 500, 1200].map((delay) => window.setTimeout(postHeight, delay));
    return () => {
      window.cancelAnimationFrame(frameId);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [postHeight]);

  React.useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      if (!token) {
        if (!cancelled) {
          setSessionUser(null);
          setAuthChecked(true);
        }
        return;
      }

      try {
        const session = await apiFetch<AuthSessionResponse>("/api/auth/session", { token });
        if (cancelled) return;
        if (session.authenticated && session.user) {
          setSessionUser(session.user);
        } else {
          clearToken();
          setToken("");
          setSessionUser(null);
        }
      } catch {
        if (!cancelled) {
          clearToken();
          setToken("");
          setSessionUser(null);
        }
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    };

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [token]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const node = contentRef.current;
    if (!node) return;

    postHeight();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleHeightSync()) : null;
    observer?.observe(node);
    window.addEventListener("load", postHeight);
    window.addEventListener("resize", postHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener("load", postHeight);
      window.removeEventListener("resize", postHeight);
    };
  }, [postHeight, scheduleHeightSync]);

  React.useEffect(() => {
    return scheduleHeightSync();
  }, [
    authChecked,
    sessionEnabled,
    toastMessage,
    backtest.backtestLoading,
    backtest.backtestError,
    backtest.backtestResult,
    scheduleHeightSync,
  ]);

  if (!authChecked) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <PageLoading title="正在加载 Walk-forward 策略验证..." />
      </div>
    );
  }

  if (!sessionEnabled) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-6 text-sm text-zinc-300">
          请先在 Legacy 控制台登录，再打开 Walk-forward 策略验证。
        </div>
      </div>
    );
  }

  return (
    <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
      {toastMessage ? (
        <div className="mb-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {toastMessage}
        </div>
      ) : null}
      <React.Suspense fallback={<PageLoading title="正在加载 Walk-forward 策略验证..." />}>
        <BacktestPage
          backtestForm={backtest.backtestForm}
          setBacktestForm={backtest.setBacktestForm}
          backtestResult={backtest.backtestResult}
          backtestLoading={backtest.backtestLoading}
          backtestError={backtest.backtestError}
          handleRunBacktest={backtest.handleRunBacktest}
        />
      </React.Suspense>
    </div>
  );
}
