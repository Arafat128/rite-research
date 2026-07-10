import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  keeperAddress,
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Browser / external poke for auto-schedule.
 *
 * Why this exists:
 * - Saving a 1m schedule only stores wakeIntervalBlocks on-chain.
 * - Vercel Hobby native cron is **once per day** — not every minute.
 * - My Agents tab calls this every ~20s when agents are LIVE so 1m schedules fire.
 *
 * Auth: no CRON_SECRET required (rate-limited). Only ticks agents that are
 * already due on-chain; early calls no-op. Keeper pays gas.
 *
 * POST/GET body or query:
 *   agentId?  — only this agent
 *   owner?    — only this owner's agents
 *   max?      — scan cap (default 15)
 */
async function handle(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`auto-wake:${ip}`, 12, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many auto-wake requests — try again shortly" },
        { status: 429 }
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
    let max = 15;

    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          agentId?: string;
          owner?: string;
          max?: number;
        };
        if (body.agentId) agentId = String(body.agentId);
        if (body.owner && isAddress(body.owner)) {
          owner = body.owner.toLowerCase();
        }
        if (body.max) max = Number(body.max);
      } catch {
        /* empty body ok */
      }
    }

    const q = req.nextUrl.searchParams;
    if (!agentId && q.get("agentId")) agentId = q.get("agentId") || undefined;
    if (!owner && q.get("owner") && isAddress(q.get("owner")!)) {
      owner = q.get("owner")!.toLowerCase();
    }
    if (q.get("max")) max = Number(q.get("max"));

    const out = await runDueAgentTicks({
      maxAgents: Math.min(40, Math.max(1, max || 15)),
      onlyAgentId: agentId,
      onlyOwner: owner,
    });

    return NextResponse.json({
      ok: true,
      autoWake: true,
      at: new Date().toLocaleString(),
      iso: new Date().toISOString(),
      keeper: keeperAddress(),
      ...out,
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
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
