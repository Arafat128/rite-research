"use client";

import React from "react";
import {
  buildErrorReport,
  copyErrorReport,
  rememberErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";

type Props = { children: React.ReactNode };
type State = { report: ErrorReport | null };

/** Suppresses wallet-extension noise that otherwise becomes Next.js redbox. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { report: null };

  static getDerivedStateFromError(error: Error): State {
    const msg = error?.message || String(error);
    // OKX / other injectors throw this when page origin isn't authorized yet
    if (
      /has not been authorized yet/i.test(msg) ||
      /chrome-extension:\/\//i.test(msg) ||
      /Failed to connect to MetaMask/i.test(msg)
    ) {
      return { report: null };
    }
    const report = buildErrorReport(error, {
      where: "ui.crash",
      userMessage: "Something went wrong loading this page.",
    });
    return { report };
  }

  componentDidCatch(error: Error) {
    const msg = error?.message || String(error);
    if (
      /has not been authorized yet/i.test(msg) ||
      /chrome-extension:\/\//i.test(msg)
    ) {
      console.warn("[wallet-extension ignored]", msg);
      return;
    }
    console.error("[ErrorBoundary]", error);
    if (this.state.report) rememberErrorReport(this.state.report);
  }

  render() {
    const { report } = this.state;
    if (report) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#04140c] p-6">
          <div className="w-full max-w-md rounded-2xl border border-red-400/30 bg-black/50 p-6 text-center">
            <p className="mb-1 text-lg font-semibold text-red-100">
              Something went wrong
            </p>
            <p className="mb-3 text-sm text-red-100/70">{report.userMessage}</p>
            <p className="mb-4 text-[11px] text-white/40">
              Error code{" "}
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/70">
                {report.code}
              </code>
            </p>
            <p className="mb-4 text-[11px] leading-relaxed text-white/45">
              Copy the error report and send it to{" "}
              <a
                href="https://x.com/its_perseus_1"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8ff4a]/80 underline"
              >
                @its_perseus_1
              </a>{" "}
              so we can fix it quickly.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="rounded-full border border-[#c8ff4a]/40 bg-[#c8ff4a]/15 px-4 py-2 text-sm font-semibold text-[#c8ff4a]"
                onClick={() => void copyErrorReport(report)}
              >
                Copy error report
              </button>
              <button
                type="button"
                className="rounded-full bg-[#c8ff4a] px-4 py-2 text-sm font-semibold text-black"
                onClick={() => {
                  this.setState({ report: null });
                  if (typeof window !== "undefined") window.location.reload();
                }}
              >
                Reload app
              </button>
              <button
                type="button"
                className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/70"
                onClick={() => this.setState({ report: null })}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
