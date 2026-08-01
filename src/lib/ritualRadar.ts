/**
 * Ritual Radar integration helpers for Rite.
 * Radar = 3D relationship graph (separate app).
 * Deep links + embed URLs only — no Oracast coupling.
 */

export const RITUAL_RADAR_URL = (
  process.env.NEXT_PUBLIC_RITUAL_RADAR_URL || "https://ritual-radar.vercel.app"
).replace(/\/$/, "");

export function isEthAddress(value: string | undefined | null): boolean {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value.trim()));
}

export type RadarLinkOpts = {
  /** Compact iframe chrome */
  embed?: boolean;
  /** Force demo graph (optional root address) */
  demo?: boolean;
};

/** Build a Ritual Radar URL for an address (or bare app home). */
export function ritualRadarUrl(
  address?: string | null,
  opts?: RadarLinkOpts
): string {
  const url = new URL(RITUAL_RADAR_URL + "/");
  const a = (address || "").trim();
  if (isEthAddress(a)) {
    url.searchParams.set("address", a.toLowerCase());
  }
  if (opts?.embed) url.searchParams.set("embed", "1");
  if (opts?.demo) url.searchParams.set("demo", "1");
  return url.toString();
}

/** Extract unique 0x addresses from free text (reports, prompts). Max 8. */
export function extractEthAddresses(text: string, max = 8): string[] {
  if (!text) return [];
  const re = /0x[a-fA-F0-9]{40}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const a = m[0].toLowerCase();
    if (seen.has(a)) continue;
    // skip null-ish / zero address noise
    if (/^0x0{40}$/.test(a)) continue;
    seen.add(a);
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

export function shortAddr(addr: string, n = 4): string {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}
