import React from "react";
import clsx from "clsx";

import type { ToastState } from "../utils";

export function ToastView({ toast }: { toast: ToastState }) {
  if (!toast) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <div
        className={clsx(
          "rounded-2xl border px-4 py-3 text-sm shadow-2xl",
          toast.kind === "success"
            ? "border-emerald-500/25 bg-emerald-500/15 text-emerald-100"
            : toast.kind === "error"
              ? "border-rose-500/25 bg-rose-500/15 text-rose-100"
              : "border-zinc-700 bg-zinc-900 text-zinc-100"
        )}
      >
        {toast.message}
      </div>
    </div>
  );
}
