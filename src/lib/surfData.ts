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
  | "stablecoin_peg"
  | "gas_fees"
  | "whale_transfers"
  | "open_interest_skew"
  | "narrative_sector"
  | "ritual_network";

export type DataKindDef = {
  id: DataKindId;
  label: string;
  short: string;
  description: string;
  /** Query target label shown in UI (null = no target needed) */
  targetLabel: string | null;
  targetPlaceholder: string;
  defaultTarget: string;
  /**
   * Surf path template — use {target} placeholder.
   * Empty string = custom multi-source fetch (not a single Surf GET).
   */
  path: (target: string) => string;
};

export const DATA_KINDS: DataKindDef[] = [
  {
    id: "market_price",
    label: "Token price",
    short: "Price",
    description: "Last ~5 daily/series price points for one symbol (5 rows).",
    targetLabel: "Symbol",
    targetPlaceholder: "BTC",
    defaultTarget: "BTC",
    path: (t) => `/market/price?symbol=${encodeURIComponent(t.toUpperCase())}`,
  },
  {
    id: "fear_greed",
    label: "Fear & Greed",
    short: "F&G",
    description: "Fear & Greed index — last 5 samples (global).",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => `/market/fear-greed`,
  },
  {
    id: "news_feed",
    label: "Crypto news",
    short: "News",
    description: "Latest crypto headlines (8 rows).",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => `/news/feed?limit=8`,
  },
  {
    id: "stablecoin_peg",
    label: "Stablecoin peg stress",
    short: "Peg",
    description: "Peg vs $1 for the stablecoin symbol you lock at deploy (1 row).",
    targetLabel: "Stablecoin symbol",
    targetPlaceholder: "USDT",
    defaultTarget: "USDT",
    path: () => "", // single-symbol peg
  },
  {
    id: "gas_fees",
    label: "Gas / fee pulse",
    short: "Gas",
    description:
      "Gas + latest block for the network you lock at deploy (ETH or Ritual).",
    targetLabel: "Network",
    targetPlaceholder: "ETH or RITUAL",
    defaultTarget: "ETH",
    path: () => "", // RPC for selected network
  },
  {
    id: "whale_transfers",
    label: "Whale / large moves",
    short: "Whales",
    description: "Top 2 large-move / liquidation events for the locked symbol.",
    targetLabel: "Symbol",
    targetPlaceholder: "BTC",
    defaultTarget: "BTC",
    path: (t) =>
      `/market/liquidations?symbol=${encodeURIComponent(t.toUpperCase())}`,
  },
  {
    id: "open_interest_skew",
    label: "OI + long/short skew",
    short: "OI skew",
    description: "One compact row: OI, funding, and long/short for a pair.",
    targetLabel: "Pair",
    targetPlaceholder: "BTC-USDT",
    defaultTarget: "BTC-USDT",
    path: (t) => {
      const pair = t.includes("-") ? t.toUpperCase() : `${t.toUpperCase()}-USDT`;
      return `/exchange/perp?pair=${encodeURIComponent(pair)}`;
    },
  },
  {
    id: "narrative_sector",
    label: "Narrative / sector score",
    short: "Narrative",
    description:
      "3 rows: news + mindshare heat for your sector query.",
    targetLabel: "Sector / query",
    targetPlaceholder: "AI",
    defaultTarget: "AI",
    path: (t) =>
      `/signal/trending?q=${encodeURIComponent(t)}&limit=3`,
  },
  {
    id: "ritual_network",
    label: "Ritual network pulse",
    short: "Ritual",
    description:
      "Ritual testnet pulse: network agent totals (AgentHeartbeat), Persistent count, block & gas — not your Rite deploys.",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => "", // RPC + Radar counts
  },
];

/** Legacy locked watchlist kinds still decode after stream rename. */
const LEGACY_KIND_MAP: Record<string, DataKindId> = {
  perp_funding: "open_interest_skew",
  social_mindshare: "narrative_sector",
};

export function getDataKind(id: string): DataKindDef | undefined {
  const mapped = LEGACY_KIND_MAP[id] || id;
  return DATA_KINDS.find((k) => k.id === mapped);
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
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v)))
    return Number(v);
  return null;
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000)
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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

async function surfGet(path: string): Promise<Record<string, unknown>> {
  const endpoint = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
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
  return json;
}

async function rpcEthCall(
  rpcUrl: string,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error?.message) throw new Error(json.error.message);
  return json.result;
}

function summarizeMarketPrice(
  json: Record<string, unknown>,
  target: string
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
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

  // 5 rows ≈ recent 5-day / last 5 series points
  const rows = takeLast(points, 5).map((p) => ({
    Time: fmtTs(p.timestamp),
    Symbol: p.symbol,
    Price: fmtUsd(p.value),
  }));

  return {
    summary: last
      ? `${target.toUpperCase()} last price ${fmtUsd(last.value)}${
          delta != null
            ? ` (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}% vs prior point)`
            : ""
        } · ${rows.length} pts`
      : `No price points for ${target}`,
    rows,
    highlights: [
      { label: "Symbol", value: target.toUpperCase() },
      { label: "Last price", value: fmtUsd(last?.value ?? null) },
      { label: "Rows", value: String(rows.length) },
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

function summarizeFearGreed(
  json: Record<string, unknown>
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
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
  // 5 rows max
  const rows = items.slice(0, 5).map((p) => ({
    Time: fmtTs(p.timestamp),
    Index: p.value ?? "—",
    Class: p.classification,
    "BTC price": fmtUsd(p.price),
  }));

  return {
    summary: latest
      ? `Fear & Greed ${latest.value ?? "—"} · ${latest.classification} · ${rows.length} samples`
      : "No Fear & Greed data",
    rows,
    highlights: [
      {
        label: "Index",
        value: latest?.value != null ? String(latest.value) : "—",
      },
      { label: "Class", value: latest?.classification ?? "—" },
      { label: "BTC ref", value: fmtUsd(latest?.price ?? null) },
      { label: "Rows", value: String(rows.length) },
    ],
  };
}

function summarizeNews(
  json: Record<string, unknown>
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
  const data = Array.isArray(json.data) ? json.data : [];
  const items = data.map((row) => {
    const r = row as Record<string, unknown>;
    const urlRaw = String(r.url ?? r.link ?? r.article_url ?? "").trim();
    const url = /^https?:\/\//i.test(urlRaw) ? urlRaw.slice(0, 2048) : "";
    return {
      title: String(r.title ?? "—").slice(0, 500),
      source: String(r.source ?? "—").slice(0, 64),
      project: String(r.project_name ?? r.project ?? "—").slice(0, 64),
      url,
      published: r.published_at ?? r.timestamp,
    };
  });

  // Exactly up to 8 news rows
  const rows = items.slice(0, 8).map((n) => ({
    Time: fmtTs(n.published),
    Source: n.source,
    Project: n.project,
    Headline: n.url ? { text: n.title, href: n.url } : n.title,
  }));

  return {
    summary: rows.length
      ? `${rows.length} headlines · top: ${items[0].title.slice(0, 72)}`
      : "No news items",
    rows,
    highlights: [
      { label: "Articles", value: String(rows.length) },
      { label: "Top source", value: items[0]?.source ?? "—" },
      { label: "Top project", value: items[0]?.project ?? "—" },
      {
        label: "Latest",
        value: items[0] ? fmtTs(items[0].published) : "—",
      },
    ],
  };
}

function lastPriceFromMarketJson(json: Record<string, unknown>): number | null {
  const data = Array.isArray(json.data) ? json.data : [];
  for (let i = data.length - 1; i >= 0; i--) {
    const v = asNum((data[i] as Record<string, unknown>).value);
    if (v != null) return v;
  }
  // alternate shapes
  const d = json.data as Record<string, unknown> | undefined;
  if (d && !Array.isArray(d)) {
    return asNum(d.price ?? d.last ?? d.value);
  }
  return asNum(json.price ?? json.value);
}

async function fetchStablecoinPeg(
  symbolRaw: string
): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  // Only the symbol locked at deploy (default USDT)
  const sym =
    symbolRaw && symbolRaw !== "_"
      ? symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "USDT"
      : "USDT";

  let px: number | null = null;
  let err: string | null = null;
  try {
    const json = await surfGet(
      `/market/price?symbol=${encodeURIComponent(sym)}`
    );
    px = lastPriceFromMarketJson(json);
  } catch {
    err = "fetch failed";
  }

  const peg = 1;
  const dev = px != null ? (px - peg) / peg : null;
  const absBps = dev != null ? Math.abs(dev) * 10_000 : null;
  const alert = absBps != null && absBps >= 20;

  const rows: Array<Record<string, SnapshotCell>> = [
    {
      Stable: sym,
      Price: err ? "—" : fmtUsd(px),
      "vs $1":
        err || dev == null
          ? err || "—"
          : `${dev >= 0 ? "+" : ""}${(dev * 100).toFixed(4)}%`,
      Stress:
        err || absBps == null ? err || "—" : `${absBps.toFixed(1)} bps`,
    },
  ];

  return {
    summary: err
      ? `${sym} peg check failed`
      : `${sym} peg · ${fmtUsd(px)} · ${
          absBps != null ? `${absBps.toFixed(1)} bps off $1` : "n/a"
        }${alert ? " · ALERT" : ""}`,
    rows,
    highlights: [
      { label: "Symbol", value: sym },
      { label: "Price", value: fmtUsd(px) },
      {
        label: "Stress",
        value: absBps != null ? `${absBps.toFixed(1)} bps` : "—",
      },
      { label: "Alert", value: alert ? "YES" : "no" },
    ],
  };
}

/** Map deploy target → which chain gas to read */
function resolveGasNetwork(
  target: string
): { id: "eth" | "ritual"; label: string; rpc: string } {
  const t = (target || "ETH").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ritualRpc =
    process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";
  const ethRpc =
    process.env.ETH_RPC_URL || "https://ethereum.publicnode.com";

  if (
    t === "RITUAL" ||
    t === "RIT" ||
    t === "RITE" ||
    t === "1979" ||
    t.startsWith("RIT")
  ) {
    return { id: "ritual", label: "Ritual", rpc: ritualRpc };
  }
  // Default + ETH / ETHEREUM / MAINNET
  return { id: "eth", label: "Ethereum L1", rpc: ethRpc };
}

async function fetchGasFees(
  target: string
): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const net = resolveGasNetwork(target);
  let gwei: number | null = null;
  let block = "—";

  try {
    const [gas, blk] = await Promise.all([
      rpcEthCall(net.rpc, "eth_gasPrice") as Promise<string>,
      rpcEthCall(net.rpc, "eth_blockNumber") as Promise<string>,
    ]);
    gwei = Number(BigInt(gas)) / 1e9;
    block = String(Number(BigInt(blk)));
  } catch {
    /* leave empty */
  }

  const digits = net.id === "ritual" ? 6 : 3;
  const rows = [
    {
      Network: net.label,
      "Gas (gwei)": gwei != null ? gwei.toFixed(digits) : "—",
      Block: block,
    },
  ];

  const congested = net.id === "eth" && gwei != null && gwei >= 40;
  return {
    summary:
      gwei != null
        ? `${net.label} gas ${gwei.toFixed(digits)} gwei · block ${block}${
            congested ? " · congested" : ""
          }`
        : `${net.label} gas unavailable`,
    rows,
    highlights: [
      { label: "Network", value: net.label },
      {
        label: "Gas",
        value: gwei != null ? `${gwei.toFixed(digits)} gwei` : "—",
      },
      { label: "Block", value: block },
      {
        label: "Busy",
        value: congested ? "YES" : net.id === "eth" ? "no" : "n/a",
      },
    ],
  };
}

function summarizeWhale(
  json: Record<string, unknown>,
  target: string
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
  const data = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.liquidations)
      ? json.liquidations
      : Array.isArray(json.transfers)
        ? json.transfers
        : [];

  // 2 rows max for locked symbol
  const items = data.slice(0, 2).map((row) => {
    const r = row as Record<string, unknown>;
    const amt = asNum(
      r.amount_usd ?? r.usd_value ?? r.value_usd ?? r.notional ?? r.value
    );
    const side = String(r.side ?? r.direction ?? r.type ?? "—").slice(0, 24);
    const exch = String(r.exchange ?? r.venue ?? r.symbol ?? target).slice(
      0,
      32
    );
    return {
      Time: fmtTs(r.timestamp ?? r.time ?? r.created_at),
      Venue: exch,
      Side: side,
      "USD size": amt != null ? fmtUsd(amt) : String(r.amount ?? "—"),
    };
  });

  const total = items.reduce((acc: number, row) => {
    const raw = String(row["USD size"] ?? "").replace(/[^0-9.-]/g, "");
    const n = Number(raw);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);

  return {
    summary: items.length
      ? `${target.toUpperCase()} whales · ${items.length} event(s)`
      : `No large-move rows for ${target.toUpperCase()}`,
    rows: items,
    highlights: [
      { label: "Symbol", value: target.toUpperCase() },
      { label: "Rows", value: String(items.length) },
      { label: "Notional", value: total > 0 ? fmtUsd(total) : "—" },
      { label: "Source", value: "Surf market" },
    ],
  };
}

function summarizeOiSkew(
  json: Record<string, unknown>,
  target: string
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
  const data = (json.data ?? json) as Record<string, unknown>;
  const funding = (data.funding ?? {}) as Record<string, unknown>;
  const oi = (data.open_interest ?? data) as Record<string, unknown>;
  const ls = (data.long_short ?? data.longShort ?? data) as Record<
    string,
    unknown
  >;

  const pair = String(data.pair ?? funding.pair ?? target);
  const exchange = String(data.exchange ?? funding.exchange ?? "—");
  const rate = asNum(funding.funding_rate ?? data.funding_rate);
  const annual = asNum(
    funding.funding_rate_annualized ?? data.funding_rate_annualized
  );
  const mark = asNum(funding.mark_price ?? data.mark_price);
  const oiUsd = asNum(
    oi.open_interest_usd ?? oi.value ?? oi.open_interest ?? data.open_interest
  );
  const longRatio = asNum(
    ls.long_ratio ?? ls.longAccount ?? data.long_ratio ?? data.long_account
  );
  const shortRatio = asNum(
    ls.short_ratio ?? ls.shortAccount ?? data.short_ratio ?? data.short_account
  );
  const longShort = asNum(
    ls.long_short_ratio ?? data.long_short_ratio ?? data.longShortRatio
  );

  const skew =
    longShort != null
      ? longShort > 1.2
        ? "long-crowded"
        : longShort < 0.85
          ? "short-crowded"
          : "balanced"
      : rate != null && Math.abs(rate) > 0.0003
        ? rate > 0
          ? "positive funding"
          : "negative funding"
        : "neutral";

  // Single compact row (not multi field/value)
  const rows = [
    {
      Exchange: exchange,
      Pair: pair,
      OI: oiUsd != null ? fmtUsd(oiUsd) : "—",
      Funding: fmtPct(rate),
      "Ann. fund": fmtPct(annual),
      Mark: fmtUsd(mark),
      Long:
        longRatio != null ? `${(longRatio * 100).toFixed(1)}%` : "—",
      Short:
        shortRatio != null ? `${(shortRatio * 100).toFixed(1)}%` : "—",
      "L/S": longShort != null ? longShort.toFixed(3) : "—",
      Skew: skew,
    },
  ];

  return {
    summary: `${pair} OI ${fmtUsd(oiUsd)} · funding ${fmtPct(rate)} · ${skew}`,
    rows,
    highlights: [
      { label: "Pair", value: pair },
      { label: "OI", value: fmtUsd(oiUsd) },
      { label: "Funding", value: fmtPct(rate) },
      { label: "Skew", value: skew },
    ],
  };
}

/** Build up to 3 rows: news headlines + mindshare for the deploy query */
async function fetchNarrativeBundle(
  query: string
): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const q = query && query !== "_" ? query : "AI";
  const rows: Array<Record<string, SnapshotCell>> = [];

  // News related to query (prefer 2 headlines)
  try {
    let newsJson: Record<string, unknown>;
    try {
      newsJson = await surfGet(
        `/news/feed?limit=3&q=${encodeURIComponent(q)}`
      );
    } catch {
      newsJson = await surfGet(`/news/feed?limit=3`);
    }
    const data = Array.isArray(newsJson.data) ? newsJson.data : [];
    for (const row of data) {
      if (rows.length >= 2) break;
      const r = row as Record<string, unknown>;
      const title = String(r.title ?? "—").slice(0, 200);
      const urlRaw = String(r.url ?? r.link ?? "").trim();
      const url = /^https?:\/\//i.test(urlRaw) ? urlRaw.slice(0, 2048) : "";
      rows.push({
        Type: "news",
        Name: url ? { text: title, href: url } : title,
        Score: "—",
        "24h Δ": String(r.source ?? "—").slice(0, 24),
      });
    }
  } catch {
    /* optional news */
  }

  // Mindshare / trending fill remaining slots up to 3
  try {
    let heat: Record<string, unknown> | null = null;
    try {
      heat = await surfGet(
        `/signal/trending?q=${encodeURIComponent(q)}&limit=3`
      );
    } catch {
      try {
        heat = await surfGet(
          `/social/mindshare?interval=7d&q=${encodeURIComponent(q)}`
        );
      } catch {
        heat = null;
      }
    }
    if (heat) {
      const data = Array.isArray(heat.data)
        ? heat.data
        : Array.isArray(heat.projects)
          ? heat.projects
          : [];
      for (const row of data) {
        if (rows.length >= 3) break;
        const r = row as Record<string, unknown>;
        const name = String(
          r.name ?? r.project ?? r.symbol ?? r.token ?? "Mindshare"
        ).slice(0, 48);
        const score = asNum(
          r.score ?? r.heat ?? r.value ?? r.mindshare ?? r.rank
        );
        rows.push({
          Type: "mindshare",
          Name: name,
          Score: score != null ? score.toLocaleString() : "—",
          "24h Δ": "—",
        });
      }
    }
  } catch {
    /* optional */
  }

  // Pad not required — return whatever we have ≤ 3
  const top =
    typeof rows[0]?.Name === "object" &&
    rows[0]?.Name &&
    "text" in (rows[0].Name as object)
      ? String((rows[0].Name as { text: string }).text)
      : String(rows[0]?.Name ?? q);

  return {
    summary: rows.length
      ? `Narrative “${q}” · ${rows.length}/3 rows (news + mindshare)`
      : `No narrative data for “${q}”`,
    rows: rows.slice(0, 3),
    highlights: [
      { label: "Query", value: q },
      { label: "Rows", value: String(Math.min(3, rows.length)) },
      { label: "Top", value: top.slice(0, 32) },
      { label: "Mix", value: "news+mindshare" },
    ],
  };
}

/**
 * Ritual system AgentHeartbeat — network-wide persistent agent registry
 * (not the Rite app RadarAgent). See docs: 0xEF50…3aCa
 */
const RITUAL_AGENT_HEARTBEAT =
  "0xEF505E801f1Db392B5289690E2ffc20e840A3aCa";

async function fetchRitualNetwork(): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const ritualRpc =
    process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";

  let block = "—";
  let gasGwei: number | null = null;
  let chainId = "—";
  /** Network-wide totals from Ritual AgentHeartbeat (testnet registry) */
  let networkTotal = 0;
  let networkPersistent = 0;
  let networkSovereign = 0;
  let networkCountsOk = false;

  try {
    const [b, g, c] = await Promise.all([
      rpcEthCall(ritualRpc, "eth_blockNumber") as Promise<string>,
      rpcEthCall(ritualRpc, "eth_gasPrice") as Promise<string>,
      rpcEthCall(ritualRpc, "eth_chainId") as Promise<string>,
    ]);
    block = String(Number(BigInt(b)));
    gasGwei = Number(BigInt(g)) / 1e9;
    chainId = String(Number(BigInt(c)));
  } catch {
    /* ignore */
  }

  // Ritual testnet agent registry (AgentHeartbeat.agentCount) — NOT Rite Radar
  try {
    const { createPublicClient, http, defineChain, parseAbi } = await import(
      "viem"
    );
    const chain = defineChain({
      id: Number(process.env.NEXT_PUBLIC_CHAIN_ID || 1979),
      name: "ritual",
      nativeCurrency: { name: "RIT", symbol: "RIT", decimals: 18 },
      rpcUrls: { default: { http: [ritualRpc] } },
    });
    const client = createPublicClient({
      chain,
      transport: http(ritualRpc, { timeout: 20_000 }),
    });

    // agentCount() — total agents registered for network heartbeat / lifecycle
    const count = (await client.readContract({
      address: RITUAL_AGENT_HEARTBEAT as `0x${string}`,
      abi: parseAbi(["function agentCount() view returns (uint256)"]),
      functionName: "agentCount",
    })) as bigint;
    networkTotal = Number(count);
    networkCountsOk = true;

    // Heartbeat registry tracks Persistent-style network agents.
    // Prefer explicit counters if the contract exposes them later.
    for (const [fn, assign] of [
      ["persistentCount", (n: number) => (networkPersistent = n)],
      ["persistentAgentCount", (n: number) => (networkPersistent = n)],
      ["sovereignCount", (n: number) => (networkSovereign = n)],
      ["sovereignAgentCount", (n: number) => (networkSovereign = n)],
    ] as const) {
      try {
        const n = (await client.readContract({
          address: RITUAL_AGENT_HEARTBEAT as `0x${string}`,
          abi: parseAbi([`function ${fn}() view returns (uint256)`]),
          functionName: fn,
        })) as bigint;
        assign(Number(n));
      } catch {
        /* optional */
      }
    }

    // Default: AgentHeartbeat is the Persistent agent registry on Ritual
    if (networkPersistent === 0 && networkTotal > 0) {
      networkPersistent = networkTotal;
    }
    // Sovereign network agents are separate (0x080C / explorer); leave 0 if unknown
  } catch {
    networkCountsOk = false;
  }

  const rows = [
    { Field: "Latest block", Value: block },
    {
      Field: "Network gas",
      Value: gasGwei != null ? `${gasGwei.toFixed(6)} gwei` : "—",
    },
    {
      Field: "Total agents (testnet)",
      Value: networkCountsOk ? String(networkTotal) : "—",
    },
    {
      Field: "Persistent agents (testnet)",
      Value: networkCountsOk ? String(networkPersistent) : "—",
    },
    {
      Field: "Sovereign agents (testnet)",
      Value: networkCountsOk
        ? networkSovereign > 0
          ? String(networkSovereign)
          : "n/a*"
        : "—",
    },
    { Field: "Chain id", Value: chainId },
    {
      Field: "Source",
      Value: "AgentHeartbeat 0xEF50…3aCa",
    },
  ];

  const sovNote =
    networkSovereign > 0
      ? `${networkSovereign} Sovereign`
      : "Sovereign n/a (not in heartbeat registry)";

  return {
    summary: networkCountsOk
      ? `Ritual testnet · block ${block} · gas ${
          gasGwei != null ? gasGwei.toFixed(4) : "—"
        } gwei · ${networkTotal} network agents (${networkPersistent} Persistent · ${sovNote})`
      : `Ritual · block ${block} · gas ${
          gasGwei != null ? gasGwei.toFixed(4) : "—"
        } gwei · agent registry unavailable`,
    rows,
    highlights: [
      { label: "Block", value: block },
      {
        label: "Gas",
        value: gasGwei != null ? `${gasGwei.toFixed(4)} gwei` : "—",
      },
      {
        label: "Total",
        value: networkCountsOk ? String(networkTotal) : "—",
      },
      {
        label: "Persistent",
        value: networkCountsOk ? String(networkPersistent) : "—",
      },
    ],
  };
}

export async function fetchSurfData(
  kindId: DataKindId,
  target: string
): Promise<SurfDataSnapshot> {
  // Map legacy kinds from old agents
  const resolvedId = (LEGACY_KIND_MAP[kindId] || kindId) as DataKindId;
  const kind = getDataKind(resolvedId);
  if (!kind) throw new Error(`Unknown data kind: ${kindId}`);

  const t =
    sanitizeDataTarget(target || kind.defaultTarget, 48) || kind.defaultTarget;

  let shaped: Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >;
  let endpoint = kind.path(t) || `custom:${resolvedId}`;

  switch (resolvedId) {
    case "market_price": {
      const json = await surfGet(kind.path(t));
      shaped = summarizeMarketPrice(json, t);
      break;
    }
    case "fear_greed": {
      const json = await surfGet(kind.path(t));
      shaped = summarizeFearGreed(json);
      break;
    }
    case "news_feed": {
      const json = await surfGet(kind.path(t));
      shaped = summarizeNews(json);
      break;
    }
    case "stablecoin_peg": {
      shaped = await fetchStablecoinPeg(t);
      endpoint = `single:/market/price?symbol=${encodeURIComponent(
        t === "_" ? "USDT" : t.toUpperCase()
      )}`;
      break;
    }
    case "gas_fees": {
      shaped = await fetchGasFees(t);
      endpoint = `rpc:${resolveGasNetwork(t).id}:gas+block`;
      break;
    }
    case "whale_transfers": {
      try {
        const json = await surfGet(
          `/market/liquidations?symbol=${encodeURIComponent(t.toUpperCase())}&limit=2`
        );
        shaped = summarizeWhale(json, t);
        endpoint = "/market/liquidations?limit=2";
      } catch (e1) {
        try {
          const json = await surfGet(kind.path(t));
          shaped = summarizeWhale(json, t);
        } catch {
          try {
            const json = await surfGet(
              `/exchange/perp?pair=${encodeURIComponent(
                t.includes("-") ? t.toUpperCase() : `${t.toUpperCase()}-USDT`
              )}`
            );
            // Still max 1–2 rows for whale fallback
            const oi = summarizeOiSkew(json, t);
            shaped = {
              summary: `Whale fallback → ${oi.summary}`,
              rows: oi.rows.slice(0, 2),
              highlights: oi.highlights,
            };
            endpoint = "/exchange/perp (fallback)";
          } catch {
            throw e1;
          }
        }
      }
      break;
    }
    case "open_interest_skew": {
      const pair = t.includes("-")
        ? t.toUpperCase()
        : `${t.toUpperCase()}-USDT`;
      try {
        const json = await surfGet(
          `/exchange/perp?pair=${encodeURIComponent(pair)}`
        );
        shaped = summarizeOiSkew(json, pair);
      } catch {
        const json = await surfGet(
          `/exchange/funding?pair=${encodeURIComponent(pair)}`
        );
        shaped = summarizeOiSkew(json, pair);
        endpoint = "/exchange/funding";
      }
      // Enrich long/short into the single row (do not add extra rows)
      try {
        const ls = await surfGet(
          `/exchange/long-short-ratio?pair=${encodeURIComponent(pair)}`
        );
        const data = (ls.data ?? ls) as Record<string, unknown>;
        const longR = asNum(data.long_ratio ?? data.longAccount);
        const shortR = asNum(data.short_ratio ?? data.shortAccount);
        if (shaped.rows[0] && (longR != null || shortR != null)) {
          shaped.rows = [
            {
              ...shaped.rows[0],
              Long:
                longR != null
                  ? `${(longR * 100).toFixed(1)}%`
                  : String(shaped.rows[0].Long ?? "—"),
              Short:
                shortR != null
                  ? `${(shortR * 100).toFixed(1)}%`
                  : String(shaped.rows[0].Short ?? "—"),
            },
          ];
        }
      } catch {
        /* optional */
      }
      // Enforce 1 row
      shaped.rows = shaped.rows.slice(0, 1);
      break;
    }
    case "narrative_sector": {
      shaped = await fetchNarrativeBundle(t);
      endpoint = "news+mindshare (3 rows)";
      break;
    }
    case "ritual_network": {
      shaped = await fetchRitualNetwork();
      endpoint = "ritual-rpc+radar";
      break;
    }
    default:
      shaped = { summary: "Data fetched", rows: [], highlights: [] };
  }

  return {
    kind: resolvedId,
    kindLabel: kind.label,
    target: t,
    fetchedAt: new Date().toISOString(),
    endpoint,
    summary: shaped.summary,
    rows: shaped.rows,
    highlights: shaped.highlights,
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
  // On-chain Radar setWatchlist max is 48 bytes per cell
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
    const mapped = (LEGACY_KIND_MAP[k] || k) as DataKindId;
    if (getDataKind(mapped)) {
      return { kind: mapped, target: rest.join("|") || "_" };
    }
  }

  // Two-cell: [kind, target]
  const mappedFirst = (LEGACY_KIND_MAP[first] || first) as DataKindId;
  if (getDataKind(mappedFirst)) {
    return {
      kind: mappedFirst,
      target: watchlist[1] || getDataKind(mappedFirst)!.defaultTarget,
    };
  }

  // Legacy free-form topics → price symbol
  return {
    kind: "market_price",
    target: first,
  };
}
