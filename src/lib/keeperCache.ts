/**
 * Ephemeral in-process cache of keeper tick snapshots.
 * Survives only as long as the serverless instance is warm —
 * client also merges on-chain seals for durability.
 */

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
};

function store(): Map<string, KeeperCachedTick[]> {
  if (!g.__riteKeeperTicks) g.__riteKeeperTicks = new Map();
  return g.__riteKeeperTicks;
}

export function cacheKeeperTick(rec: KeeperCachedTick) {
  const m = store();
  const list = m.get(rec.agentId) || [];
  const next = [rec, ...list.filter((t) => t.runCount !== rec.runCount)].slice(
    0,
    20
  );
  m.set(rec.agentId, next);
}

export function listCachedKeeperTicks(agentId: string): KeeperCachedTick[] {
  return store().get(agentId) || [];
}
