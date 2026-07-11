/**
 * Multi-user Telegram prefs for serverless.
 *
 * Correct product flow (each user only clicks Connect Telegram in the app):
 *   webhook / register_chat → setTelegramPref → Upstash Redis (shared)
 *   keeper cron → getTelegramPref(owner) → send DM
 *
 * One-time admin setup (not per user): free Upstash Redis on Vercel/Upstash
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Without Upstash, prefs are memory+/tmp only → multi-instance cron cannot see
 * links made on another instance. TELEGRAM_DEFAULT_CHAT_ID is a dev-only fallback.
 */

import type { TelegramPref } from "@/lib/telegramPrefs";

const KEY_PREFIX = "rite:tg:pref:";

function upstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

export function telegramStoreBackend(): "upstash" | "memory" {
  return upstashConfigured() ? "upstash" : "memory";
}

async function upstashFetch(
  path: string[],
  init?: RequestInit
): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const url = `${base}/${path.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = (await res.json()) as { result?: unknown };
  return data.result;
}

export async function remoteGetPref(
  owner: string
): Promise<TelegramPref | null> {
  if (!upstashConfigured()) return null;
  try {
    const raw = await upstashFetch([
      "get",
      `${KEY_PREFIX}${owner.toLowerCase()}`,
    ]);
    if (raw == null || raw === "") return null;
    const p =
      typeof raw === "string" ? (JSON.parse(raw) as TelegramPref) : (raw as TelegramPref);
    if (!p?.chatId) return null;
    return { ...p, owner: owner.toLowerCase() };
  } catch (e) {
    console.warn("[telegramStore] get failed", e);
    return null;
  }
}

export async function remoteSetPref(pref: TelegramPref): Promise<boolean> {
  if (!upstashConfigured()) return false;
  try {
    const body = JSON.stringify({
      ...pref,
      owner: pref.owner.toLowerCase(),
    });
    // SET key value  — REST path form
    await upstashFetch(
      ["set", `${KEY_PREFIX}${pref.owner.toLowerCase()}`, body],
      { method: "POST" }
    );
    return true;
  } catch (e) {
    console.warn("[telegramStore] set failed", e);
    return false;
  }
}

export async function remoteDeletePref(owner: string): Promise<boolean> {
  if (!upstashConfigured()) return false;
  try {
    await upstashFetch(["del", `${KEY_PREFIX}${owner.toLowerCase()}`]);
    return true;
  } catch (e) {
    console.warn("[telegramStore] del failed", e);
    return false;
  }
}

const TICK_DM_PREFIX = "rite:tg:tickdm:";

/**
 * Claim exclusive right to send a tick DM (multi-instance safe when Upstash is on).
 * @returns true if this caller should send; false if already claimed/sent
 */
export async function remoteClaimTickDm(
  key: string,
  ttlSec = 900
): Promise<boolean | null> {
  if (!upstashConfigured()) return null;
  try {
    // SET key 1 NX EX ttl — result "OK" if claimed, null if key exists
    const result = await upstashFetch([
      "set",
      `${TICK_DM_PREFIX}${key}`,
      "1",
      "nx",
      "ex",
      String(Math.max(60, ttlSec)),
    ]);
    return result === "OK" || result === true;
  } catch (e) {
    console.warn("[telegramStore] claim tick dm failed", e);
    return null;
  }
}

/** Release claim so a failed send can be retried */
export async function remoteReleaseTickDm(key: string): Promise<void> {
  if (!upstashConfigured()) return;
  try {
    await upstashFetch(["del", `${TICK_DM_PREFIX}${key}`]);
  } catch {
    /* ignore */
  }
}
