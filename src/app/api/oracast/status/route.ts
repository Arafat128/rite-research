import { NextRequest, NextResponse } from "next/server";
import {
  getOracastRuntimeStatus,
  listAllActiveWatches,
  publicWatch,
} from "@/lib/oracastWatch";
import { telegramConfigured } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public diagnostics (no secrets) so we can see why closed-tab alerts fail.
 * Bearer CRON_SECRET adds active-watch summary (no private keys).
 */
export async function GET(req: NextRequest) {
  try {
    const status = await getOracastRuntimeStatus();
    const auth = req.headers.get("authorization") || "";
    const secret = process.env.CRON_SECRET;
    const detailed = Boolean(secret && auth === `Bearer ${secret}`);

    let watches: ReturnType<typeof publicWatch>[] | undefined;
    if (detailed) {
      try {
        const rows = await listAllActiveWatches();
        watches = rows.slice(0, 20).map(publicWatch);
      } catch {
        watches = [];
      }
    }

    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      telegramBot: status.telegramBot || telegramConfigured(),
      upstash: status.upstash,
      storage: status.storage,
      vercel: status.vercel,
      closedTabReady: status.closedTabReady,
      activeWatches: status.activeWatches,
      totalWatches: status.totalWatches,
      hint: status.hint,
      cron: {
        agentCron: "/api/agent/cron (Bearer CRON_SECRET) — also runs Oracast",
        oracastTick: "/api/oracast/tick (Bearer CRON_SECRET or x-vercel-cron)",
        githubAction: "Agent keeper (unattended) — needs APP_URL + CRON_SECRET secrets",
      },
      ...(detailed
        ? { detailed: true, watches }
        : { note: "Add Authorization: Bearer CRON_SECRET for detailed mode" }),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "status failed" },
      { status: 500 }
    );
  }
}
