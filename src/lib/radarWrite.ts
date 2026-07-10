/**
 * Reliable RadarAgent writes for MetaMask on Ritual.
 *
 * Ritual RPC reports tiny EIP-1559 base fees (~7 wei) while eth_gasPrice is ~1 gwei.
 * MetaMask often fails fee estimation ("gas unavailable") on value-returning
 * calls (withdraw / killAgent). We always:
 *  1) simulateContract → clear custom-error messages
 *  2) estimateContractGas + buffer
 *  3) attach legacy gasPrice so the wallet does not need feeHistory
 *
 * Note: Some deployed Radar builds (e.g. 0x5ed8…) have NO killAgent in bytecode.
 * Use supportsKillAgent() and soft-close (withdraw + pause) on those.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import {
  getRitualReadClient,
  RADAR_CONTRACT,
  radarAgentAbi,
  ritualChain,
} from "@/lib/ritual";

/** killAgent(uint256) selector */
const KILL_AGENT_SELECTOR = "4b9f3075";

let _killSupportCache: { address: string; ok: boolean } | null = null;

/**
 * True if the configured Radar bytecode includes killAgent(uint256).
 * Older mainnet/testnet deploys only had withdraw — kill always reverts there.
 */
export async function supportsKillAgent(): Promise<boolean> {
  if (!RADAR_CONTRACT) return false;
  const addr = RADAR_CONTRACT.toLowerCase();
  if (_killSupportCache?.address === addr) return _killSupportCache.ok;
  try {
    const client = getRitualReadClient(true);
    const code = await client.getBytecode({
      address: RADAR_CONTRACT as Address,
    });
    const ok = Boolean(
      code && code.toLowerCase().includes(KILL_AGENT_SELECTOR)
    );
    _killSupportCache = { address: addr, ok };
    return ok;
  } catch {
    _killSupportCache = { address: addr, ok: false };
    return false;
  }
}

const ERROR_HINTS: Record<string, string> = {
  NotOwner:
    "Connected wallet is not the agent owner. Switch to the wallet that created this agent.",
  AgentIsDead:
    "Agent is already dead on-chain. Kill only works once — any balance was refunded in the kill transaction. Deploy a new agent if you need another.",
  /** Legacy Radar (0x5ed8…) reverts withdraw when status=Dead — residual can be stuck */
  AgentIsDeadWithdraw:
    "This Radar contract blocks withdraw after an agent dies, so residual RIT cannot be recovered. Use a kill-capable Radar for new agents, or withdraw balance before the last sovereign tick.",
  InsufficientBalance:
    "Nothing left to withdraw: agent on-chain balance is zero (already withdrawn or refunded on kill). Click Refresh.",
  UnknownAgent: "Agent not found on this Radar contract.",
  TransferFailed:
    "Contract could not send RITUAL to your wallet. Use a normal MetaMask account (EOA), not a smart-contract wallet without receive().",
  ZeroAmount: "Amount must be greater than zero.",
  BadStatus: "Agent status does not allow this action (activate / pause first).",
  EmptyWatchlist: "Set a data stream (watchlist) before waking.",
  InsufficientPayment: "Not enough RITUAL attached to cover the deploy fee.",
  BadName: "Invalid name or watchlist entry.",
  BadKind: "Invalid agent class.",
};

/** Known custom-error selectors (first 4 bytes) → name */
const ERROR_SELECTORS: Record<string, string> = {
  "0x5509c32c": "AgentIsDead",
  "0xf4d678b8": "InsufficientBalance",
  "0x30cd7471": "NotOwner",
  "0x90b8ec18": "TransferFailed",
  "0x1f2a2005": "ZeroAmount",
  "0x0df2949d": "UnknownAgent",
  "0x5c975bda": "BadStatus",
  "0xb467aa13": "EmptyWatchlist",
};

function walkError(e: unknown): unknown[] {
  const out: unknown[] = [e];
  let cur: unknown = e;
  for (let i = 0; i < 6; i++) {
    if (cur && typeof cur === "object" && "cause" in cur) {
      cur = (cur as { cause?: unknown }).cause;
      if (cur) out.push(cur);
      else break;
    } else break;
  }
  return out;
}

function extractRevertData(e: unknown): Hex | undefined {
  for (const node of walkError(e)) {
    if (!node || typeof node !== "object") continue;
    const n = node as {
      data?: unknown;
      raw?: unknown;
      cause?: { data?: unknown };
      details?: unknown;
      metaMessages?: unknown;
      message?: unknown;
      shortMessage?: unknown;
    };
    const candidates = [n.data, n.raw, n.cause?.data, n.details];
    for (const c of candidates) {
      if (typeof c === "string" && /^0x[0-9a-fA-F]{8,}$/.test(c)) {
        return c as Hex;
      }
      if (c && typeof c === "object" && "data" in c) {
        const d = (c as { data?: unknown }).data;
        if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
          return d as Hex;
        }
      }
    }
    // Sometimes only the 4-byte selector is embedded in a message string
    const blob = `${n.message || ""} ${n.shortMessage || ""} ${n.details || ""}`;
    const m = blob.match(/0x([0-9a-fA-F]{8})\b/);
    if (m) return `0x${m[1]}` as Hex;
  }
  return undefined;
}

function hintForErrorName(
  name: string | undefined,
  context?: string
): string | null {
  if (!name) return null;
  if (name === "AgentIsDead" && context === "withdraw") {
    return ERROR_HINTS.AgentIsDeadWithdraw;
  }
  if (ERROR_HINTS[name]) return ERROR_HINTS[name];
  // viem sometimes puts "execution reverted" as the reason with no name
  if (/execution reverted/i.test(name)) return null;
  return `Contract reverted: ${name}`;
}

/** Map viem / MetaMask reverts into a short user-facing reason. */
export function decodeRadarRevert(
  e: unknown,
  context?: "killAgent" | "withdraw" | "fundAgent" | "runTick" | string
): string {
  for (const node of walkError(e)) {
    if (node instanceof BaseError) {
      const rev = node.walk((x) => x instanceof ContractFunctionRevertedError);
      if (rev instanceof ContractFunctionRevertedError) {
        const name = rev.data?.errorName;
        const hinted = hintForErrorName(name, context);
        if (hinted) return hinted;
        // reason is often the useless string "execution reverted"
        if (rev.reason && !/execution reverted/i.test(rev.reason)) {
          const h2 = hintForErrorName(rev.reason, context);
          if (h2) return h2;
        }
      }
    }
  }

  const data = extractRevertData(e);
  if (data) {
    const sel = data.slice(0, 10).toLowerCase();
    const bySel = ERROR_SELECTORS[sel];
    if (bySel) {
      const hinted = hintForErrorName(bySel, context);
      if (hinted) return hinted;
    }
    try {
      const decoded = decodeErrorResult({ abi: radarAgentAbi, data });
      const hinted = hintForErrorName(decoded.errorName, context);
      if (hinted) return hinted;
    } catch {
      /* not a custom error */
    }
  }

  if (e && typeof e === "object") {
    const o = e as {
      shortMessage?: string;
      message?: string;
      details?: string;
    };
    const raw = `${o.shortMessage || ""} ${o.message || ""} ${o.details || ""}`;
    if (/insufficient funds|exceeds the balance|gas.*fund/i.test(raw)) {
      return "Wallet does not have enough RITUAL for gas. Agent balance cannot pay gas — keep a little RIT in the wallet itself.";
    }
    if (/user rejected|denied|rejected the request/i.test(raw)) {
      return "Transaction rejected in wallet.";
    }
    if (/gas|fee|estimate/i.test(raw) && /unavail|fail|intrinsic|underpriced/i.test(raw)) {
      return "MetaMask could not estimate gas on Ritual. Retry — the app now sets gas price explicitly. If it persists, switch network off/on Ritual Testnet (1979).";
    }
    // Context-aware fallback when RPC only says "execution reverted"
    if (/execution reverted/i.test(raw)) {
      if (context === "killAgent") {
        return ERROR_HINTS.AgentIsDead;
      }
      if (context === "withdraw") {
        return ERROR_HINTS.AgentIsDeadWithdraw;
      }
      return "Transaction would revert on-chain. Click Refresh — the agent may already be dead or have zero balance.";
    }
    if (o.shortMessage && !/execution reverted/i.test(o.shortMessage)) {
      return o.shortMessage;
    }
    if (o.message && !/execution reverted/i.test(o.message)) {
      return o.message.slice(0, 220);
    }
  }
  if (e instanceof Error && !/execution reverted/i.test(e.message)) {
    return e.message.slice(0, 220);
  }
  if (context === "killAgent") return ERROR_HINTS.AgentIsDead;
  if (context === "withdraw") return ERROR_HINTS.AgentIsDeadWithdraw;
  return "Transaction would revert. Click Refresh and check agent status/balance.";
}

export type RadarFeeOverrides = {
  /** Gas limit with buffer */
  gas: bigint;
  /** Legacy gas price — forces type-0 tx in MetaMask (reliable on Ritual) */
  gasPrice: bigint;
};

/**
 * Simulate + estimate gas for a RadarAgent write.
 * Throws with a decoded message if the call would revert.
 */
export async function prepareRadarWrite(opts: {
  account: Address;
  functionName:
    | "createAgent"
    | "fundAgent"
    | "withdraw"
    | "killAgent"
    | "setActive"
    | "setPaused"
    | "setWatchlist"
    | "setWakeInterval"
    | "runTick";
  args?: readonly unknown[];
  value?: bigint;
  /** Minimum gas floor (value-returning calls need more headroom) */
  gasFloor?: bigint;
}): Promise<RadarFeeOverrides> {
  if (!RADAR_CONTRACT) {
    throw new Error("NEXT_PUBLIC_RADAR_CONTRACT is not set");
  }
  const client = getRitualReadClient(true);
  const address = RADAR_CONTRACT as Address;
  const args = (opts.args ?? []) as never[];

  const base = {
    address,
    abi: radarAgentAbi,
    functionName: opts.functionName,
    args: args as never,
    account: opts.account,
    ...(opts.value != null ? { value: opts.value } : {}),
  } as const;

  try {
    await client.simulateContract({
      ...base,
      chain: ritualChain,
    } as never);
  } catch (e) {
    throw new Error(decodeRadarRevert(e, opts.functionName));
  }

  let gas: bigint;
  try {
    gas = await client.estimateContractGas(base as never);
  } catch (e) {
    throw new Error(
      decodeRadarRevert(e, opts.functionName) ||
        "Gas estimation failed. Ensure you are on Ritual Testnet and own this agent."
    );
  }

  // Headroom for Ritual RPC variance + refunds (withdraw/kill send value out)
  gas = (gas * BigInt(150)) / BigInt(100);
  const floor = opts.gasFloor ?? BigInt(100_000);
  if (gas < floor) gas = floor;
  if (gas > BigInt(800_000)) gas = BigInt(800_000);

  let gasPrice: bigint;
  try {
    gasPrice = await client.getGasPrice();
  } catch {
    gasPrice = BigInt(1_500_000_000); // 1.5 gwei fallback
  }
  // Ritual feeHistory baseFee is ~7 wei — never trust sub-gwei for MetaMask
  const minGwei = BigInt(1_000_000_000);
  if (gasPrice < minGwei) gasPrice = minGwei;
  gasPrice = (gasPrice * BigInt(120)) / BigInt(100);

  return { gas, gasPrice };
}

/** Ensure the EOA can pay gas (agent balance cannot). */
export function assertWalletCanPayGas(
  walletBalance: bigint | undefined,
  fees: RadarFeeOverrides,
  value: bigint = BigInt(0)
): void {
  if (walletBalance == null) return;
  const need = fees.gas * fees.gasPrice + value;
  if (walletBalance < need) {
    throw new Error(
      `Not enough RITUAL in the wallet for gas` +
        (value > BigInt(0) ? " + payment" : "") +
        `. Need ~${formatEther(need)} RIT in the connected wallet (agent balance does not pay gas).`
    );
  }
}
