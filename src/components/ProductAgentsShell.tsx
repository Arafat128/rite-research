"use client";

import { useState } from "react";
import { AgentTab } from "@/components/AgentTab";
import { OfficialAgentTab } from "@/components/OfficialAgentTab";

/**
 * Deploy / My Agents product surface.
 * - Data agents: Rite Radar + Surf streams
 * - Ritual AI agents: official TEE Persistent (0x0820) + Sovereign (0x080C)
 */
export function ProductAgentsShell({
  mode,
}: {
  mode: "deploy" | "manage";
}) {
  const [product, setProduct] = useState<"data" | "official">("data");

  return (
    <div>
      <div className="mx-auto mb-6 flex max-w-3xl flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setProduct("data")}
          className={`rounded-xl px-3.5 py-2 text-left text-sm transition ${
            product === "data"
              ? "border border-[#c8ff4a]/50 bg-[#c8ff4a]/15 text-[#c8ff4a]"
              : "border border-white/10 bg-black/20 text-white/55 hover:border-white/20 hover:text-white/75"
          }`}
        >
          <span className="block font-semibold">Data agents</span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Radar · Surf streams · deploy &amp; wake
          </span>
        </button>
        <button
          type="button"
          onClick={() => setProduct("official")}
          className={`rounded-xl px-3.5 py-2 text-left text-sm transition ${
            product === "official"
              ? "border border-violet-400/50 bg-violet-500/15 text-violet-200"
              : "border border-white/10 bg-black/20 text-white/55 hover:border-white/20 hover:text-white/75"
          }`}
        >
          <span className="flex items-center gap-2 font-semibold">
            Ritual AI agents
            <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200/80">
              Live
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Official TEE Persistent / Sovereign factories
          </span>
        </button>
      </div>

      {product === "data" ? (
        <AgentTab mode={mode} />
      ) : (
        <OfficialAgentTab mode={mode} />
      )}
    </div>
  );
}
