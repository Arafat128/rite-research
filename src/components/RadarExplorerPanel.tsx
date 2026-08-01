"use client";

import { useMemo, useState } from "react";
import {
  isEthAddress,
  ritualRadarUrl,
  shortAddr,
} from "@/lib/ritualRadar";
import { OpenOnRadar } from "@/components/OpenOnRadar";

export type RadarTarget = {
  address: string;
  label: string;
  hint?: string;
};

type Props = {
  /** Addresses the user can explore (wallet, contracts, agents) */
  targets: RadarTarget[];
  /** Default selected target address */
  defaultAddress?: string | null;
  /** Start expanded */
  defaultOpen?: boolean;
  title?: string;
  subtitle?: string;
  /** iframe height */
  height?: number;
};

/**
 * In-app Ritual Radar explorer: pick a related address, embed 3D graph, or open full app.
 */
export function RadarExplorerPanel({
  targets,
  defaultAddress,
  defaultOpen = false,
  title = "Relationship radar",
  subtitle = "Live 3D neighborhood on Ritual Chain — who this address connects to.",
  height = 420,
}: Props) {
  const validTargets = useMemo(
    () =>
      targets.filter(
        (t, i, arr) =>
          isEthAddress(t.address) &&
          arr.findIndex(
            (x) => x.address.toLowerCase() === t.address.toLowerCase()
          ) === i
      ),
    [targets]
  );

  const initial =
    (defaultAddress &&
      validTargets.find(
        (t) => t.address.toLowerCase() === defaultAddress.toLowerCase()
      )?.address) ||
    validTargets[0]?.address ||
    "";

  const [open, setOpen] = useState(defaultOpen);
  const [selected, setSelected] = useState(initial);
  const [reloadKey, setReloadKey] = useState(0);

  // Keep selection valid when targets change
  const active =
    validTargets.find((t) => t.address.toLowerCase() === selected.toLowerCase())
      ?.address || validTargets[0]?.address;

  const embedSrc = active
    ? ritualRadarUrl(active, { embed: true }) + `&_r=${reloadKey}`
    : "";

  if (validTargets.length === 0) return null;

  return (
    <div className="glass overflow-hidden rounded-2xl border border-cyan-400/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
      >
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
            <span className="text-cyan-300/90" aria-hidden>
              ◎
            </span>
            {title}
          </div>
          <p className="mt-0.5 text-[11px] text-white/40">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[10px] uppercase tracking-wide text-white/45">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/10 px-4 pb-4 pt-3">
          <div className="flex flex-wrap gap-1.5">
            {validTargets.map((t) => {
              const on =
                active &&
                t.address.toLowerCase() === active.toLowerCase();
              return (
                <button
                  key={t.address}
                  type="button"
                  onClick={() => {
                    setSelected(t.address);
                    setReloadKey((k) => k + 1);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                    on
                      ? "border border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                      : "border border-white/10 bg-black/25 text-white/50 hover:border-white/20 hover:text-white/75"
                  }`}
                  title={t.hint || t.address}
                >
                  {t.label}
                  <span className="ml-1 font-mono text-[10px] opacity-60">
                    {shortAddr(t.address, 3)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <OpenOnRadar address={active} label="Open full Radar" size="md" />
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded-full border border-white/15 px-3 py-1.5 text-[11px] text-white/55 hover:bg-white/5"
            >
              Reload graph
            </button>
            {active && (
              <span className="font-mono text-[10px] text-white/30">
                {active}
              </span>
            )}
          </div>

          <div
            className="relative overflow-hidden rounded-xl border border-white/10 bg-black/60"
            style={{ height }}
          >
            {embedSrc ? (
              <iframe
                key={embedSrc}
                title={`Ritual Radar — ${active}`}
                src={embedSrc}
                className="h-full w-full border-0"
                allow="clipboard-write"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-white/40">
                Select an address
              </div>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-white/30">
            Live graph from Ritual RPC + agent registry + recent blocks. Demo
            edges are never mixed into live scans. Fullscreen: use{" "}
            <b className="text-white/45">Open full Radar</b>.
          </p>
        </div>
      )}
    </div>
  );
}
