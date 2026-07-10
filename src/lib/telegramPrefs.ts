/**
 * Telegram notification prefs (owner wallet → chat id).
 *
 * Link tokens are **HMAC-signed and stateless** (safe across Vercel instances).
 * Prefs stay in-memory (reconnect after cold start unless Redis is added later).
 */

import { createHmac, timingSafeEqual } from "crypto";

export type TelegramPref = {
  owner: string;
  chatId: string;
  /** empty = all agents owned by this wallet */
  agentIds: string[];
  enabled: boolean;
  linkedAt: number;
  username?: string;
};

const g = globalThis as typeof globalThis & {
  __riteTgPrefs?: Map<string, TelegramPref>;
};

function prefs(): Map<string, TelegramPref> {
  if (!g.__riteTgPrefs) g.__riteTgPrefs = new Map();
  return g.__riteTgPrefs;
}

function linkSecret(): string {
  return (
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    process.env.CRON_SECRET ||
    process.env.TELEGRAM_BOT_TOKEN ||
    "rite-dev-tg-link"
  );
}

export function getTelegramPref(owner: string): TelegramPref | null {
  return prefs().get(owner.toLowerCase()) || null;
}

export function setTelegramPref(pref: TelegramPref) {
  prefs().set(pref.owner.toLowerCase(), {
    ...pref,
    owner: pref.owner.toLowerCase(),
  });
}

export function unlinkTelegram(owner: string) {
  prefs().delete(owner.toLowerCase());
}

/**
 * Stateless link token for t.me/bot?start=TOKEN (Telegram max ~64 chars).
 * Format: base64url(20-byte address + 4-byte exp) + 11-char sig  (~43 chars)
 */
export function createLinkToken(owner: string): string {
  const hex = owner.toLowerCase().replace(/^0x/, "");
  if (!/^[a-f0-9]{40}$/.test(hex)) {
    throw new Error("Invalid owner address for link token");
  }
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const buf = Buffer.alloc(24);
  Buffer.from(hex, "hex").copy(buf, 0);
  buf.writeUInt32BE(exp >>> 0, 20);
  const payload = buf.toString("base64url");
  const sig = createHmac("sha256", linkSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, 11);
  return `${payload}.${sig}`;
}

export function verifyLinkToken(
  token: string
): { owner: string } | null {
  const raw = (token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expect = createHmac("sha256", linkSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, 11);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(payload, "base64url");
  } catch {
    return null;
  }
  if (buf.length !== 24) return null;
  const exp = buf.readUInt32BE(20);
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const owner = `0x${buf.subarray(0, 20).toString("hex")}`;
  return { owner };
}

/** @deprecated use verifyLinkToken — kept name for call sites */
export function consumeLinkToken(
  token: string
): { owner: string; token: string; expiresAt: number } | null {
  const v = verifyLinkToken(token);
  if (!v) return null;
  return {
    owner: v.owner,
    token,
    expiresAt: Date.now() + 60_000,
  };
}

export function findPrefByChatId(chatId: string): TelegramPref | null {
  const list = Array.from(prefs().values());
  for (let i = 0; i < list.length; i++) {
    if (list[i].chatId === chatId) return list[i];
  }
  return null;
}

export function shouldNotifyAgent(
  pref: TelegramPref,
  agentId: string
): boolean {
  if (!pref.enabled || !pref.chatId) return false;
  if (!pref.agentIds.length) return true;
  return pref.agentIds.includes(agentId);
}

/** HMAC so client can confirm link without trusting raw chat ids alone */
export function createConfirmCode(owner: string, chatId: string): string {
  const body = `${owner.toLowerCase()}:${chatId}`;
  return createHmac("sha256", linkSecret())
    .update(body)
    .digest("hex")
    .slice(0, 24);
}

export function verifyConfirmCode(
  owner: string,
  chatId: string,
  code: string
): boolean {
  const expect = createConfirmCode(owner, chatId);
  try {
    const a = Buffer.from((code || "").toLowerCase());
    const b = Buffer.from(expect.toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
