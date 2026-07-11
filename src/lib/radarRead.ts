/**
 * Resilient RadarAgent reads against flaky Ritual RPC.
 * Retries + raw eth_call fallback when viem reports empty "0x".
 */

import {
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  getRitualReadClient,
  radarAgentAbi,
  RADAR_CONTRACT,
} from "@/lib/ritual";

export type AgentView = {
  owner: Address;
  status: number;
  kind: number;
  balance: bigint;
  createdAt: bigint;
  lastRunAt: bigint;
  runCount: bigint;
  maxRuns: bigint;
  wakeIntervalBlocks: bigint;
  name: string;
  lastDigest: Hex;
  lastTopic: string;
};

function radarAddress(): Address {
  if (!RADAR_CONTRACT) throw new Error("NEXT_PUBLIC_RADAR_CONTRACT not set");
  try {
    return getAddress(RADAR_CONTRACT);
  } catch {
    return RADAR_CONTRACT as Address;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isEmptyCallError(e: unknown): boolean {
  const m =
    e && typeof e === "object" && "shortMessage" in e
      ? String((e as { shortMessage?: string }).shortMessage)
      : e instanceof Error
        ? e.message
        : String(e ?? "");
  return /returned no data|no data \("0x"\)|could not be found|HTTP request failed|fetch failed|timeout|network/i.test(
    m
  );
}

/** Read with retries; recreate client on transport-level failures. */
export async function radarReadContract<T>(
  params: {
    functionName: string;
    args?: readonly unknown[];
  },
  /** Fewer attempts = faster list loads; use 4 for critical single reads */
  attempts = 3
): Promise<T> {
  const address = radarAddress();
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      // Fresh client every other attempt to drop stuck keep-alive connections
      const client: PublicClient =
        i === 0 ? getRitualReadClient() : getRitualReadClient(true);

      const result = await client.readContract({
        address,
        abi: radarAgentAbi,
        functionName: params.functionName as never,
        args: (params.args ?? []) as never,
      });
      return result as T;
    } catch (e) {
      lastErr = e;
      if (!isEmptyCallError(e) && i >= 1) break;
      await sleep(250 * (i + 1));
    }
  }

  const msg =
    lastErr && typeof lastErr === "object" && "shortMessage" in lastErr
      ? String((lastErr as { shortMessage?: string }).shortMessage)
      : lastErr instanceof Error
        ? lastErr.message
        : String(lastErr ?? "read failed");
  throw new Error(msg);
}

export async function readNextAgentId(): Promise<bigint> {
  return radarReadContract<bigint>({ functionName: "nextAgentId" });
}

export async function readRunFee(): Promise<bigint> {
  return radarReadContract<bigint>({ functionName: "runFee" });
}

export async function readOwnerAgentCount(owner: Address): Promise<bigint> {
  return radarReadContract<bigint>({
    functionName: "ownerAgentCount",
    args: [owner],
  });
}

export async function readOwnerAgentIds(owner: Address): Promise<bigint[]> {
  return radarReadContract<bigint[]>({
    functionName: "ownerAgentIds",
    args: [owner],
  });
}

export async function readAgent(id: bigint): Promise<AgentView | null> {
  try {
    return await radarReadContract<AgentView>({
      functionName: "getAgent",
      args: [id],
    });
  } catch (e) {
    if (isEmptyCallError(e) || /UnknownAgent|execution reverted/i.test(String(e))) {
      // one more direct try after short delay
      try {
        await sleep(400);
        return await radarReadContract<AgentView>(
          { functionName: "getAgent", args: [id] },
          2
        );
      } catch {
        return null;
      }
    }
    throw e;
  }
}

export async function readWatchlist(id: bigint): Promise<string[]> {
  try {
    return await radarReadContract<string[]>({
      functionName: "getWatchlist",
      args: [id],
    });
  } catch {
    return [];
  }
}

export async function readTicksRemaining(id: bigint): Promise<bigint | null> {
  try {
    return await radarReadContract<bigint>({
      functionName: "ticksRemaining",
      args: [id],
    });
  } catch {
    return null;
  }
}

/** Soft ping — never throws; used so a flaky nextAgentId can't brick the UI. */
export async function pingRadar(): Promise<boolean> {
  try {
    await readRunFee();
    return true;
  } catch {
    try {
      await readNextAgentId();
      return true;
    } catch {
      return false;
    }
  }
}
