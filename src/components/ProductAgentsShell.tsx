"use client";

import { AgentTab } from "@/components/AgentTab";

/**
 * Deploy / My Agents product surface.
 * Official Ritual TEE agents (Persistent 0x0820 / Sovereign 0x080C) are locked
 * for public launch until factory launch is production-stable.
 * Data agents (Rite Radar + Surf streams) remain fully available.
 */
export function ProductAgentsShell({
  mode,
}: {
  mode: "deploy" | "manage";
}) {
  return (
    <div>
      <div className="mx-auto mb-6 flex max-w-3xl flex-wrap gap-2">
        <div
          className="rounded-xl border border-[#c8ff4a]/50 bg-[#c8ff4a]/15 px-3.5 py-2 text-left text-sm text-[#c8ff4a]"
        >
          <span className="block font-semibold">Data agents</span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Radar · Surf streams · deploy &amp; wake
          </span>
        </div>
        <div
          className="cursor-not-allowed rounded-xl border border-white/10 bg-black/20 px-3.5 py-2 text-left text-sm text-white/35 opacity-80"
          title="Coming soon — official Ritual TEE agents are not available in this release"
          aria-disabled="true"
        >
          <span className="flex items-center gap-2 font-semibold">
            Ritual AI agents
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/40">
              Coming soon
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] opacity-70">
            Official TEE Persistent / Sovereign — locked for this release
          </span>
        </div>
      </div>

      <AgentTab mode={mode} />
    </div>
  );
}
