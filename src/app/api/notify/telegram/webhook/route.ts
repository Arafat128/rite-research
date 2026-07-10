import { NextRequest, NextResponse } from "next/server";
import {
  consumeLinkToken,
  findPrefByChatId,
  getTelegramPref,
  setTelegramPref,
} from "@/lib/telegramPrefs";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { publicErrorMessage } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telegram will POST updates here.
 * Set webhook:
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_APP/api/notify/telegram/webhook&secret_token=YOUR_SECRET
 *
 * Auth: header X-Telegram-Bot-Api-Secret-Token === TELEGRAM_WEBHOOK_SECRET
 *   (or CRON_SECRET if webhook secret unset)
 */
function webhookAuthorized(req: NextRequest): boolean {
  const secret =
    process.env.TELEGRAM_WEBHOOK_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return true; // allow if not configured (dev only)
  const header = req.headers.get("x-telegram-bot-api-secret-token") || "";
  return header === secret;
}

type TgUpdate = {
  message?: {
    text?: string;
    chat?: { id: number; username?: string; type?: string };
    from?: { username?: string };
  };
};

export async function POST(req: NextRequest) {
  try {
    if (!telegramConfigured()) {
      return NextResponse.json({ ok: false }, { status: 503 });
    }
    if (!webhookAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const update = (await req.json()) as TgUpdate;
    const msg = update.message;
    const text = (msg?.text || "").trim();
    const chatId = msg?.chat?.id;
    if (!text || chatId == null) {
      return NextResponse.json({ ok: true });
    }

    const chat = String(chatId);
    const username = msg?.from?.username || msg?.chat?.username;

    // /start <token> — link wallet from Rite app
    if (text.startsWith("/start")) {
      const parts = text.split(/\s+/);
      const token = parts[1]?.trim();
      if (!token) {
        await sendTelegramMessage(
          chat,
          [
            `<b>Rite notifications</b>`,
            ``,
            `Open the Rite app → <b>My Agents</b> → <b>Telegram</b> → Connect.`,
            `That opens this bot with a one-time link so we can DM your agent ticks.`,
          ].join("\n")
        );
        return NextResponse.json({ ok: true });
      }

      const pending = consumeLinkToken(token);
      if (!pending) {
        await sendTelegramMessage(
          chat,
          `Link expired or invalid. Go back to Rite → My Agents → Connect Telegram and try again.`
        );
        return NextResponse.json({ ok: true });
      }

      const existing = getTelegramPref(pending.owner);
      setTelegramPref({
        owner: pending.owner,
        chatId: chat,
        agentIds: existing?.agentIds || [],
        enabled: true,
        linkedAt: Date.now(),
        username,
      });

      await sendTelegramMessage(
        chat,
        [
          `<b>Linked to Rite</b> ✅`,
          ``,
          `Wallet: <code>${pending.owner.slice(0, 6)}…${pending.owner.slice(-4)}</code>`,
          `You will receive DMs when your agents seal a tick.`,
          ``,
          `Commands:`,
          `/status — link status`,
          `/stop — pause notifications`,
          `/start — help`,
        ].join("\n")
      );
      return NextResponse.json({ ok: true });
    }

    if (text === "/status" || text.startsWith("/status")) {
      const found = findPrefByChatId(chat);
      if (!found) {
        await sendTelegramMessage(
          chat,
          `Not linked. Use Rite → My Agents → Connect Telegram.`
        );
      } else {
        await sendTelegramMessage(
          chat,
          [
            `<b>Status</b>`,
            `Wallet: <code>${found.owner.slice(0, 6)}…${found.owner.slice(-4)}</code>`,
            `Notifications: ${found.enabled ? "ON" : "OFF"}`,
          ].join("\n")
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (text === "/stop") {
      const found = findPrefByChatId(chat);
      if (found) {
        setTelegramPref({ ...found, enabled: false });
      }
      await sendTelegramMessage(
        chat,
        `Notifications paused. Re-enable from Rite → My Agents → Telegram, or Connect again.`
      );
      return NextResponse.json({ ok: true });
    }

    await sendTelegramMessage(
      chat,
      `Unknown command. Use /start, /status, or /stop.`
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[telegram/webhook]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "webhook failed") },
      { status: 500 }
    );
  }
}
