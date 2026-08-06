import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  keeperAddress,
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";
import { sustainUnattendedCoverage } from "@/lib/unattendedKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Browser / keepalive poke for Radar data-agent auto-schedule.
 *
 * Auth model (product decision — smooth UX, no MetaMask spam):
 * - Owner address only (must match on-chain agent.owner for any tick)
 * - Rate limited per IP + per owner
 * - Only due LIVE agents with balance are ticked
 *
 * Unattended (tab closed): Bearer `/api/agent/cron` (GitHub Action / QStash).
 */
async function handle(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`auto-wake:${ip}`, 48, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many auto-wake requests — try again shortly" },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSec) },
        }
      );
    }

    if (!keeperConfigured()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Keeper not configured. Set KEEPER_PRIVATE_KEY (and Radar address) on the server.",
          autoWake: false,
        },
        { status: 503 }
      );
    }
    if (!process.env.SURF_API_KEY) {
      return NextResponse.json(
        { error: "SURF_API_KEY not configured" },
        { status: 500 }
      );
    }

    let agentId: string | undefined;
    let owner: string | undefined;
    let max = 20;

    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          agentId?: string;
          owner?: string;
          max?: number;
        };
        if (body.agentId && /^\d{1,12}$/.test(String(body.agentId))) {
          agentId = String(body.agentId);
        }
        if (body.owner && isAddress(body.owner)) {
          owner = body.owner.toLowerCase();
        }
        if (body.max != null) max = Number(body.max);
      } catch {
        /* empty body ok */
      }
    }

    const q = req.nextUrl.searchParams;
    if (!agentId && q.get("agentId") && /^\d{1,12}$/.test(q.get("agentId")!)) {
      agentId = q.get("agentId") || undefined;
    }
    if (!owner && q.get("owner") && isAddress(q.get("owner")!)) {
      owner = q.get("owner")!.toLowerCase();
    }
    if (q.get("max")) max = Number(q.get("max"));

    if (!owner) {
      return NextResponse.json(
        { error: "owner address required" },
        { status: 400 }
      );
    }

    const rlOwner = rateLimit(`auto-wake-owner:${owner}`, 60, 60_000);
    if (!rlOwner.ok) {
      return NextResponse.json(
        { error: "Too many auto-wake requests for this owner" },
        {
          status: 429,
          headers: { "Retry-After": String(rlOwner.retryAfterSec) },
        }
      );
    }

    const out = await runDueAgentTicks({
      maxAgents: Math.min(30, Math.max(1, max || 20)),
      onlyAgentId: agentId,
      onlyOwner: owner,
    });

    if (out.ticked > 0) {
      console.info(
        `[api/agent/auto-wake] owner=${owner.slice(0, 10)}… ticked=${out.ticked}`,
        out.results
          .filter((r) => r.ok)
          .map((r) => `#${r.agentId}@${r.runCount}`)
          .join(",")
      );
    }

    // Await arm registration before response — void async was killed on freeze
    // (agent #70 never got run 3 after tab close).
    let armed: { armed: boolean; reason: string } | undefined;
    try {
      const cov = await sustainUnattendedCoverage({
        kickNow: false,
        forceArm: out.ticked > 0,
        skipQstash: true,
      });
      armed = cov.armed;
    } catch (e) {
      console.warn("[api/agent/auto-wake] arm failed", e);
    }

    return NextResponse.json({
      ok: true,
      autoWake: true,
      at: new Date().toLocaleString(),
      iso: new Date().toISOString(),
      keeperConfigured: Boolean(keeperAddress()),
      scanned: out.scanned,
      ticked: out.ticked,
      results: out.results,
      keeperOnChain: out.keeperOnChain,
      armed,
    });
  } catch (e: unknown) {
    console.error("[api/agent/auto-wake]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "auto-wake failed") },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  // Allow GET ?owner= for simple keepalive probes
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
