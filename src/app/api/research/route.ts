import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  keccak256,
  stringToBytes,
  verifyMessage,
  type Hex,
  type Address,
  decodeEventLog,
  isAddress,
  isHex,
} from "viem";
import { ritualChain, researchDeskAbi, RESEARCH_CONTRACT } from "@/lib/ritual";
import { runSurfResearch } from "@/lib/surf";
import {
  clampPrompt,
  clientIp,
  PROMPT_MIN,
  publicErrorMessage,
  rateLimit,
} from "@/lib/security";
import {
  buildClaimMessage,
  cacheReport,
  getCachedReport,
  sealReport,
  withResearchLock,
} from "@/lib/researchSeal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
  /** EIP-191 signature of claim message */
  signature?: Hex;
  nonce?: string;
  expiry?: number;
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

async function getPaymentReceipt(txHash: Hex) {
  const existing = await publicClient
    .getTransactionReceipt({ hash: txHash })
    .catch(() => null);
  if (existing) return existing;

  return publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 25_000,
    pollingInterval: 1_500,
  });
}

async function verifyClaimSig(opts: {
  researcher: Address;
  researchId: string;
  promptHash: Hex;
  signature?: Hex;
  nonce?: string;
  expiry?: number;
}): Promise<string | null> {
  if (!opts.signature || !opts.nonce || !opts.expiry) {
    return "Missing wallet signature (signature, nonce, expiry required)";
  }
  const now = Math.floor(Date.now() / 1000);
  if (opts.expiry < now) return "Signature expired — request again";
  if (opts.expiry > now + 30 * 60) return "Signature expiry too far in the future";
  if (opts.nonce.length < 8 || opts.nonce.length > 128) {
    return "Invalid nonce";
  }
  const message = buildClaimMessage({
    researchId: opts.researchId,
    promptHash: opts.promptHash,
    nonce: opts.nonce,
    expiry: opts.expiry,
  });
  try {
    const ok = await verifyMessage({
      address: opts.researcher,
      message,
      signature: opts.signature,
    });
    if (!ok) return "Invalid wallet signature for research claim";
  } catch {
    return "Could not verify wallet signature";
  }
  return null;
}

/**
 * POST /api/research
 * Runs Surf after payment verification + wallet signature.
 * Returns sealedReport + resultHash only — never plaintext report.
 * Client must settleResearch then POST /api/research/reveal.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`research:${ip}`, 12, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many research requests. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSec) },
        }
      );
    }

    const cl = req.headers.get("content-length");
    if (cl && Number(cl) > 64_000) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const prompt = clampPrompt(body.prompt || "");
    const researcher = body.researcher;
    const txHash = body.txHash;
    const researchIdRaw = body.researchId;

    if (!prompt || prompt.length < PROMPT_MIN) {
      return NextResponse.json({ error: "Prompt too short" }, { status: 400 });
    }
    if (!researcher || !isAddress(researcher)) {
      return NextResponse.json(
        { error: "Invalid researcher address" },
        { status: 400 }
      );
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

    if (
      researchIdRaw !== undefined &&
      researchIdRaw !== null &&
      researchIdRaw !== ""
    ) {
      let id: bigint;
      try {
        id = BigInt(researchIdRaw);
        if (id <= BigInt(0)) throw new Error("bad id");
      } catch {
        return NextResponse.json(
          { error: "Invalid research id" },
          { status: 400 }
        );
      }

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
          { error: `Research id #${id.toString()} not found on-chain` },
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
        return NextResponse.json(
          { error: "No fee recorded for this id" },
          { status: 402 }
        );
      }
      if (record.settled) {
        return NextResponse.json(
          {
            error:
              "This research was already completed and sealed on-chain. Pay a new fee for a new report.",
          },
          { status: 409 }
        );
      }

      researchId = id.toString();
    } else if (txHash && isHex(txHash) && txHash.length === 66) {
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
        return NextResponse.json(
          { error: "Payment transaction failed" },
          { status: 402 }
        );
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
        if (log.address.toLowerCase() !== RESEARCH_CONTRACT.toLowerCase())
          continue;
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
      if (
        eventPromptHash &&
        eventPromptHash.toLowerCase() !== promptHash.toLowerCase()
      ) {
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

    const sigErr = await verifyClaimSig({
      researcher,
      researchId: researchId!,
      promptHash,
      signature: body.signature,
      nonce: body.nonce,
      expiry: body.expiry,
    });
    if (sigErr) {
      return NextResponse.json({ error: sigErr }, { status: 401 });
    }

    // Idempotent Surf call per researchId (prevents concurrent double-spend of API)
    const payload = await withResearchLock(researchId!, async () => {
      const cached = getCachedReport(researchId!);
      if (cached) {
        return {
          resultHash: cached.resultHash,
          report: cached.report,
          model: "cached",
        };
      }
      const result = await runSurfResearch(prompt);
      const resultHash = keccak256(stringToBytes(result.content));
      cacheReport(researchId!, resultHash, result.content);
      return {
        resultHash,
        report: result.content,
        model: result.model,
      };
    });

    const sealedReport = sealReport(researchId!, payload.report);

    const explorerBase = (
      process.env.NEXT_PUBLIC_EXPLORER_URL ||
      "https://explorer.ritualfoundation.org"
    ).replace(/\/$/, "");

    // NEVER return plaintext report — only sealed blob + hash for settle
    return NextResponse.json({
      ok: true,
      researchId,
      promptHash,
      resultHash: payload.resultHash,
      model: payload.model,
      sealedReport,
      paymentTx,
      claimed: Boolean(researchIdRaw),
      explorerTx: paymentTx ? `${explorerBase}/tx/${paymentTx}` : null,
      revealRequired: true,
    });
  } catch (e: unknown) {
    console.error("[api/research]", e);
    const message = publicErrorMessage(e, "Research failed");
    const isTimeout = /timed out|timeout|504|AbortError/i.test(message);
    return NextResponse.json(
      { error: message },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
