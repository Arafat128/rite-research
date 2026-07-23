import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Hex } from "viem";
import {
  ORACAST_RATE_RIT_PER_HOUR,
  createWatch,
  depositAddress,
  fundWatch,
  listWatchesByOwner,
  publicWatch,
  updateWatchPrefs,
} from "@/lib/oracastWatch";
import { clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const owner = (req.nextUrl.searchParams.get("owner") || "").toLowerCase();
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ error: "owner address required" }, { status: 400 });
  }
  try {
    const watches = await listWatchesByOwner(owner);
    return NextResponse.json({
      rateRitPerHour: ORACAST_RATE_RIT_PER_HOUR,
      depositTo: depositAddress(),
      watches: watches.map(publicWatch),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "list failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = rateLimit(`oracast-watch:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  try {
    const body = (await req.json()) as {
      action?: string;
      owner?: string;
      watchId?: string;
      coinId?: string;
      contractAddress?: string;
      chainHint?: string;
      frequencyMin?: number;
      depositRit?: string;
      txHash?: string;
      active?: boolean;
    };

    const owner = (body.owner || "").toLowerCase();
    if (!owner || !isAddress(owner)) {
      return NextResponse.json({ error: "owner required" }, { status: 400 });
    }

    if (body.action === "create") {
      if (!body.txHash || !/^0x[a-fA-F0-9]{64}$/.test(body.txHash)) {
        return NextResponse.json(
          { error: "txHash of RIT deposit required" },
          { status: 400 }
        );
      }
      const w = await createWatch({
        owner,
        coinId: body.coinId,
        contractAddress: body.contractAddress,
        chainHint: body.chainHint,
        frequencyMin: Number(body.frequencyMin || 60),
        depositRit: String(body.depositRit || "0"),
        txHash: body.txHash as Hex,
      });
      return NextResponse.json({ ok: true, watch: publicWatch(w) });
    }

    if (body.action === "fund") {
      if (!body.watchId || !body.txHash) {
        return NextResponse.json(
          { error: "watchId and txHash required" },
          { status: 400 }
        );
      }
      const w = await fundWatch({
        watchId: body.watchId,
        owner,
        depositRit: String(body.depositRit || "0"),
        txHash: body.txHash as Hex,
      });
      return NextResponse.json({ ok: true, watch: publicWatch(w) });
    }

    if (body.action === "update") {
      if (!body.watchId) {
        return NextResponse.json({ error: "watchId required" }, { status: 400 });
      }
      const w = await updateWatchPrefs({
        watchId: body.watchId,
        owner,
        frequencyMin:
          body.frequencyMin != null ? Number(body.frequencyMin) : undefined,
        active: body.active,
      });
      return NextResponse.json({ ok: true, watch: publicWatch(w) });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "request failed" },
      { status: 400 }
    );
  }
}
