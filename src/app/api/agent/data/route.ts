import { NextRequest, NextResponse } from "next/server";
import {
  DATA_KINDS,
  fetchSurfData,
  getDataKind,
  type DataKindId,
} from "@/lib/surfData";
import {
  clientIp,
  publicErrorMessage,
  rateLimit,
  sanitizeDataTarget,
} from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Surf DATA API proxy for radar agents.
 * POST { kind, target } → structured snapshot (no raw upstream payload).
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    product: "Surf Data API",
    note: "Agents pull one locked data kind per tick — not Chat/Responses.",
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
    const ip = clientIp(req);
    const rl = rateLimit(`agent-data:${ip}`, 30, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many data requests. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSec) },
        }
      );
    }

    const cl = req.headers.get("content-length");
    if (cl && Number(cl) > 16_000) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }

    let body: { kind?: string; target?: string };
    try {
      body = (await req.json()) as { kind?: string; target?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const kindId = (body.kind || "").trim() as DataKindId;
    if (!getDataKind(kindId)) {
      return NextResponse.json(
        {
          error: `Invalid kind. Choose one of: ${DATA_KINDS.map((k) => k.id).join(", ")}`,
        },
        { status: 400 }
      );
    }

    if (!process.env.SURF_API_KEY) {
      return NextResponse.json(
        { error: "SURF_API_KEY not configured on server" },
        { status: 500 }
      );
    }

    const target = sanitizeDataTarget(body.target || "", 48);
    const snapshot = await fetchSurfData(kindId, target);

    // Never send upstream raw payload to the browser
    const safeSnapshot = {
      kind: snapshot.kind,
      kindLabel: snapshot.kindLabel,
      target: snapshot.target,
      fetchedAt: snapshot.fetchedAt,
      endpoint: snapshot.endpoint,
      summary: snapshot.summary,
      rows: snapshot.rows,
      highlights: snapshot.highlights,
    };

    return NextResponse.json({
      ok: true,
      source: "surf-data-api",
      snapshot: safeSnapshot,
    });
  } catch (e: unknown) {
    console.error("[api/agent/data]", e);
    return NextResponse.json(
      { error: publicErrorMessage(e, "Data fetch failed") },
      { status: 500 }
    );
  }
}
