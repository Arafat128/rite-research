import { NextRequest, NextResponse } from "next/server";
import {
  isKeeperOnChain,
  keeperAddress,
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { tickOracastWatches } from "@/lib/oracastWatch";
import { tickOfficialAgentAlerts } from "@/lib/officialAgentRegistry";
import { publicErrorMessage } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Automatic agent wakes (Vercel Cron or manual).
 *
 * Auth (strict): Authorization: Bearer <CRON_SECRET> only.
 * Hobby Vercel: native cron is once/day — use /api/agent/auto-wake from the
 * app for 1m schedules, or an external cron with this Bearer header.
 * Env: KEEPER_PRIVATE_KEY (gas only), CRON_SECRET, SURF_API_KEY
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
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
      return NextResponse.json(
        {
          error: "Unauthorized",
          hint:
            "Send Authorization: Bearer CRON_SECRET. " +
            "For in-app 1m schedules use POST /api/agent/auto-wake (no secret). " +
            "If you see a Vercel login page, disable Deployment Protection or use a Protection Bypass header.",
        },
        { status: 401 }
      );
    }

    // Health only with auth (no config leak on public endpoints)
    if (req.nextUrl.searchParams.get("health") === "1") {
      const addr = keeperAddress();
      const onChain = await isKeeperOnChain(addr);
      let oracastStatus = null;
      try {
        const { getOracastRuntimeStatus } = await import("@/lib/oracastWatch");
        oracastStatus = await getOracastRuntimeStatus();
      } catch {
        /* ignore */
      }
      return NextResponse.json({
        ok: true,
        autoWakeReady:
          Boolean(process.env.KEEPER_PRIVATE_KEY) &&
          Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT) &&
          Boolean(process.env.SURF_API_KEY) &&
          onChain !== false,
        hasCronSecret: true,
        hasKeeperKey: Boolean(process.env.KEEPER_PRIVATE_KEY),
        hasRadar: Boolean(process.env.NEXT_PUBLIC_RADAR_CONTRACT),
        hasSurf: Boolean(process.env.SURF_API_KEY),
        hasUpstash: Boolean(
          process.env.UPSTASH_REDIS_REST_URL?.trim() &&
            process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
        ),
        hasTelegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
        keeper: addr,
        keeperOnChain: onChain,
        oracast: oracastStatus,
        hint:
          onChain === false
            ? "Call setKeeper(keeperAddress, true) as Radar admin or auto runTick will NotAuthorized"
            : onChain === true
              ? "Keeper is allowlisted on Radar"
              : "Could not read isKeeper — check Radar ABI/RPC",
      });
    }

    // Run Oracast + official + Radar in parallel so radar 1m agents are not
    // starved waiting on price/official fan-out.
    const only = req.nextUrl.searchParams.get("agentId") || undefined;
    const max = Number(req.nextUrl.searchParams.get("max") || "25");

    const oracastP = tickOracastWatches({ max: 40 }).catch((e) => {
      console.error("[api/agent/cron] oracast", e);
      return null;
    });
    const officialP = tickOfficialAgentAlerts({ max: 40 }).catch((e) => {
      console.error("[api/agent/cron] official", e);
      return null;
    });

    let radar: Awaited<ReturnType<typeof runDueAgentTicks>> | null = null;
    let radarError: string | undefined;
    if (!keeperConfigured()) {
      radarError =
        "Oracast + official agents ticked. Radar auto-wake needs KEEPER_PRIVATE_KEY.";
    } else if (!process.env.SURF_API_KEY) {
      radarError = "SURF_API_KEY not configured (Radar ticks skipped)";
    } else {
      try {
        radar = await runDueAgentTicks({
          maxAgents: Math.min(50, Math.max(1, max || 25)),
          onlyAgentId: only || undefined,
        });
      } catch (e) {
        console.error("[api/agent/cron] radar", e);
        radarError = publicErrorMessage(e, "Radar ticks failed");
      }
    }

    const [oracast, official] = await Promise.all([oracastP, officialP]);

    return NextResponse.json({
      ok: true,
      autoWake: Boolean(radar),
      at: new Date().toISOString(),
      ticked: radar?.ticked ?? 0,
      scanned: radar?.scanned ?? 0,
      results: radar?.results ?? [],
      keeper: radar?.keeper,
      keeperOnChain: radar?.keeperOnChain,
      oracast,
      official,
      ...(radarError ? { error: radarError, hint: radarError } : {}),
    });
  } catch (e: unknown) {
    console.error("[api/agent/cron]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "Cron tick failed") },
      { status: 500 }
    );
  }
}
