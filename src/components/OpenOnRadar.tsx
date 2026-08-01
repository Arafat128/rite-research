"use client";

import {
  isEthAddress,
  ritualRadarUrl,
  shortAddr,
} from "@/lib/ritualRadar";

type Props = {
  address?: string | null;
  /** Button label */
  label?: string;
  /** compact pill vs default */
  size?: "sm" | "md";
  className?: string;
  title?: string;
  /** open embed-friendly full page (still external tab) */
  embedPreview?: boolean;
};

/**
 * Primary CTA: open Ritual Radar for an address (new tab).
 */
export function OpenOnRadar({
  address,
  label,
  size = "sm",
  className = "",
  title,
  embedPreview = false,
}: Props) {
  const ok = isEthAddress(address || "");
  if (!ok) return null;

  const href = ritualRadarUrl(address, {
    embed: embedPreview ? false : false,
  });
  const text =
    label ||
    (size === "sm" ? "Radar" : `Radar ${shortAddr(address || "", 4)}`);

  const sizeCls =
    size === "sm"
      ? "px-2.5 py-1 text-[11px]"
      : "px-3.5 py-1.5 text-xs font-semibold";

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title || `Open ${address} on Ritual Radar`}
      className={`inline-flex items-center gap-1 rounded-full border border-cyan-400/35 bg-cyan-500/10 font-medium text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-500/20 ${sizeCls} ${className}`}
    >
      <span aria-hidden className="text-[10px]">
        ◎
      </span>
      {text}
      <span className="opacity-60" aria-hidden>
        ↗
      </span>
    </a>
  );
}
