/**
 * Server security helpers (no flow changes — input/output hardening only).
 */

import type { NextRequest } from "next/server";
export { sanitizeHttpUrl } from "@/lib/safeUrl";

/** Explorer path segment — only hex addresses/hashes */
export function sanitizeExplorerPath(value: string): string {
  const v = value.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(v) || /^0x[a-fA-F0-9]{64}$/.test(v)) return v;
  return "";
}

/** Data API target (symbols, pairs, queries) — no path injection */
export function sanitizeDataTarget(raw: string, maxLen = 48): string {
  return String(raw || "")
    .trim()
    .slice(0, maxLen)
    .replace(/[^\w.\-| $%]/g, "");
}

/** Research prompt bounds */
export const PROMPT_MIN = 3;
export const PROMPT_MAX = 4000;

export function clampPrompt(raw: string): string {
  return String(raw || "").trim().slice(0, PROMPT_MAX);
}

const ALLOWED_SURF_HOSTS = new Set([
  "api.asksurf.ai",
  "gateway.asksurf.ai",
]);

/** Lock Surf base URL to known hosts (prevents SSRF via env misconfig) */
export function resolveSurfBaseUrl(configured?: string): string {
  const fallback = "https://api.asksurf.ai/gateway/v1";
  const raw = (configured || fallback).replace(/\/$/, "");
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return fallback;
    if (!ALLOWED_SURF_HOSTS.has(u.hostname)) return fallback;
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

/** Simple in-memory rate limit (per-instance; good enough for Vercel edge isolation) */
const buckets = new Map<string, number[]>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowStart = now - windowMs;
  const prev = (buckets.get(key) || []).filter((t) => t > windowStart);
  if (prev.length >= limit) {
    const oldest = prev[0] || now;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  prev.push(now);
  buckets.set(key, prev);
  // prune map size
  if (buckets.size > 5000) {
    const first = buckets.keys().next().value;
    if (first) buckets.delete(first);
  }
  return { ok: true, retryAfterSec: 0 };
}

export function clientIp(req: NextRequest): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || "unknown";
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/** Safe JSON error — never leak stacks / secrets */
export function publicErrorMessage(e: unknown, fallback = "Request failed"): string {
  if (!(e instanceof Error)) return fallback;
  const m = e.message || fallback;
  // Strip accidental secrets
  if (/sk-surf|api[_-]?key|bearer\s+\S+/i.test(m)) {
    return fallback;
  }
  // Cap length
  return m.slice(0, 400);
}
