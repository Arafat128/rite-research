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

/** killAgent(uint256) selector (no 0x) */
const KILL_AGENT_SELECTOR = "4b9f3075";

/** Known Ritual testnet deploys — avoid flaky bytecode fetches in the browser */
const KNOWN_KILL_SUPPORT: Record<string, boolean> = {
  // Preferred deploy with killAgent + withdraw-after-dead
  "0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f": true,
  // Legacy — no killAgent; soft-close only
  "0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30": false,
  "0xa84fbdef457c08de31fba4c2ba9d004056f1384b": false,
};

let _killSupportCache: { address: string; ok: boolean } | null = null;

/**
 * True if the configured Radar includes killAgent(uint256).
 * Order: known map → bytecode scan → optimistic true (try kill; soft-close only if missing).
 */
export async function supportsKillAgent(): Promise<boolean> {
  if (!RADAR_CONTRACT) return false;
  const addr = RADAR_CONTRACT.toLowerCase() as Address;
  if (addr in KNOWN_KILL_SUPPORT) {
    return KNOWN_KILL_SUPPORT[addr];
  }
  if (_killSupportCache?.address === addr) return _killSupportCache.ok;

  try {
    const client = getRitualReadClient(true);
    const code = await client.getBytecode({
      address: RADAR_CONTRACT as Address,
    });
    if (code && code !== "0x") {
      const ok = code.toLowerCase().includes(KILL_AGENT_SELECTOR);
      _killSupportCache = { address: addr, ok };
      return ok;
    }
  } catch {
    /* RPC flaky — fall through */
  }

  // Unknown deploy + bytecode unread: assume kill exists and let simulate decide
  _killSupportCache = { address: addr, ok: true };
  return true;
}

/** True when a killAgent simulate failed because the method is missing (legacy Radar). */
export function isMissingKillFunctionError(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6; i++) {
    if (!cur) break;
    if (cur instanceof Error) parts.push(cur.message);
    if (cur && typeof cur === "object") {
      const o = cur as { shortMessage?: string; details?: string; message?: string };
      if (o.shortMessage) parts.push(o.shortMessage);
      if (o.details) parts.push(String(o.details));
      if (o.message) parts.push(o.message);
      if ("cause" in o) cur = (o as { cause?: unknown }).cause;
      else break;
    } else break;
  }
  const blob = parts.join(" ").toLowerCase();
  // Missing selector / empty revert — not NotOwner / AgentIsDead custom errors
  if (/function selector|does not exist|not a function|returned no data|0x$/.test(blob)) {
    return true;
  }
  // Pure "execution reverted" without a decoded custom error often = missing method on legacy
  if (
    /execution reverted/i.test(blob) &&
    !/notowner|agentisdead|not authorized|zerodigest|toearly|insufficient/i.test(
      blob
    )
  ) {
    // Only treat as missing method if we *know* this address has no kill
    const addr = (RADAR_CONTRACT || "").toLowerCase();
    if (addr in KNOWN_KILL_SUPPORT && KNOWN_KILL_SUPPORT[addr] === false) {
      return true;
    }
  }
  return false;
}

export function radarHasKnownKill(): boolean | null {
  if (!RADAR_CONTRACT) return null;
  const addr = RADAR_CONTRACT.toLowerCase();
  if (addr in KNOWN_KILL_SUPPORT) return KNOWN_KILL_SUPPORT[addr];
  return null;
}

const ERROR_HINTS: Record<string, string> = {
  NotOwner:
    "Connected wallet is not the agent owner. Switch to the wallet that created this agent.",
  AgentIsDead:
    "Agent is already dead on-chain. Kill only works once — any balance was refunded in the kill transaction. Deploy a new agent if you need another.",
  /** Legacy Radar reverts withdraw when status=Dead — residual can be stuck */
  AgentIsDeadWithdraw:
    "Remaining balance cannot be withdrawn after this agent finished. For new agents, withdraw before the final tick if needed.",
  InsufficientBalance:
    "Nothing left to withdraw — agent balance is zero (already withdrawn or refunded). Click Refresh.",
  UnknownAgent: "Agent not found. Click Refresh and try again.",
  TransferFailed:
    "Could not send RITUAL to your wallet. Use a normal MetaMask account (not a smart-contract wallet).",
  ZeroAmount: "Amount must be greater than zero.",
  BadStatus: "Agent status does not allow this action (activate / pause first).",
  EmptyWatchlist: "Set a data stream (watchlist) before waking.",
  InsufficientPayment: "Not enough RITUAL attached to cover the deploy fee.",
  BadName: "Invalid name or watchlist entry.",
  BadKind: "Invalid agent class.",
  TooEarly:
    "Schedule not due yet (on-chain block interval). Wait for the countdown, then Wake again.",
  NotAuthorized:
    "Wallet is not allowed to run this tick. Use the agent owner wallet.",
  ZeroDigest: "Invalid tick digest — try Wake again.",
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
    if (
      /transaction creation failed|opcodenotfound/i.test(raw) &&
      /estimate|gas|rpc/i.test(raw)
    ) {
      return "Ritual RPC failed gas estimation (network flake). Retry Wake in a few seconds.";
    }
    if (/gas|fee|estimate/i.test(raw) && /unavail|fail|intrinsic|underpriced/i.test(raw)) {
      return "MetaMask could not estimate gas on Ritual. Retry — the app sets gas price explicitly. If it persists, switch network off/on Ritual Testnet (1979).";
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

/** Ritual RPC often returns this for eth_call / eth_estimateGas under load. */
function isRitualRpcFlake(e: unknown): boolean {
  const parts: string[] = [];
  for (const node of walkError(e)) {
    if (!node) continue;
    if (node instanceof Error) parts.push(node.message);
    if (node && typeof node === "object") {
      const o = node as {
        shortMessage?: string;
        details?: string;
        message?: string;
      };
      if (o.shortMessage) parts.push(o.shortMessage);
      if (o.details) parts.push(String(o.details));
      if (o.message) parts.push(o.message);
    }
  }
  const blob = parts.join(" ").toLowerCase();
  // "Transaction creation failed" / OpcodeNotFound is Ritual's flaky estimateGas
  if (
    /transaction creation failed|opcodenotfound|http request failed|fetch failed|timeout|econnreset|socket|502|503|504|network error|internal error|rate limit/i.test(
      blob
    )
  ) {
    // Real contract reverts should not use the floor path
    if (
      /execution reverted|tooearly|notauthorized|notowner|agentisdead|badstatus|emptywatchlist|zerodigest|insufficientbalance|insufficient funds/i.test(
        blob
      )
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Simulate + estimate gas for a RadarAgent write.
 * Throws with a decoded message if the call would revert.
 *
 * Ritual public RPC frequently fails eth_estimateGas with
 * "Transaction creation failed" even when runTick is valid — we retry,
 * then fall back to a safe gas floor so Wake still opens the wallet.
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
  const address = RADAR_CONTRACT as Address;
  const args = (opts.args ?? []) as never[];
  const floor = opts.gasFloor ?? BigInt(100_000);

  const base = {
    address,
    abi: radarAgentAbi,
    functionName: opts.functionName,
    args: args as never,
    account: opts.account,
    ...(opts.value != null ? { value: opts.value } : {}),
  } as const;

  // --- simulate (retries on flaky RPC) ---
  let simulated = false;
  let lastSimErr: unknown;
  for (let i = 0; i < 3; i++) {
    const client = getRitualReadClient(i > 0);
    try {
      await client.simulateContract({
        ...base,
        chain: ritualChain,
      } as never);
      simulated = true;
      lastSimErr = undefined;
      break;
    } catch (e) {
      lastSimErr = e;
      if (isRitualRpcFlake(e) && i < 2) {
        await sleepMs(350 * (i + 1));
        continue;
      }
      if (!isRitualRpcFlake(e)) {
        throw new Error(decodeRadarRevert(e, opts.functionName));
      }
    }
  }
  if (!simulated && lastSimErr && !isRitualRpcFlake(lastSimErr)) {
    throw new Error(decodeRadarRevert(lastSimErr, opts.functionName));
  }

  // --- estimate gas (retries → floor on RPC flake) ---
  let gas: bigint | null = null;
  let lastEstErr: unknown;
  for (let i = 0; i < 3; i++) {
    const client = getRitualReadClient(i > 0);
    try {
      gas = await client.estimateContractGas(base as never);
      lastEstErr = undefined;
      break;
    } catch (e) {
      lastEstErr = e;
      if (isRitualRpcFlake(e) && i < 2) {
        await sleepMs(350 * (i + 1));
        continue;
      }
      if (!isRitualRpcFlake(e)) {
        throw new Error(
          decodeRadarRevert(e, opts.functionName) ||
            "Gas estimation failed. Ensure you are on Ritual Testnet and own this agent."
        );
      }
    }
  }

  if (gas == null) {
    // Flaky eth_estimateGas only — use function-specific safe floor
    const defaults: Partial<Record<string, bigint>> = {
      runTick: BigInt(280_000),
      createAgent: BigInt(350_000),
      setWatchlist: BigInt(200_000),
      killAgent: BigInt(200_000),
      withdraw: BigInt(150_000),
      setActive: BigInt(120_000),
      setPaused: BigInt(120_000),
      fundAgent: BigInt(120_000),
      setWakeInterval: BigInt(120_000),
    };
    gas = defaults[opts.functionName] ?? floor;
    if (lastEstErr && !isRitualRpcFlake(lastEstErr)) {
      throw new Error(
        decodeRadarRevert(lastEstErr, opts.functionName) ||
          "Gas estimation failed."
      );
    }
  } else {
    // Headroom for Ritual RPC variance + refunds (withdraw/kill send value out)
    gas = (gas * BigInt(150)) / BigInt(100);
  }

  if (gas < floor) gas = floor;
  if (gas > BigInt(800_000)) gas = BigInt(800_000);

  let gasPrice: bigint;
  try {
    gasPrice = await getRitualReadClient(true).getGasPrice();
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
