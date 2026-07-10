/**
 * Server-side agent keeper: fetch Surf data + runTick for due agents.
 * Fee comes from agent balance; keeper only pays gas.
 *
 * On-chain schedule is **block-based** (lastTickBlock + wakeIntervalBlocks).
 * Time-based UI (~2s/block) is approximate only.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RADAR_CONTRACT,
  radarAgentAbi,
  ritualChain,
  RPC_URL,
} from "@/lib/ritual";
import { decodeAgentTrack, fetchSurfData } from "@/lib/surfData";
import type { AgentView } from "@/lib/radarRead";
import { cacheKeeperTick } from "@/lib/keeperCache";
import { notifyAgentTick } from "@/lib/telegram";

export type KeeperTickResult = {
  agentId: string;
  ok: boolean;
  skipped?: string;
  txHash?: string;
  summary?: string;
  error?: string;
};

function publicClient() {
  return createPublicClient({
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 25_000, retryCount: 2 }),
  });
}

function normalizePk(raw: string): Hex {
  const t = raw.trim();
  if (t.startsWith("0x")) return t as Hex;
  return `0x${t}` as Hex;
}

export function keeperConfigured(): boolean {
  return Boolean(process.env.KEEPER_PRIVATE_KEY && RADAR_CONTRACT);
}

export function keeperAddress(): Address | null {
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return privateKeyToAccount(normalizePk(pk)).address;
  } catch {
    return null;
  }
}

/** Whether this keeper wallet is allowlisted on Radar (required for auto runTick). */
export async function isKeeperOnChain(addr?: Address | null): Promise<
  boolean | null
> {
  if (!RADAR_CONTRACT) return null;
  const who = addr || keeperAddress();
  if (!who) return null;
  try {
    const client = publicClient();
    return (await client.readContract({
      address: RADAR_CONTRACT as Address,
      abi: radarAgentAbi,
      functionName: "isKeeper",
      args: [who],
    })) as boolean;
  } catch {
    return null;
  }
}

/**
 * On-chain due: lastTickBlock==0 OR block.number >= lastTickBlock + interval.
 * Matches RadarAgent.runTick TooEarly check exactly.
 */
export async function isAgentDueOnChain(
  agentId: bigint,
  wakeIntervalBlocks: bigint
): Promise<{
  due: boolean;
  lastTickBlock: bigint;
  blockNumber: bigint;
  nextDueBlock: bigint;
  blocksUntilDue: bigint;
}> {
  const client = publicClient();
  const [lastB, blockNumber] = await Promise.all([
    client.readContract({
      address: RADAR_CONTRACT as Address,
      abi: radarAgentAbi,
      functionName: "lastTickBlock",
      args: [agentId],
    }) as Promise<bigint>,
    client.getBlockNumber(),
  ]);
  const interval =
    wakeIntervalBlocks === BigInt(0) ? BigInt(1) : wakeIntervalBlocks;
  const nextDue = lastB === BigInt(0) ? blockNumber : lastB + interval;
  const due = lastB === BigInt(0) || blockNumber >= nextDue;
  const blocksUntilDue =
    due || nextDue <= blockNumber ? BigInt(0) : nextDue - blockNumber;
  return {
    due,
    lastTickBlock: lastB,
    blockNumber,
    nextDueBlock: nextDue,
    blocksUntilDue,
  };
}

export async function runDueAgentTicks(opts?: {
  maxAgents?: number;
  onlyAgentId?: string;
  /** If set, only tick agents owned by this wallet (lower-case address) */
  onlyOwner?: string;
}): Promise<{
  scanned: number;
  ticked: number;
  results: KeeperTickResult[];
  keeper?: string;
  keeperOnChain?: boolean | null;
}> {
  if (!RADAR_CONTRACT) {
    throw new Error("NEXT_PUBLIC_RADAR_CONTRACT not set");
  }
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk) {
    throw new Error("KEEPER_PRIVATE_KEY not configured");
  }

  const account = privateKeyToAccount(normalizePk(pk));
  const client = publicClient();
  const wallet = createWalletClient({
    account,
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 60_000 }),
  });

  let keeperOnChain: boolean | null = null;
  try {
    keeperOnChain = (await client.readContract({
      address: RADAR_CONTRACT as Address,
      abi: radarAgentAbi,
      functionName: "isKeeper",
      args: [account.address],
    })) as boolean;
  } catch {
    keeperOnChain = null;
  }

  const runFee = (await client.readContract({
    address: RADAR_CONTRACT,
    abi: radarAgentAbi,
    functionName: "runFee",
  })) as bigint;

  const nextId = (await client.readContract({
    address: RADAR_CONTRACT,
    abi: radarAgentAbi,
    functionName: "nextAgentId",
  })) as bigint;

  const total = nextId > BigInt(1) ? Number(nextId - BigInt(1)) : 0;
  const maxAgents = opts?.maxAgents ?? 40;
  const start = Math.max(1, total - maxAgents + 1);
  const ownerFilter = opts?.onlyOwner?.toLowerCase();

  const results: KeeperTickResult[] = [];
  let ticked = 0;
  let scanned = 0;

  for (let i = start; i <= total; i++) {
    if (opts?.onlyAgentId && opts.onlyAgentId !== String(i)) continue;
    scanned += 1;
    const id = BigInt(i);

    try {
      const agent = (await client.readContract({
        address: RADAR_CONTRACT,
        abi: radarAgentAbi,
        functionName: "getAgent",
        args: [id],
      })) as AgentView;

      if (ownerFilter && agent.owner.toLowerCase() !== ownerFilter) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: "not_owner",
        });
        continue;
      }

      if (agent.status !== 1) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: agent.status === 4 ? "dead" : "not_active",
        });
        continue;
      }
      if (agent.balance < runFee) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: "insufficient_balance",
        });
        continue;
      }

      // Primary: on-chain block schedule (what runTick enforces)
      const chainDue = await isAgentDueOnChain(id, agent.wakeIntervalBlocks);
      if (!chainDue.due) {
        // Estimate seconds for UX using ~block time
        const approxSec =
          Number(chainDue.blocksUntilDue) *
          Math.max(
            1,
            Number(process.env.NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC || "2") || 2
          );
        results.push({
          agentId: String(i),
          ok: false,
          skipped: `not_due_${chainDue.blocksUntilDue}blocks_~${approxSec}s`,
        });
        continue;
      }

      const wl = (await client.readContract({
        address: RADAR_CONTRACT,
        abi: radarAgentAbi,
        functionName: "getWatchlist",
        args: [id],
      })) as string[];
      const track = decodeAgentTrack(wl);
      if (!track) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: "no_data_stream",
        });
        continue;
      }

      const snapshot = await fetchSurfData(track.kind, track.target);
      const digestPayload = JSON.stringify({
        kind: snapshot.kind,
        target: snapshot.target,
        summary: snapshot.summary,
        highlights: snapshot.highlights,
        fetchedAt: snapshot.fetchedAt,
        agentId: String(i),
        keeper: true,
      });
      const digest = keccak256(stringToBytes(digestPayload));

      const hash = await wallet.writeContract({
        address: RADAR_CONTRACT as Address,
        abi: radarAgentAbi,
        functionName: "runTick",
        args: [id, digest],
        chain: ritualChain,
        account,
      });

      const receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
        confirmations: 1,
      });
      if (receipt.status !== "success") {
        results.push({
          agentId: String(i),
          ok: false,
          error: "runTick receipt not successful",
        });
        continue;
      }

      const newCount = agent.runCount + BigInt(1);
      cacheKeeperTick({
        agentId: String(i),
        runCount: newCount.toString(),
        at: Date.now(),
        txHash: hash,
        digest,
        snapshot,
      });

      void notifyAgentTick({
        owner: agent.owner,
        agentId: String(i),
        agentName: agent.name,
        runCount: newCount.toString(),
        summary: snapshot.summary,
        kindLabel: snapshot.kindLabel,
        target: snapshot.target,
        txHash: hash,
        died: agent.maxRuns > BigInt(0) && newCount >= agent.maxRuns,
        rows: snapshot.rows,
        highlights: snapshot.highlights,
      });

      ticked += 1;
      results.push({
        agentId: String(i),
        ok: true,
        txHash: hash,
        summary: snapshot.summary.slice(0, 120),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      // Map common reverts to clear skips
      let error = msg;
      if (/NotAuthorized|0x82b42900/i.test(msg)) {
        error =
          "NotAuthorized: keeper wallet is not setKeeper(true) on this Radar — admin must allowlist KEEPER_PRIVATE_KEY address";
      } else if (/TooEarly/i.test(msg)) {
        error = "TooEarly: on-chain block interval not elapsed";
      }
      results.push({
        agentId: String(i),
        ok: false,
        error,
      });
    }
  }

  return {
    scanned,
    ticked,
    results,
    keeper: account.address,
    keeperOnChain,
  };
}
