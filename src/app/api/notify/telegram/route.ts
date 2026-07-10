import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  createLinkToken,
  getTelegramPref,
  resolveTelegramPref,
  setTelegramPref,
  setTelegramPrefAsync,
  telegramPrefsBackend,
  unlinkTelegram,
  verifyConfirmCode,
} from "@/lib/telegramPrefs";
import {
  telegramBotUsername,
  telegramConfigured,
  sendTelegramMessage,
} from "@/lib/telegram";
import { clientIp, publicErrorMessage, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  ?owner=0x…     → link status + deep-link URL
 * POST { action, owner, ... }
 *   action=link     → { deepLink, token }
 *   action=unlink   → clear prefs
 *   action=toggle   → { enabled }
 *   action=test     → send test DM
 *   action=agents   → { agentIds: string[] }  filter (empty = all)
 */
export async function GET(req: NextRequest) {
  try {
    const owner = (req.nextUrl.searchParams.get("owner") || "").toLowerCase();
    if (!owner || !isAddress(owner)) {
      return NextResponse.json({ error: "owner address required" }, { status: 400 });
    }
    const pref = await resolveTelegramPref(owner);
    const bot = telegramBotUsername();
    const linked = Boolean(pref?.chatId);
    const backend = telegramPrefsBackend();
    // Never expose raw chatId on unauthenticated GET (hijack / spam target)
    return NextResponse.json({
      ok: true,
      configured: telegramConfigured(),
      botUsername: bot || null,
      linked,
      enabled: pref?.enabled ?? false,
      username: pref?.username || null,
      agentIds: pref?.agentIds || [],
      linkedAt: pref?.linkedAt || null,
      hasChatId: Boolean(pref?.chatId),
      storeBackend: backend,
      multiUserReady: backend === "upstash",
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: publicErrorMessage(e, "status failed") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`tg-api:${ip}`, 30, 60_000);
    if (!rl.ok) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = (await req.json()) as {
      action?: string;
      owner?: string;
      enabled?: boolean;
      agentIds?: string[];
      chatId?: string;
      code?: string;
      username?: string;
      /** skip DM when re-hydrating from localStorage after cold start */
      silent?: boolean;
    };
    const owner = (body.owner || "").toLowerCase();
    if (!owner || !isAddress(owner)) {
      return NextResponse.json({ error: "Valid owner address required" }, { status: 400 });
    }
    if (!telegramConfigured()) {
      return NextResponse.json(
        {
          error:
            "Telegram not configured. Set TELEGRAM_BOT_TOKEN (and NEXT_PUBLIC_TELEGRAM_BOT_USERNAME).",
        },
        { status: 503 }
      );
    }

    const action = body.action || "link";

    if (action === "link") {
      const token = createLinkToken(owner);
      const bot = telegramBotUsername();
      if (!bot) {
        return NextResponse.json(
          {
            error:
              "Set NEXT_PUBLIC_TELEGRAM_BOT_USERNAME (bot username without @).",
          },
          { status: 503 }
        );
      }
      const deepLink = `https://t.me/${bot}?start=${encodeURIComponent(token)}`;
      return NextResponse.json({
        ok: true,
        token,
        deepLink,
        expiresInSec: 15 * 60,
      });
    }

    if (action === "unlink") {
      unlinkTelegram(owner);
      return NextResponse.json({ ok: true, linked: false });
    }

    if (action === "toggle") {
      const pref = getTelegramPref(owner);
      if (!pref?.chatId) {
        return NextResponse.json({ error: "Link Telegram first" }, { status: 400 });
      }
      const enabled = body.enabled ?? !pref.enabled;
      setTelegramPref({ ...pref, enabled });
      return NextResponse.json({ ok: true, enabled });
    }

    if (action === "agents") {
      const pref = getTelegramPref(owner);
      if (!pref?.chatId) {
        return NextResponse.json({ error: "Link Telegram first" }, { status: 400 });
      }
      const agentIds = Array.isArray(body.agentIds)
        ? body.agentIds.map(String).slice(0, 50)
        : [];
      setTelegramPref({ ...pref, agentIds });
      return NextResponse.json({ ok: true, agentIds });
    }

    if (action === "test") {
      let pref = await resolveTelegramPref(owner);
      // Allow client to rehydrate chat id when serverless instance has empty memory
      const clientChat = String(body.chatId || "").trim();
      if (!pref?.chatId && clientChat && /^\d+$/.test(clientChat)) {
        await setTelegramPrefAsync({
          owner,
          chatId: clientChat,
          agentIds: [],
          enabled: true,
          linkedAt: Date.now(),
          username: body.username?.replace(/^@/, "") || undefined,
        });
        pref = await resolveTelegramPref(owner);
      }
      if (!pref?.chatId) {
        return NextResponse.json({ error: "Link Telegram first" }, { status: 400 });
      }
      if (!pref.enabled) {
        return NextResponse.json(
          { error: "Notifications are paused — enable them first" },
          { status: 400 }
        );
      }
      await sendTelegramMessage(
        pref.chatId,
        [
          `<b>Rite test message</b> ✅`,
          ``,
          `Linked wallet: <code>${owner.slice(0, 6)}…${owner.slice(-4)}</code>`,
          `When your agents seal a tick, you will get a DM like this.`,
        ].join("\n")
      );
      return NextResponse.json({ ok: true, sent: true });
    }

    // Confirm link from Telegram deep-link back into the app (durable across instances)
    if (action === "confirm") {
      const chatId = String(body.chatId || "").trim();
      const code = String(body.code || "").trim();
      if (!chatId || !code) {
        return NextResponse.json(
          { error: "chatId and code required" },
          { status: 400 }
        );
      }
      if (!verifyConfirmCode(owner, chatId, code)) {
        return NextResponse.json(
          { error: "Invalid confirm code" },
          { status: 403 }
        );
      }
      const existing = await resolveTelegramPref(owner);
      const username =
        (body.username || existing?.username || "").replace(/^@/, "") ||
        undefined;
      await setTelegramPrefAsync({
        owner,
        chatId,
        agentIds: existing?.agentIds || [],
        enabled: true,
        linkedAt: Date.now(),
        username,
      });
      return NextResponse.json({
        ok: true,
        linked: true,
        chatId,
        username: username || null,
      });
    }

    // Manual chat id paste (backup) OR silent re-hydrate from browser localStorage.
    // Security: never allow overwriting an existing link with a *different* chatId
    // without confirm code (prevents wallet→chat hijack).
    if (action === "register_chat") {
      const chatId = String(body.chatId || "").trim();
      if (!/^\d+$/.test(chatId)) {
        return NextResponse.json(
          { error: "chatId must be numeric (from the bot message)" },
          { status: 400 }
        );
      }
      const existing = await resolveTelegramPref(owner);
      if (existing?.chatId && existing.chatId !== chatId) {
        return NextResponse.json(
          {
            error:
              "Owner already linked to a different chat. Unlink first or use Connect Telegram / confirm link.",
          },
          { status: 403 }
        );
      }
      const username =
        (body.username || existing?.username || "").replace(/^@/, "") ||
        undefined;
      const enabled =
        typeof body.enabled === "boolean"
          ? body.enabled
          : (existing?.enabled ?? true);
      await setTelegramPrefAsync({
        owner,
        chatId,
        agentIds: existing?.agentIds || [],
        enabled,
        linkedAt: existing?.linkedAt || Date.now(),
        username,
      });
      if (!body.silent) {
        try {
          await sendTelegramMessage(
            chatId,
            `<b>Rite</b>: chat id registered for <code>${owner.slice(0, 6)}…${owner.slice(-4)}</code>. Alerts ON.`
          );
        } catch {
          /* still save */
        }
      }
      return NextResponse.json({
        ok: true,
        linked: true,
        chatId,
        username: username || null,
        enabled,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: unknown) {
    console.error("[telegram/api]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "Telegram API failed") },
      { status: 500 }
    );
  }
}
