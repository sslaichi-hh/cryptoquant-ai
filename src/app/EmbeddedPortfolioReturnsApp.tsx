import React from "react";

import {
  apiFetch,
  type AuthSessionResponse,
  type SessionUser,
} from "./api";
import { PageLoading } from "./components/common";
import { usePortfolioReturnAnalytics } from "./hooks/usePortfolioReturnAnalytics";
import { ReturnAnalyticsModule } from "./pages/PortfolioPage";
import { clearToken, readStoredToken } from "./utils";

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

function postLegacyPortfolioReturnsHeight(height: number) {
  if (typeof window === "undefined" || !window.parent || window.parent === window) return;
  window.parent.postMessage(
    {
      type: "cq-legacy-portfolio-returns-height",
      height,
    },
    window.location.origin
  );
}

export function EmbeddedPortfolioReturnsApp() {
  const [token, setToken] = React.useState(() => readStoredToken() || readParentToken());
  const [sessionUser, setSessionUser] = React.useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const lastSentHeightRef = React.useRef(0);

  const sessionEnabled = Boolean(sessionUser && token);
  const returnAnalyticsRuntime = usePortfolioReturnAnalytics({
    token,
    enabled: sessionEnabled,
    limit: 200,
  });

  const postHeight = React.useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    const nextHeight = Math.ceil(node.getBoundingClientRect().height);
    if (nextHeight <= 0) return;
    if (Math.abs(nextHeight - lastSentHeightRef.current) < 2) return;
    lastSentHeightRef.current = nextHeight;
    postLegacyPortfolioReturnsHeight(nextHeight);
  }, []);

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
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(postHeight) : null;
    observer?.observe(node);
    window.addEventListener("load", postHeight);
    window.addEventListener("resize", postHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener("load", postHeight);
      window.removeEventListener("resize", postHeight);
    };
  }, [postHeight]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.requestAnimationFrame(postHeight);
    return () => window.cancelAnimationFrame(id);
  });

  if (!authChecked) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <PageLoading title="正在加载自动交易收益..." />
      </div>
    );
  }

  if (!sessionEnabled) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-6 text-sm text-zinc-300">
          请先在 Legacy 控制台登录，再打开投资组合收益分析。
        </div>
      </div>
    );
  }

  return (
    <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
      <ReturnAnalyticsModule
        returnMode={returnAnalyticsRuntime.returnMode}
        setReturnMode={returnAnalyticsRuntime.setReturnMode}
        returnRange={returnAnalyticsRuntime.returnRange}
        setReturnRange={returnAnalyticsRuntime.setReturnRange}
        returnAnalytics={returnAnalyticsRuntime.returnAnalytics}
        returnAnalyticsLoadingInitial={returnAnalyticsRuntime.returnAnalyticsLoadingInitial}
        returnAnalyticsRefreshing={returnAnalyticsRuntime.returnAnalyticsRefreshing}
        returnAnalyticsError={returnAnalyticsRuntime.returnAnalyticsError}
        returnAnalyticsStaleWarning={returnAnalyticsRuntime.returnAnalyticsStaleWarning}
      />
    </div>
  );
}
