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
 * Browser poke for auto-schedule (My Agents tab).
 *
 * Hardened vs open gas grief:
 * - Rate limited per IP
 * - Requires valid `owner` address (scoped ticks)
 * - Caps scan size
 * - Only agents already due on-chain are ticked
 *
 * Unattended production wakes should use Bearer-auth `/api/agent/cron`
 * (GitHub Actions / QStash / cron-job.org), not this route.
 */
async function handle(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`auto-wake:${ip}`, 8, 60_000);
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
    let max = 12;

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

    // Require owner scope — prevents unauthenticated full-registry scans
    if (!owner) {
      return NextResponse.json(
        { error: "owner address required" },
        { status: 400 }
      );
    }

    const out = await runDueAgentTicks({
      maxAgents: Math.min(15, Math.max(1, max || 12)),
      onlyAgentId: agentId,
      onlyOwner: owner,
    });

    return NextResponse.json({
      ok: true,
      autoWake: true,
      at: new Date().toLocaleString(),
      iso: new Date().toISOString(),
      // Do not advertise keeper EOA unnecessarily
      keeperConfigured: Boolean(keeperAddress()),
      scanned: out.scanned,
      ticked: out.ticked,
      results: out.results,
      keeperOnChain: out.keeperOnChain,
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
