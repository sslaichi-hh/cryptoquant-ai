import React from "react";

function usePageVisibility() {
  const [visible, setVisible] = React.useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible"
  );

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const handle = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);

  return visible;
}

export function usePollingTask(
  task: (signal: AbortSignal) => Promise<void>,
  enabled: boolean,
  deps: React.DependencyList,
  visibleIntervalMs: number,
  hiddenIntervalMs: number
) {
  const visible = usePageVisibility();

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeoutId: number | undefined;
    let controller: AbortController | null = null;

    const run = async () => {
      if (cancelled) return;
      controller = new AbortController();
      try {
        await task(controller.signal);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error(error);
        }
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(run, visible ? visibleIntervalMs : hiddenIntervalMs);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller?.abort();
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [enabled, visible, visibleIntervalMs, hiddenIntervalMs, task, ...deps]);
}
