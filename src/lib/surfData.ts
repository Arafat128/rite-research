/**
 * Surf DATA API client (not Chat / Responses research).
 *
 * Base: https://api.asksurf.ai/gateway/v1
 * Auth: Bearer SURF_API_KEY
 *
 * Agents wake on schedule and pull ONE locked data kind per agent.
 */

import { resolveSurfBaseUrl, sanitizeDataTarget } from "@/lib/security";
import { generateRitualLlmSnapshot } from "@/lib/ritualLlm";

export type DataKindId =
  | "market_price"
  | "fear_greed"
  | "news_feed"
  | "stablecoin_peg"
  | "gas_fees"
  | "whale_transfers"
  | "open_interest_skew"
  | "narrative_sector"
  | "ritual_network"
  | "custom_ritual_llm";

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
    id: "stablecoin_peg",
    label: "Stablecoin peg stress",
    short: "Peg",
    description:
      "USDT / USDC / DAI (and optional extra symbol) vs $1 — depeg early warning.",
    targetLabel: "Extra symbol (optional)",
    targetPlaceholder: "FDUSD",
    defaultTarget: "_",
    path: () => "", // multi-fetch
  },
  {
    id: "gas_fees",
    label: "Gas / fee pulse",
    short: "Gas",
    description:
      "Ethereum L1 gas + Ritual network gas/block — timing for txs and congestion.",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => "", // RPC multi-fetch
  },
  {
    id: "whale_transfers",
    label: "Whale / large moves",
    short: "Whales",
    description:
      "Large-flow / liquidation-style market pressure (Surf market + exchange signals).",
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
    description:
      "Perp open interest, funding, and long/short positioning for a pair.",
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
      "Theme / sector heat (AI, RWA, memes, L2s…) from Surf signal/trending data.",
    targetLabel: "Sector / query",
    targetPlaceholder: "AI",
    defaultTarget: "AI",
    path: (t) =>
      `/signal/trending?q=${encodeURIComponent(t)}&limit=10`,
  },
  {
    id: "ritual_network",
    label: "Ritual network pulse",
    short: "Ritual",
    description:
      "Ritual chain block/gas + Radar registry size — native to this app’s stack.",
    targetLabel: null,
    targetPlaceholder: "",
    defaultTarget: "_",
    path: () => "", // RPC + contract
  },
  {
    id: "custom_ritual_llm",
    label: "Custom (Ritual LLM)",
    short: "Custom",
    description:
      "You describe what to track. Ritual LLM (on-chain TEE, GLM-4.7) returns a short table each tick. No OpenAI key.",
    targetLabel: "What should this agent track?",
    targetPlaceholder: "e.g. Overnight risk for ETH vs BTC in 5 bullets",
    defaultTarget: "Summarize crypto market risk in one short table",
    path: () => "", // Ritual LLM precompile
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

  const rows = takeLast(points, 12).map((p) => ({
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
      {
        label: "Index",
        value: latest?.value != null ? String(latest.value) : "—",
      },
      { label: "Class", value: latest?.classification ?? "—" },
      { label: "BTC ref", value: fmtUsd(latest?.price ?? null) },
      { label: "Samples", value: String(items.length) },
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
  extra: string
): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const symbols = ["USDT", "USDC", "DAI"];
  const ex = extra && extra !== "_" ? extra.toUpperCase() : "";
  if (ex && !symbols.includes(ex)) symbols.push(ex);

  const rows: Array<Record<string, SnapshotCell>> = [];
  let worstBps: number | null = null;
  let worstSym = "—";

  for (const sym of symbols) {
    try {
      const json = await surfGet(
        `/market/price?symbol=${encodeURIComponent(sym)}`
      );
      const px = lastPriceFromMarketJson(json);
      const peg = 1;
      const dev = px != null ? (px - peg) / peg : null;
      const absBps = dev != null ? Math.abs(dev) * 10_000 : null;
      if (absBps != null && (worstBps == null || absBps > worstBps)) {
        worstBps = absBps;
        worstSym = sym;
      }
      rows.push({
        Stable: sym,
        Price: fmtUsd(px),
        "vs $1":
          dev == null
            ? "—"
            : `${dev >= 0 ? "+" : ""}${(dev * 100).toFixed(4)}%`,
        Stress: absBps == null ? "—" : `${absBps.toFixed(1)} bps`,
      });
    } catch {
      rows.push({
        Stable: sym,
        Price: "—",
        "vs $1": "—",
        Stress: "fetch failed",
      });
    }
  }

  const alert =
    worstBps != null && worstBps >= 20
      ? ` · ALERT ${worstSym} ${worstBps.toFixed(0)} bps off peg`
      : "";

  return {
    summary: `Stablecoin peg check · worst ${worstSym} ${
      worstBps != null ? `${worstBps.toFixed(1)} bps` : "n/a"
    }${alert}`,
    rows,
    highlights: [
      { label: "Worst", value: worstSym },
      {
        label: "Stress",
        value: worstBps != null ? `${worstBps.toFixed(1)} bps` : "—",
      },
      { label: "Coins", value: String(rows.length) },
      {
        label: "Alert",
        value: worstBps != null && worstBps >= 20 ? "YES" : "no",
      },
    ],
  };
}

async function fetchGasFees(): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const ethRpc =
    process.env.ETH_RPC_URL || "https://ethereum.publicnode.com";
  const ritualRpc =
    process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";

  let ethGwei: number | null = null;
  let ritualGwei: number | null = null;
  let ritualBlock: string = "—";
  let ethBlock: string = "—";

  try {
    const [gas, block] = await Promise.all([
      rpcEthCall(ethRpc, "eth_gasPrice") as Promise<string>,
      rpcEthCall(ethRpc, "eth_blockNumber") as Promise<string>,
    ]);
    const wei = Number(BigInt(gas));
    ethGwei = wei / 1e9;
    ethBlock = String(Number(BigInt(block)));
  } catch {
    /* optional eth */
  }

  try {
    const [gas, block] = await Promise.all([
      rpcEthCall(ritualRpc, "eth_gasPrice") as Promise<string>,
      rpcEthCall(ritualRpc, "eth_blockNumber") as Promise<string>,
    ]);
    const wei = Number(BigInt(gas));
    ritualGwei = wei / 1e9;
    ritualBlock = String(Number(BigInt(block)));
  } catch {
    /* optional ritual */
  }

  const rows = [
    {
      Network: "Ethereum L1",
      "Gas (gwei)": ethGwei != null ? ethGwei.toFixed(3) : "—",
      Block: ethBlock,
    },
    {
      Network: "Ritual",
      "Gas (gwei)": ritualGwei != null ? ritualGwei.toFixed(6) : "—",
      Block: ritualBlock,
    },
  ];

  const congested = ethGwei != null && ethGwei >= 40;
  return {
    summary:
      ethGwei != null
        ? `ETH gas ${ethGwei.toFixed(2)} gwei · Ritual ${
            ritualGwei != null ? ritualGwei.toFixed(4) : "—"
          } gwei${congested ? " · L1 congested" : ""}`
        : `Ritual gas ${
            ritualGwei != null ? ritualGwei.toFixed(4) : "—"
          } gwei · block ${ritualBlock}`,
    rows,
    highlights: [
      {
        label: "ETH gwei",
        value: ethGwei != null ? ethGwei.toFixed(2) : "—",
      },
      {
        label: "Ritual gwei",
        value: ritualGwei != null ? ritualGwei.toFixed(4) : "—",
      },
      { label: "Ritual block", value: ritualBlock },
      { label: "L1 busy", value: congested ? "YES" : "no" },
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

  const items = data.slice(0, 12).map((row) => {
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

  const total = data.reduce((acc: number, row) => {
    const r = row as Record<string, unknown>;
    const amt = asNum(
      r.amount_usd ?? r.usd_value ?? r.value_usd ?? r.notional ?? r.value
    );
    return acc + (amt ?? 0);
  }, 0);

  return {
    summary: items.length
      ? `${target.toUpperCase()} large-move pulse · ${items.length} events · ~${fmtUsd(total)} notional`
      : `No large-move rows for ${target.toUpperCase()} (endpoint empty)`,
    rows: items,
    highlights: [
      { label: "Symbol", value: target.toUpperCase() },
      { label: "Events", value: String(items.length) },
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

  const rows = [
    { Field: "Exchange", Value: exchange },
    { Field: "Pair", Value: pair },
    { Field: "Open interest", Value: oiUsd != null ? fmtUsd(oiUsd) : "—" },
    { Field: "Funding", Value: fmtPct(rate) },
    { Field: "Funding ann.", Value: fmtPct(annual) },
    { Field: "Mark", Value: fmtUsd(mark) },
    {
      Field: "Long ratio",
      Value: longRatio != null ? `${(longRatio * 100).toFixed(2)}%` : "—",
    },
    {
      Field: "Short ratio",
      Value: shortRatio != null ? `${(shortRatio * 100).toFixed(2)}%` : "—",
    },
    {
      Field: "Long/Short",
      Value: longShort != null ? longShort.toFixed(3) : "—",
    },
  ];

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

function summarizeNarrative(
  json: Record<string, unknown>,
  target: string
): Omit<
  SurfDataSnapshot,
  "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
> {
  const data = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.projects)
      ? json.projects
      : Array.isArray(json.tokens)
        ? json.tokens
        : [];

  const rows = data.slice(0, 10).map((row, i) => {
    const r = row as Record<string, unknown>;
    const name = String(
      r.name ?? r.project ?? r.symbol ?? r.token ?? `Item ${i + 1}`
    ).slice(0, 48);
    const score = asNum(r.score ?? r.heat ?? r.rank ?? r.value ?? r.mindshare);
    const change = asNum(r.change_24h ?? r.delta ?? r.change);
    return {
      Rank: String(r.rank ?? i + 1),
      Name: name,
      Score: score != null ? score.toLocaleString() : "—",
      "24h Δ":
        change == null
          ? "—"
          : `${change >= 0 ? "+" : ""}${(change * (Math.abs(change) < 2 ? 100 : 1)).toFixed(2)}${Math.abs(change) < 2 ? "%" : ""}`,
    };
  });

  const top = rows[0]?.Name ?? target;
  return {
    summary: rows.length
      ? `Narrative “${target}” · ${rows.length} names · top ${top}`
      : `No narrative rows for “${target}”`,
    rows,
    highlights: [
      { label: "Query", value: target },
      { label: "Names", value: String(rows.length) },
      { label: "Top", value: String(top) },
      { label: "Source", value: "Surf signal" },
    ],
  };
}

async function fetchRitualNetwork(): Promise<
  Omit<
    SurfDataSnapshot,
    "kind" | "kindLabel" | "target" | "fetchedAt" | "endpoint" | "raw"
  >
> {
  const ritualRpc =
    process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";
  const radar = (process.env.NEXT_PUBLIC_RADAR_CONTRACT || "").trim();

  let block = "—";
  let gasGwei: number | null = null;
  let chainId = "—";
  let nextAgent = "—";

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

  if (radar && /^0x[a-fA-F0-9]{40}$/.test(radar)) {
    try {
      // nextAgentId() selector
      const data = "0x30efc498";
      const raw = (await rpcEthCall(ritualRpc, "eth_call", [
        { to: radar, data },
        "latest",
      ])) as string;
      if (raw && raw !== "0x") {
        nextAgent = String(Number(BigInt(raw)));
      }
    } catch {
      /* optional */
    }
  }

  const rows = [
    { Field: "Chain id", Value: chainId },
    { Field: "Latest block", Value: block },
    {
      Field: "Gas",
      Value: gasGwei != null ? `${gasGwei.toFixed(6)} gwei` : "—",
    },
    { Field: "Radar nextAgentId", Value: nextAgent },
    {
      Field: "Radar",
      Value: radar ? `${radar.slice(0, 8)}…${radar.slice(-4)}` : "not set",
    },
  ];

  return {
    summary: `Ritual chain ${chainId} · block ${block} · gas ${
      gasGwei != null ? gasGwei.toFixed(4) : "—"
    } gwei · agents up to #${nextAgent}`,
    rows,
    highlights: [
      { label: "Block", value: block },
      {
        label: "Gas",
        value: gasGwei != null ? `${gasGwei.toFixed(4)} gwei` : "—",
      },
      { label: "Next agent", value: nextAgent },
      { label: "Chain", value: chainId },
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
      endpoint = "multi:/market/price (USDT,USDC,DAI,…)";
      break;
    }
    case "gas_fees": {
      shaped = await fetchGasFees();
      endpoint = "rpc:eth_gasPrice+eth_blockNumber";
      break;
    }
    case "whale_transfers": {
      try {
        const json = await surfGet(kind.path(t));
        shaped = summarizeWhale(json, t);
      } catch (e1) {
        // Fallback paths
        try {
          const json = await surfGet(
            `/market/liquidations?symbol=${encodeURIComponent(t.toUpperCase())}&limit=12`
          );
          shaped = summarizeWhale(json, t);
          endpoint = "/market/liquidations";
        } catch {
          try {
            const json = await surfGet(
              `/exchange/perp?pair=${encodeURIComponent(
                t.includes("-") ? t.toUpperCase() : `${t.toUpperCase()}-USDT`
              )}`
            );
            shaped = summarizeOiSkew(json, t);
            shaped = {
              ...shaped,
              summary: `Whale path fallback → OI/funding for ${t}: ${shaped.summary}`,
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
      // Enrich with long/short if available
      try {
        const ls = await surfGet(
          `/exchange/long-short-ratio?pair=${encodeURIComponent(pair)}`
        );
        const data = (ls.data ?? ls) as Record<string, unknown>;
        const longR = asNum(data.long_ratio ?? data.longAccount);
        const shortR = asNum(data.short_ratio ?? data.shortAccount);
        if (longR != null || shortR != null) {
          shaped.rows = [
            ...shaped.rows,
            {
              Field: "Long (ratio API)",
              Value:
                longR != null ? `${(longR * 100).toFixed(2)}%` : "—",
            },
            {
              Field: "Short (ratio API)",
              Value:
                shortR != null ? `${(shortR * 100).toFixed(2)}%` : "—",
            },
          ];
        }
      } catch {
        /* optional */
      }
      break;
    }
    case "narrative_sector": {
      try {
        const json = await surfGet(kind.path(t));
        shaped = summarizeNarrative(json, t);
      } catch {
        try {
          const json = await surfGet(
            `/signal/heat?q=${encodeURIComponent(t)}&limit=10`
          );
          shaped = summarizeNarrative(json, t);
          endpoint = "/signal/heat";
        } catch {
          const json = await surfGet(
            `/social/mindshare?interval=7d&q=${encodeURIComponent(t)}`
          );
          // mindshare series as narrative proxy
          const data = Array.isArray(json.data) ? json.data : [];
          const points = data.map((row) => {
            const r = row as Record<string, unknown>;
            return { timestamp: r.timestamp, value: asNum(r.value) };
          });
          const last = points[points.length - 1];
          shaped = {
            summary:
              last?.value != null
                ? `Narrative proxy (mindshare) “${t}” · ${last.value.toLocaleString()}`
                : `No narrative data for “${t}”`,
            rows: takeLast(points, 12).map((p) => ({
              Time: fmtTs(p.timestamp),
              Score: p.value != null ? p.value.toLocaleString() : "—",
            })),
            highlights: [
              { label: "Query", value: t },
              {
                label: "Latest",
                value: last?.value != null ? last.value.toLocaleString() : "—",
              },
              { label: "Points", value: String(points.length) },
              { label: "Source", value: "mindshare fallback" },
            ],
          };
          endpoint = "/social/mindshare (fallback)";
        }
      }
      break;
    }
    case "ritual_network": {
      shaped = await fetchRitualNetwork();
      endpoint = "ritual-rpc+radar";
      break;
    }
    case "custom_ritual_llm": {
      const out = await generateRitualLlmSnapshot(t);
      shaped = {
        summary: out.summary,
        rows: out.rows as Array<Record<string, SnapshotCell>>,
        highlights: out.highlights,
      };
      endpoint = out.endpoint;
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
  let t = (target || k.defaultTarget).trim() || k.defaultTarget;
  // Custom prompts may be longer; cap for on-chain string gas
  if (kind === "custom_ritual_llm") {
    t = t.slice(0, 100);
  }
  const cell = `${kind}|${t}`;
  const max = kind === "custom_ritual_llm" ? 120 : 48;
  if (cell.length > max) throw new Error("Target too long for on-chain lock");
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
