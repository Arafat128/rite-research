"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useBalance,
} from "wagmi";
import { formatEther } from "viem";
import { ritualChain } from "@/lib/ritual";

/** Lazy-load heavy tabs so first paint stays fast */
const ResearchTab = dynamic(
  () => import("./ResearchTab").then((m) => ({ default: m.ResearchTab })),
  {
    ssr: false,
    loading: () => (
      <p className="py-12 text-center text-sm text-white/40">Loading research…</p>
    ),
  }
);
const RecordsTab = dynamic(
  () => import("./RecordsTab").then((m) => ({ default: m.RecordsTab })),
  {
    ssr: false,
    loading: () => (
      <p className="py-12 text-center text-sm text-white/40">Loading records…</p>
    ),
  }
);
const ProductAgentsShell = dynamic(
  () =>
    import("./ProductAgentsShell").then((m) => ({
      default: m.ProductAgentsShell,
    })),
  {
    ssr: false,
    loading: () => (
      <p className="py-12 text-center text-sm text-white/40">Loading agents…</p>
    ),
  }
);
const OracastMarketTab = dynamic(
  () =>
    import("./OracastMarketTab").then((m) => ({
      default: m.OracastMarketTab,
    })),
  {
    ssr: false,
    loading: () => (
      <p className="py-12 text-center text-sm text-white/40">
        Loading Oracast Alert…
      </p>
    ),
  }
);
const BountyBanner = dynamic(
  () => import("./BountyBanner").then((m) => ({ default: m.BountyBanner })),
  { ssr: false }
);
const TelegramNotifyCard = dynamic(
  () =>
    import("./TelegramNotifyCard").then((m) => ({
      default: m.TelegramNotifyCard,
    })),
  { ssr: false }
);

type Tab = "research" | "records" | "deploy" | "agents" | "markets";

export function AppShell() {
  const [tab, setTab] = useState<Tab>("research");
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: bal } = useBalance({ address });

  const wrongChain = isConnected && chainId !== ritualChain.id;

  /**
   * Keepalive while ANY Rite tab is open (wallet connected):
   * - Oracast 5m/15m price DMs
   * - Radar data-agent auto-wake (was only on My Agents — switching tabs
   *   stopped the 3rd+ tick)
   * Visibility/focus re-poke (background tabs throttle timers).
   * Fully closed tab → Agent keeper GH Action long loop.
   */
  useEffect(() => {
    if (!address || !isConnected) return;
    const headers = { "Content-Type": "application/json" };
    const bodyOracast = JSON.stringify({ owner: address, max: 12 });
    const bodyWake = JSON.stringify({ owner: address, max: 20 });
    const poke = () => {
      void fetch("/api/oracast/tick", {
        method: "POST",
        headers,
        body: bodyOracast,
        cache: "no-store",
      }).catch(() => undefined);
      void fetch("/api/agent/auto-wake", {
        method: "POST",
        headers,
        body: bodyWake,
        cache: "no-store",
      }).catch(() => undefined);
    };
    poke();
    // 25s: under auto-wake rate limit (8/min) even if My Agents also pokes
    const t = setInterval(poke, 25_000);
    const onVis = () => {
      if (document.visibilityState === "visible") poke();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [address, isConnected]);

  async function onConnect() {
    const injected = connectors.find((c) => c.id === "injected") || connectors[0];
    if (!injected) {
      alert("No browser wallet found. Install MetaMask.");
      return;
    }
    connect({ connector: injected, chainId: ritualChain.id });
  }

  return (
    <div className="min-h-screen px-4 pb-16 pt-5 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Top bar */}
        <header className="mb-10 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight text-[#c8ff4a]">Rite</span>
            <span className="hidden text-xs text-white/40 sm:inline">Research Desk</span>
          </div>

          <nav className="pill-nav order-3 flex w-full items-center justify-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-medium sm:order-none sm:w-auto sm:text-sm">
            {(
              [
                ["research", "Research"],
                ["records", "Records"],
                ["deploy", "Deploy"],
                ["agents", "My Agents"],
                ["markets", "Oracast Alert"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-full px-2.5 py-1.5 transition sm:px-3 ${
                  tab === id ? "active" : "hover:bg-black/5"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {isConnected && address ? (
              <>
                {wrongChain && (
                  <button
                    type="button"
                    disabled={switching}
                    onClick={() => switchChain({ chainId: ritualChain.id })}
                    className="rounded-full bg-amber-400/90 px-3 py-1.5 text-xs font-semibold text-black"
                  >
                    Switch to Ritual
                  </button>
                )}
                <div className="hidden rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] text-white/70 sm:block">
                  {bal ? `${Number(formatEther(bal.value)).toFixed(4)} RIT` : "…"} ·{" "}
                  {address.slice(0, 6)}…{address.slice(-4)}
                </div>
                <button
                  type="button"
                  onClick={() => disconnect()}
                  className="rounded-full border border-white/15 bg-black/40 px-3 py-1.5 text-xs text-white/80 hover:bg-black/55"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={isPending}
                onClick={() => void onConnect()}
                className="btn-primary rounded-full px-4 py-1.5 text-sm shadow-lg"
              >
                {isPending ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </header>

        {connectError && (
          <p className="mb-4 text-center text-sm text-red-300">
            {connectError.message}
          </p>
        )}

        <BountyBanner />

        {/* One Telegram connect for the whole app (research DMs, agent ticks, Oracast alerts) */}
        {isConnected && address && (
          <div className="mb-6 mx-auto max-w-3xl">
            <TelegramNotifyCard owner={address} />
          </div>
        )}

        {tab === "research" && <ResearchTab />}
        {tab === "records" && <RecordsTab />}
        {tab === "deploy" && <ProductAgentsShell mode="deploy" />}
        {tab === "agents" && <ProductAgentsShell mode="manage" />}
        {tab === "markets" && <OracastMarketTab />}

        <footer className="mt-14 border-t border-white/10 pt-6 pb-2 text-center">
          <p className="text-sm text-white/50">
            Made with{" "}
            <span className="text-rose-400" aria-hidden>
              ♥
            </span>{" "}
            by{" "}
            <span className="font-semibold text-[#c8ff4a]">mehidy</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://github.com/Arafat128/rite-research"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-white/40 transition hover:text-[#c8ff4a]"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 fill-current"
                aria-hidden
              >
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              GitHub
            </a>
            <a
              href="https://x.com/its_perseus_1"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-white/40 transition hover:text-[#c8ff4a]"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 fill-current"
                aria-hidden
              >
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
              </svg>
              @its_perseus_1
            </a>
          </div>
          <p className="mx-auto mt-3 max-w-sm text-[11px] leading-relaxed text-white/30">
            Hit an error? Use <b className="text-white/45">Copy error report</b>{" "}
            and DM the code — that helps fix issues faster.
          </p>
        </footer>
      </div>
    </div>
  );
}
