/**
 * Reliable RadarAgent writes for MetaMask on Ritual.
 *
 * Ritual RPC reports tiny EIP-1559 base fees (~7 wei) while eth_gasPrice is ~1 gwei.
 * MetaMask often fails fee estimation ("gas unavailable") on value-returning
 * calls (withdraw / killAgent). We always:
 *  1) simulateContract → clear custom-error messages
 *  2) estimateContractGas + buffer
 *  3) attach legacy gasPrice so the wallet does not need feeHistory
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

const ERROR_HINTS: Record<string, string> = {
  NotOwner:
    "Connected wallet is not the agent owner. Switch to the wallet that created this agent.",
  AgentIsDead: "Agent is already dead.",
  InsufficientBalance:
    "Amount exceeds the agent’s on-chain balance (or balance is zero). Click Refresh and try again.",
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
    };
    const candidates = [n.data, n.raw, n.cause?.data];
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) {
        return c as Hex;
      }
      if (c && typeof c === "object" && "data" in c) {
        const d = (c as { data?: unknown }).data;
        if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
          return d as Hex;
        }
      }
    }
  }
  return undefined;
}

/** Map viem / MetaMask reverts into a short user-facing reason. */
export function decodeRadarRevert(e: unknown): string {
  for (const node of walkError(e)) {
    if (node instanceof BaseError) {
      const rev = node.walk((x) => x instanceof ContractFunctionRevertedError);
      if (rev instanceof ContractFunctionRevertedError) {
        const name = rev.data?.errorName || rev.reason;
        if (name && ERROR_HINTS[name]) return ERROR_HINTS[name];
        if (name) return `Contract reverted: ${name}`;
        if (rev.reason) return `Contract reverted: ${rev.reason}`;
      }
    }
  }

  const data = extractRevertData(e);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: radarAgentAbi, data });
      if (ERROR_HINTS[decoded.errorName]) return ERROR_HINTS[decoded.errorName];
      return `Contract reverted: ${decoded.errorName}`;
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
    if (o.shortMessage) return o.shortMessage;
    if (o.message) return o.message.slice(0, 220);
  }
  if (e instanceof Error) return e.message.slice(0, 220);
  return String(e);
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
    throw new Error(decodeRadarRevert(e));
  }

  let gas: bigint;
  try {
    gas = await client.estimateContractGas(base as never);
  } catch (e) {
    throw new Error(
      decodeRadarRevert(e) ||
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
