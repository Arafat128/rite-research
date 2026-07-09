import { NextRequest, NextResponse } from "next/server";
import { keeperConfigured, runDueAgentTicks } from "@/lib/agentKeeper";
import { publicErrorMessage } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Automatic agent wakes (Vercel Cron or manual with secret).
 *
 * Auth: Authorization: Bearer CRON_SECRET  OR  ?secret=CRON_SECRET
 * Env: KEEPER_PRIVATE_KEY (gas only), CRON_SECRET, SURF_API_KEY
 *
 * Keeper pattern: anyone can runTick when Active; fee from agent balance.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Refuse unauthenticated cron if secret not set
    return false;
  }
  const auth = req.headers.get("authorization") || "";
  // Vercel Cron injects Authorization: Bearer <CRON_SECRET>
  if (auth === `Bearer ${secret}`) return true;
  const q = req.nextUrl.searchParams.get("secret");
  return q === secret;
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  try {
    if (!authorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!keeperConfigured()) {
      return NextResponse.json(
        {
          error:
            "Keeper not configured. Set KEEPER_PRIVATE_KEY (gas wallet) and CRON_SECRET.",
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

    const only = req.nextUrl.searchParams.get("agentId") || undefined;
    const max = Number(req.nextUrl.searchParams.get("max") || "25");

    const out = await runDueAgentTicks({
      maxAgents: Math.min(50, Math.max(1, max || 25)),
      onlyAgentId: only || undefined,
    });

    return NextResponse.json({
      ok: true,
      autoWake: true,
      at: new Date().toISOString(),
      ...out,
    });
  } catch (e: unknown) {
    console.error("[api/agent/cron]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "Cron tick failed") },
      { status: 500 }
    );
  }
}
