import React from "react";

import { apiFetch, type AuthSessionResponse, type SessionUser } from "./api";
import { PageLoading } from "./components/common";
import { useDiagnosticsRuntime } from "./hooks/useDiagnosticsRuntime";
import { clearToken, formatDateOnly, readStoredToken } from "./utils";

const DiagnosticsPage = React.lazy(() =>
  import("./pages/DiagnosticsPage").then((module) => ({ default: module.DiagnosticsPage }))
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

function postLegacyDiagnosticsHeight(height: number) {
  if (typeof window === "undefined" || !window.parent || window.parent === window) return;
  window.parent.postMessage(
    {
      type: "cq-legacy-diagnostics-height",
      height,
    },
    window.location.origin
  );
}

export function EmbeddedDiagnosticsApp() {
  const [token, setToken] = React.useState(() => readStoredToken() || readParentToken());
  const [sessionUser, setSessionUser] = React.useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [diagnosticsDate, setDiagnosticsDate] = React.useState("");
  const [diagnosticsPage, setDiagnosticsPage] = React.useState(1);
  const [selectedTraceId, setSelectedTraceId] = React.useState<string | null>(null);
  const [selectedShadowOrderId, setSelectedShadowOrderId] = React.useState<string | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const lastSentHeightRef = React.useRef(0);

  const sessionEnabled = Boolean(sessionUser && token);
  const {
    diagnosticsTraces,
    diagnosticsCycles,
    shadowSummary,
    shadowOpenOrders,
    shadowClosedOrders,
    refreshDiagnostics,
  } = useDiagnosticsRuntime({
    token,
    enabled: sessionEnabled,
  });

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
    if (!sessionEnabled) return;
    void refreshDiagnostics();
  }, [refreshDiagnostics, sessionEnabled]);

  const filteredTraces = React.useMemo(() => {
    return diagnosticsTraces.filter((trace) => {
      if (!diagnosticsDate) return true;
      return formatDateOnly(trace.createdAt) === diagnosticsDate;
    });
  }, [diagnosticsDate, diagnosticsTraces]);

  const tracePageCount = Math.max(1, Math.ceil(filteredTraces.length / 10));

  const visibleTraces = React.useMemo(() => {
    const pageIndex = Math.min(diagnosticsPage, tracePageCount) - 1;
    return filteredTraces.slice(pageIndex * 10, pageIndex * 10 + 10);
  }, [diagnosticsPage, filteredTraces, tracePageCount]);

  React.useEffect(() => {
    if (diagnosticsPage > tracePageCount) setDiagnosticsPage(tracePageCount);
  }, [diagnosticsPage, tracePageCount]);

  React.useEffect(() => {
    if (!visibleTraces.length) {
      setSelectedTraceId(null);
      return;
    }
    const visibleIds = new Set(visibleTraces.map((trace) => trace.id));
    if (!selectedTraceId || !visibleIds.has(selectedTraceId)) {
      setSelectedTraceId(visibleTraces[0].id);
    }
  }, [selectedTraceId, visibleTraces]);

  React.useEffect(() => {
    const availableIds = new Set(
      shadowOpenOrders.concat(shadowClosedOrders).map((order) => order.id)
    );
    if (!availableIds.size) {
      setSelectedShadowOrderId(null);
      return;
    }
    if (!selectedShadowOrderId || !availableIds.has(selectedShadowOrderId)) {
      setSelectedShadowOrderId(shadowOpenOrders[0]?.id || shadowClosedOrders[0]?.id || null);
    }
  }, [selectedShadowOrderId, shadowClosedOrders, shadowOpenOrders]);

  const selectedTrace = diagnosticsTraces.find((trace) => trace.id === selectedTraceId) || null;
  const selectedShadowOrder =
    shadowOpenOrders.concat(shadowClosedOrders).find((order) => order.id === selectedShadowOrderId) || null;

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const node = contentRef.current;
    if (!node) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      if (Math.abs(nextHeight - lastSentHeightRef.current) < 2) return;
      lastSentHeightRef.current = nextHeight;
      postLegacyDiagnosticsHeight(nextHeight);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    window.addEventListener("load", updateHeight);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("load", updateHeight);
      window.removeEventListener("resize", updateHeight);
    };
  }, [
    authChecked,
    diagnosticsCycles,
    shadowClosedOrders,
    shadowOpenOrders,
    shadowSummary,
    filteredTraces.length,
    selectedShadowOrderId,
    selectedTraceId,
    tracePageCount,
    visibleTraces.length,
  ]);

  if (!authChecked) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <PageLoading title="正在加载策略诊断..." />
      </div>
    );
  }

  if (!sessionEnabled) {
    return (
      <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
        <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-6 text-sm text-zinc-300">
          请先在 Legacy 控制台登录，再打开策略诊断。
        </div>
      </div>
    );
  }

  return (
    <div ref={contentRef} className="bg-zinc-950/0 px-6 py-6 text-zinc-100">
      <React.Suspense fallback={<PageLoading title="正在加载策略诊断..." />}>
        <DiagnosticsPage
          diagnosticsCycles={diagnosticsCycles}
          diagnosticsDate={diagnosticsDate}
          setDiagnosticsDate={setDiagnosticsDate}
          diagnosticsPage={diagnosticsPage}
          setDiagnosticsPage={setDiagnosticsPage}
          tracePageCount={tracePageCount}
          filteredTraces={filteredTraces}
          visibleTraces={visibleTraces}
          selectedTraceId={selectedTraceId}
          setSelectedTraceId={setSelectedTraceId}
          selectedTrace={selectedTrace}
          shadowSummary={shadowSummary}
          shadowOpenOrders={shadowOpenOrders}
          shadowClosedOrders={shadowClosedOrders}
          selectedShadowOrderId={selectedShadowOrderId}
          setSelectedShadowOrderId={setSelectedShadowOrderId}
          selectedShadowOrder={selectedShadowOrder}
          embedded
        />
      </React.Suspense>
    </div>
  );
}
