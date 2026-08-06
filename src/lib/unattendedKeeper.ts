/**
 * Keep Radar agents + Oracast ticking when the browser tab is closed.
 *
 * Strategy (layered):
 * 1. GitHub Action agent-keeper.yml — every 10m, 9×1m pokes (must not cancel mid-loop)
 * 2. Vercel Cron → /api/agent/cron (Hobby = daily only; Pro can be * * * * *)
 * 3. QStash 1m schedule if QSTASH_TOKEN is set
 * 4. Server self-chain: after each successful keeper poke, schedule +55s follow-up
 *    via waitUntil (survives tab close as long as the chain is warm)
 */

import { kvSetNx, kvGet, kvSet } from "@/lib/durableKv";

const CHAIN_LOCK = "rite:keeper:chain:v1";
const QSTASH_ARMED = "rite:keeper:qstash:armed:v1";

export function appPublicBaseUrl(): string | null {
  const explicit =
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod.replace(/^https?:\/\//, "")}`;

  // Prefer production alias when available
  if (process.env.VERCEL_ENV === "production") {
    return "https://rite-woad.vercel.app";
  }

  const vu = process.env.VERCEL_URL?.trim();
  if (vu) return `https://${vu.replace(/^https?:\/\//, "")}`;
  return null;
}

function cronSecret(): string | null {
  return process.env.CRON_SECRET?.trim() || null;
}

/**
 * Fire the full unattended keeper endpoint once (Radar + Oracast + official).
 */
export async function pokeFullKeeper(opts?: {
  max?: number;
  reason?: string;
}): Promise<{ ok: boolean; status: number; body?: string }> {
  const base = appPublicBaseUrl();
  const secret = cronSecret();
  if (!base || !secret) {
    return { ok: false, status: 0, body: "APP_URL/CRON_SECRET missing" };
  }
  const max = opts?.max ?? 40;
  const url = `${base}/api/agent/cron?max=${max}&_src=${encodeURIComponent(opts?.reason || "chain")}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "User-Agent": "rite-unattended-keeper/1.0",
      },
      body: "{}",
      cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 400) };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: e instanceof Error ? e.message : "fetch failed",
    };
  }
}

/**
 * After a successful keeper/auto-wake pass, arm a +55s follow-up so closed-tab
 * coverage continues without the browser. Uses durable NX lock so only one
 * chain runs fleet-wide.
 */
export async function armNextKeeperPoke(opts?: {
  delayMs?: number;
  force?: boolean;
}): Promise<{ armed: boolean; reason: string }> {
  const secret = cronSecret();
  const base = appPublicBaseUrl();
  if (!secret || !base) {
    return { armed: false, reason: "missing_app_url_or_cron_secret" };
  }

  const delayMs = Math.min(
    90_000,
    Math.max(20_000, opts?.delayMs ?? 55_000)
  );

  // Only one pending chain across all instances
  if (!opts?.force) {
    const got = await kvSetNx(CHAIN_LOCK, String(Date.now()), 70);
    if (!got) {
      return { armed: false, reason: "chain_already_armed" };
    }
  } else {
    await kvSet(CHAIN_LOCK, String(Date.now()), 70);
  }

  const run = async () => {
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      const out = await pokeFullKeeper({ reason: "self_chain" });
      // Clear lock so a later poke can re-arm
      try {
        const { kvDel } = await import("@/lib/durableKv");
        await kvDel(CHAIN_LOCK);
      } catch {
        /* */
      }
      if (!out.ok) {
        console.warn(
          "[unattendedKeeper] self_chain poke failed",
          out.status,
          out.body
        );
        return;
      }
      // Continue the chain for closed-tab coverage
      void armNextKeeperPoke({ delayMs: 55_000 }).catch(() => undefined);
    } catch (e) {
      console.warn("[unattendedKeeper] chain error", e);
    }
  };

  // Prefer Vercel waitUntil so work continues after the HTTP response
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(run());
    return { armed: true, reason: "waitUntil" };
  } catch {
    // Local / no package — still schedule in process (best effort)
    void run();
    return { armed: true, reason: "background" };
  }
}

/**
 * Ensure a QStash * * * * * schedule exists (one-time arm).
 * Requires QSTASH_TOKEN + CRON_SECRET + resolvable APP_URL.
 */
export async function ensureQStashMinuteSchedule(): Promise<{
  ok: boolean;
  reason: string;
}> {
  const token = process.env.QSTASH_TOKEN?.trim();
  const secret = cronSecret();
  const base = appPublicBaseUrl();
  if (!token) return { ok: false, reason: "no_qstash_token" };
  if (!secret || !base) return { ok: false, reason: "no_app_url_or_secret" };

  const already = await kvGet(QSTASH_ARMED);
  if (already === "1") return { ok: true, reason: "already_armed" };

  const destination = `${base}/api/agent/cron?max=40`;
  try {
    const res = await fetch(
      `https://qstash.upstash.io/v2/schedules/${encodeURIComponent(destination)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Upstash-Cron": "* * * * *",
          "Upstash-Forward-Authorization": `Bearer ${secret}`,
          "Upstash-Method": "POST",
          "Content-Type": "application/json",
        },
        body: "{}",
      }
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn("[unattendedKeeper] qstash schedule failed", res.status, text.slice(0, 200));
      return { ok: false, reason: `qstash_${res.status}` };
    }
    await kvSet(QSTASH_ARMED, "1", 86400 * 7);
    return { ok: true, reason: "created" };
  } catch (e) {
    console.warn("[unattendedKeeper] qstash", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 80) : "qstash_error",
    };
  }
}

/** Call from browser pokes + cron so unattended path stays hot */
export async function sustainUnattendedCoverage(): Promise<void> {
  try {
    await ensureQStashMinuteSchedule();
  } catch {
    /* optional */
  }
  try {
    await armNextKeeperPoke({ delayMs: 55_000 });
  } catch (e) {
    console.warn("[unattendedKeeper] arm failed", e);
  }
}
