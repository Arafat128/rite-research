/**
 * Keep Radar agents + Oracast ticking when the browser tab is closed.
 *
 * Hobby-safe chain (critical):
 * 1) Register waitUntil *before* the HTTP response is sent (callers must await arm).
 * 2) waitUntil only sleeps, then HTTP-POSTs /api/agent/cron (new invocation, 120s budget).
 *    Do NOT run heavy Surf+tx inside the sleep invocation (Hobby arm maxDuration=60).
 * 3) Cron ticks due agents, then awaits arm again → loop continues without the browser.
 * 4) GitHub Action every 5m as external heartbeat.
 */

import {
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { tickOracastWatches } from "@/lib/oracastWatch";
import { tickOfficialAgentAlerts } from "@/lib/officialAgentRegistry";
import { kvSetNx, kvGet, kvSet, kvDel } from "@/lib/durableKv";

const CHAIN_LOCK = "rite:keeper:chain:v3";
const QSTASH_ARMED = "rite:keeper:qstash:armed:v1";

/** Sleep before next cron poke. Must fit Hobby arm maxDuration (60s) + fetch headroom. */
const DEFAULT_CHAIN_DELAY_MS = 45_000;

export function appPublicBaseUrl(): string | null {
  const explicit =
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod.replace(/^https?:\/\//, "")}`;

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

function protectionBypass(): string | null {
  return (
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ||
    process.env.VERCEL_PROTECTION_BYPASS?.trim() ||
    null
  );
}

export type KeeperPassResult = {
  ok: boolean;
  ticked: number;
  oracastNotified: number;
  error?: string;
};

/**
 * Full unattended pass — same work as /api/agent/cron, in-process.
 */
export async function runKeeperPassInProcess(opts?: {
  onlyOwner?: string;
  onlyAgentId?: string;
  maxAgents?: number;
}): Promise<KeeperPassResult> {
  let ticked = 0;
  let oracastNotified = 0;
  try {
    const oracastP = tickOracastWatches({
      onlyOwner: opts?.onlyOwner,
      max: 40,
    }).catch((e) => {
      console.error("[unattendedKeeper] oracast", e);
      return null;
    });
    const officialP = tickOfficialAgentAlerts({ max: 40 }).catch((e) => {
      console.error("[unattendedKeeper] official", e);
      return null;
    });

    if (keeperConfigured() && process.env.SURF_API_KEY) {
      try {
        const radar = await runDueAgentTicks({
          maxAgents: opts?.maxAgents ?? 40,
          onlyAgentId: opts?.onlyAgentId,
          onlyOwner: opts?.onlyOwner,
        });
        ticked = radar.ticked;
      } catch (e) {
        console.error("[unattendedKeeper] radar", e);
      }
    }

    const [oracast] = await Promise.all([oracastP, officialP]);
    oracastNotified = oracast?.notified ?? 0;

    return { ok: true, ticked, oracastNotified };
  } catch (e) {
    return {
      ok: false,
      ticked,
      oracastNotified,
      error: e instanceof Error ? e.message : "keeper pass failed",
    };
  }
}

function chainFetchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-rite-chain": "1",
    "User-Agent": "rite-unattended-chain/2.0",
  };
  const secret = cronSecret();
  const bypass = protectionBypass();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}

/**
 * New invocation: full cron tick + re-arm (120s maxDuration on cron route).
 */
async function httpCronPoke(): Promise<{
  ok: boolean;
  status?: number;
  ticked?: number;
  reason: string;
}> {
  const base = appPublicBaseUrl();
  const secret = cronSecret();
  if (!base) return { ok: false, reason: "no_app_url" };
  if (!secret) return { ok: false, reason: "no_cron_secret" };

  const bypass = protectionBypass();
  const url = new URL(`${base}/api/agent/cron`);
  url.searchParams.set("max", "40");
  // Prevent infinite waitUntil→cron→arm→cron loops from stacking same second
  url.searchParams.set("chain", "1");
  if (bypass) {
    url.searchParams.set("x-vercel-protection-bypass", bypass);
  }

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: chainFetchHeaders(),
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(110_000),
    });
    const text = await res.text().catch(() => "");
    let ticked: number | undefined;
    try {
      const j = JSON.parse(text) as { ticked?: number };
      ticked = j.ticked;
    } catch {
      /* */
    }
    console.info(
      "[unattendedKeeper] http cron poke",
      res.status,
      "ticked=",
      ticked,
      text.slice(0, 100)
    );
    return {
      ok: res.ok,
      status: res.status,
      ticked,
      reason: res.ok ? "http_cron" : `http_${res.status}`,
    };
  } catch (e) {
    console.warn("[unattendedKeeper] http cron poke failed", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 80) : "http_error",
    };
  }
}

/**
 * Fallback rearm if cron HTTP fails — starts a new arm-unattended waitUntil.
 */
async function httpArmOnly(): Promise<{ ok: boolean; reason: string }> {
  const base = appPublicBaseUrl();
  if (!base) return { ok: false, reason: "no_app_url" };

  const bypass = protectionBypass();
  const url = new URL(`${base}/api/agent/arm-unattended`);
  if (bypass) {
    url.searchParams.set("x-vercel-protection-bypass", bypass);
  }

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: chainFetchHeaders(),
      body: JSON.stringify({ kick: false, force: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    console.info("[unattendedKeeper] http arm only", res.status);
    return { ok: res.ok, reason: res.ok ? "http_arm" : `http_arm_${res.status}` };
  } catch (e) {
    console.warn("[unattendedKeeper] http arm only failed", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 80) : "http_error",
    };
  }
}

/**
 * Schedule next closed-tab poke: sleep → HTTP cron (new invocation).
 * Callers MUST await this so waitUntil is registered before the response ends.
 */
export async function armNextKeeperPoke(opts?: {
  delayMs?: number;
  force?: boolean;
}): Promise<{ armed: boolean; reason: string }> {
  // Cap so sleep + fetch always fit Hobby arm maxDuration (60s)
  const delayMs = Math.min(
    48_000,
    Math.max(20_000, opts?.delayMs ?? DEFAULT_CHAIN_DELAY_MS)
  );

  if (!opts?.force) {
    const got = await kvSetNx(CHAIN_LOCK, String(Date.now()), 75);
    if (!got) {
      return { armed: false, reason: "chain_already_armed" };
    }
  } else {
    await kvSet(CHAIN_LOCK, String(Date.now()), 75);
  }

  const run = async () => {
    try {
      await new Promise((r) => setTimeout(r, delayMs));
    } catch {
      /* */
    }

    try {
      await kvDel(CHAIN_LOCK);
    } catch {
      /* */
    }

    // Prefer new cron invocation (long maxDuration) over in-process tick here
    const cron = await httpCronPoke();
    if (cron.ok) {
      console.info(
        "[unattendedKeeper] chain→cron ok ticked=",
        cron.ticked ?? "?"
      );
      return;
    }

    // Fallback: tick in-process then arm a new waitUntil via HTTP
    console.warn(
      "[unattendedKeeper] cron http failed, in-process fallback:",
      cron.reason
    );
    try {
      const out = await runKeeperPassInProcess({ maxAgents: 40 });
      console.info(
        "[unattendedKeeper] fallback pass ticked=",
        out.ticked,
        "oracast=",
        out.oracastNotified,
        out.error || "ok"
      );
    } catch (e) {
      console.warn("[unattendedKeeper] fallback pass error", e);
    }

    const arm = await httpArmOnly();
    if (!arm.ok) {
      // Last resort nested arm (may only last one more cycle)
      void armNextKeeperPoke({ delayMs: 40_000, force: true }).catch(
        () => undefined
      );
    }
  };

  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(run());
    console.info(
      "[unattendedKeeper] armed waitUntil delayMs=",
      delayMs,
      "force=",
      Boolean(opts?.force)
    );
    return { armed: true, reason: "waitUntil" };
  } catch {
    void run();
    return { armed: true, reason: "background" };
  }
}

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
      console.warn(
        "[unattendedKeeper] qstash schedule failed",
        res.status,
        text.slice(0, 200)
      );
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

/**
 * Arm closed-tab chain. Callers must await this before finishing the request.
 */
export async function sustainUnattendedCoverage(opts?: {
  kickNow?: boolean;
  forceArm?: boolean;
  onlyOwner?: string;
  onlyAgentId?: string;
  delayMs?: number;
  /** Skip QStash ensure (faster arm path) */
  skipQstash?: boolean;
}): Promise<{
  armed: { armed: boolean; reason: string };
  kick?: KeeperPassResult;
  qstash?: { ok: boolean; reason: string };
}> {
  let qstash: { ok: boolean; reason: string } | undefined;
  if (!opts?.skipQstash) {
    // Non-blocking — never delay arm registration for QStash
    void ensureQStashMinuteSchedule()
      .then((r) => {
        if (!r.ok && r.reason !== "no_qstash_token" && r.reason !== "already_armed") {
          console.info("[unattendedKeeper] qstash", r.reason);
        }
      })
      .catch(() => undefined);
  }

  let kick: KeeperPassResult | undefined;
  if (opts?.kickNow) {
    kick = await runKeeperPassInProcess({
      onlyOwner: opts.onlyOwner,
      onlyAgentId: opts.onlyAgentId,
      maxAgents: 20,
    });
    console.info(
      "[unattendedKeeper] kickNow ticked=",
      kick.ticked,
      "oracast=",
      kick.oracastNotified,
      opts.onlyAgentId ? `agent=${opts.onlyAgentId}` : "",
      kick.error || "ok"
    );
  }

  const force = opts?.forceArm === true || opts?.kickNow === true;

  const armed = await armNextKeeperPoke({
    delayMs: opts?.delayMs ?? DEFAULT_CHAIN_DELAY_MS,
    force,
  });

  return { armed, kick, qstash };
}
