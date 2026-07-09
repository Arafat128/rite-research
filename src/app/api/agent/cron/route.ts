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
  const auth = req.headers.get("authorization") || "";
  const q = req.nextUrl.searchParams.get("secret");
  const isVercelCron = req.headers.get("x-vercel-cron") === "1";

  // Vercel Cron with CRON_SECRET env → Authorization: Bearer <CRON_SECRET>
  if (secret && auth === `Bearer ${secret}`) return true;
  if (secret && q === secret) return true;

  // Native Vercel Cron header (when protection allows cron)
  if (isVercelCron) return true;

  return false;
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  try {
    // Lightweight health (no secrets) — UI can detect auto-wake readiness
    if (req.nextUrl.searchParams.get("health") === "1") {
      return NextResponse.json({
        ok: true,
        autoWakeReady:
          Boolean(process.env.KEEPER_PRIVATE_KEY) &&
          Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT) &&
          Boolean(process.env.SURF_API_KEY),
        hasCronSecret: Boolean(process.env.CRON_SECRET),
        hasKeeperKey: Boolean(process.env.KEEPER_PRIVATE_KEY),
        hasRadar: Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT),
        hasSurf: Boolean(process.env.SURF_API_KEY),
        schedule: "*/5 * * * *",
      });
    }

    if (!authorized(req)) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          autoWakeReady:
            Boolean(process.env.KEEPER_PRIVATE_KEY) &&
            Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT),
          hasCronSecret: Boolean(process.env.CRON_SECRET),
          hasKeeperKey: Boolean(process.env.KEEPER_PRIVATE_KEY),
          hint:
            "Use ?secret=CRON_SECRET or Authorization: Bearer CRON_SECRET. " +
            "If you see a Vercel login/SSO page (HTML), disable Deployment Protection for Production " +
            "or add Protection Bypass for Automation and pass x-vercel-protection-bypass.",
        },
        { status: 401 }
      );
    }
    if (!keeperConfigured()) {
      return NextResponse.json(
        {
          error:
            "Keeper not configured. Set KEEPER_PRIVATE_KEY (gas wallet) on Vercel Production.",
          autoWake: false,
          hasCronSecret: Boolean(process.env.CRON_SECRET),
          hasKeeperKey: Boolean(process.env.KEEPER_PRIVATE_KEY),
          hasRadar: Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT),
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
      radar: process.env.NEXT_PUBLIC_RADAR_CONTRACT,
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
