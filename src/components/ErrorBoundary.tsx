"use client";

import React from "react";

type Props = { children: React.ReactNode };
type State = { error: string | null };

/** Suppresses wallet-extension noise that otherwise becomes Next.js redbox. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    const msg = error?.message || String(error);
    // OKX / other injectors throw this when page origin isn't authorized yet
    if (
      /has not been authorized yet/i.test(msg) ||
      /chrome-extension:\/\//i.test(msg) ||
      /Failed to connect to MetaMask/i.test(msg)
    ) {
      return { error: null };
    }
    return { error: msg };
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
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-[#04140c] p-8 text-center text-red-200">
          <p className="mb-3 text-lg font-semibold">Something went wrong</p>
          <p className="mb-4 text-sm opacity-80">{this.state.error}</p>
          <button
            type="button"
            className="rounded-full bg-[#c8ff4a] px-4 py-2 text-sm font-semibold text-black"
            onClick={() => this.setState({ error: null })}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
