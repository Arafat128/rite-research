/**
 * Surf DATA API client (not Chat / Responses research).
 *
 * Base: https://api.asksurf.ai/gateway/v1
 * Auth: Bearer SURF_API_KEY
 *
 * Agents wake on schedule and pull ONE locked data kind per agent.
 */

import { resolveSurfBaseUrl, sanitizeDataTarget } from "@/lib/security";

export type DataKindId =
  | "market_price"
  | "fear_greed"
  | "news_feed"
  | "perp_funding"
  | "social_mindshare";

export type DataKindDef = {
  id: DataKindId;
  label: string;
  short: string;
  description: string;
  /** Query target label shown in UI (null = no target needed) */
  targetLabel: string | null;
  targetPlaceholder: string;
  defaultTarget: string;
  /** Surf path template — use {target} placeholder */
  path: (target: string) => string;
};

export const DATA_KINDS: DataKindDef[] = [
  {
    id: "market_price",
    label: "Token price",
    short: "Price",
    description: "Live / recent market price series for a symbol (BTC, ETH, …).",
    targetLabel: "Symbol",
    targetPlaceholder: "BTC",
    defaultTarget: "BTC",
    path: (t) => `/market/price?symbol=${encodeURIComponent(t.toUpperCase())}`,
  },
  {
    id: "fear_greed",
    label: "Fear & Greed",
    short: "F&G",
    description: "Crypto Fear & Greed index history (global — no target).",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => `/market/fear-greed`,
  },
  {
    id: "news_feed",
    label: "Crypto news",
    short: "News",
    description: "Latest crypto news headlines from Surf news feed.",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => `/news/feed?limit=8`,
  },
  {
    id: "perp_funding",
    label: "Perp funding",
    short: "Funding",
    description: "Perpetual funding rate, mark/index price, open interest.",
    targetLabel: "Pair",
    targetPlaceholder: "BTC-USDT",
    defaultTarget: "BTC-USDT",
    path: (t) => {
      // API wants pair like BTC-USDT
      const pair = t.includes("-") ? t.toUpperCase() : `${t.toUpperCase()}-USDT`;
      return `/exchange/perp?pair=${encodeURIComponent(pair)}`;
    },
  },
  {
    id: "social_mindshare",
    label: "Social mindshare",
    short: "Social",
    description: "Social mindshare time series for a query (e.g. ETH, bitcoin).",
    targetLabel: "Query",
    targetPlaceholder: "ETH",
    defaultTarget: "ETH",
    path: (t) =>
      `/social/mindshare?interval=7d&q=${encodeURIComponent(t)}`,
  },
];

export function getDataKind(id: string): DataKindDef | undefined {
  return DATA_KINDS.find((k) => k.id === id);
}

function baseUrl() {
  return resolveSurfBaseUrl(process.env.SURF_API_BASE_URL);
}

function apiKey() {
  const k = process.env.SURF_API_KEY;
  if (!k) throw new Error("SURF_API_KEY is not configured");
  return k;
}

/** Table cell — plain value or clickable link */
export type SnapshotCell =
  | string
  | number
  | null
  | { text: string; href?: string };

export type SurfDataSnapshot = {
  kind: DataKindId;
  kindLabel: string;
  target: string;
  fetchedAt: string;
  endpoint: string;
  summary: string;
  rows: Array<Record<string, SnapshotCell>>;
  highlights: Array<{ label: string; value: string }>;
  raw: unknown;
};

export function snapshotCellText(cell: SnapshotCell): string {
  if (cell == null) return "";
  if (typeof cell === "object" && "text" in cell) return cell.text;
  return String(cell);
}

export function snapshotCellHref(cell: SnapshotCell): string | undefined {
  if (cell && typeof cell === "object" && "href" in cell && cell.href) {
    return cell.href;
  }
  return undefined;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(4)}%`;
}

function fmtTs(ts: unknown): string {
  const n = asNum(ts);
  if (n == null) return "—";
  // Surf sometimes uses seconds
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return String(ts);
  }
}

function takeLast<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  return arr.slice(arr.length - n);
}

function summarizeMarketPrice(json: Record<string, unknown>, target: string): Omit<SurfDataSnapshot, "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"> {
  const data = Array.isArray(json.data) ? json.data : [];
  const points = data
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        symbol: String(r.symbol ?? target),
        metric: String(r.metric ?? "price"),
        value: asNum(r.value),
        timestamp: r.timestamp,
      };
    })
    .filter((p) => p.value != null);

  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const delta =
    last?.value != null && prev?.value != null && prev.value !== 0
      ? (last.value - prev.value) / prev.value
      : null;

  const rows = takeLast(points, 12).map((p) => ({
    Time: fmtTs(p.timestamp),
    Symbol: p.symbol,
    Price: fmtUsd(p.value),
  }));

  return {
    summary: last
      ? `${target.toUpperCase()} last price ${fmtUsd(last.value)}${
          delta != null ? ` (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}% vs prior point)` : ""
        }`
      : `No price points for ${target}`,
    rows,
    highlights: [
      { label: "Symbol", value: target.toUpperCase() },
      { label: "Last price", value: fmtUsd(last?.value ?? null) },
      { label: "Points", value: String(points.length) },
      {
        label: "Δ last step",
        value:
          delta == null
            ? "—"
            : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(3)}%`,
      },
    ],
  };
}

function summarizeFearGreed(json: Record<string, unknown>): Omit<SurfDataSnapshot, "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"> {
  const data = Array.isArray(json.data) ? json.data : [];
  const items = data.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      value: asNum(r.value),
      classification: String(r.classification ?? "—"),
      price: asNum(r.price),
      timestamp: r.timestamp,
    };
  });
  const latest = items[0] || items[items.length - 1];
  const rows = items.slice(0, 10).map((p) => ({
    Time: fmtTs(p.timestamp),
    Index: p.value ?? "—",
    Class: p.classification,
    "BTC price": fmtUsd(p.price),
  }));

  return {
    summary: latest
      ? `Fear & Greed ${latest.value ?? "—"} · ${latest.classification}`
      : "No Fear & Greed data",
    rows,
    highlights: [
      { label: "Index", value: latest?.value != null ? String(latest.value) : "—" },
      { label: "Class", value: latest?.classification ?? "—" },
      { label: "BTC ref", value: fmtUsd(latest?.price ?? null) },
      { label: "Samples", value: String(items.length) },
    ],
  };
}

function summarizeNews(json: Record<string, unknown>): Omit<SurfDataSnapshot, "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"> {
  const data = Array.isArray(json.data) ? json.data : [];
  const items = data.map((row) => {
    const r = row as Record<string, unknown>;
    const urlRaw = String(r.url ?? r.link ?? r.article_url ?? "").trim();
    // Only http(s) — validated again on render
    const url = /^https?:\/\//i.test(urlRaw) ? urlRaw.slice(0, 2048) : "";
    return {
      title: String(r.title ?? "—").slice(0, 500),
      source: String(r.source ?? "—").slice(0, 64),
      project: String(r.project_name ?? r.project ?? "—").slice(0, 64),
      url,
      published: r.published_at ?? r.timestamp,
      summary: String(r.summary ?? "").slice(0, 160),
    };
  });

  const rows = items.slice(0, 8).map((n) => ({
    Time: fmtTs(n.published),
    Source: n.source,
    Project: n.project,
    Headline: n.url ? { text: n.title, href: n.url } : n.title,
  }));

  return {
    summary: items.length
      ? `${items.length} headlines · top: ${items[0].title.slice(0, 72)}`
      : "No news items",
    rows,
    highlights: [
      { label: "Articles", value: String(items.length) },
      { label: "Top source", value: items[0]?.source ?? "—" },
      { label: "Top project", value: items[0]?.project ?? "—" },
      {
        label: "Latest",
        value: items[0] ? fmtTs(items[0].published) : "—",
      },
    ],
  };
}

function summarizePerp(json: Record<string, unknown>, target: string): Omit<SurfDataSnapshot, "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"> {
  const data = (json.data ?? json) as Record<string, unknown>;
  const funding = (data.funding ?? {}) as Record<string, unknown>;
  const oi = (data.open_interest ?? {}) as Record<string, unknown>;
  const pair = String(data.pair ?? funding.pair ?? target);
  const exchange = String(data.exchange ?? funding.exchange ?? "—");

  const rate = asNum(funding.funding_rate);
  const annual = asNum(funding.funding_rate_annualized);
  const mark = asNum(funding.mark_price);
  const index = asNum(funding.index_price);
  const oiUsd = asNum(oi.open_interest_usd ?? oi.value ?? oi.open_interest);

  const rows = [
    {
      Field: "Exchange",
      Value: exchange,
    },
    { Field: "Pair", Value: pair },
    { Field: "Funding rate", Value: fmtPct(rate) },
    { Field: "Annualized", Value: fmtPct(annual) },
    { Field: "Mark", Value: fmtUsd(mark) },
    { Field: "Index", Value: fmtUsd(index) },
    {
      Field: "Next funding",
      Value: String(funding.next_funding ?? "—"),
    },
    {
      Field: "Open interest",
      Value: oiUsd != null ? fmtUsd(oiUsd) : String(oi.open_interest ?? "—"),
    },
  ];

  return {
    summary: `${pair} funding ${fmtPct(rate)} on ${exchange}`,
    rows,
    highlights: [
      { label: "Pair", value: pair },
      { label: "Funding", value: fmtPct(rate) },
      { label: "Annualized", value: fmtPct(annual) },
      { label: "Mark", value: fmtUsd(mark) },
    ],
  };
}

function summarizeMindshare(json: Record<string, unknown>, target: string): Omit<SurfDataSnapshot, "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"> {
  const data = Array.isArray(json.data) ? json.data : [];
  const points = data.map((row) => {
    const r = row as Record<string, unknown>;
    return { timestamp: r.timestamp, value: asNum(r.value) };
  });
  const last = points[points.length - 1];
  const first = points[0];
  const delta =
    last?.value != null && first?.value != null && first.value !== 0
      ? (last.value - first.value) / first.value
      : null;

  const rows = takeLast(points, 12).map((p) => ({
    Time: fmtTs(p.timestamp),
    Mindshare: p.value != null ? p.value.toLocaleString() : "—",
  }));

  return {
    summary:
      last?.value != null
        ? `${target} mindshare ${last.value.toLocaleString()}${
            delta != null
              ? ` (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% over window)`
              : ""
          }`
        : `No mindshare points for ${target}`,
    rows,
    highlights: [
      { label: "Query", value: target },
      {
        label: "Latest",
        value: last?.value != null ? last.value.toLocaleString() : "—",
      },
      { label: "Points", value: String(points.length) },
      {
        label: "Window Δ",
        value:
          delta == null
            ? "—"
            : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`,
      },
    ],
  };
}

export async function fetchSurfData(
  kindId: DataKindId,
  target: string
): Promise<SurfDataSnapshot> {
  const kind = getDataKind(kindId);
  if (!kind) throw new Error(`Unknown data kind: ${kindId}`);

  const t =
    sanitizeDataTarget(target || kind.defaultTarget, 48) || kind.defaultTarget;
  const path = kind.path(t);
  const endpoint = `${baseUrl()}${path}`;
  // Defense: never call non-Surf hosts even if path is wrong
  if (!endpoint.startsWith(baseUrl())) {
    throw new Error("Invalid data endpoint");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("Surf Data API timed out");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Surf Data API non-JSON (${res.status}): ${text.slice(0, 200) || res.statusText}`
    );
  }

  if (!res.ok) {
    const err = json.error as { message?: string } | string | undefined;
    const msg =
      (typeof err === "object" && err?.message) ||
      (typeof err === "string" ? err : undefined) ||
      (typeof json.message === "string" ? json.message : undefined) ||
      text.slice(0, 200);
    throw new Error(`Surf Data API ${res.status}: ${msg}`);
  }

  let shaped: Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >;

  switch (kindId) {
    case "market_price":
      shaped = summarizeMarketPrice(json, t);
      break;
    case "fear_greed":
      shaped = summarizeFearGreed(json);
      break;
    case "news_feed":
      shaped = summarizeNews(json);
      break;
    case "perp_funding":
      shaped = summarizePerp(json, t);
      break;
    case "social_mindshare":
      shaped = summarizeMindshare(json, t);
      break;
    default:
      shaped = {
        summary: "Data fetched",
        rows: [],
        highlights: [],
      };
  }

  return {
    kind: kindId,
    kindLabel: kind.label,
    target: t,
    fetchedAt: new Date().toISOString(),
    endpoint: path,
    summary: shaped.summary,
    rows: shaped.rows,
    highlights: shaped.highlights,
    // raw omitted from client-facing payloads by API layer
    raw: undefined,
  };
}

/**
 * Encode kind+target into on-chain watchlist.
 * Single cell `kind|target` so runTick's lastTopic is stable (one stream only).
 */
export function encodeAgentTrack(kind: DataKindId, target: string): string[] {
  const k = getDataKind(kind);
  if (!k) throw new Error("Invalid kind");
  const t = (target || k.defaultTarget).trim() || k.defaultTarget;
  const cell = `${kind}|${t}`;
  if (cell.length > 48) throw new Error("Target too long for on-chain lock");
  return [cell];
}

export function decodeAgentTrack(
  watchlist: string[]
): { kind: DataKindId; target: string } | null {
  if (!watchlist?.length) return null;
  const first = watchlist[0];

  // Preferred: "kind|target"
  if (first.includes("|")) {
    const [k, ...rest] = first.split("|");
    if (getDataKind(k)) {
      return { kind: k as DataKindId, target: rest.join("|") || "_" };
    }
  }

  // Two-cell: [kind, target]
  if (getDataKind(first)) {
    return {
      kind: first as DataKindId,
      target: watchlist[1] || getDataKind(first)!.defaultTarget,
    };
  }

  // Legacy free-form topics → price symbol
  return {
    kind: "market_price",
    target: first,
  };
}
