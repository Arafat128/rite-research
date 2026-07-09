import { NextRequest, NextResponse } from "next/server";
import {
  fetchOnChainTicks,
  onChainToTickRecords,
  tickFromAgentState,
} from "@/lib/agentTicks";
import { listCachedKeeperTicks } from "@/lib/keeperCache";
import { readAgent } from "@/lib/radarRead";
import { publicErrorMessage } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agent/ticks?agentId=1
 * Returns on-chain + warm keeper-cache tick history for the UI.
 */
export async function GET(req: NextRequest) {
  try {
    const idRaw = req.nextUrl.searchParams.get("agentId");
    if (!idRaw || !/^\d+$/.test(idRaw)) {
      return NextResponse.json(
        { error: "agentId query required (uint)" },
        { status: 400 }
      );
    }
    const agentId = BigInt(idRaw);

    const [chain, agent] = await Promise.all([
      fetchOnChainTicks(agentId, 20).catch(() => []),
      readAgent(agentId),
    ]);

    const ticks = onChainToTickRecords(chain);

    // Warm keeper cache (full Surf snapshots when same instance ran cron)
    const cached = listCachedKeeperTicks(idRaw);
    for (const c of cached) {
      const i = ticks.findIndex((t) => t.runCount === c.runCount);
      const rec = {
        agentId: c.agentId,
        runCount: c.runCount,
        at: c.at,
        txHash: c.txHash,
        digest: c.digest,
        source: "keeper" as const,
        snapshot: c.snapshot,
      };
      if (i >= 0) ticks[i] = rec;
      else ticks.push(rec);
    }

    // Always surface latest seal from agent state if runCount > 0
    if (agent && agent.runCount > BigInt(0)) {
      const fromState = tickFromAgentState({
        agentId: idRaw,
        runCount: agent.runCount,
        lastRunAt: agent.lastRunAt,
        lastTopic: agent.lastTopic,
        lastDigest: agent.lastDigest,
      });
      if (fromState) {
        const has = ticks.some((t) => t.runCount === fromState.runCount);
        if (!has) ticks.push(fromState);
      }
    }

    ticks.sort(
      (a, b) => Number(b.runCount) - Number(a.runCount) || b.at - a.at
    );

    return NextResponse.json({
      ok: true,
      agentId: idRaw,
      runCount: agent ? agent.runCount.toString() : "0",
      lastRunAt: agent ? agent.lastRunAt.toString() : "0",
      lastTopic: agent?.lastTopic || "",
      ticks: ticks.slice(0, 20).map((t) => ({
        agentId: t.agentId,
        runCount: t.runCount,
        at: t.at,
        txHash: t.txHash,
        digest: t.digest,
        source: t.source,
        snapshot: {
          kind: t.snapshot.kind,
          kindLabel: t.snapshot.kindLabel,
          target: t.snapshot.target,
          fetchedAt: t.snapshot.fetchedAt,
          endpoint: t.snapshot.endpoint,
          summary: t.snapshot.summary,
          rows: t.snapshot.rows,
          highlights: t.snapshot.highlights,
        },
      })),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: publicErrorMessage(e, "Failed to load ticks") },
      { status: 500 }
    );
  }
}
