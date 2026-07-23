import { NextRequest, NextResponse } from "next/server";
import {
  ORACAST_TOKEN_LIST,
  formatUsdPrice,
  resolvePrice,
} from "@/lib/oracastPrice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const coinId = req.nextUrl.searchParams.get("coinId") || undefined;
  const contract =
    req.nextUrl.searchParams.get("contract") ||
    req.nextUrl.searchParams.get("address") ||
    undefined;
  const chain = req.nextUrl.searchParams.get("chain") || undefined;

  if (req.nextUrl.searchParams.get("list") === "1") {
    return NextResponse.json({
      tokens: ORACAST_TOKEN_LIST,
      rateRitPerHour: Number(process.env.ORACAST_RATE_RIT_PER_HOUR || "0.05"),
    });
  }

  if (!coinId && !contract) {
    return NextResponse.json(
      { error: "coinId or contract required" },
      { status: 400 }
    );
  }

  try {
    const quote = await resolvePrice({
      coinId,
      contractAddress: contract,
      chainHint: chain || undefined,
    });
    return NextResponse.json({
      ...quote,
      priceLabel: formatUsdPrice(quote.price),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "price failed" },
      { status: 502 }
    );
  }
}
