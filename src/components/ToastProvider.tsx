"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  ms: number;
};

type ToastInput = {
  kind?: ToastKind;
  title: string;
  detail?: string;
  /** Auto-dismiss ms (default 4.5s success/info, 6.5s error) */
  ms?: number;
};

type ToastApi = {
  push: (t: ToastInput) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const kind = t.kind || "info";
      const id = `t-${++toastSeq}-${Date.now()}`;
      const ms =
        t.ms ??
        (kind === "error" ? 6500 : kind === "success" ? 4500 : 4000);
      const item: ToastItem = {
        id,
        kind,
        title: t.title.slice(0, 120),
        detail: t.detail?.slice(0, 200),
        ms,
      };
      setItems((prev) => [...prev.slice(-4), item]); // cap stack
      window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, detail) => push({ kind: "success", title, detail }),
      error: (title, detail) => push({ kind: "error", title, detail }),
      info: (title, detail) => push({ kind: "info", title, detail }),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-xl border px-3.5 py-3 shadow-lg backdrop-blur-md transition ${
              t.kind === "success"
                ? "border-[#c8ff4a]/40 bg-[#0d1f12]/95 text-[#d8f5a0]"
                : t.kind === "error"
                  ? "border-red-400/40 bg-[#2a1010]/95 text-red-100"
                  : "border-white/15 bg-black/90 text-white/85"
            }`}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-snug">
                  {t.title}
                </p>
                {t.detail && (
                  <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                    {t.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] opacity-60 hover:opacity-100"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Safe no-op outside provider (tests / SSR)
    return {
      push: () => undefined,
      success: () => undefined,
      error: () => undefined,
      info: () => undefined,
    };
  }
  return ctx;
}
