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
  | "ritual_network"
  /** @deprecated removed from deploy UI — still decoded for old watchlists */
  | "open_interest_skew"
  /** @deprecated removed from deploy UI — still decoded for old watchlists */
  | "narrative_sector";

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

/**
 * Streams offered at deploy. Keep this list short and reliable.
 * Deprecated kinds stay in the type + fetch switch for old agents only.
 */
export const DATA_KINDS: DataKindDef[] = [
  {
    id: "market_price",
    label: "Token price",
    short: "Price",
    description: "Last ~5 series price points for one symbol (Surf market).",
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
    description: "Latest crypto headlines (up to 8 rows).",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => `/news/feed?limit=8`,
  },
  {
    id: "stablecoin_peg",
    label: "Stablecoin peg stress",
    short: "Peg",
    description:
      "Peg vs $1 for the stablecoin you lock (USDT, USDC, DAI, …). Multi-source price.",
    targetLabel: "Stablecoin symbol",
    targetPlaceholder: "USDT",
    defaultTarget: "USDT",
    path: () => "",
  },
  {
    id: "gas_fees",
    label: "Gas / fee pulse",
    short: "Gas",
    description:
      "Gas + latest block for the network locked at deploy (ETH, POL/Polygon, Ritual, Base, Arb, …).",
    targetLabel: "Network",
    targetPlaceholder: "ETH · POL · RITUAL · BASE · ARB",
    defaultTarget: "ETH",
    path: () => "",
  },
  {
    id: "whale_transfers",
    label: "Whale / large moves",
    short: "Whales",
    description:
      "Perp market stress for the locked symbol (OI, funding, L/S) when liquidations are unavailable.",
    targetLabel: "Symbol",
    targetPlaceholder: "BTC",
    defaultTarget: "BTC",
    path: (t) => {
      const pair = t.includes("-") ? t.toUpperCase() : `${t.toUpperCase()}-USDT`;
      return `/exchange/perp?pair=${encodeURIComponent(pair)}`;
    },
  },
  {
    id: "ritual_network",
    label: "Ritual network pulse",
    short: "Ritual",
    description:
      "Ritual testnet: block, gas, heartbeat-registered TEE agents (alive/total). Not your Rite Radar deploys.",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => "",
  },
];

/** Legacy locked watchlist kinds still decode after stream rename/removal. */
const LEGACY_KIND_MAP: Record<string, DataKindId> = {
  perp_funding: "whale_transfers",
  social_mindshare: "news_feed",
  open_interest_skew: "whale_transfers",
  narrative_sector: "news_feed",
};

/** Full defs for deprecated kinds (old agents still ticking). Not shown at deploy. */
const DEPRECATED_DATA_KINDS: DataKindDef[] = [
  {
    id: "open_interest_skew",
    label: "OI + long/short skew (legacy)",
    short: "OI skew",
    description: "Legacy stream — maps to perp market stress.",
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
    label: "Narrative / sector (legacy)",
    short: "Narrative",
    description: "Legacy stream — falls back to news.",
    targetLabel: "Query",
    targetPlaceholder: "AI",
    defaultTarget: "AI",
    path: () => `/news/feed?limit=8`,
  },
];

export function getDataKind(id: string): DataKindDef | undefined {
  const mapped = (LEGACY_KIND_MAP[id] || id) as DataKindId;
  return (
    DATA_KINDS.find((k) => k.id === mapped) ||
    DEPRECATED_DATA_KINDS.find((k) => k.id === mapped) ||
    DEPRECATED_DATA_KINDS.find((k) => k.id === id) ||
    DATA_KINDS.find((k) => k.id === id)
  );
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
    .filter(
      (p) =>
        p.value != null &&
        p.value > 0 &&
        !(asNum(p.timestamp) === 0 && p.value < 1e-9)
    );

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

/** Prefer real market points — Surf often returns {value:0,timestamp:0} stubs (e.g. USDC). */
function lastPriceFromMarketJson(json: Record<string, unknown>): number | null {
  const data = Array.isArray(json.data) ? json.data : [];
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i] as Record<string, unknown>;
    const v = asNum(r.value ?? r.price);
    const ts = asNum(r.timestamp);
    // Reject zero stubs / empty timestamps that look like bad placeholders
    if (v != null && v > 0 && Number.isFinite(v)) {
      if (ts != null && ts === 0 && v < 1e-6) continue;
      return v;
    }
  }
  const d = json.data as Record<string, unknown> | undefined;
  if (d && !Array.isArray(d)) {
    const v = asNum(d.price ?? d.last ?? d.value);
    if (v != null && v > 0) return v;
  }
  const top = asNum(json.price ?? json.value);
  return top != null && top > 0 ? top : null;
}

/** Public spot fallbacks when Surf returns 0 / wrong assets for stables. */
async function fetchPublicSpotUsd(symbol: string): Promise<{
  price: number | null;
  source: string;
}> {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sym) return { price: null, source: "none" };

  // Binance USDT pairs (USDCUSDT ≈ peg)
  const binanceMap: Record<string, string> = {
    USDT: "USDTUSD", // may 404 — try USDCUSDT inverse later
    USDC: "USDCUSDT",
    FDUSD: "FDUSDUSDT",
    TUSD: "TUSDUSDT",
    USDP: "USDPUSDT",
    BUSD: "BUSDUSDT",
    DAI: "DAIUSDT",
  };
  const pair = binanceMap[sym] || `${sym}USDT`;
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) }
    );
    if (r.ok) {
      const j = (await r.json()) as { price?: string };
      const px = asNum(j.price);
      if (px != null && px > 0) return { price: px, source: `binance:${pair}` };
    }
  } catch {
    /* next */
  }

  // CoinGecko simple (no key)
  const cgIds: Record<string, string> = {
    USDT: "tether",
    USDC: "usd-coin",
    DAI: "dai",
    FDUSD: "first-digital-usd",
    TUSD: "true-usd",
    USDP: "paxos-standard",
    FRAX: "frax",
    PYUSD: "paypal-usd",
  };
  const id = cgIds[sym];
  if (id) {
    try {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
        { cache: "no-store", signal: AbortSignal.timeout(10_000) }
      );
      if (r.ok) {
        const j = (await r.json()) as Record<string, { usd?: number }>;
        const px = asNum(j[id]?.usd);
        if (px != null && px > 0) return { price: px, source: `coingecko:${id}` };
      }
    } catch {
      /* next */
    }
  }

  // DefiLlama coins
  const llama: Record<string, string> = {
    USDT: "coingecko:tether",
    USDC: "coingecko:usd-coin",
    DAI: "coingecko:dai",
    FDUSD: "coingecko:first-digital-usd",
  };
  const coin = llama[sym];
  if (coin) {
    try {
      const r = await fetch(
        `https://coins.llama.fi/prices/current/${encodeURIComponent(coin)}`,
        { cache: "no-store", signal: AbortSignal.timeout(10_000) }
      );
      if (r.ok) {
        const j = (await r.json()) as {
          coins?: Record<string, { price?: number }>;
        };
        const px = asNum(j.coins?.[coin]?.price);
        if (px != null && px > 0) return { price: px, source: `llama:${coin}` };
      }
    } catch {
      /* none */
    }
  }

  return { price: null, source: "none" };
}

/** True if price is a plausible stablecoin peg quote. */
function isPlausibleStablePrice(px: number | null): boolean {
  return px != null && Number.isFinite(px) && px > 0.5 && px < 1.5;
}

async function fetchStablecoinPeg(
  symbolRaw: string
): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const sym =
    symbolRaw && symbolRaw !== "_"
      ? symbolRaw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "USDT"
      : "USDT";

  let px: number | null = null;
  let source = "surf";
  let err: string | null = null;

  // 1) Surf market price (works for USDT; often returns 0 stub for USDC)
  try {
    const json = await surfGet(
      `/market/price?symbol=${encodeURIComponent(sym)}`
    );
    const surfPx = lastPriceFromMarketJson(json);
    if (isPlausibleStablePrice(surfPx)) {
      px = surfPx;
      source = "surf";
    }
  } catch {
    /* try public feeds */
  }

  // 2) Public CEX / CoinGecko / Llama when Surf is wrong or empty
  if (!isPlausibleStablePrice(px)) {
    const pub = await fetchPublicSpotUsd(sym);
    if (isPlausibleStablePrice(pub.price)) {
      px = pub.price;
      source = pub.source;
    } else if (px == null) {
      err = "no price";
    } else {
      // keep non-plausible only if nothing else — but flag error
      err = "unreliable surf price";
      px = null;
    }
  }

  const peg = 1;
  const dev = px != null ? (px - peg) / peg : null;
  const absBps = dev != null ? Math.abs(dev) * 10_000 : null;
  const alert = absBps != null && absBps >= 20;

  const rows: Array<Record<string, SnapshotCell>> = [
    {
      Stable: sym,
      Price: err && px == null ? "—" : fmtUsd(px),
      "vs $1":
        px == null || dev == null
          ? err || "—"
          : `${dev >= 0 ? "+" : ""}${(dev * 100).toFixed(4)}%`,
      Stress: absBps == null ? err || "—" : `${absBps.toFixed(1)} bps`,
      Source: source,
    },
  ];

  return {
    summary:
      px == null
        ? `${sym} peg check failed (${err || "no price"})`
        : `${sym} peg · ${fmtUsd(px)} · ${
            absBps != null ? `${absBps.toFixed(1)} bps off $1` : "n/a"
          }${alert ? " · ALERT" : ""} · via ${source}`,
    rows,
    highlights: [
      { label: "Symbol", value: sym },
      { label: "Price", value: fmtUsd(px) },
      {
        label: "Stress",
        value: absBps != null ? `${absBps.toFixed(1)} bps` : "—",
      },
      { label: "Source", value: source },
    ],
  };
}

type GasNetId =
  | "eth"
  | "polygon"
  | "ritual"
  | "base"
  | "arb"
  | "op"
  | "bsc"
  | "avax";

/** Map deploy target → which chain gas to read */
function resolveGasNetwork(
  target: string
): { id: GasNetId; label: string; rpc: string; busyGwei: number } {
  const t = (target || "ETH").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ritualRpc =
    process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";
  const ethRpc =
    process.env.ETH_RPC_URL || "https://ethereum.publicnode.com";
  const polyRpc =
    process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
  const baseRpc =
    process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
  const arbRpc =
    process.env.ARB_RPC_URL || "https://arbitrum-one-rpc.publicnode.com";
  const opRpc =
    process.env.OP_RPC_URL || "https://optimism-rpc.publicnode.com";
  const bscRpc =
    process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com";
  const avaxRpc =
    process.env.AVAX_RPC_URL || "https://avalanche-c-chain-rpc.publicnode.com";

  // Ritual testnet
  if (
    t === "RITUAL" ||
    t === "RIT" ||
    t === "RITE" ||
    t === "1979" ||
    t.startsWith("RIT")
  ) {
    return { id: "ritual", label: "Ritual testnet", rpc: ritualRpc, busyGwei: 50 };
  }
  // Polygon / POL (user locked POL on gas stream — must NOT use Ethereum L1)
  if (
    t === "POL" ||
    t === "MATIC" ||
    t === "POLYGON" ||
    t === "POLY" ||
    t === "137"
  ) {
    return { id: "polygon", label: "Polygon", rpc: polyRpc, busyGwei: 200 };
  }
  if (t === "BASE" || t === "8453") {
    return { id: "base", label: "Base", rpc: baseRpc, busyGwei: 0.1 };
  }
  if (t === "ARB" || t === "ARBITRUM" || t === "42161") {
    return { id: "arb", label: "Arbitrum One", rpc: arbRpc, busyGwei: 0.5 };
  }
  if (t === "OP" || t === "OPTIMISM" || t === "10") {
    return { id: "op", label: "Optimism", rpc: opRpc, busyGwei: 0.1 };
  }
  if (t === "BSC" || t === "BNB" || t === "56") {
    return { id: "bsc", label: "BNB Chain", rpc: bscRpc, busyGwei: 3 };
  }
  if (t === "AVAX" || t === "AVALANCHE" || t === "43114") {
    return { id: "avax", label: "Avalanche C-Chain", rpc: avaxRpc, busyGwei: 30 };
  }
  // ETH default
  return { id: "eth", label: "Ethereum L1", rpc: ethRpc, busyGwei: 40 };
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

  const digits =
    net.id === "ritual" || net.id === "base" || net.id === "op" || net.id === "arb"
      ? 4
      : net.id === "polygon"
        ? 2
        : 3;
  const rows = [
    {
      Network: net.label,
      "Gas (gwei)": gwei != null ? gwei.toFixed(digits) : "—",
      Block: block,
      Target: (target || "ETH").toUpperCase(),
    },
  ];

  const congested = gwei != null && gwei >= net.busyGwei;
  return {
    summary:
      gwei != null
        ? `${net.label} gas ${gwei.toFixed(digits)} gwei · block ${block}${
            congested ? " · busy" : ""
          }`
        : `${net.label} gas unavailable (RPC)`,
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
        value: gwei == null ? "—" : congested ? "YES" : "no",
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

/**
 * Ritual system AgentHeartbeat — TEE Persistent agent registry
 * (not Rite Radar; not Sovereign 0x080C jobs). Docs: 0xEF50…3aCa
 *
 * On-chain: agentCount(), agentList(i), isAlive(addr).
 * Explorer may list Sovereign sessions separately — they do NOT register here.
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
  let networkTotal = 0;
  let networkAlive = 0;
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
      transport: http(ritualRpc, { timeout: 25_000 }),
    });
    const hb = RITUAL_AGENT_HEARTBEAT as `0x${string}`;

    const count = (await client.readContract({
      address: hb,
      abi: parseAbi(["function agentCount() view returns (uint256)"]),
      functionName: "agentCount",
    })) as bigint;
    networkTotal = Number(count);
    networkCountsOk = true;

    // Count alive via isAlive(agentList(i)) — heartbeat registry = Persistent TEE agents
    const n = Math.min(networkTotal, 80); // safety cap
    let alive = 0;
    const batch = 8;
    for (let i = 0; i < n; i += batch) {
      const slice = Array.from(
        { length: Math.min(batch, n - i) },
        (_, k) => i + k
      );
      const results = await Promise.all(
        slice.map(async (idx) => {
          try {
            const addr = (await client.readContract({
              address: hb,
              abi: parseAbi([
                "function agentList(uint256) view returns (address)",
              ]),
              functionName: "agentList",
              args: [BigInt(idx)],
            })) as `0x${string}`;
            if (
              !addr ||
              addr === "0x0000000000000000000000000000000000000000"
            ) {
              return false;
            }
            return (await client.readContract({
              address: hb,
              abi: parseAbi([
                "function isAlive(address) view returns (bool)",
              ]),
              functionName: "isAlive",
              args: [addr],
            })) as boolean;
          } catch {
            return false;
          }
        })
      );
      alive += results.filter(Boolean).length;
    }
    networkAlive = alive;
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
      Field: "Heartbeat agents (total)",
      Value: networkCountsOk ? String(networkTotal) : "—",
    },
    {
      Field: "Heartbeat agents (alive)",
      Value: networkCountsOk ? String(networkAlive) : "—",
    },
    {
      Field: "Registry type",
      Value: "Persistent TEE (AgentHeartbeat)",
    },
    {
      Field: "Sovereign TEE jobs",
      Value:
        "Not in heartbeat — listed separately on explorer (0x080C jobs)",
    },
    { Field: "Chain id", Value: chainId },
    {
      Field: "Source",
      Value: "AgentHeartbeat 0xEF50…3aCa",
    },
  ];

  return {
    summary: networkCountsOk
      ? `Ritual testnet · block ${block} · gas ${
          gasGwei != null ? gasGwei.toFixed(4) : "—"
        } gwei · ${networkAlive}/${networkTotal} heartbeat agents alive (Persistent TEE registry)`
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
        label: "Alive",
        value: networkCountsOk ? String(networkAlive) : "—",
      },
      {
        label: "Total",
        value: networkCountsOk ? String(networkTotal) : "—",
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
      // Liquidations route removed from Surf (404). Use exchange/perp + L/S.
      const pair = t.includes("-")
        ? t.toUpperCase()
        : `${t.toUpperCase()}-USDT`;
      try {
        const json = await surfGet(
          `/exchange/perp?pair=${encodeURIComponent(pair)}`
        );
        const oi = summarizeOiSkew(json, pair);
        // Optional L/S enrich
        try {
          const ls = await surfGet(
            `/exchange/long-short-ratio?pair=${encodeURIComponent(pair)}`
          );
          const data = Array.isArray(ls.data)
            ? (ls.data[0] as Record<string, unknown>)
            : ((ls.data ?? ls) as Record<string, unknown>);
          const lsr = asNum(
            data.long_short_ratio ?? data.longShortRatio ?? data.ratio
          );
          if (oi.rows[0] && lsr != null) {
            oi.rows = [
              {
                ...oi.rows[0],
                "L/S": lsr.toFixed(3),
                Skew:
                  lsr > 1.2
                    ? "long-crowded"
                    : lsr < 0.85
                      ? "short-crowded"
                      : String(oi.rows[0].Skew ?? "balanced"),
              },
            ];
          }
        } catch {
          /* optional */
        }
        shaped = {
          summary: `${t.toUpperCase()} market stress · ${oi.summary}`,
          rows: oi.rows.slice(0, 2),
          highlights: [
            { label: "Symbol", value: t.toUpperCase() },
            ...oi.highlights.slice(0, 3),
          ],
        };
        endpoint = "/exchange/perp + long-short-ratio";
      } catch (e1) {
        // last resort: liquidations (if restored)
        try {
          const json = await surfGet(
            `/market/liquidations?symbol=${encodeURIComponent(t.toUpperCase())}&limit=2`
          );
          shaped = summarizeWhale(json, t);
          endpoint = "/market/liquidations";
        } catch {
          throw e1;
        }
      }
      break;
    }
    case "open_interest_skew": {
      // Legacy agents only — same as whale perp stress
      const pair = t.includes("-")
        ? t.toUpperCase()
        : `${t.toUpperCase()}-USDT`;
      const json = await surfGet(
        `/exchange/perp?pair=${encodeURIComponent(pair)}`
      );
      shaped = summarizeOiSkew(json, pair);
      try {
        const ls = await surfGet(
          `/exchange/long-short-ratio?pair=${encodeURIComponent(pair)}`
        );
        const data = Array.isArray(ls.data)
          ? (ls.data[0] as Record<string, unknown>)
          : ((ls.data ?? ls) as Record<string, unknown>);
        const longR = asNum(data.long_ratio ?? data.longAccount);
        const shortR = asNum(data.short_ratio ?? data.shortAccount);
        const lsr = asNum(data.long_short_ratio ?? data.longShortRatio);
        if (shaped.rows[0]) {
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
              "L/S":
                lsr != null
                  ? lsr.toFixed(3)
                  : String(shaped.rows[0]["L/S"] ?? "—"),
            },
          ];
        }
      } catch {
        /* optional */
      }
      shaped.rows = shaped.rows.slice(0, 1);
      break;
    }
    case "narrative_sector": {
      // Legacy — news only (trending endpoint removed)
      const q = t && t !== "_" ? t : "crypto";
      try {
        const json = await surfGet(
          `/news/feed?limit=8&q=${encodeURIComponent(q)}`
        );
        shaped = summarizeNews(json);
        shaped.summary = `News for “${q}” · ${shaped.summary}`;
      } catch {
        const json = await surfGet(`/news/feed?limit=8`);
        shaped = summarizeNews(json);
      }
      endpoint = "/news/feed";
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
