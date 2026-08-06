/**
 * Keep Radar agents + Oracast ticking when the browser tab is closed.
 *
 * Design (Hobby-safe):
 * - Do NOT rely on infinite nested waitUntil (dies after ~60s maxDuration).
 * - One waitUntil: sleep → keeper pass → HTTP POST arm-unattended to start a
 *   *new* invocation for the next loop (survives freeze / tab close).
 * - GitHub Action every 5m as external heartbeat (cancel-in-progress: false).
 * - Optional QStash true 1m if QSTASH_TOKEN is set.
 */

import {
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { tickOracastWatches } from "@/lib/oracastWatch";
import { tickOfficialAgentAlerts } from "@/lib/officialAgentRegistry";
import { kvSetNx, kvGet, kvSet, kvDel } from "@/lib/durableKv";

const CHAIN_LOCK = "rite:keeper:chain:v2";
const QSTASH_ARMED = "rite:keeper:qstash:armed:v1";

/** ~1m agents: poke a bit under a minute so due windows aren't missed. */
const DEFAULT_CHAIN_DELAY_MS = 50_000;

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

/**
 * Continue the chain in a *new* serverless invocation.
 * Nested waitUntil alone dies when the parent function hits maxDuration (Hobby ~60s).
 */
async function httpRearmChain(): Promise<{ ok: boolean; status?: number; reason: string }> {
  const base = appPublicBaseUrl();
  if (!base) return { ok: false, reason: "no_app_url" };

  const bypass = protectionBypass();
  const secret = cronSecret();
  const url = new URL(`${base}/api/agent/arm-unattended`);
  if (bypass) {
    url.searchParams.set("x-vercel-protection-bypass", bypass);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-rite-chain": "1",
    "User-Agent": "rite-unattended-chain/1.0",
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ kick: false, force: true }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    console.info(
      "[unattendedKeeper] http rearm",
      res.status,
      text.slice(0, 120)
    );
    return {
      ok: res.ok,
      status: res.status,
      reason: res.ok ? "http_rearm" : `http_${res.status}`,
    };
  } catch (e) {
    console.warn("[unattendedKeeper] http rearm failed", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 80) : "http_error",
    };
  }
}

/**
 * Schedule an in-process keeper pass after delayMs, then HTTP-rearm.
 * Survives tab close when started via waitUntil on a completed request.
 */
export async function armNextKeeperPoke(opts?: {
  delayMs?: number;
  force?: boolean;
}): Promise<{ armed: boolean; reason: string }> {
  const delayMs = Math.min(
    55_000,
    Math.max(25_000, opts?.delayMs ?? DEFAULT_CHAIN_DELAY_MS)
  );

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
      const out = await runKeeperPassInProcess({ maxAgents: 40 });
      console.info(
        "[unattendedKeeper] chain pass ticked=",
        out.ticked,
        "oracast=",
        out.oracastNotified,
        out.error || "ok"
      );
    } catch (e) {
      console.warn("[unattendedKeeper] chain error", e);
    } finally {
      try {
        await kvDel(CHAIN_LOCK);
      } catch {
        /* */
      }
    }

    // New invocation continues the chain (do not nest waitUntil forever)
    const rearm = await httpRearmChain();
    if (!rearm.ok) {
      // Last-resort nested arm — may only live one more cycle on Hobby
      void armNextKeeperPoke({ delayMs: 40_000, force: true }).catch(
        () => undefined
      );
    }
  };

  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(run());
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
 * Arm closed-tab chain. Optionally run a pass immediately (e.g. after Activate).
 * forceArm: always schedule a fresh waitUntil (Activate / HTTP rearm / cron).
 */
export async function sustainUnattendedCoverage(opts?: {
  kickNow?: boolean;
  forceArm?: boolean;
  onlyOwner?: string;
  onlyAgentId?: string;
  delayMs?: number;
}): Promise<{
  armed: { armed: boolean; reason: string };
  kick?: KeeperPassResult;
  qstash?: { ok: boolean; reason: string };
}> {
  let qstash: { ok: boolean; reason: string } | undefined;
  try {
    qstash = await ensureQStashMinuteSchedule();
  } catch {
    qstash = { ok: false, reason: "qstash_error" };
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

  // forceArm (Activate / HTTP rearm / cron) always starts a fresh waitUntil
  const force = opts?.forceArm === true || opts?.kickNow === true;

  const armed = await armNextKeeperPoke({
    delayMs: opts?.delayMs ?? DEFAULT_CHAIN_DELAY_MS,
    force,
  });

  return { armed, kick, qstash };
}
