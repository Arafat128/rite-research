"use client";

import { useEffect, useMemo, useState } from "react";

export type ResearchLoadPhase = "paying" | "researching" | "settling";

type Props = {
  phase: ResearchLoadPhase;
  status?: string;
};

const PHASE_META: Record<
  ResearchLoadPhase,
  { title: string; hint: string; chips: string[] }
> = {
  paying: {
    title: "Confirming fee on Ritual",
    hint: "Approve the payment in your wallet, then wait for chain confirmation.",
    chips: ["Wallet", "Fee", "On-chain"],
  },
  researching: {
    title: "Surf is researching",
    hint: "This can take a minute. Your report unlocks only after the seal tx.",
    chips: ["Markets", "On-chain", "Risks", "Sources"],
  },
  settling: {
    title: "Seal to unlock report",
    hint: "Confirm the seal transaction — rejecting cancels the report view.",
    chips: ["Hash", "Seal", "Unlock"],
  },
};

const RESEARCH_TICKS = [
  { afterMs: 0, text: "Fee confirmed · opening Surf research…" },
  { afterMs: 5_000, text: "Scanning markets & project signals…" },
  { afterMs: 15_000, text: "Weaving tokenomics & catalysts…" },
  { afterMs: 28_000, text: "Mapping risks into the table…" },
  { afterMs: 42_000, text: "Still weaving — deep research takes a moment…" },
  { afterMs: 60_000, text: "Almost there · preparing seal hash…" },
];

export function ResearchLoading({ phase, status }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const meta = PHASE_META[phase];

  useEffect(() => {
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 500), 500);
    return () => clearInterval(t);
  }, [phase]);

  const tickLine = useMemo(() => {
    if (phase !== "researching") return status || meta.hint;
    let line = RESEARCH_TICKS[0].text;
    for (const tick of RESEARCH_TICKS) {
      if (elapsed >= tick.afterMs) line = tick.text;
    }
    return line;
  }, [phase, elapsed, status, meta.hint]);

  const progress = useMemo(() => {
    if (phase === "paying") return Math.min(28, 8 + elapsed / 800);
    if (phase === "settling") return Math.min(92, 72 + elapsed / 400);
    return Math.min(88, 30 + elapsed / 1200);
  }, [phase, elapsed]);

  const activeChip = Math.floor(elapsed / 2500) % meta.chips.length;

  return (
    <div className="glass ritual-load relative z-[1] mx-auto mt-8 w-full max-w-md overflow-hidden rounded-2xl p-6 sm:p-8">
      {/* Soft ring spinner — no logo image */}
      <div className="relative mx-auto mb-5 flex h-20 w-20 items-center justify-center">
        <div className="ritual-ring ritual-ring-a" aria-hidden />
        <div className="ritual-ring ritual-ring-b" aria-hidden />
        <div className="ritual-core-dot" aria-hidden />
      </div>

      <h3 className="text-center text-lg font-semibold tracking-tight text-[#c8ff4a]">
        {meta.title}
      </h3>
      <p className="mt-2 min-h-[2.5rem] text-center text-sm leading-relaxed text-white/65">
        {tickLine}
      </p>

      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {meta.chips.map((chip, i) => (
          <span
            key={chip}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all duration-500 ${
              i === activeChip
                ? "border-[#c8ff4a]/50 bg-[#c8ff4a]/15 text-[#c8ff4a]"
                : "border-white/10 bg-black/25 text-white/40"
            }`}
          >
            {chip}
          </span>
        ))}
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex justify-between text-[10px] uppercase tracking-wide text-white/35">
          <span>
            {phase === "paying"
              ? "Payment"
              : phase === "researching"
                ? "Research"
                : "Seal"}
          </span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-black/45">
          <div
            className="ritual-progress-bar h-full rounded-full"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {phase === "researching" && (
        <p className="mt-4 text-center text-[11px] leading-snug text-white/35">
          Next: confirm the <b className="text-white/50">seal</b> transaction to
          unlock the report. Rejecting cancels the view (fee stays paid).
        </p>
      )}
      {phase === "settling" && (
        <p className="mt-4 text-center text-[11px] leading-snug text-amber-200/70">
          Approve the seal in your wallet to reveal the research.
        </p>
      )}
    </div>
  );
}
