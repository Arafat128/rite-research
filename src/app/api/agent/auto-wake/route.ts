import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address, type Hex } from "viem";
import {
  keeperAddress,
  keeperConfigured,
  runDueAgentTicks,
} from "@/lib/agentKeeper";
import { verifyAutoWakeSig } from "@/lib/ownerWakeAuth";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Browser poke for auto-schedule (My Agents tab).
 *
 * Hardened vs open gas grief:
 * - Rate limited per IP + per owner
 * - Requires owner wallet signature (nonce + expiry)
 * - Caps scan size
 * - Only agents already due on-chain are ticked
 *
 * Unattended production wakes: Bearer-auth `/api/agent/cron` only.
 */
async function handle(req: NextRequest) {
  try {
    const ip = clientIp(req);
    // Adaptive client polls every ~3–15s when near due — allow burst
    const rl = rateLimit(`auto-wake:${ip}`, 40, 60_000);
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
    let signature: string | undefined;
    let nonce: string | undefined;
    let expiry: number | undefined;

    if (req.method === "POST") {
      try {
        const body = (await req.json()) as {
          agentId?: string;
          owner?: string;
          max?: number;
          signature?: string;
          nonce?: string;
          expiry?: number;
        };
        if (body.agentId && /^\d{1,12}$/.test(String(body.agentId))) {
          agentId = String(body.agentId);
        }
        if (body.owner && isAddress(body.owner)) {
          owner = body.owner.toLowerCase();
        }
        if (body.max != null) max = Number(body.max);
        signature = body.signature;
        nonce = body.nonce;
        expiry = body.expiry != null ? Number(body.expiry) : undefined;
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

    // Signature required for browser path (GET without sig is rejected)
    const sigErr = await verifyAutoWakeSig({
      owner: owner as Address,
      signature: signature as Hex | undefined,
      nonce,
      expiry,
    });
    if (sigErr) {
      return NextResponse.json({ error: sigErr, code: "WAKE_AUTH" }, { status: 401 });
    }

    const rlOwner = rateLimit(`auto-wake-owner:${owner}`, 50, 60_000);
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
    });
  } catch (e: unknown) {
    console.error("[api/agent/auto-wake]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "auto-wake failed") },
      { status: 500 }
    );
  }
}

/** GET alone is not enough — signature must be POSTed */
export async function GET() {
  return NextResponse.json(
    {
      error:
        "POST with owner wallet signature required. Unattended wakes: /api/agent/cron with CRON_SECRET.",
    },
    { status: 405 }
  );
}

export async function POST(req: NextRequest) {
  return handle(req);
}
