/**
 * Credit Oracast Telegram alerts as BountyPool interactions (1 per successful DM).
 *
 * BountyPool.credit is only callable by feeders (ResearchDesk / Radar / keeper EOA).
 * Uses KEEPER_PRIVATE_KEY with a small RIT value so the poll counter advances.
 * Failures never block Telegram delivery.
 *
 * Admin (once): BountyPool.setFeeder(keeperAddress, true) if NotFeeder reverts.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BOUNTY_CONTRACT,
  bountyPoolAbi,
  ritualChain,
  RPC_URL,
} from "@/lib/ritual";

/** Dust RIT attached so credit() accepts (points weight for lottery). */
const DEFAULT_CREDIT_RIT =
  process.env.ORACAST_BOUNTY_CREDIT_RIT?.trim() || "0.0005";

function normalizePk(raw: string): Hex {
  const t = raw.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as Hex;
}

export type OracastBountyResult = {
  ok: boolean;
  reason?: string;
  txHash?: string;
};

async function setKeeperAsFeeder(
  ownerPk: string,
  keeper: Address
): Promise<boolean> {
  if (!BOUNTY_CONTRACT) return false;
  try {
    const owner = privateKeyToAccount(normalizePk(ownerPk));
    const client = createPublicClient({
      chain: ritualChain,
      transport: http(RPC_URL, { timeout: 25_000 }),
    });
    const wallet = createWalletClient({
      account: owner,
      chain: ritualChain,
      transport: http(RPC_URL, { timeout: 45_000 }),
    });
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "setFeeder",
          stateMutability: "nonpayable",
          inputs: [
            { name: "feeder", type: "address" },
            { name: "allowed", type: "bool" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "setFeeder",
      args: [keeper, true],
    });
    const block = await client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? BigInt(1);
    const maxPriorityFeePerGas = BigInt(1_000_000);
    let maxFeePerGas = base * BigInt(3) + maxPriorityFeePerGas;
    if (maxFeePerGas < BigInt(10_000_000)) maxFeePerGas = BigInt(10_000_000);
    const hash = await wallet.sendTransaction({
      account: owner,
      chain: ritualChain,
      to: BOUNTY_CONTRACT as Address,
      data,
      gas: BigInt(100_000),
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559",
    });
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 90_000,
    });
    console.info(
      `[oracastBounty] setFeeder(${keeper}, true) status=${receipt.status} tx=${hash}`
    );
    return receipt.status === "success";
  } catch (e) {
    console.warn(
      "[oracastBounty] setFeeder failed",
      e instanceof Error ? e.message.slice(0, 160) : e
    );
    return false;
  }
}

/**
 * One successful Oracast price alert → 1 BountyPool interaction for `user`.
 */
export async function creditOracastBountyInteraction(
  user: string
): Promise<OracastBountyResult> {
  if (!BOUNTY_CONTRACT) {
    return { ok: false, reason: "bounty_not_configured" };
  }
  const pk = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!pk) {
    return { ok: false, reason: "keeper_not_configured" };
  }
  if (!user || !/^0x[a-fA-F0-9]{40}$/.test(user)) {
    return { ok: false, reason: "bad_user" };
  }

  let value: bigint;
  try {
    value = parseEther(DEFAULT_CREDIT_RIT);
  } catch {
    value = parseEther("0.0005");
  }
  if (value <= BigInt(0)) {
    return { ok: false, reason: "bad_credit_amount" };
  }

  try {
    const account = privateKeyToAccount(normalizePk(pk));
    const client = createPublicClient({
      chain: ritualChain,
      transport: http(RPC_URL, { timeout: 25_000, retryCount: 2 }),
    });
    const wallet = createWalletClient({
      account,
      chain: ritualChain,
      transport: http(RPC_URL, { timeout: 45_000 }),
    });

    // Ensure keeper is a feeder (once). Owner key optional on Vercel.
    try {
      const allowed = await client.readContract({
        address: BOUNTY_CONTRACT as Address,
        abi: bountyPoolAbi,
        functionName: "isFeeder",
        args: [account.address],
      });
      if (allowed === false) {
        const ownerPk =
          process.env.BOUNTY_OWNER_PRIVATE_KEY?.trim() ||
          process.env.RITE_OWNER_PRIVATE_KEY?.trim();
        if (ownerPk) {
          const setOk = await setKeeperAsFeeder(ownerPk, account.address);
          if (!setOk) {
            return { ok: false, reason: "set_feeder_failed" };
          }
        } else {
          console.warn(
            `[oracastBounty] keeper ${account.address} is not a BountyPool feeder. ` +
              `Pool owner must: cast send ${BOUNTY_CONTRACT} "setFeeder(address,bool)" ${account.address} true ` +
              `— or set BOUNTY_OWNER_PRIVATE_KEY on Vercel.`
          );
          return { ok: false, reason: "keeper_not_feeder" };
        }
      }
    } catch {
      /* proceed; credit will revert if not feeder */
    }

    const bal = await client.getBalance({ address: account.address });
    const gasLimit = BigInt(120_000);
    // Cheap Ritual EIP-1559 fees
    const block = await client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? BigInt(1);
    const maxPriorityFeePerGas = BigInt(1_000_000);
    let maxFeePerGas = base * BigInt(3) + maxPriorityFeePerGas;
    if (maxFeePerGas < BigInt(10_000_000)) maxFeePerGas = BigInt(10_000_000);
    if (maxFeePerGas > BigInt(5_000_000_000)) maxFeePerGas = BigInt(5_000_000_000);

    const need = value + gasLimit * maxFeePerGas;
    if (bal < need) {
      console.warn(
        `[oracastBounty] keeper low balance (have ${bal}, need ~${need})`
      );
      return { ok: false, reason: "keeper_low_balance" };
    }

    const data = encodeFunctionData({
      abi: bountyPoolAbi,
      functionName: "credit",
      args: [user as Address],
    });

    const nonce = await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    const hash = await wallet.sendTransaction({
      account,
      chain: ritualChain,
      to: BOUNTY_CONTRACT as Address,
      data,
      value,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      type: "eip1559",
    });

    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 90_000,
    });
    if (receipt.status !== "success") {
      return { ok: false, reason: "tx_reverted", txHash: hash };
    }
    return { ok: true, txHash: hash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NotFeeder|0x/i.test(msg) && /feeder/i.test(msg)) {
      console.warn(
        "[oracastBounty] NotFeeder — BountyPool owner must setFeeder(keeper, true)"
      );
      return { ok: false, reason: "keeper_not_feeder" };
    }
    console.warn("[oracastBounty] credit failed", msg.slice(0, 200));
    return {
      ok: false,
      reason: msg.slice(0, 120),
    };
  }
}
