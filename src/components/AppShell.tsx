"use client";

import { useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useBalance,
} from "wagmi";
import { formatEther } from "viem";
import { ritualChain } from "@/lib/ritual";
import { ResearchTab } from "./ResearchTab";
import { RecordsTab } from "./RecordsTab";
import { AgentTab } from "./AgentTab";
import { BountyBanner } from "./BountyBanner";

type Tab = "research" | "records" | "deploy" | "agents";

export function AppShell() {
  const [tab, setTab] = useState<Tab>("research");
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: bal } = useBalance({ address });

  const wrongChain = isConnected && chainId !== ritualChain.id;

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
                onClick={onConnect}
                className="btn-primary rounded-full px-4 py-1.5 text-sm shadow-lg"
              >
                {isPending ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </header>

        {connectError && (
          <p className="mb-4 text-center text-sm text-red-300">{connectError.message}</p>
        )}

        {/* Auto bounty winner + live pool — always top of screen */}
        <BountyBanner />

        {tab === "research" && <ResearchTab />}
        {tab === "records" && <RecordsTab />}
        {tab === "deploy" && <AgentTab mode="deploy" />}
        {tab === "agents" && <AgentTab mode="manage" />}

        <footer className="mt-14 border-t border-white/10 pt-6 pb-2 text-center">
          <p className="text-sm text-white/50">
            Made with{" "}
            <span className="text-rose-400" aria-hidden>
              ♥
            </span>{" "}
            by{" "}
            <span className="font-semibold text-[#c8ff4a]">mehidy</span>
          </p>
          <a
            href="https://x.com/its_perseus_1"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-white/40 transition hover:text-[#c8ff4a]"
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
        </footer>
      </div>
    </div>
  );
}
