import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";
import { sustainUnattendedCoverage } from "@/lib/unattendedKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Hobby max 60s — chain sleep is ≤55s so pass + HTTP rearm must fit. */
export const maxDuration = 60;

/**
 * Arm closed-tab keeper chain (and optional immediate kick).
 * Called after Activate / Deploy, and by the keeper self-chain HTTP rearm.
 *
 * Body: { owner?: string, agentId?: string, kick?: boolean, force?: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const isChain =
      req.headers.get("x-rite-chain") === "1" ||
      req.nextUrl.searchParams.get("chain") === "1";

    // Internal chain rearm must not die on IP rate limits (shared egress)
    if (!isChain) {
      const rl = rateLimit(`arm-unattended:${ip}`, 30, 60_000);
      if (!rl.ok) {
        return NextResponse.json(
          { error: "Too many arm requests" },
          { status: 429 }
        );
      }
    }

    let owner: string | undefined;
    let agentId: string | undefined;
    // Default false: immediate kick raced browser auto-wake (agent #68).
    let kick = false;
    // Always force a fresh chain from this endpoint (Activate + HTTP rearm).
    let force = true;

    try {
      const body = (await req.json()) as {
        owner?: string;
        agentId?: string;
        kick?: boolean;
        force?: boolean;
      };
      if (body.owner && isAddress(body.owner)) {
        owner = body.owner.toLowerCase();
      }
      if (body.agentId && /^\d{1,12}$/.test(String(body.agentId))) {
        agentId = String(body.agentId);
      }
      if (body.kick === true) kick = true;
      if (body.force === false) force = false;
    } catch {
      /* empty */
    }

    const out = await sustainUnattendedCoverage({
      kickNow: kick,
      forceArm: force,
      onlyOwner: owner,
      onlyAgentId: agentId,
      // Slightly under 1m so due windows are hit; fits Hobby 60s with margin
      delayMs: isChain ? 48_000 : 50_000,
    });

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      chain: isChain,
      ...out,
      kick: out.kick
        ? {
            ok: out.kick.ok,
            ticked: out.kick.ticked,
            oracastNotified: out.kick.oracastNotified,
            error: out.kick.error,
          }
        : undefined,
    });
  } catch (e: unknown) {
    console.error("[api/agent/arm-unattended]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "arm failed") },
      { status: 500 }
    );
  }
}
