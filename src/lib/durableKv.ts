/**
 * Shared durable KV for research locks / nonces / sealed reports.
 * Prefers Upstash (same as Oracast); falls back to local filesystem JSON.
 *
 * Env (production multi-instance):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */
import fs from "node:fs";
import path from "node:path";

const FILE =
  process.env.VERCEL
    ? "/tmp/rite-durable-kv.json"
    : path.join(process.cwd(), "data", "rite-durable-kv.json");

type Store = Record<string, { v: string; exp?: number }>;

function loadFile(): Store {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function saveFile(s: Store) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(s), "utf8");
  } catch (e) {
    console.warn("[durableKv] file write failed", e);
  }
}

function upstashConfigured() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

async function upstash(
  cmd: (string | number)[]
): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await fetch(`${base}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([cmd]),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const json = (await res.json()) as { result?: unknown }[];
  return json?.[0]?.result;
}

export async function kvGet(key: string): Promise<string | null> {
  if (upstashConfigured()) {
    try {
      const r = await upstash(["GET", key]);
      return r == null ? null : String(r);
    } catch (e) {
      console.warn("[durableKv] GET", e);
    }
  }
  const s = loadFile();
  const row = s[key];
  if (!row) return null;
  if (row.exp && row.exp < Date.now()) {
    delete s[key];
    saveFile(s);
    return null;
  }
  return row.v;
}

export async function kvSet(
  key: string,
  value: string,
  ttlSec?: number
): Promise<void> {
  if (upstashConfigured()) {
    try {
      if (ttlSec && ttlSec > 0) {
        await upstash(["SET", key, value, "EX", ttlSec]);
      } else {
        await upstash(["SET", key, value]);
      }
      return;
    } catch (e) {
      console.warn("[durableKv] SET", e);
    }
  }
  const s = loadFile();
  s[key] = {
    v: value,
    exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined,
  };
  saveFile(s);
}

/** SET NX with TTL — returns true if lock acquired */
export async function kvSetNx(
  key: string,
  value: string,
  ttlSec: number
): Promise<boolean> {
  if (upstashConfigured()) {
    try {
      const r = await upstash(["SET", key, value, "EX", ttlSec, "NX"]);
      return r === "OK";
    } catch (e) {
      console.warn("[durableKv] SET NX", e);
    }
  }
  const s = loadFile();
  const row = s[key];
  if (row && (!row.exp || row.exp > Date.now())) return false;
  s[key] = { v: value, exp: Date.now() + ttlSec * 1000 };
  saveFile(s);
  return true;
}

export async function kvDel(key: string): Promise<void> {
  if (upstashConfigured()) {
    try {
      await upstash(["DEL", key]);
      return;
    } catch {
      /* */
    }
  }
  const s = loadFile();
  delete s[key];
  saveFile(s);
}
