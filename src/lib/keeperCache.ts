/**
 * Keeper tick snapshots for UI merge.
 * In-memory + durable JSON (local .data / Vercel /tmp) so /api/agent/ticks
 * can still serve full rows after auto-wake on the same machine/instance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { SurfDataSnapshot } from "@/lib/surfData";

export type KeeperCachedTick = {
  agentId: string;
  runCount: string;
  at: number;
  txHash?: string;
  digest?: string;
  snapshot: SurfDataSnapshot;
};

const g = globalThis as typeof globalThis & {
  __riteKeeperTicks?: Map<string, KeeperCachedTick[]>;
  __riteKeeperTicksLoaded?: boolean;
};

function store(): Map<string, KeeperCachedTick[]> {
  if (!g.__riteKeeperTicks) g.__riteKeeperTicks = new Map();
  return g.__riteKeeperTicks;
}

function durablePath(): string | null {
  try {
    if (process.env.KEEPER_TICKS_PATH) return process.env.KEEPER_TICKS_PATH;
    if (process.env.RITE_DATA_DIR) {
      return path.join(process.env.RITE_DATA_DIR, "keeper-ticks.json");
    }
    return process.env.VERCEL
      ? path.join("/tmp", "rite-keeper-ticks.json")
      : path.join(process.cwd(), ".data", "keeper-ticks.json");
  } catch {
    return null;
  }
}

function loadDurable(): void {
  if (g.__riteKeeperTicksLoaded) return;
  g.__riteKeeperTicksLoaded = true;
  const file = durablePath();
  if (!file || !existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      KeeperCachedTick[]
    >;
    const m = store();
    for (const [k, list] of Object.entries(raw)) {
      if (Array.isArray(list) && list.length) m.set(k, list.slice(0, 20));
    }
  } catch (e) {
    console.warn("[keeperCache] durable load failed", e);
  }
}

function saveDurable(): void {
  const file = durablePath();
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, KeeperCachedTick[]> = {};
    store().forEach((list, k) => {
      obj[k] = list;
    });
    writeFileSync(file, JSON.stringify(obj), "utf8");
  } catch (e) {
    console.warn("[keeperCache] durable save failed", e);
  }
}

export function cacheKeeperTick(rec: KeeperCachedTick) {
  loadDurable();
  const m = store();
  const list = m.get(rec.agentId) || [];
  // Strip raw to keep durable file small
  const slim: KeeperCachedTick = {
    ...rec,
    snapshot: {
      ...rec.snapshot,
      raw: undefined,
    },
  };
  const next = [
    slim,
    ...list.filter((t) => t.runCount !== rec.runCount),
  ].slice(0, 20);
  m.set(rec.agentId, next);
  saveDurable();
}

export function listCachedKeeperTicks(agentId: string): KeeperCachedTick[] {
  loadDurable();
  return store().get(agentId) || [];
}
