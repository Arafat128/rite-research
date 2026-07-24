import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { tickOracastWatches } from "@/lib/oracastWatch";
import { clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Process Oracast price watches → Telegram.
 * - Owner poke (browser): POST { owner } (rate limited)
 * - Cron: Authorization: Bearer CRON_SECRET (Vercel cron + GitHub keeper)
 */
async function handle(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") || "";
    const secret = process.env.CRON_SECRET;
    // Vercel Cron also sends x-vercel-cron: 1
    const isVercelCron = req.headers.get("x-vercel-cron") === "1";
    const isCron = Boolean(
      (secret && auth === `Bearer ${secret}`) || isVercelCron
    );

    let onlyOwner: string | undefined;
    let max = 40;

    if (!isCron) {
      const ip = clientIp(req);
      const rl = rateLimit(`oracast-tick:${ip}`, 12, 60_000);
      if (!rl.ok) {
        return NextResponse.json(
          { error: "Too many tick requests" },
          { status: 429 }
        );
      }
      try {
        const body = (await req.json()) as { owner?: string; max?: number };
        if (!body.owner || !isAddress(body.owner)) {
          return NextResponse.json(
            { error: "owner required (or use CRON_SECRET)" },
            { status: 400 }
          );
        }
        onlyOwner = body.owner.toLowerCase();
        if (body.max != null) max = Math.min(20, Number(body.max) || 12);
      } catch {
        return NextResponse.json(
          { error: "JSON body required" },
          { status: 400 }
        );
      }
    } else {
      try {
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            owner?: string;
            max?: number;
          };
          if (body.owner && isAddress(body.owner)) onlyOwner = body.owner;
          if (body.max != null) max = Math.min(80, Number(body.max) || 40);
        }
      } catch {
        /* empty */
      }
    }

    const out = await tickOracastWatches({ onlyOwner, max });
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      cron: isCron,
      ...out,
    });
  } catch (e) {
    console.error("[api/oracast/tick]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "tick failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  // Vercel Cron may GET the path
  return handle(req);
}
