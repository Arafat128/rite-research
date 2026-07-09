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
export const dynamic = "force-dynamic";
/** Vercel Hobby allows up to 300s with fluid compute */
export const maxDuration = 300;

const publicClient = createPublicClient({
  chain: ritualChain,
  transport: http(
    process.env.NEXT_PUBLIC_RPC_URL || ritualChain.rpcUrls.default.http[0],
    { timeout: 20_000, retryCount: 2 }
  ),
});

type Body = {
  prompt: string;
  researcher: Address;
  txHash?: Hex;
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

/** Client already waits for confirmation — only poll briefly if receipt not yet visible. */
async function getPaymentReceipt(txHash: Hex) {
  const existing = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (existing) return existing;

  return publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 25_000,
    pollingInterval: 1_500,
  });
}

/**
 * POST /api/research
 * Path A: { prompt, researcher, txHash }
 * Path B: { prompt, researcher, researchId } — claim after failed Surf
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
    }
    // ---------- Path A: verify new payment tx (fast) ----------
    else if (txHash && isHex(txHash) && txHash.length === 66) {
      let receipt;
      try {
        receipt = await getPaymentReceipt(txHash);
      } catch {
        return NextResponse.json(
          {
            error:
              "Payment tx not confirmed yet on Ritual RPC. Wait a few seconds, then use Claim free report with the same prompt (you already paid).",
          },
          { status: 408 }
        );
      }

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

    // ---------- Surf research ----------
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
    // Surface timeout-ish errors as 504 so the client can guide claim
    const isTimeout = /timed out|timeout|504|AbortError/i.test(message);
    return NextResponse.json(
      { error: message },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
