/**
 * Server-side agent keeper: fetch Surf data + runTick for due agents.
 * Fee comes from agent balance; keeper only pays gas.
 *
 * Deployed Radar 0x50a3… has no lastTickBlock/TooEarly — schedule is enforced
 * off-chain (lastRunAt time math + Upstash post-seal cooldown for full interval).
 * Time uses BLOCK_TIME_SEC (~0.25s Ritual) for blocks→seconds only.
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
import { BLOCK_TIME_SEC, computeDue } from "@/lib/agentSchedule";
import type { AgentView } from "@/lib/radarRead";
import { cacheKeeperTick } from "@/lib/keeperCache";
import { notifyAgentTick } from "@/lib/telegram";
import { kvDel, kvSet, kvSetNx } from "@/lib/durableKv";

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
    transport: http(RPC_URL, {
      // Keep reads snappy — long hangs block the whole due-scan
      timeout: 12_000,
      retryCount: 1,
    }),
  });
}

/** Bound a promise so Telegram / slow RPC cannot stall the tick path forever */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(fallback);
        }
      }
    );
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Parallel fee + balance + nonce — shaves a round-trip off each tick
      const [block, bal, nonce] = await Promise.all([
        opts.client.getBlock({ blockTag: "latest" }),
        opts.client.getBalance({ address: opts.account.address }),
        opts.client.getTransactionCount({
          address: opts.account.address,
          blockTag: "pending",
        }),
      ]);
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

      const need = gas * maxFeePerGas;
      if (bal < need) {
        throw new Error(
          `Keeper wallet low on RIT for gas (have ${bal.toString()} wei, need ~${need.toString()} wei). ` +
            `Send a little RIT to ${opts.account.address} — agent balance cannot pay gas.`
        );
      }

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
      if (!isRpcFlake(e) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
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

/**
 * Serialize ticks per agent:
 * 1) in-process Map (same isolate)
 * 2) Upstash SET NX (multi-instance)
 *
 * Production Radar 0x50a3… has NO lastTickBlock/TooEarly in bytecode — schedule
 * is off-chain only. Releasing the lock right after a tick lets arm-kick +
 * auto-wake both seal within 1s (agent #68 run1@50:06 + run2@50:07).
 * After a successful seal we HOLD the key for the full wake interval.
 */
const agentTickLocks = new Map<string, Promise<unknown>>();

type TickLockInner =
  | { kind: "skip"; skipped: string }
  | { kind: "fail"; error: string; txHash?: Hex }
  | {
      kind: "ok";
      hash: Hex;
      snapshot: SurfDataSnapshot;
      fresh: AgentView;
      postAgent: AgentView;
      newCount: bigint;
    };

type TickLockOutcome =
  | { kind: "busy"; skipped: string }
  | { kind: "ran"; value: TickLockInner };

function intervalSecFromBlocks(wakeIntervalBlocks: bigint): number {
  return Math.max(1, Math.round(Number(wakeIntervalBlocks) * BLOCK_TIME_SEC));
}

async function withAgentTickLock(
  agentId: string,
  wakeIntervalBlocks: bigint,
  fn: () => Promise<TickLockInner>
): Promise<TickLockOutcome> {
  const prev = agentTickLocks.get(agentId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => gate);
  agentTickLocks.set(agentId, chained);
  await prev.catch(() => undefined);

  const distKey = `rite:agent:ticklock:${agentId}`;
  const intervalSec = intervalSecFromBlocks(wakeIntervalBlocks);
  // Hold long enough for one tick attempt; success extends to full interval
  const attemptTtl = Math.max(90, Math.min(intervalSec + 30, 600));

  try {
    const got = await kvSetNx(distKey, `attempt:${Date.now()}`, attemptTtl);
    if (!got) {
      return { kind: "busy", skipped: "tick_in_flight_or_cooldown" };
    }
    try {
      const value = await fn();
      if (value.kind === "ok") {
        // Keep peers out for the full schedule (off-chain TooEarly substitute)
        const holdSec = Math.max(intervalSec, 55);
        try {
          await kvSet(
            distKey,
            `sealed:${value.newCount.toString()}:${Date.now()}`,
            holdSec
          );
        } catch {
          /* TTL on NX key still covers attemptTtl */
        }
      } else {
        try {
          await kvDel(distKey);
        } catch {
          /* */
        }
      }
      return { kind: "ran", value };
    } catch (e) {
      try {
        await kvDel(distKey);
      } catch {
        /* */
      }
      throw e;
    }
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
 *
 * Pass `cachedHead` when scanning many agents so we only call getBlockNumber once.
 */
export async function isAgentDueFast(
  client: PublicClient,
  agentId: bigint,
  wakeIntervalBlocks: bigint,
  lastRunAt: bigint,
  cachedHead: bigint | null
): Promise<{
  due: boolean;
  mode: "blocks" | "time";
  secondsUntilDue: number;
  detail: string;
}> {
  try {
    const lastB = (await client.readContract({
      address: RADAR_CONTRACT as Address,
      abi: radarAgentAbi,
      functionName: "lastTickBlock",
      args: [agentId],
    })) as bigint;
    const blockNumber =
      cachedHead != null ? cachedHead : await client.getBlockNumber();
    const interval =
      wakeIntervalBlocks === BigInt(0) ? BigInt(1) : wakeIntervalBlocks;
    const nextDue = lastB === BigInt(0) ? blockNumber : lastB + interval;
    const due = lastB === BigInt(0) || blockNumber >= nextDue;
    const blocksUntilDue =
      due || nextDue <= blockNumber ? BigInt(0) : nextDue - blockNumber;
    const secondsUntilDue = Math.max(
      0,
      Math.ceil(Number(blocksUntilDue) * BLOCK_TIME_SEC)
    );
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
  return isAgentDueFast(
    publicClient(),
    agentId,
    wakeIntervalBlocks,
    lastRunAt,
    null
  );
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
    transport: http(RPC_URL, { timeout: 35_000 }),
  });

  // Parallel bootstrap reads
  const [keeperOnChainRaw, runFee, nextId] = await Promise.all([
    client
      .readContract({
        address: RADAR_CONTRACT as Address,
        abi: radarAgentAbi,
        functionName: "isKeeper",
        args: [account.address],
      })
      .catch(() => null) as Promise<boolean | null>,
    client.readContract({
      address: RADAR_CONTRACT,
      abi: radarAgentAbi,
      functionName: "runFee",
    }) as Promise<bigint>,
    client.readContract({
      address: RADAR_CONTRACT,
      abi: radarAgentAbi,
      functionName: "nextAgentId",
    }) as Promise<bigint>,
  ]);
  const keeperOnChain = keeperOnChainRaw;

  const total = nextId > BigInt(1) ? Number(nextId - BigInt(1)) : 0;
  const maxAgents = opts?.maxAgents ?? 40;
  const start = Math.max(1, total - maxAgents + 1);
  const ownerFilter = opts?.onlyOwner?.toLowerCase();

  /**
   * Build id list to scan:
   * - onlyAgentId → that id
   * - onlyOwner → ownerAgentIds (all of user's agents, newest first) — critical so
   *   early-created agents aren't skipped when nextAgentId is high and maxAgents is small
   * - else → trailing window [start..total]
   */
  let idsToScan: number[] = [];
  if (opts?.onlyAgentId && /^\d{1,12}$/.test(opts.onlyAgentId)) {
    idsToScan = [Number(opts.onlyAgentId)];
  } else if (ownerFilter) {
    try {
      const owned = (await client.readContract({
        address: RADAR_CONTRACT as Address,
        abi: radarAgentAbi,
        functionName: "ownerAgentIds",
        args: [ownerFilter as Address],
      })) as bigint[];
      idsToScan = owned
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
      idsToScan.sort((a, b) => b - a); // newest first
      // Cap work per request (auto-wake / serverless time)
      const cap = Math.min(40, Math.max(maxAgents, 20));
      idsToScan = idsToScan.slice(0, cap);
    } catch {
      for (let i = start; i <= total; i++) idsToScan.push(i);
    }
  } else {
    /**
     * Global cron: newest agents are often dead Sovereigns (3-tick life).
     * Walking only [total-max..total] misses older LIVE Persistent agents.
     * Pre-scan newest→oldest (capped), keep Active ids first, then fill.
     */
    const lookback = Math.min(total, Math.max(maxAgents * 4, 80));
    const from = Math.max(1, total - lookback + 1);
    const candidates: number[] = [];
    for (let i = total; i >= from; i--) candidates.push(i);

    // Batch getAgent to prefer LIVE (status===1) without full sequential ticks
    const liveIds: number[] = [];
    const otherIds: number[] = [];
    const BATCH = 12;
    for (let b = 0; b < candidates.length; b += BATCH) {
      if (liveIds.length >= maxAgents) break;
      const chunk = candidates.slice(b, b + BATCH);
      const rows = await Promise.all(
        chunk.map(async (id) => {
          try {
            const agent = (await client.readContract({
              address: RADAR_CONTRACT as Address,
              abi: radarAgentAbi,
              functionName: "getAgent",
              args: [BigInt(id)],
            })) as AgentView;
            return { id, status: Number(agent.status) };
          } catch {
            return { id, status: -1 };
          }
        })
      );
      for (const row of rows) {
        if (row.status === 1) liveIds.push(row.id);
        else if (row.status >= 0) otherIds.push(row.id);
      }
    }
    // LIVE first (newest among them already ordered), then others as filler
    idsToScan = [...liveIds, ...otherIds].slice(
      0,
      Math.min(lookback, Math.max(maxAgents * 2, 40))
    );
    if (idsToScan.length === 0) {
      for (let i = start; i <= total; i++) idsToScan.push(i);
    }
  }

  const results: KeeperTickResult[] = [];
  let ticked = 0;
  let scanned = 0;
  /**
   * Drip successful ticks per request — do NOT dump every due agent in one
   * shot (that is why Telegram goes quiet then floods when cron/fix runs).
   * Keeper / AppShell call often (~25s–1m); 1–2 ticks per call spreads DMs.
   * onlyAgentId: always 1.
   */
  const maxTicked = opts?.onlyAgentId
    ? 1
    : ownerFilter
      ? Math.min(4, Math.max(1, maxAgents))
      : Math.min(5, Math.max(1, maxAgents));

  // Shared head for due checks — one RPC for the whole scan pass
  let headBlock: bigint | null = null;
  try {
    headBlock = await client.getBlockNumber();
  } catch {
    headBlock = null;
  }

  for (const i of idsToScan) {
    if (ticked >= maxTicked) {
      results.push({
        agentId: String(i),
        ok: false,
        skipped: "tick_budget",
      });
      continue;
    }
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

      const dueInfo = await isAgentDueFast(
        client,
        id,
        agent.wakeIntervalBlocks,
        agent.lastRunAt,
        headBlock
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

      // Serialize + post-seal cooldown (Radar 0x50a3 has no on-chain TooEarly)
      const locked = await withAgentTickLock(
        String(i),
        agent.wakeIntervalBlocks,
        async () => {
          // Fresh agent read — catch RPC lag after a peer just sealed
          let live = agent;
          try {
            live = (await client.readContract({
              address: RADAR_CONTRACT as Address,
              abi: radarAgentAbi,
              functionName: "getAgent",
              args: [id],
            })) as AgentView;
          } catch {
            /* use pre */
          }
          if (live.runCount > agent.runCount) {
            return {
              kind: "skip" as const,
              skipped: `not_due_peer_sealed_run${live.runCount.toString()}`,
            };
          }
          if (live.status !== 1) {
            return {
              kind: "skip" as const,
              skipped: live.status === 4 ? "dead" : "not_active",
            };
          }

          const due2 = await isAgentDueFast(
            client,
            id,
            live.wakeIntervalBlocks,
            live.lastRunAt,
            null
          );
          if (!due2.due) {
            return {
              kind: "skip" as const,
              skipped: `not_due_${due2.detail}`,
            };
          }

          // Short Surf timeout — do not hold the poll for 45s
          const snapshot = await fetchSurfData(track.kind, track.target, {
            timeoutMs: 12_000,
          });
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

          // Ritual ~0.2s blocks — poll aggressively; 45s max wait
          const receipt = await client.waitForTransactionReceipt({
            hash,
            timeout: 45_000,
            confirmations: 1,
            pollingInterval: 400,
          });

          const receiptOk =
            receipt.status === "success" ||
            (receipt as { status?: unknown }).status === 1 ||
            (receipt as { status?: unknown }).status === "0x1";

          let postAgent = live;
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

          const runAdvanced = postAgent.runCount > live.runCount;
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
            fresh: live,
            postAgent,
            newCount:
              postAgent.runCount > live.runCount
                ? postAgent.runCount
                : live.runCount + BigInt(1),
          };
        }
      );

      if (locked.kind === "busy") {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: locked.skipped,
        });
        continue;
      }

      const inner = locked.value;
      if (inner.kind === "skip") {
        results.push({
          agentId: String(i),
          ok: false,
          skipped: inner.skipped,
        });
        continue;
      }
      if (inner.kind === "fail") {
        results.push({
          agentId: String(i),
          ok: false,
          error: inner.error,
          txHash: inner.txHash,
        });
        continue;
      }

      const { hash, snapshot, newCount, fresh } = inner;
      console.info(
        `[agentKeeper] sealed agent=${i} run=${newCount.toString()} tx=${hash}`
      );
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

      // Give Telegram more time; if still pending, keep notify running in background
      // so DMs are not dropped when Upstash/Telegram is slow.
      const tgPromise = notifyAgentTick({
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
      const telegram = await withTimeout(tgPromise, 12_000, {
        sent: false,
        reason: "notify_pending",
      });
      if (telegram.reason === "notify_pending") {
        void tgPromise.catch((e) =>
          console.warn("[agentKeeper] delayed telegram", e)
        );
      }

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
          "Ritual RPC flake during auto-wake send — retrying on next poll (~3–8s).";
      } else if (/getAgent/i.test(msg)) {
        // Don't dump raw viem getAgent reverts into the My Agents auto-wake line
        error = "Could not read agent on-chain (RPC). Retrying next poll.";
      } else if (/timed out|timeout|AbortError/i.test(msg)) {
        error = "Data fetch timed out — retrying next poll.";
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
