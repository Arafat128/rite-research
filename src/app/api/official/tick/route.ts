import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { tickOfficialAgentAlerts } from "@/lib/officialAgentRegistry";
import { clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Poll official Ritual agents for activity → Telegram.
 * - Browser: POST { owner }
 * - Cron / keeper: Bearer CRON_SECRET or x-vercel-cron
 */
async function handle(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") || "";
    const secret = process.env.CRON_SECRET;
    const isCron = Boolean(
      (secret && auth === `Bearer ${secret}`) ||
        req.headers.get("x-vercel-cron") === "1"
    );

    let onlyOwner: string | undefined;
    let max = 40;

    if (!isCron) {
      const ip = clientIp(req);
      const rl = rateLimit(`official-tick:${ip}`, 12, 60_000);
      if (!rl.ok) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
      }
      try {
        const body = (await req.json()) as { owner?: string; max?: number };
        if (!body.owner || !isAddress(body.owner)) {
          return NextResponse.json(
            { error: "owner required (or CRON_SECRET)" },
            { status: 400 }
          );
        }
        onlyOwner = body.owner.toLowerCase();
        if (body.max != null) max = Math.min(20, Number(body.max) || 12);
      } catch {
        return NextResponse.json({ error: "JSON body required" }, { status: 400 });
      }
    } else if (req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          owner?: string;
          max?: number;
        };
        if (body.owner && isAddress(body.owner)) onlyOwner = body.owner;
        if (body.max != null) max = Math.min(80, Number(body.max) || 40);
      } catch {
        /* empty */
      }
    }

    const out = await tickOfficialAgentAlerts({ onlyOwner, max });
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      cron: isCron,
      ...out,
    });
  } catch (e) {
    console.error("[api/official/tick]", e);
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
  return handle(req);
}
