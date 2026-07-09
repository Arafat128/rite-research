/**
 * On-chain AgentTick history + merge with localStorage ticks.
 * Ritual RPC often rejects large eth_getLogs ranges — scan in small windows.
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { RADAR_CONTRACT, ritualChain, RPC_URL, radarAgentAbi } from "@/lib/ritual";
import {
  DATA_KINDS,
  decodeAgentTrack,
  type DataKindId,
  type SurfDataSnapshot,
} from "@/lib/surfData";
import type { TickRecord } from "@/lib/agentStore";

export type OnChainTick = {
  agentId: string;
  runCount: string;
  topic: string;
  digest: Hex;
  feePaid: string;
  caller: Address;
  txHash: Hex;
  blockNumber: string;
  at: number; // ms
};

const ZERO_DIGEST =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

type TickLog = {
  args: {
    agentId?: bigint;
    caller?: Address;
    topic?: string;
    digest?: Hex;
    feePaid?: bigint;
    runCount?: bigint;
  };
  transactionHash?: Hex;
  blockNumber?: bigint;
};

function client() {
  return createPublicClient({
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 25_000, retryCount: 1 }),
  });
}

/** Build a display snapshot from on-chain topic when full Surf rows are not stored. */
export function snapshotFromTopic(
  topic: string,
  atMs: number,
  opts?: { summary?: string; source?: string }
): SurfDataSnapshot {
  const track = decodeAgentTrack(topic ? [topic] : []);
  const kind: DataKindId = track?.kind || "market_price";
  const def = DATA_KINDS.find((k) => k.id === kind);
  const target = track?.target || "_";
  return {
    kind,
    kindLabel: def?.label || kind,
    target,
    fetchedAt: new Date(atMs || Date.now()).toISOString(),
    endpoint: opts?.source || "on-chain",
    summary:
      opts?.summary ||
      `Sealed on-chain · ${topic || `${kind}|${target}`}`,
    rows: [],
    highlights: [
      { label: "Source", value: "On-chain seal" },
      { label: "Stream", value: topic || `${kind}|${target}` },
    ],
    raw: undefined,
  };
}

/**
 * Scan recent blocks for AgentTick logs (small windows — Ritual RPC limit).
 */
export async function fetchOnChainTicks(
  agentId: bigint,
  limit = 20
): Promise<OnChainTick[]> {
  if (!RADAR_CONTRACT) return [];

  const c = client();
  const latest = await c.getBlockNumber();
  // ~2s blocks → 5_000 blocks ≈ 3h; scan a few windows (Ritual RPC rejects huge ranges)
  const windowSize = BigInt(5_000);
  const maxWindows = 6;
  const all: TickLog[] = [];

  for (let w = 0; w < maxWindows; w++) {
    const toBlock = latest - windowSize * BigInt(w);
    if (toBlock < BigInt(0)) break;
    const fromBlock =
      toBlock >= windowSize - BigInt(1)
        ? toBlock - windowSize + BigInt(1)
        : BigInt(0);
    try {
      const logs = (await c.getContractEvents({
        address: RADAR_CONTRACT as Address,
        abi: radarAgentAbi,
        eventName: "AgentTick",
        args: { agentId },
        fromBlock,
        toBlock,
      })) as unknown as TickLog[];
      all.push(...logs);
      if (all.length >= limit) break;
    } catch {
      try {
        const small = BigInt(1_000);
        const from2 = toBlock > small ? toBlock - small : BigInt(0);
        const logs = (await c.getContractEvents({
          address: RADAR_CONTRACT as Address,
          abi: radarAgentAbi,
          eventName: "AgentTick",
          args: { agentId },
          fromBlock: from2,
          toBlock,
        })) as unknown as TickLog[];
        all.push(...logs);
      } catch {
        /* skip window */
      }
    }
    if (fromBlock === BigInt(0)) break;
  }

  const out: OnChainTick[] = [];
  for (const log of all) {
    const args = log.args || {};
    if (args.runCount == null) continue;
    const blockNum = log.blockNumber ?? BigInt(0);
    out.push({
      agentId: (args.agentId ?? agentId).toString(),
      runCount: args.runCount.toString(),
      topic: args.topic || "",
      digest: (args.digest || ZERO_DIGEST) as Hex,
      feePaid: (args.feePaid ?? BigInt(0)).toString(),
      caller: (args.caller ||
        "0x0000000000000000000000000000000000000000") as Address,
      txHash: (log.transactionHash || ZERO_DIGEST) as Hex,
      blockNumber: blockNum.toString(),
      at: 0,
    });
  }

  // Dedupe by runCount, newest first
  const byRun = new Map<string, OnChainTick>();
  for (const t of out) {
    const prev = byRun.get(t.runCount);
    if (!prev || Number(t.blockNumber) > Number(prev.blockNumber)) {
      byRun.set(t.runCount, t);
    }
  }
  return Array.from(byRun.values())
    .sort((a, b) => Number(b.runCount) - Number(a.runCount))
    .slice(0, limit);
}

/** Convert chain ticks → TickRecord (synthetic snapshot if needed). */
export function onChainToTickRecords(chain: OnChainTick[]): TickRecord[] {
  return chain.map((t) => ({
    agentId: t.agentId,
    runCount: t.runCount,
    at: t.at || Date.now(),
    txHash: t.txHash,
    digest: t.digest,
    source: "chain" as const,
    snapshot: snapshotFromTopic(t.topic, t.at || Date.now()),
  }));
}

/**
 * Prefer local (full Surf snapshot) over chain-only for same runCount.
 */
export function mergeTickRecords(
  local: TickRecord[],
  chain: TickRecord[]
): TickRecord[] {
  const map = new Map<string, TickRecord>();
  for (const t of chain) map.set(t.runCount, t);
  for (const t of local) {
    const prev = map.get(t.runCount);
    // Local with real data wins
    if (
      !prev ||
      (t.snapshot?.endpoint && t.snapshot.endpoint !== "on-chain") ||
      (t.snapshot?.rows?.length ?? 0) > 0
    ) {
      map.set(t.runCount, {
        ...t,
        source: t.source || "local",
        txHash: t.txHash || prev?.txHash,
        digest: t.digest || prev?.digest,
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => Number(b.runCount) - Number(a.runCount) || b.at - a.at
  );
}

/**
 * When agent has sealed ticks but history APIs returned nothing,
 * surface at least the latest seal from agent state.
 */
export function tickFromAgentState(opts: {
  agentId: string;
  runCount: bigint | number;
  lastRunAt: bigint | number;
  lastTopic: string;
  lastDigest?: string;
}): TickRecord | null {
  const run = typeof opts.runCount === "bigint" ? Number(opts.runCount) : opts.runCount;
  if (!run || run <= 0) return null;
  const last =
    typeof opts.lastRunAt === "bigint"
      ? Number(opts.lastRunAt)
      : opts.lastRunAt;
  const atMs = last > 0 ? last * 1000 : Date.now();
  return {
    agentId: opts.agentId,
    runCount: String(run),
    at: atMs,
    digest: opts.lastDigest,
    source: "chain",
    snapshot: snapshotFromTopic(opts.lastTopic || "", atMs, {
      summary: `Latest seal #${run} · ${opts.lastTopic || "on-chain"}`,
    }),
  };
}
