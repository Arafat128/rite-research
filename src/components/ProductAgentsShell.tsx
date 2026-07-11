"use client";

import { useState } from "react";
import { AgentTab } from "@/components/AgentTab";
import { OfficialAgentTab } from "@/components/OfficialAgentTab";

type Product = "data" | "ritual";

/**
 * Side-by-side product switcher:
 * 1) Data agents — Rite Radar (Surf streams)
 * 2) Official Ritual agents — factory Persistent / Sovereign
 */
export function ProductAgentsShell({
  mode,
}: {
  mode: "deploy" | "manage";
}) {
  const [product, setProduct] = useState<Product>("data");

  return (
    <div>
      <div className="mx-auto mb-6 flex max-w-3xl flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setProduct("data")}
          className={`rounded-xl border px-3.5 py-2 text-left text-sm transition ${
            product === "data"
              ? "border-[#c8ff4a]/50 bg-[#c8ff4a]/15 text-[#c8ff4a]"
              : "border-white/10 bg-black/25 text-white/55 hover:border-white/20"
          }`}
        >
          <span className="block font-semibold">Data agents</span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Radar · Surf streams · cheap ticks
          </span>
        </button>
        <button
          type="button"
          onClick={() => setProduct("ritual")}
          className={`rounded-xl border px-3.5 py-2 text-left text-sm transition ${
            product === "ritual"
              ? "border-violet-400/50 bg-violet-500/20 text-violet-100"
              : "border-white/10 bg-black/25 text-white/55 hover:border-white/20"
          }`}
        >
          <span className="block font-semibold">Ritual AI agents</span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Official Persistent / Sovereign · TEE
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
