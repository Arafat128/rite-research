import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { notifyAgentTick, sendTelegramMessage, formatTickTelegramMessage } from "@/lib/telegram";
import { getTelegramPref, setTelegramPref } from "@/lib/telegramPrefs";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — send tick DM (called from browser after successful manual Wake).
 * Optional chatId from client localStorage re-hydrates server prefs after cold start.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`tg-push:${ip}`, 40, 60_000);
    if (!rl.ok) {
      return NextResponse.json({ error: "rate limited" }, { status: 429 });
    }

    const body = (await req.json()) as {
      owner?: string;
      agentId?: string;
      agentName?: string;
      runCount?: string;
      summary?: string;
      kindLabel?: string;
      target?: string;
      txHash?: string;
      died?: boolean;
      chatId?: string;
    };

    if (!body.owner || !isAddress(body.owner)) {
      return NextResponse.json({ error: "owner required" }, { status: 400 });
    }
    if (!body.agentId || !body.summary || !body.runCount) {
      return NextResponse.json(
        { error: "agentId, runCount, summary required" },
        { status: 400 }
      );
    }

    // Re-hydrate server map from client chat id if needed
    if (body.chatId && /^\d+$/.test(body.chatId)) {
      const pref = getTelegramPref(body.owner);
      if (!pref?.chatId) {
        setTelegramPref({
          owner: body.owner.toLowerCase(),
          chatId: body.chatId,
          agentIds: [],
          enabled: true,
          linkedAt: Date.now(),
        });
      }
    }

    const out = await notifyAgentTick({
      owner: body.owner,
      agentId: String(body.agentId),
      agentName: body.agentName,
      runCount: String(body.runCount),
      summary: String(body.summary).slice(0, 800),
      kindLabel: body.kindLabel,
      target: body.target,
      txHash: body.txHash,
      died: Boolean(body.died),
    });

    // Direct send if notify skipped not_linked but client sent chatId
    if (!out.sent && body.chatId && /^\d+$/.test(body.chatId) && out.reason === "not_linked") {
      try {
        await sendTelegramMessage(
          body.chatId,
          formatTickTelegramMessage({
            owner: body.owner,
            agentId: String(body.agentId),
            agentName: body.agentName,
            runCount: String(body.runCount),
            summary: String(body.summary).slice(0, 800),
            kindLabel: body.kindLabel,
            target: body.target,
            txHash: body.txHash,
            died: Boolean(body.died),
          })
        );
        return NextResponse.json({ ok: true, sent: true, reason: "client_chat" });
      } catch {
        /* fall through */
      }
    }

    return NextResponse.json({ ok: true, ...out });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: publicErrorMessage(e, "push failed") },
      { status: 500 }
    );
  }
}
