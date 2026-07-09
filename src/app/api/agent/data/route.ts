import { NextRequest, NextResponse } from "next/server";
import {
  DATA_KINDS,
  fetchSurfData,
  getDataKind,
  type DataKindId,
} from "@/lib/surfData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Surf DATA API proxy for persistent radar agents.
 * POST { kind, target } → structured snapshot (not Chat/Responses research).
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    product: "Surf Data API",
    note: "Persistent agents pull one locked data kind per tick — not Chat/Responses.",
    kinds: DATA_KINDS.map((k) => ({
      id: k.id,
      label: k.label,
      description: k.description,
      targetLabel: k.targetLabel,
      defaultTarget: k.defaultTarget,
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      kind?: string;
      target?: string;
    };

    const kindId = (body.kind || "").trim() as DataKindId;
    if (!getDataKind(kindId)) {
      return NextResponse.json(
        {
          error: `Invalid kind. Choose one of: ${DATA_KINDS.map((k) => k.id).join(", ")}`,
        },
        { status: 400 }
      );
    }

    const target = (body.target || "").trim();
    const snapshot = await fetchSurfData(kindId, target);

    return NextResponse.json({
      ok: true,
      source: "surf-data-api",
      snapshot,
    });
  } catch (e: unknown) {
    console.error("[api/agent/data]", e);
    const message = e instanceof Error ? e.message : "Data fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
