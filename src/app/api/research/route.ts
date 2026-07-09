import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
  type Address,
  decodeEventLog,
  isAddress,
  isHex,
} from "viem";
import { ritualChain, researchDeskAbi, RESEARCH_CONTRACT } from "@/lib/ritual";
import { runSurfResearch } from "@/lib/surf";

export const runtime = "nodejs";
export const maxDuration = 60;

const publicClient = createPublicClient({
  chain: ritualChain,
  transport: http(
    process.env.NEXT_PUBLIC_RPC_URL || ritualChain.rpcUrls.default.http[0]
  ),
});

type Body = {
  prompt: string;
  researcher: Address;
  /** Payment tx from payForResearch (new pay path) */
  txHash?: Hex;
  /** Existing on-chain research id — claim without paying again */
  researchId?: string | number;
};

type RecordTuple = {
  researcher: Address;
  feePaid: bigint;
  paidAt: bigint;
  settledAt: bigint;
  promptHash: Hex;
  resultHash: Hex;
  settled: boolean;
};

/**
 * POST /api/research
 *
 * Path A (new pay): { prompt, researcher, txHash }
 *   → verify ResearchPaid on tx, then Surf
 *
 * Path B (claim paid credit): { prompt, researcher, researchId }
 *   → verify on-chain record owned by researcher + promptHash match + fee already paid
 *   → Surf without new payment (fixes failed Surf after successful pay)
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    const prompt = (body.prompt || "").trim();
    const researcher = body.researcher;
    const txHash = body.txHash;
    const researchIdRaw = body.researchId;

    if (!prompt || prompt.length < 3) {
      return NextResponse.json({ error: "Prompt too short" }, { status: 400 });
    }
    if (!researcher || !isAddress(researcher)) {
      return NextResponse.json({ error: "Invalid researcher address" }, { status: 400 });
    }
    if (!RESEARCH_CONTRACT) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_RESEARCH_CONTRACT not configured" },
        { status: 500 }
      );
    }
    if (!process.env.SURF_API_KEY) {
      return NextResponse.json(
        { error: "SURF_API_KEY not configured on server" },
        { status: 500 }
      );
    }

    const promptHash = keccak256(stringToBytes(prompt));
    let researchId: string | null = null;
    let paymentTx: string | null = txHash || null;

    // ---------- Path B: claim existing paid research id ----------
    if (researchIdRaw !== undefined && researchIdRaw !== null && researchIdRaw !== "") {
      const id = BigInt(researchIdRaw);
      let record: RecordTuple;
      try {
        record = (await publicClient.readContract({
          address: RESEARCH_CONTRACT,
          abi: researchDeskAbi,
          functionName: "getRecord",
          args: [id],
        })) as RecordTuple;
      } catch {
        return NextResponse.json(
          { error: `Research id #${researchIdRaw} not found on-chain` },
          { status: 404 }
        );
      }

      if (record.researcher.toLowerCase() !== researcher.toLowerCase()) {
        return NextResponse.json(
          { error: "This research id was not paid by your wallet" },
          { status: 403 }
        );
      }
      if (record.promptHash.toLowerCase() !== promptHash.toLowerCase()) {
        return NextResponse.json(
          {
            error:
              "Prompt does not match the paid promptHash. Use the exact prompt you paid for.",
          },
          { status: 400 }
        );
      }
      if (record.feePaid === BigInt(0)) {
        return NextResponse.json({ error: "No fee recorded for this id" }, { status: 402 });
      }

      researchId = id.toString();
      // already settled is OK to re-fetch report off-chain (user already paid)
    }
    // ---------- Path A: verify new payment tx ----------
    else if (txHash && isHex(txHash) && txHash.length === 66) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: 120_000,
      });

      if (receipt.status !== "success") {
        return NextResponse.json({ error: "Payment transaction failed" }, { status: 402 });
      }
      if (receipt.to?.toLowerCase() !== RESEARCH_CONTRACT.toLowerCase()) {
        return NextResponse.json(
          { error: "Payment was not sent to ResearchDesk contract" },
          { status: 402 }
        );
      }

      let paidBy: string | null = null;
      let eventPromptHash: string | null = null;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== RESEARCH_CONTRACT.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: researchDeskAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "ResearchPaid") {
            const args = decoded.args as {
              id: bigint;
              researcher: Address;
              promptHash: Hex;
            };
            researchId = args.id.toString();
            paidBy = args.researcher;
            eventPromptHash = args.promptHash;
            break;
          }
        } catch {
          /* skip */
        }
      }

      if (!researchId || !paidBy) {
        return NextResponse.json(
          { error: "ResearchPaid event not found in payment tx" },
          { status: 402 }
        );
      }
      if (paidBy.toLowerCase() !== researcher.toLowerCase()) {
        return NextResponse.json(
          { error: "Payment researcher does not match connected wallet" },
          { status: 403 }
        );
      }
      if (eventPromptHash && eventPromptHash.toLowerCase() !== promptHash.toLowerCase()) {
        return NextResponse.json(
          { error: "Prompt does not match on-chain promptHash" },
          { status: 400 }
        );
      }
      paymentTx = txHash;
    } else {
      return NextResponse.json(
        {
          error:
            "Provide either txHash (new payment) or researchId (claim already-paid credit)",
        },
        { status: 400 }
      );
    }

    // ---------- Surf research (Responses API) ----------
    const result = await runSurfResearch(prompt);
    const resultHash = keccak256(stringToBytes(result.content));

    return NextResponse.json({
      ok: true,
      researchId,
      promptHash,
      resultHash,
      model: result.model,
      report: result.content,
      paymentTx,
      claimed: Boolean(researchIdRaw),
      explorerTx: paymentTx
        ? `${process.env.NEXT_PUBLIC_EXPLORER_URL || "https://explorer.ritualfoundation.org"}/tx/${paymentTx}`
        : null,
    });
  } catch (e: unknown) {
    console.error("[api/research]", e);
    const message = e instanceof Error ? e.message : "Research failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
