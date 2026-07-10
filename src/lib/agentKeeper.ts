/**
 * Server-side agent keeper: fetch Surf data + runTick for due agents.
 * Fee comes from agent balance; keeper only pays gas.
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
import { computeDue } from "@/lib/agentSchedule";
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

export async function runDueAgentTicks(opts?: {
  maxAgents?: number;
  onlyAgentId?: string;
}): Promise<{
  scanned: number;
  ticked: number;
  results: KeeperTickResult[];
  keeper?: string;
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

  const results: KeeperTickResult[] = [];
  let ticked = 0;
  let scanned = 0;
  const nowSec = Math.floor(Date.now() / 1000);

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

      const due = computeDue(agent.lastRunAt, agent.wakeIntervalBlocks, nowSec);
      if (!due.due) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: `not_due_${due.secondsUntilDue}s`,
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

      // Off-chain DM (does not affect tick flow) — full rows for clickable headlines
      void notifyAgentTick({
        owner: agent.owner,
        agentId: String(i),
        agentName: agent.name,
        runCount: newCount.toString(),
        summary: snapshot.summary,
        kindLabel: snapshot.kindLabel,
        target: snapshot.target,
        txHash: hash,
        died:
          agent.maxRuns > BigInt(0) && newCount >= agent.maxRuns,
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
      results.push({
        agentId: String(i),
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }

  return {
    scanned,
    ticked,
    results,
    keeper: account.address,
  };
}
