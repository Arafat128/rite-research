/**
 * Telegram Bot API helpers (server-only).
 * Docs: https://core.telegram.org/bots/api
 */

import { EXPLORER_URL as EXPLORER } from "@/lib/ritual";
import {
  getTelegramPref,
  shouldNotifyAgent,
  type TelegramPref,
} from "@/lib/telegramPrefs";

const API = "https://api.telegram.org";

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function telegramBotUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "").replace(
    /^@/,
    ""
  );
}

async function botApi<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result as T;
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts?: { disablePreview?: boolean }
): Promise<void> {
  await botApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: opts?.disablePreview ?? true,
  });
}

export type TickNotifyPayload = {
  owner: string;
  agentId: string;
  agentName?: string;
  runCount: string;
  summary: string;
  kindLabel?: string;
  target?: string;
  txHash?: string;
  died?: boolean;
};

export function formatTickTelegramMessage(p: TickNotifyPayload): string {
  const stream = [p.kindLabel, p.target && p.target !== "_" ? p.target : ""]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `<b>Rite agent tick</b>`,
    ``,
    `Agent <b>#${p.agentId}</b>${p.agentName ? ` · ${escapeHtml(p.agentName)}` : ""}`,
    stream ? `Stream: ${escapeHtml(stream)}` : null,
    `Tick <b>#${p.runCount}</b>${p.died ? " · <b>DIED</b> (sovereign complete)" : ""}`,
    ``,
    escapeHtml(p.summary.slice(0, 500)),
  ].filter((x) => x != null) as string[];

  if (p.txHash) {
    const base = (EXPLORER || "https://explorer.ritualfoundation.org").replace(
      /\/$/,
      ""
    );
    lines.push(``, `<a href="${base}/tx/${p.txHash}">Seal tx ↗</a>`);
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Notify owner if Telegram is linked and agent matches filter.
 * Never throws to callers (log only).
 */
export async function notifyAgentTick(
  p: TickNotifyPayload
): Promise<{ sent: boolean; reason?: string }> {
  if (!telegramConfigured()) {
    return { sent: false, reason: "telegram_not_configured" };
  }
  const pref = getTelegramPref(p.owner);
  if (!pref) return { sent: false, reason: "not_linked" };
  if (!shouldNotifyAgent(pref, p.agentId)) {
    return { sent: false, reason: "filtered" };
  }
  try {
    await sendTelegramMessage(pref.chatId, formatTickTelegramMessage(p));
    return { sent: true };
  } catch (e) {
    console.warn("[telegram] send failed", e);
    return {
      sent: false,
      reason: e instanceof Error ? e.message.slice(0, 120) : "send_failed",
    };
  }
}

export type { TelegramPref };
