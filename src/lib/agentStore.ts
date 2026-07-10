/**
 * Client-side registry for agents created in this app,
 * plus tick result history (Surf Data API snapshots).
 */

import type { DataKindId, SurfDataSnapshot } from "@/lib/surfData";
import type { AgentKindId } from "@/lib/ritual";

const REG_KEY = "rite_agents_v2";
const TICK_KEY = "rite_agent_ticks_v1";

export type AppAgentRecord = {
  agentId: string;
  owner: string;
  name: string;
  /** On-chain agent class: 0 Persistent | 1 Sovereign */
  agentKind: AgentKindId;
  /** Surf data stream kind */
  dataKind: DataKindId;
  target: string;
  createdAt: number;
  createTx?: string;
};

export type TickRecord = {
  agentId: string;
  runCount: string;
  at: number;
  txHash?: string;
  digest?: string;
  /** local = this browser woke; chain = from AgentTick / agent state; keeper = server */
  source?: "local" | "chain" | "keeper";
  snapshot: SurfDataSnapshot;
};

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota */
  }
}

export function listAppAgents(owner?: string): AppAgentRecord[] {
  const all = readJson<AppAgentRecord[]>(REG_KEY, []);
  // migrate v1 records if present
  const legacy = readJson<
    Array<{
      agentId: string;
      owner: string;
      name: string;
      kind: DataKindId;
      target: string;
      createdAt: number;
      createTx?: string;
    }>
  >("rite_persistent_agents_v1", []);
  const merged = [...all];
  for (const L of legacy) {
    if (!merged.some((m) => m.agentId === L.agentId)) {
      merged.push({
        agentId: L.agentId,
        owner: L.owner,
        name: L.name,
        agentKind: 0,
        dataKind: L.kind,
        target: L.target,
        createdAt: L.createdAt,
        createTx: L.createTx,
      });
    }
  }
  if (!owner) return merged;
  return merged.filter((a) => a.owner.toLowerCase() === owner.toLowerCase());
}

export function registerAppAgent(rec: AppAgentRecord) {
  const all = readJson<AppAgentRecord[]>(REG_KEY, []);
  const next = all.filter((a) => a.agentId !== rec.agentId);
  next.push(rec);
  writeJson(REG_KEY, next);
}

export function getAppAgent(agentId: string): AppAgentRecord | undefined {
  return listAppAgents().find((a) => a.agentId === agentId);
}

export function listTicks(agentId: string): TickRecord[] {
  const all = readJson<TickRecord[]>(TICK_KEY, []);
  return all
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => b.at - a.at);
}

export function saveTick(rec: TickRecord) {
  const all = readJson<TickRecord[]>(TICK_KEY, []);
  all.unshift(rec);
  writeJson(TICK_KEY, all.slice(0, 40));
}

/**
 * Soft-closed agents (legacy Radar without killAgent).
 * MUST be scoped by Radar address — agent id "2" on 0x5ed8… is NOT agent "2" on 0x50a3….
 * Old global key `rite_closed_agents_v1` caused new deploys to appear instantly DEAD.
 */
const CLOSED_KEY_LEGACY = "rite_closed_agents_v1";
const CLOSED_KEY_PREFIX = "rite_closed_agents_v2:";

function closedStorageKey(radar?: string | null): string {
  const r = (radar || "").toLowerCase().trim();
  if (r && /^0x[a-f0-9]{40}$/.test(r)) {
    return `${CLOSED_KEY_PREFIX}${r}`;
  }
  // Fallback only when radar unknown — prefer empty over cross-contract pollution
  return `${CLOSED_KEY_PREFIX}unknown`;
}

export function isAgentClosed(
  agentId: string,
  radar?: string | null
): boolean {
  const scoped = readJson<string[]>(closedStorageKey(radar), []);
  if (scoped.includes(agentId)) return true;
  // Do NOT fall back to legacy global list when radar is known — that was the bug
  if (!radar) {
    const legacy = readJson<string[]>(CLOSED_KEY_LEGACY, []);
    return legacy.includes(agentId);
  }
  return false;
}

export function markAgentClosed(
  agentId: string,
  radar?: string | null
) {
  const key = closedStorageKey(radar);
  const all = readJson<string[]>(key, []);
  if (!all.includes(agentId)) {
    all.push(agentId);
    writeJson(key, all);
  }
}

export function unmarkAgentClosed(
  agentId: string,
  radar?: string | null
) {
  const key = closedStorageKey(radar);
  writeJson(
    key,
    readJson<string[]>(key, []).filter((id) => id !== agentId)
  );
  // Also scrub legacy global key so old pollution cannot return
  const legacy = readJson<string[]>(CLOSED_KEY_LEGACY, []);
  if (legacy.includes(agentId)) {
    writeJson(
      CLOSED_KEY_LEGACY,
      legacy.filter((id) => id !== agentId)
    );
  }
}

/** Clear one-shot migration: drop global closed list (unsafe across Radars). */
export function clearLegacyGlobalClosedAgents() {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(CLOSED_KEY_LEGACY);
    }
  } catch {
    /* ignore */
  }
}
