"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  copyErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";

export type ToastKind = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  ms: number;
  /** Optional full support package for error toasts */
  report?: ErrorReport;
};

type ToastInput = {
  kind?: ToastKind;
  title: string;
  detail?: string;
  /** Auto-dismiss ms (default 4.5s success/info, 8s error with report) */
  ms?: number;
  report?: ErrorReport;
};

type ToastApi = {
  push: (t: ToastInput) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string, report?: ErrorReport) => void;
  info: (title: string, detail?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;

function ToastRow({
  t,
  onDismiss,
}: {
  t: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div
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
          <p className="text-[13px] font-semibold leading-snug">{t.title}</p>
          {t.detail && (
            <p className="mt-1 text-[11px] leading-relaxed opacity-80">
              {t.detail}
            </p>
          )}
          {t.report && (
            <p className="mt-1 text-[10px] opacity-55">
              Code{" "}
              <code className="font-mono opacity-90">{t.report.code}</code>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(t.id)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {t.kind === "error" && t.report && (
        <button
          type="button"
          className="mt-2 rounded-md border border-red-300/30 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-100/90 hover:bg-red-500/20"
          onClick={() => {
            void copyErrorReport(t.report!).then((ok) => {
              if (ok) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }
            });
          }}
        >
          {copied ? "Report copied ✓" : "Copy error report"}
        </button>
      )}
    </div>
  );
}

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
        (kind === "error"
          ? t.report
            ? 10000
            : 7000
          : kind === "success"
            ? 4500
            : 4000);
      const item: ToastItem = {
        id,
        kind,
        title: t.title.slice(0, 120),
        detail: t.detail?.slice(0, 220),
        ms,
        report: t.report,
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
      error: (title, detail, report) =>
        push({ kind: "error", title, detail, report }),
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
          <ToastRow key={t.id} t={t} onDismiss={dismiss} />
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
