import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";
import { sustainUnattendedCoverage } from "@/lib/unattendedKeeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Arm closed-tab keeper chain (and optional immediate kick).
 * Called after Activate / Deploy so ticks continue without the browser.
 *
 * Body: { owner?: string, agentId?: string, kick?: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`arm-unattended:${ip}`, 20, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many arm requests" },
        { status: 429 }
      );
    }

    let owner: string | undefined;
    let agentId: string | undefined;
    // Default false: immediate kick raced browser auto-wake and double-sealed
    // agents when on-chain TooEarly is missing (Radar 0x50a3).
    let kick = false;

    try {
      const body = (await req.json()) as {
        owner?: string;
        agentId?: string;
        kick?: boolean;
      };
      if (body.owner && isAddress(body.owner)) {
        owner = body.owner.toLowerCase();
      }
      if (body.agentId && /^\d{1,12}$/.test(String(body.agentId))) {
        agentId = String(body.agentId);
      }
      if (body.kick === true) kick = true;
    } catch {
      /* empty */
    }

    const out = await sustainUnattendedCoverage({
      kickNow: kick,
      onlyOwner: owner,
      onlyAgentId: agentId,
    });

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
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
