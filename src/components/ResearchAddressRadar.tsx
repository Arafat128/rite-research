"use client";

import { useMemo } from "react";
import { extractEthAddresses, shortAddr } from "@/lib/ritualRadar";
import { OpenOnRadar } from "@/components/OpenOnRadar";

type Props = {
  /** Research prompt and/or report markdown */
  text: string;
  className?: string;
};

/**
 * After research unlocks: surface any 0x addresses found → investigate on Radar.
 */
export function ResearchAddressRadar({ text, className = "" }: Props) {
  const addrs = useMemo(() => extractEthAddresses(text, 6), [text]);
  if (addrs.length === 0) return null;

  return (
    <div
      className={`rounded-xl border border-cyan-400/20 bg-cyan-950/20 px-3 py-3 ${className}`}
    >
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-200/90">
        Investigate on Radar
      </div>
      <p className="mb-2 text-[11px] text-white/45">
        Addresses mentioned in this research — open the 3D relationship graph.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {addrs.map((a) => (
          <OpenOnRadar
            key={a}
            address={a}
            label={shortAddr(a, 5)}
            title={`Map ${a} on Ritual Radar`}
          />
        ))}
      </div>
    </div>
  );
}
