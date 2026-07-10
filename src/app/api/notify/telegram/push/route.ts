import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  notifyAgentTick,
  sendTelegramMessage,
  formatTickTelegramMessage,
  type TickNotifyPayload,
} from "@/lib/telegram";
import { setTelegramPrefAsync } from "@/lib/telegramPrefs";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";
import type { SnapshotCell } from "@/lib/surfData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cap rows sent in DM (matches site news table) */
const MAX_ROWS = 8;

function slimRows(
  rows: unknown
): Array<Record<string, SnapshotCell>> | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return rows.slice(0, MAX_ROWS).map((row) => {
    const out: Record<string, SnapshotCell> = {};
    if (!row || typeof row !== "object") return out;
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (v == null) {
        out[k] = null;
      } else if (typeof v === "string" || typeof v === "number") {
        out[k] = typeof v === "string" ? v.slice(0, 500) : v;
      } else if (typeof v === "object" && v !== null && "text" in v) {
        const o = v as { text?: unknown; href?: unknown };
        const href =
          typeof o.href === "string" && /^https?:\/\//i.test(o.href)
            ? o.href.slice(0, 2048)
            : undefined;
        out[k] = {
          text: String(o.text ?? "").slice(0, 500),
          ...(href ? { href } : {}),
        };
      } else {
        out[k] = String(v).slice(0, 200);
      }
    }
    return out;
  });
}

/**
 * POST — send tick DM (called from browser after successful manual Wake).
 * Optional chatId from client localStorage re-hydrates server prefs after cold start.
 * Pass `rows` + `highlights` so Telegram mirrors the site table (clickable headlines).
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
      rows?: unknown;
      highlights?: Array<{ label?: string; value?: string }>;
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

    // Re-hydrate durable store from client chat id (multi-user + cold start)
    if (body.chatId && /^\d+$/.test(body.chatId)) {
      await setTelegramPrefAsync({
        owner: body.owner.toLowerCase(),
        chatId: body.chatId,
        agentIds: [],
        enabled: true,
        linkedAt: Date.now(),
      });
    }

    const rows = slimRows(body.rows);
    const highlights = Array.isArray(body.highlights)
      ? body.highlights
          .filter((h) => h && (h.label || h.value))
          .slice(0, 8)
          .map((h) => ({
            label: String(h.label || "").slice(0, 40),
            value: String(h.value || "").slice(0, 80),
          }))
      : undefined;

    const payload: TickNotifyPayload = {
      owner: body.owner,
      agentId: String(body.agentId),
      agentName: body.agentName,
      runCount: String(body.runCount),
      summary: String(body.summary).slice(0, 800),
      kindLabel: body.kindLabel,
      target: body.target,
      txHash: body.txHash,
      died: Boolean(body.died),
      rows,
      highlights,
    };

    const out = await notifyAgentTick(payload);

    // Direct send if notify skipped not_linked but client sent chatId
    if (
      !out.sent &&
      body.chatId &&
      /^\d+$/.test(body.chatId) &&
      out.reason === "not_linked"
    ) {
      try {
        await sendTelegramMessage(
          body.chatId,
          formatTickTelegramMessage(payload)
        );
        return NextResponse.json({
          ok: true,
          sent: true,
          reason: "client_chat",
        });
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
