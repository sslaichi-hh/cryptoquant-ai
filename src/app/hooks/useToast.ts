import React from "react";

import type { ToastState } from "../utils";

export function useToast() {
  const [toast, setToast] = React.useState<ToastState>(null);

  React.useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  return { toast, setToast };
}
