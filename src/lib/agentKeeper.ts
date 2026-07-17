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
  encodeFunctionData,
  http,
  keccak256,
  stringToBytes,
  type Account,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RADAR_CONTRACT,
  radarAgentAbi,
  ritualChain,
  RPC_URL,
} from "@/lib/ritual";
import {
  decodeAgentTrack,
  fetchSurfData,
  type SurfDataSnapshot,
} from "@/lib/surfData";
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
  runCount?: string;
  agentName?: string;
  kindLabel?: string;
  target?: string;
  died?: boolean;
  telegram?: { sent: boolean; reason?: string };
  /** Full Surf snapshot for UI + Telegram (no huge raw blob) */
  snapshot?: {
    kind: string;
    kindLabel: string;
    target: string;
    fetchedAt: string;
    endpoint: string;
    summary: string;
    rows: SurfDataSnapshot["rows"];
    highlights: SurfDataSnapshot["highlights"];
  };
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

function errBlob(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6; i++) {
    if (!cur) break;
    if (cur instanceof Error) parts.push(cur.message);
    if (cur && typeof cur === "object") {
      const o = cur as {
        shortMessage?: string;
        details?: string;
        message?: string;
        cause?: unknown;
      };
      if (o.shortMessage) parts.push(o.shortMessage);
      if (o.details) parts.push(String(o.details));
      if (o.message) parts.push(o.message);
      cur = o.cause;
    } else break;
  }
  return parts.join(" ");
}

function isRpcFlake(e: unknown): boolean {
  const blob = errBlob(e).toLowerCase();
  if (
    /tooearly|notauthorized|notowner|agentisdead|badstatus|emptywatchlist|zerodigest|insufficientbalance|insufficient funds|execution reverted/i.test(
      blob
    ) &&
    !/transaction creation failed|opcodenotfound/i.test(blob)
  ) {
    return false;
  }
  return /transaction creation failed|opcodenotfound|timeout|fetch failed|http request failed|econnreset|socket|502|503|504|network|internal error|rate limit/i.test(
    blob
  );
}

/**
 * Server runTick — never eth_estimateGas / simulateContract.
 *
 * Ritual facts (verified against public RPC):
 * - Legacy type-0 txs are rejected: "transaction type not supported"
 * - EIP-1559 (type 2) is accepted
 * - baseFee is tiny (~wei); forcing 1+ gwei drains the keeper wallet
 * - Manual Wake uses the user wallet for gas; auto-wake uses KEEPER_PRIVATE_KEY
 */
async function sendKeeperRunTick(opts: {
  wallet: WalletClient;
  client: PublicClient;
  account: Account;
  agentId: bigint;
  digest: Hex;
}): Promise<Hex> {
  const data = encodeFunctionData({
    abi: radarAgentAbi,
    functionName: "runTick",
    args: [opts.agentId, opts.digest],
  });

  // Observed ~108k–150k; leave headroom (out-of-gas shows as receipt.reverted)
  const gas = BigInt(350_000);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const block = await opts.client.getBlock({ blockTag: "latest" });
      const base = block.baseFeePerGas ?? BigInt(1);
      // tip + 2× base — stays cheap on Ritual (do NOT force 1 gwei)
      const maxPriorityFeePerGas = BigInt(1_000_000); // 0.001 gwei
      let maxFeePerGas = base * BigInt(2) + maxPriorityFeePerGas;
      // Safety floor so zero-fee txs aren't dropped if RPC returns 0 baseFee
      if (maxFeePerGas < BigInt(10_000_000)) {
        maxFeePerGas = BigInt(10_000_000); // 0.01 gwei
      }
      // Cap so a flaky high gasPrice RPC cannot drain the keeper
      const cap = BigInt(50_000_000_000); // 50 gwei
      if (maxFeePerGas > cap) maxFeePerGas = cap;

      const bal = await opts.client.getBalance({
        address: opts.account.address,
      });
      const need = gas * maxFeePerGas;
      if (bal < need) {
        throw new Error(
          `Keeper wallet low on RIT for gas (have ${bal.toString()} wei, need ~${need.toString()} wei). ` +
            `Send a little RIT to ${opts.account.address} — agent balance cannot pay gas.`
        );
      }

      const nonce = await opts.client.getTransactionCount({
        address: opts.account.address,
        blockTag: "pending",
      });

      // Fully specified EIP-1559 — Ritual rejects legacy type-0
      const hash = await opts.wallet.sendTransaction({
        account: opts.account,
        to: RADAR_CONTRACT as Address,
        data,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        chain: ritualChain,
        type: "eip1559",
      });
      return hash;
    } catch (e) {
      lastErr = e;
      const blob = errBlob(e);
      // Don't spin on insufficient funds / auth / too-early
      if (
        /insufficient funds|notauthorized|tooearly|notowner|agentisdead|badstatus|emptywatchlist|zerodigest|low on rit for gas/i.test(
          blob
        )
      ) {
        break;
      }
      if (!isRpcFlake(e) || attempt === 4) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(errBlob(lastErr).slice(0, 240) || "runTick send failed");
}

/**
 * Turn a failed runTick receipt into a short actionable error.
 * Live Radar 0x50a3 may not expose lastTickBlock() even when ticks succeed.
 */
async function explainFailedRunTick(
  client: PublicClient,
  opts: {
    hash: Hex;
    from: Address;
    agentId: bigint;
    digest: Hex;
    gasUsed?: bigint;
    gasLimit?: bigint;
  }
): Promise<string> {
  const short = opts.hash.slice(0, 12);
  // Out of gas: used almost all limit
  if (
    opts.gasUsed != null &&
    opts.gasLimit != null &&
    opts.gasUsed >= (opts.gasLimit * BigInt(95)) / BigInt(100)
  ) {
    return `runTick out of gas (used ${opts.gasUsed.toString()}/${opts.gasLimit.toString()}) tx ${short}…`;
  }

  // eth_call replay often returns the custom error
  try {
    await client.simulateContract({
      address: RADAR_CONTRACT as Address,
      abi: radarAgentAbi,
      functionName: "runTick",
      args: [opts.agentId, opts.digest],
      account: opts.from,
    });
  } catch (e) {
    const blob = errBlob(e);
    if (/TooEarly|too early/i.test(blob)) {
      return `TooEarly: schedule not elapsed yet (tx ${short}…). Next poll will retry.`;
    }
    if (/NotAuthorized|0x82b42900/i.test(blob)) {
      return `NotAuthorized: keeper not allowlisted for runTick (tx ${short}…)`;
    }
    if (/AgentIsDead|dead/i.test(blob)) {
      return `AgentIsDead (tx ${short}…)`;
    }
    if (/BadStatus|not active|BadStatus/i.test(blob)) {
      return `BadStatus: agent not LIVE (tx ${short}…)`;
    }
    if (/InsufficientBalance|insufficient/i.test(blob)) {
      return `InsufficientBalance: fund the agent (tx ${short}…)`;
    }
    if (/EmptyWatchlist|watchlist/i.test(blob)) {
      return `EmptyWatchlist: no data stream locked (tx ${short}…)`;
    }
    if (/ZeroDigest/i.test(blob)) {
      return `ZeroDigest (tx ${short}…)`;
    }
    const brief = blob.replace(/\s+/g, " ").slice(0, 140);
    if (brief) {
      return `runTick reverted: ${brief} (tx ${short}…)`;
    }
  }

  return `runTick receipt not successful (tx ${short}…). Often a race with another wake — check explorer; if run count increased, ignore.`;
}

/** Serialize ticks per agent on this instance (avoids double-fire races). */
const agentTickLocks = new Map<string, Promise<unknown>>();

async function withAgentTickLock<T>(
  agentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = agentTickLocks.get(agentId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => gate);
  agentTickLocks.set(agentId, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
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
 * Prefer on-chain lastTickBlock + interval (matches runTick TooEarly).
 * Some Radar deploys revert on lastTickBlock() — fall back to time-based
 * lastRunAt + approx block time (same as UI countdown).
 */
export async function isAgentDue(
  agentId: bigint,
  wakeIntervalBlocks: bigint,
  lastRunAt: bigint
): Promise<{
  due: boolean;
  mode: "blocks" | "time";
  secondsUntilDue: number;
  detail: string;
}> {
  const client = publicClient();
  try {
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
    const blockSec = Math.max(
      1,
      Number(process.env.NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC || "2") || 2
    );
    const secondsUntilDue = Number(blocksUntilDue) * blockSec;
    return {
      due,
      mode: "blocks",
      secondsUntilDue,
      detail: due
        ? "due"
        : `${blocksUntilDue}blocks_~${secondsUntilDue}s`,
    };
  } catch {
    // Deploy without public lastTickBlock — use lastRunAt time math
    const nowSec = Math.floor(Date.now() / 1000);
    const t = computeDue(lastRunAt, wakeIntervalBlocks, nowSec);
    return {
      due: t.due,
      mode: "time",
      secondsUntilDue: t.secondsUntilDue,
      detail: t.due ? "due" : `${t.secondsUntilDue}s`,
    };
  }
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

      const dueInfo = await isAgentDue(
        id,
        agent.wakeIntervalBlocks,
        agent.lastRunAt
      );
      if (!dueInfo.due) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: `not_due_${dueInfo.detail}`,
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

      // Serialize per-agent ticks on this instance (auto-wake + cron race)
      const locked = await withAgentTickLock(String(i), async () => {
        // Re-read after wait — prior tick may have just landed
        let fresh = agent;
        try {
          fresh = (await client.readContract({
            address: RADAR_CONTRACT as Address,
            abi: radarAgentAbi,
            functionName: "getAgent",
            args: [id],
          })) as AgentView;
        } catch {
          /* use stale */
        }
        if (fresh.status !== 1) {
          return {
            kind: "skip" as const,
            skipped: fresh.status === 4 ? "dead" : "not_active",
          };
        }
        if (fresh.balance < runFee) {
          return { kind: "skip" as const, skipped: "insufficient_balance" };
        }
        const due2 = await isAgentDue(
          id,
          fresh.wakeIntervalBlocks,
          fresh.lastRunAt
        );
        if (!due2.due) {
          return {
            kind: "skip" as const,
            skipped: `not_due_${due2.detail}`,
          };
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

        const hash = await sendKeeperRunTick({
          wallet,
          client,
          account,
          agentId: id,
          digest,
        });

        const receipt = await client.waitForTransactionReceipt({
          hash,
          timeout: 90_000,
          confirmations: 1,
        });

        const receiptOk =
          receipt.status === "success" ||
          (receipt as { status?: unknown }).status === 1 ||
          (receipt as { status?: unknown }).status === "0x1";

        let postAgent = fresh;
        try {
          postAgent = (await client.readContract({
            address: RADAR_CONTRACT as Address,
            abi: radarAgentAbi,
            functionName: "getAgent",
            args: [id],
          })) as AgentView;
        } catch {
          /* keep pre */
        }

        const runAdvanced = postAgent.runCount > fresh.runCount;
        if (!receiptOk && !runAdvanced) {
          const reason = await explainFailedRunTick(client, {
            hash,
            from: account.address,
            agentId: id,
            digest,
            gasUsed: receipt.gasUsed,
            gasLimit: BigInt(350_000),
          });
          return {
            kind: "fail" as const,
            error: reason,
            txHash: hash,
          };
        }
        if (!receiptOk && runAdvanced) {
          console.warn(
            `[agentKeeper] agent ${i} receipt status=${String(receipt.status)} but runCount advanced — treating as success`,
            hash
          );
        }

        return {
          kind: "ok" as const,
          hash,
          snapshot,
          fresh,
          postAgent,
          newCount:
            postAgent.runCount > fresh.runCount
              ? postAgent.runCount
              : fresh.runCount + BigInt(1),
        };
      });

      if (locked.kind === "skip") {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: locked.skipped,
        });
        continue;
      }
      if (locked.kind === "fail") {
        results.push({
          agentId: String(i),
          ok: false,
          error: locked.error,
          txHash: locked.txHash,
        });
        continue;
      }

      const { hash, snapshot, newCount, fresh } = locked;
      const died =
        fresh.maxRuns > BigInt(0) && newCount >= fresh.maxRuns;
      const digest = keccak256(
        stringToBytes(
          JSON.stringify({
            kind: snapshot.kind,
            target: snapshot.target,
            summary: snapshot.summary,
            highlights: snapshot.highlights,
            fetchedAt: snapshot.fetchedAt,
            agentId: String(i),
            keeper: true,
          })
        )
      );
      cacheKeeperTick({
        agentId: String(i),
        runCount: newCount.toString(),
        at: Date.now(),
        txHash: hash,
        digest,
        snapshot,
      });

      // Await notify so durable prefs + send finish in this request
      const telegram = await notifyAgentTick({
        owner: fresh.owner,
        agentId: String(i),
        agentName: fresh.name,
        runCount: newCount.toString(),
        summary: snapshot.summary,
        kindLabel: snapshot.kindLabel,
        target: snapshot.target,
        txHash: hash,
        died,
        rows: snapshot.rows,
        highlights: snapshot.highlights,
      });

      ticked += 1;
      results.push({
        agentId: String(i),
        ok: true,
        txHash: hash,
        runCount: newCount.toString(),
        agentName: fresh.name,
        kindLabel: snapshot.kindLabel,
        target: snapshot.target,
        died,
        summary: snapshot.summary.slice(0, 200),
        telegram,
        // Client persists this to localStorage + shows table + can re-push Telegram
        snapshot: {
          kind: snapshot.kind,
          kindLabel: snapshot.kindLabel,
          target: snapshot.target,
          fetchedAt: snapshot.fetchedAt,
          endpoint: snapshot.endpoint || "keeper",
          summary: snapshot.summary,
          rows: snapshot.rows,
          highlights: snapshot.highlights,
        },
      });
    } catch (e: unknown) {
      const msg = errBlob(e).slice(0, 280);
      // Missing id in scan range — not a user-facing failure
      if (/UnknownAgent|0x0df2949d/i.test(msg)) {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: "unknown_agent",
        });
        continue;
      }
      let error = msg;
      if (/NotAuthorized|0x82b42900/i.test(msg)) {
        error =
          "NotAuthorized: keeper wallet is not setKeeper(true) on this Radar — admin must allowlist KEEPER_PRIVATE_KEY address";
      } else if (/TooEarly/i.test(msg)) {
        error = "TooEarly: on-chain block interval not elapsed";
      } else if (/low on rit for gas|insufficient funds for gas/i.test(msg)) {
        error =
          "Keeper wallet needs more RIT for gas (agent balance cannot pay gas). Fund the keeper address shown in /api/agent/cron?health=1.";
      } else if (/transaction type not supported/i.test(msg)) {
        error =
          "Ritual rejected tx type — auto-wake must use EIP-1559 (deploy update if you still see this).";
      } else if (isRpcFlake(e)) {
        error =
          "Ritual RPC flake during auto-wake send — retrying on next poll (~20s).";
      } else if (/getAgent/i.test(msg)) {
        // Don't dump raw viem getAgent reverts into the My Agents auto-wake line
        error = "Could not read agent on-chain (RPC). Retrying next poll.";
      }
      console.error(`[agentKeeper] agent ${i} tick failed:`, msg.slice(0, 200));
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
