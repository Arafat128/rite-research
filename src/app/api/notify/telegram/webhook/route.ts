import { NextRequest, NextResponse } from "next/server";
import {
  createConfirmCode,
  findPrefByChatId,
  getTelegramPref,
  setTelegramPref,
  verifyLinkToken,
} from "@/lib/telegramPrefs";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { publicErrorMessage } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telegram POSTs updates here.
 *
 * setWebhook MUST use the SAME secret_token as env TELEGRAM_WEBHOOK_SECRET:
 *   secret_token=<TELEGRAM_WEBHOOK_SECRET>
 * Telegram then sends header: X-Telegram-Bot-Api-Secret-Token
 *
 * If Vercel Deployment Protection is on, use bypass query on the webhook URL.
 */
function webhookAuthorized(req: NextRequest): boolean {
  const secret = (
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    process.env.CRON_SECRET ||
    ""
  ).trim();
  // No secret configured → accept (dev). Production should always set one.
  if (!secret) return true;
  const header = (
    req.headers.get("x-telegram-bot-api-secret-token") || ""
  ).trim();
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
      console.warn("[telegram/webhook] TELEGRAM_BOT_TOKEN missing");
      return NextResponse.json({ ok: false, error: "bot not configured" }, { status: 503 });
    }
    if (!webhookAuthorized(req)) {
      console.warn(
        "[telegram/webhook] Unauthorized — secret_token must match TELEGRAM_WEBHOOK_SECRET on Vercel. Re-run setWebhook."
      );
      return NextResponse.json(
        {
          error: "Unauthorized",
          hint: "setWebhook secret_token must equal TELEGRAM_WEBHOOK_SECRET env exactly",
        },
        { status: 401 }
      );
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
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      ""
    ).replace(/\/$/, "");
    const site =
      appUrl.startsWith("http")
        ? appUrl
        : appUrl
          ? `https://${appUrl}`
          : "https://rite-mehidy-s-projects.vercel.app";

    // /start <token> — link wallet from Rite app deep link
    if (text.startsWith("/start")) {
      const parts = text.split(/\s+/);
      const token = parts[1]?.trim();
      if (!token) {
        await sendTelegramMessage(
          chat,
          [
            `<b>Rite notifications</b>`,
            ``,
            `This Start had <b>no wallet token</b> (Telegram dropped it or you opened the bot directly).`,
            ``,
            `<b>Fix:</b>`,
            `1. Rite → My Agents → <b>Connect Telegram</b> / <b>New link</b>`,
            `2. Use <b>Open bot</b> or <b>Copy link</b> (must look like <code>t.me/…?start=…</code>)`,
            `3. Press Start from that link`,
            ``,
            `<b>Backup:</b> send`,
            `<code>/link 0xYourWalletAddress</code>`,
            `then paste the chat id into the app.`,
          ].join("\n")
        );
        return NextResponse.json({ ok: true });
      }

      const verified = verifyLinkToken(token);
      if (!verified) {
        await sendTelegramMessage(
          chat,
          [
            `Link expired or invalid.`,
            ``,
            `1. Open Rite → <b>My Agents</b>`,
            `2. Click <b>Connect Telegram</b> again (new link)`,
            `3. Press <b>Start</b> in this bot`,
            ``,
            `Do not type /start yourself without the app link.`,
          ].join("\n")
        );
        return NextResponse.json({ ok: true });
      }

      const existing = getTelegramPref(verified.owner);
      setTelegramPref({
        owner: verified.owner,
        chatId: chat,
        agentIds: existing?.agentIds || [],
        enabled: true,
        linkedAt: Date.now(),
        username,
      });

      const confirm = createConfirmCode(verified.owner, chat);
      const confirmUrl = `${site}/?tg_owner=${encodeURIComponent(verified.owner)}&tg_chat=${encodeURIComponent(chat)}&tg_code=${encodeURIComponent(confirm)}`;

      await sendTelegramMessage(
        chat,
        [
          `<b>Linked to Rite</b> ✅`,
          ``,
          `Wallet: <code>${verified.owner.slice(0, 6)}…${verified.owner.slice(-4)}</code>`,
          `Chat id: <code>${chat}</code>`,
          ``,
          `Back in Rite, click <b>Refresh status</b> (or open this link once):`,
          confirmUrl,
          ``,
          `You will get DMs when agents seal a tick.`,
          `/status · /stop`,
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
            `Chat id: <code>${chat}</code>`,
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
        `Notifications paused. Re-enable from Rite → My Agents → Telegram.`
      );
      return NextResponse.json({ ok: true });
    }

    // Manual paste: /link 0xWALLET (backup if deep link fails)
    if (text.startsWith("/link ")) {
      const owner = text.slice(6).trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(owner)) {
        await sendTelegramMessage(
          chat,
          `Usage: <code>/link 0xYourWalletAddress</code>`
        );
        return NextResponse.json({ ok: true });
      }
      setTelegramPref({
        owner,
        chatId: chat,
        agentIds: [],
        enabled: true,
        linkedAt: Date.now(),
        username,
      });
      const confirm = createConfirmCode(owner, chat);
      const confirmUrl = `${site}/?tg_owner=${encodeURIComponent(owner)}&tg_chat=${encodeURIComponent(chat)}&tg_code=${encodeURIComponent(confirm)}`;
      await sendTelegramMessage(
        chat,
        [
          `<b>Linked</b> ✅ via /link`,
          `Wallet: <code>${owner.slice(0, 6)}…${owner.slice(-4)}</code>`,
          ``,
          `Confirm in Rite:`,
          confirmUrl,
        ].join("\n")
      );
      return NextResponse.json({ ok: true });
    }

    await sendTelegramMessage(
      chat,
      `Commands: /start · /status · /stop · /link 0xYourWallet`
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
