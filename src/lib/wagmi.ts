"use client";

import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { ritualChain, RPC_URL } from "./ritual";

/**
 * Prefer MetaMask when multiple injectors exist (OKX often throws
 * "source has not been authorized yet" on localhost).
 */
function getPreferredProvider():
  | { request: (...args: unknown[]) => Promise<unknown>; isMetaMask?: boolean }
  | undefined {
  if (typeof window === "undefined") return undefined;
  const eth = (
    window as unknown as {
      ethereum?: {
        providers?: Array<{ isMetaMask?: boolean; isOkxWallet?: boolean }>;
        isMetaMask?: boolean;
        isOkxWallet?: boolean;
        request: (...args: unknown[]) => Promise<unknown>;
      };
    }
  ).ethereum;
  if (!eth) return undefined;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    const mm = eth.providers.find((p) => p.isMetaMask && !p.isOkxWallet);
    return (mm || eth.providers[0]) as {
      request: (...args: unknown[]) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
  return eth as {
    request: (...args: unknown[]) => Promise<unknown>;
    isMetaMask?: boolean;
  };
}

export const wagmiConfig = createConfig({
  chains: [ritualChain],
  connectors: [
    injected({
      shimDisconnect: true,
      // Use preferred provider when available
      target() {
        const provider = getPreferredProvider();
        if (!provider) return undefined;
        return {
          id: "injected",
          name: provider.isMetaMask ? "MetaMask" : "Injected",
          provider: provider as never,
        };
      },
    }),
  ],
  transports: {
    [ritualChain.id]: http(RPC_URL),
  },
  ssr: true,
});
