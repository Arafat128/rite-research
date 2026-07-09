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
