/**
 * Telegram notification prefs (owner wallet → chat id).
 *
 * Link tokens are **HMAC-signed and stateless** (safe across Vercel instances).
 * Prefs: in-memory + durable JSON file when possible (local / writable FS).
 * On multi-instance serverless, clients re-hydrate via register_chat + localStorage.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

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
  __riteTgPrefsLoaded?: boolean;
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

/** Writable path for durable prefs (works locally; may work on some serverless). */
function durablePath(): string | null {
  try {
    const base =
      process.env.TELEGRAM_PREFS_PATH ||
      process.env.RITE_DATA_DIR ||
      (process.env.VERCEL
        ? path.join("/tmp", "rite-telegram-prefs.json")
        : path.join(process.cwd(), ".data", "telegram-prefs.json"));
    return base;
  } catch {
    return null;
  }
}

function loadDurable(): void {
  if (g.__riteTgPrefsLoaded) return;
  g.__riteTgPrefsLoaded = true;
  const file = durablePath();
  if (!file || !existsSync(file)) return;
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as Record<string, TelegramPref>;
    const m = prefs();
    for (const [k, v] of Object.entries(data)) {
      if (v?.chatId && v?.owner) {
        m.set(k.toLowerCase(), {
          ...v,
          owner: v.owner.toLowerCase(),
        });
      }
    }
  } catch (e) {
    console.warn("[telegramPrefs] durable load failed", e);
  }
}

function saveDurable(): void {
  const file = durablePath();
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, TelegramPref> = {};
    prefs().forEach((v, k) => {
      obj[k] = v;
    });
    writeFileSync(file, JSON.stringify(obj), "utf8");
  } catch (e) {
    // /tmp works on Vercel but is per-instance ephemeral — still better than pure RAM for warm instances
    console.warn("[telegramPrefs] durable save failed", e);
  }
}

export function getTelegramPref(owner: string): TelegramPref | null {
  loadDurable();
  return prefs().get(owner.toLowerCase()) || null;
}

export function setTelegramPref(pref: TelegramPref) {
  loadDurable();
  prefs().set(pref.owner.toLowerCase(), {
    ...pref,
    owner: pref.owner.toLowerCase(),
  });
  saveDurable();
}

export function unlinkTelegram(owner: string) {
  loadDurable();
  prefs().delete(owner.toLowerCase());
  saveDurable();
}

/**
 * Stateless link token for t.me/bot?start=TOKEN.
 *
 * Telegram deep-link payload: max 64 chars, ONLY [A-Za-z0-9_-]
 * (a bare "." is illegal — Telegram drops the whole start param → bare /start).
 *
 * Format: base64url(20-byte address + 4-byte exp)[32] + sig[11] = 43 chars
 * (no separator; fixed lengths)
 */
const LINK_PAYLOAD_LEN = 32;
const LINK_SIG_LEN = 11;

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
  if (payload.length !== LINK_PAYLOAD_LEN) {
    throw new Error("Unexpected link payload length");
  }
  const sig = createHmac("sha256", linkSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, LINK_SIG_LEN);
  return `${payload}${sig}`;
}

export function verifyLinkToken(
  token: string
): { owner: string } | null {
  let raw = (token || "").trim();
  // Legacy tokens used "payload.sig" — Telegram never delivered the ".";
  // still accept if something forwards them with a separator.
  if (raw.includes(".")) {
    const parts = raw.split(".");
    if (parts.length === 2 && parts[0] && parts[1]) {
      raw = `${parts[0]}${parts[1]}`;
    } else {
      return null;
    }
  }
  if (raw.length !== LINK_PAYLOAD_LEN + LINK_SIG_LEN) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const payload = raw.slice(0, LINK_PAYLOAD_LEN);
  const sig = raw.slice(LINK_PAYLOAD_LEN);
  const expect = createHmac("sha256", linkSecret())
    .update(payload)
    .digest("base64url")
    .slice(0, LINK_SIG_LEN);
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
  loadDurable();
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
