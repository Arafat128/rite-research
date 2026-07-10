import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  verifyMessage,
  type Address,
  type Hex,
  isAddress,
  isHex,
} from "viem";
import { ritualChain, researchDeskAbi, RESEARCH_CONTRACT } from "@/lib/ritual";
import {
  clientIp,
  publicErrorMessage,
  rateLimit,
} from "@/lib/security";
import {
  buildClaimMessage,
  getCachedReport,
  unsealReport,
} from "@/lib/researchSeal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicClient = createPublicClient({
  chain: ritualChain,
  transport: http(
    process.env.NEXT_PUBLIC_RPC_URL || ritualChain.rpcUrls.default.http[0],
    { timeout: 20_000, retryCount: 2 }
  ),
});

type Body = {
  researchId: string | number;
  researcher: Address;
  resultHash: Hex;
  sealedReport?: string;
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

/**
 * POST /api/research/reveal
 * Returns plaintext report only after on-chain settleResearch matches resultHash.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    const rl = rateLimit(`research-reveal:${ip}`, 20, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many reveal requests" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.researcher || !isAddress(body.researcher)) {
      return NextResponse.json({ error: "Invalid researcher" }, { status: 400 });
    }
    if (!body.resultHash || !isHex(body.resultHash) || body.resultHash.length !== 66) {
      return NextResponse.json({ error: "Invalid resultHash" }, { status: 400 });
    }
    if (!RESEARCH_CONTRACT) {
      return NextResponse.json(
        { error: "Research contract not configured" },
        { status: 500 }
      );
    }

    let id: bigint;
    try {
      id = BigInt(body.researchId);
      if (id <= BigInt(0)) throw new Error("bad");
    } catch {
      return NextResponse.json({ error: "Invalid researchId" }, { status: 400 });
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
      return NextResponse.json({ error: "Research id not found" }, { status: 404 });
    }

    if (record.researcher.toLowerCase() !== body.researcher.toLowerCase()) {
      return NextResponse.json({ error: "Not the researcher for this id" }, { status: 403 });
    }
    if (!record.settled) {
      return NextResponse.json(
        {
          error:
            "Report is sealed until settleResearch is confirmed on-chain. Confirm the seal tx first.",
        },
        { status: 403 }
      );
    }
    if (record.resultHash.toLowerCase() !== body.resultHash.toLowerCase()) {
      return NextResponse.json(
        { error: "resultHash does not match on-chain seal" },
        { status: 400 }
      );
    }

    // Signature over reveal claim (binds wallet)
    if (!body.signature || !body.nonce || !body.expiry) {
      return NextResponse.json(
        { error: "Wallet signature required to reveal report" },
        { status: 401 }
      );
    }
    const now = Math.floor(Date.now() / 1000);
    if (body.expiry < now || body.expiry > now + 30 * 60) {
      return NextResponse.json({ error: "Invalid signature expiry" }, { status: 401 });
    }
    const message = buildClaimMessage({
      researchId: id.toString(),
      promptHash: record.promptHash,
      nonce: body.nonce,
      expiry: body.expiry,
    });
    try {
      const ok = await verifyMessage({
        address: body.researcher,
        message,
        signature: body.signature,
      });
      if (!ok) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    // Prefer cache; else unseal client blob
    const cached = getCachedReport(id.toString());
    if (cached && cached.resultHash === body.resultHash.toLowerCase()) {
      return NextResponse.json({
        ok: true,
        researchId: id.toString(),
        report: cached.report,
        resultHash: body.resultHash,
      });
    }

    if (!body.sealedReport || typeof body.sealedReport !== "string") {
      return NextResponse.json(
        {
          error:
            "Report cache expired and no sealedReport provided. Re-run is blocked after settle — keep sealedReport from the research response.",
        },
        { status: 410 }
      );
    }

    try {
      const report = unsealReport(id.toString(), body.sealedReport);
      // Integrity: hash must match sealed result
      const { keccak256, stringToBytes } = await import("viem");
      const h = keccak256(stringToBytes(report));
      if (h.toLowerCase() !== body.resultHash.toLowerCase()) {
        return NextResponse.json(
          { error: "Sealed report does not match resultHash" },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        researchId: id.toString(),
        report,
        resultHash: body.resultHash,
      });
    } catch {
      return NextResponse.json(
        { error: "Could not decrypt sealed report" },
        { status: 400 }
      );
    }
  } catch (e: unknown) {
    console.error("[api/research/reveal]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "Reveal failed") },
      { status: 500 }
    );
  }
}
