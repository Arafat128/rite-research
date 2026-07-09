"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useEffect, useState, type ReactNode } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { ErrorBoundary } from "./ErrorBoundary";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient());

  useEffect(() => {
    // Prevent OKX/MetaMask inject scripts from becoming unhandled Next.js redboxes
    const onError = (event: ErrorEvent) => {
      const msg = event.message || "";
      const src = event.filename || "";
      if (
        /has not been authorized yet/i.test(msg) ||
        /chrome-extension:\/\//i.test(src) ||
        /chrome-extension:\/\//i.test(msg)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        console.warn("[ignored extension error]", msg || src);
        return true;
      }
      return false;
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : String(reason ?? "");
      if (
        /has not been authorized yet/i.test(msg) ||
        /chrome-extension:\/\//i.test(msg)
      ) {
        event.preventDefault();
        console.warn("[ignored extension rejection]", msg);
      }
    };
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return (
    <ErrorBoundary>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  );
}
