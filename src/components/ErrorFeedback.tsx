"use client";

import { useState } from "react";
import {
  copyErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";

type Props = {
  report: ErrorReport;
  /** Optional dismiss */
  onDismiss?: () => void;
  className?: string;
};

/**
 * Customer-facing error panel: clear message + one-click copy for support.
 */
export function ErrorFeedback({ report, onDismiss, className = "" }: Props) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const ok = await copyErrorReport(report);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  }

  return (
    <div
      role="alert"
      className={`rounded-xl border border-red-400/35 bg-red-950/40 px-3.5 py-3 text-left ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-100">
            {report.userMessage}
          </p>
          <p className="mt-1 text-[11px] text-red-100/55">
            Error code{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-red-100/80">
              {report.code}
            </code>
            {report.where ? (
              <span className="text-red-100/40"> · {report.where}</span>
            ) : null}
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 text-[11px] text-red-100/50 underline hover:text-red-100/80"
          >
            Dismiss
          </button>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-red-100/60">
        If this keeps happening, copy the error report and send it to{" "}
        <a
          href="https://x.com/its_perseus_1"
          target="_blank"
          rel="noopener noreferrer"
          className="text-red-100/90 underline hover:text-white"
        >
          @its_perseus_1
        </a>{" "}
        — the code helps fix it much faster.
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onCopy()}
          className="rounded-lg border border-red-300/40 bg-red-500/15 px-3 py-1.5 text-[12px] font-medium text-red-100 hover:bg-red-500/25"
        >
          {copied ? "Copied ✓" : "Copy error report"}
        </button>
        <span className="text-[10px] text-red-100/40">
          Includes code, time, and safe technical detail (no secrets)
        </span>
      </div>
    </div>
  );
}
