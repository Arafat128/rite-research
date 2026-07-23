/**
 * Oracast price-watch subscriptions with prepaid RIT billing.
 * Rate: 0.05 RIT per hour of active monitoring (configurable).
 *
 * Storage: Upstash Redis when configured, else memory + /tmp file (local).
 */

import { createPublicClient, formatEther, http, parseEther, type Hex } from "viem";
import {
  FEE_RECIPIENT,
  RPC_URL,
  ritualChain,
} from "@/lib/ritual";
import { resolveTelegramPref } from "@/lib/telegramPrefs";
import { sendTelegramMessage } from "@/lib/telegram";
import { formatUsdPrice, resolvePrice } from "@/lib/oracastPrice";
import {
  FREQ_OPTIONS_MIN,
  ORACAST_RATE_RIT_PER_HOUR,
} from "@/lib/oracastConstants";

export { FREQ_OPTIONS_MIN, ORACAST_RATE_RIT_PER_HOUR };

export const ORACAST_RATE_WEI = parseEther(
  String(ORACAST_RATE_RIT_PER_HOUR)
);

export type OracastWatch = {
  id: string;
  owner: string;
  /** CoinGecko / Oracast id */
  coinId?: string;
  contractAddress?: string;
  chainHint?: string;
  symbol: string;
  name: string;
  /** Minutes between Telegram price updates */
  frequencyMin: number;
  /** Remaining prepaid balance (wei string) */
  depositWei: string;
  active: boolean;
  lastNotifyAt: number;
  lastBilledAt: number;
  lastPrice?: number;
  lastSource?: string;
  createdAt: number;
  /** Tx hashes already credited (anti double-fund) */
  fundedTxs: string[];
  notifyCount: number;
};

const KEY_PREFIX = "rite:oracast:watch:";
const INDEX_KEY = "rite:oracast:watch_index";
const TX_KEY_PREFIX = "rite:oracast:tx:";

type G = typeof globalThis & {
  __riteOracastWatches?: Map<string, OracastWatch>;
  __riteOracastTx?: Set<string>;
};

function mem(): Map<string, OracastWatch> {
  const g = globalThis as G;
  if (!g.__riteOracastWatches) g.__riteOracastWatches = new Map();
  return g.__riteOracastWatches;
}

function memTx(): Set<string> {
  const g = globalThis as G;
  if (!g.__riteOracastTx) g.__riteOracastTx = new Set();
  return g.__riteOracastTx;
}

function upstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

async function upstash(path: string[], init?: RequestInit): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const url = `${base}/${path.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = (await res.json()) as { result?: unknown };
  return data.result;
}

function newId(): string {
  return `ow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hoursRemaining(depositWei: string): number {
  try {
    const d = BigInt(depositWei || "0");
    if (d <= BigInt(0) || ORACAST_RATE_WEI <= BigInt(0)) return 0;
    return Number(d) / Number(ORACAST_RATE_WEI);
  } catch {
    return 0;
  }
}

export async function getWatch(id: string): Promise<OracastWatch | null> {
  if (upstashConfigured()) {
    try {
      const raw = await upstash(["get", `${KEY_PREFIX}${id}`]);
      if (raw == null || raw === "") return null;
      return typeof raw === "string"
        ? (JSON.parse(raw) as OracastWatch)
        : (raw as OracastWatch);
    } catch (e) {
      console.warn("[oracastWatch] get", e);
    }
  }
  return mem().get(id) || null;
}

export async function saveWatch(w: OracastWatch): Promise<void> {
  mem().set(w.id, w);
  if (upstashConfigured()) {
    try {
      await upstash(
        ["set", `${KEY_PREFIX}${w.id}`, JSON.stringify(w)],
        { method: "POST" }
      );
      // index by owner
      await upstash(
        ["sadd", `${INDEX_KEY}:${w.owner.toLowerCase()}`, w.id],
        { method: "POST" }
      );
      await upstash(["sadd", INDEX_KEY, w.id], { method: "POST" });
    } catch (e) {
      console.warn("[oracastWatch] save remote", e);
    }
  }
}

export async function listWatchesByOwner(
  owner: string
): Promise<OracastWatch[]> {
  const o = owner.toLowerCase();
  if (upstashConfigured()) {
    try {
      const ids = (await upstash([
        "smembers",
        `${INDEX_KEY}:${o}`,
      ])) as string[] | null;
      if (Array.isArray(ids) && ids.length) {
        const out: OracastWatch[] = [];
        for (const id of ids) {
          const w = await getWatch(id);
          if (w && w.owner.toLowerCase() === o) out.push(w);
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
      }
    } catch (e) {
      console.warn("[oracastWatch] list remote", e);
    }
  }
  return Array.from(mem().values())
    .filter((w) => w.owner.toLowerCase() === o)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAllActiveWatches(): Promise<OracastWatch[]> {
  if (upstashConfigured()) {
    try {
      const ids = (await upstash(["smembers", INDEX_KEY])) as string[] | null;
      if (Array.isArray(ids) && ids.length) {
        const out: OracastWatch[] = [];
        for (const id of ids) {
          const w = await getWatch(id);
          if (w?.active) out.push(w);
        }
        return out;
      }
    } catch (e) {
      console.warn("[oracastWatch] listAll", e);
    }
  }
  return Array.from(mem().values()).filter((w) => w.active);
}

export type CreateWatchInput = {
  owner: string;
  coinId?: string;
  contractAddress?: string;
  chainHint?: string;
  frequencyMin: number;
  depositRit: string;
  txHash: Hex;
};

function feeRecipient(): `0x${string}` {
  const r = (FEE_RECIPIENT || "").toLowerCase();
  if (!r || r === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "FEE_RECIPIENT not configured — set NEXT_PUBLIC_FEE_RECIPIENT for Oracast deposits"
    );
  }
  return FEE_RECIPIENT as `0x${string}`;
}

async function txAlreadyUsed(txHash: string): Promise<boolean> {
  const h = txHash.toLowerCase();
  if (memTx().has(h)) return true;
  if (upstashConfigured()) {
    try {
      const v = await upstash(["get", `${TX_KEY_PREFIX}${h}`]);
      return v != null && v !== "";
    } catch {
      return false;
    }
  }
  return false;
}

async function markTxUsed(txHash: string): Promise<void> {
  const h = txHash.toLowerCase();
  memTx().add(h);
  if (upstashConfigured()) {
    try {
      await upstash(
        ["set", `${TX_KEY_PREFIX}${h}`, "1"],
        { method: "POST" }
      );
    } catch (e) {
      console.warn("[oracastWatch] mark tx", e);
    }
  }
}

/** Verify native RIT transfer to fee recipient on Ritual. */
export async function verifyDepositTx(opts: {
  txHash: Hex;
  owner: string;
  minValueWei: bigint;
}): Promise<{ valueWei: bigint }> {
  const client = createPublicClient({
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 25_000 }),
  });
  const receipt = await client.getTransactionReceipt({ hash: opts.txHash });
  if (receipt.status !== "success") {
    throw new Error("Deposit transaction failed on-chain");
  }
  const tx = await client.getTransaction({ hash: opts.txHash });
  if (!tx) throw new Error("Transaction not found");
  if (tx.from.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error("Deposit must come from your connected wallet");
  }
  const to = (tx.to || "").toLowerCase();
  if (to !== feeRecipient().toLowerCase()) {
    throw new Error(
      `Deposit must be sent to fee recipient ${feeRecipient()}`
    );
  }
  // Native transfer only (no contract call data required)
  if (tx.input && tx.input !== "0x" && tx.input.length > 2) {
    // still allow if value is set
  }
  if (tx.value < opts.minValueWei) {
    throw new Error(
      `Deposit too small: got ${formatEther(tx.value)} RIT, need ≥ ${formatEther(opts.minValueWei)} RIT`
    );
  }
  if (await txAlreadyUsed(opts.txHash)) {
    throw new Error("This deposit transaction was already used");
  }
  return { valueWei: tx.value };
}

export async function createWatch(
  input: CreateWatchInput
): Promise<OracastWatch> {
  const owner = input.owner.toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    throw new Error("Invalid wallet");
  }
  const freq = Number(input.frequencyMin);
  if (!FREQ_OPTIONS_MIN.includes(freq as (typeof FREQ_OPTIONS_MIN)[number])) {
    throw new Error(
      `Frequency must be one of: ${FREQ_OPTIONS_MIN.join(", ")} minutes`
    );
  }
  if (!input.coinId && !input.contractAddress) {
    throw new Error("Select a token or paste a contract address");
  }

  let depositWei: bigint;
  try {
    depositWei = parseEther(String(input.depositRit || "0"));
  } catch {
    throw new Error("Invalid deposit amount");
  }
  if (depositWei < ORACAST_RATE_WEI) {
    throw new Error(
      `Minimum deposit is ${ORACAST_RATE_RIT_PER_HOUR} RIT (1 hour)`
    );
  }

  // Resolve token before taking funds credit
  const quote = await resolvePrice({
    coinId: input.coinId,
    contractAddress: input.contractAddress,
    chainHint: input.chainHint,
  });

  const { valueWei } = await verifyDepositTx({
    txHash: input.txHash,
    owner,
    minValueWei: depositWei,
  });

  // Credit actual on-chain value (may be higher than stated)
  const credited = valueWei >= depositWei ? valueWei : depositWei;

  await markTxUsed(input.txHash);

  const now = Date.now();
  const w: OracastWatch = {
    id: newId(),
    owner,
    coinId: input.coinId || quote.coinId,
    contractAddress: input.contractAddress || quote.contractAddress,
    chainHint: input.chainHint,
    symbol: quote.symbol,
    name: quote.name,
    frequencyMin: freq,
    depositWei: credited.toString(),
    active: true,
    lastNotifyAt: 0,
    lastBilledAt: now,
    lastPrice: quote.price,
    lastSource: quote.source,
    createdAt: now,
    fundedTxs: [input.txHash.toLowerCase()],
    notifyCount: 0,
  };
  await saveWatch(w);
  return w;
}

export async function fundWatch(opts: {
  watchId: string;
  owner: string;
  depositRit: string;
  txHash: Hex;
}): Promise<OracastWatch> {
  const w = await getWatch(opts.watchId);
  if (!w) throw new Error("Watch not found");
  if (w.owner.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error("Not your watch");
  }
  let depositWei: bigint;
  try {
    depositWei = parseEther(String(opts.depositRit || "0"));
  } catch {
    throw new Error("Invalid amount");
  }
  if (depositWei < ORACAST_RATE_WEI / BigInt(2)) {
    throw new Error("Deposit too small");
  }
  const { valueWei } = await verifyDepositTx({
    txHash: opts.txHash,
    owner: opts.owner,
    minValueWei: depositWei,
  });
  await markTxUsed(opts.txHash);
  const add = valueWei;
  w.depositWei = (BigInt(w.depositWei) + add).toString();
  w.fundedTxs = [...w.fundedTxs, opts.txHash.toLowerCase()].slice(-20);
  w.active = true;
  await saveWatch(w);
  return w;
}

export async function updateWatchPrefs(opts: {
  watchId: string;
  owner: string;
  frequencyMin?: number;
  active?: boolean;
}): Promise<OracastWatch> {
  const w = await getWatch(opts.watchId);
  if (!w) throw new Error("Watch not found");
  if (w.owner.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error("Not your watch");
  }
  if (opts.frequencyMin != null) {
    if (
      !FREQ_OPTIONS_MIN.includes(
        opts.frequencyMin as (typeof FREQ_OPTIONS_MIN)[number]
      )
    ) {
      throw new Error("Invalid frequency");
    }
    w.frequencyMin = opts.frequencyMin;
  }
  if (opts.active != null) {
    w.active = opts.active;
    if (opts.active) w.lastBilledAt = Date.now();
  }
  await saveWatch(w);
  return w;
}

/** Accrue hourly burn since lastBilledAt. */
function applyBilling(w: OracastWatch, now = Date.now()): OracastWatch {
  const elapsedMs = Math.max(0, now - (w.lastBilledAt || w.createdAt));
  if (elapsedMs < 1_000) return w;
  const hours = elapsedMs / 3_600_000;
  const burn = BigInt(Math.floor(hours * Number(ORACAST_RATE_WEI)));
  if (burn <= BigInt(0)) {
    w.lastBilledAt = now;
    return w;
  }
  let bal = BigInt(w.depositWei || "0");
  if (burn >= bal) {
    bal = BigInt(0);
    w.active = false;
  } else {
    bal -= burn;
  }
  w.depositWei = bal.toString();
  w.lastBilledAt = now;
  return w;
}

export function publicWatch(w: OracastWatch) {
  const hrs = hoursRemaining(w.depositWei);
  return {
    id: w.id,
    owner: w.owner,
    coinId: w.coinId,
    contractAddress: w.contractAddress,
    symbol: w.symbol,
    name: w.name,
    frequencyMin: w.frequencyMin,
    depositRit: formatEther(BigInt(w.depositWei || "0")),
    hoursRemaining: Math.floor(hrs * 10) / 10,
    active: w.active && hrs > 0,
    lastNotifyAt: w.lastNotifyAt,
    lastPrice: w.lastPrice,
    lastSource: w.lastSource,
    notifyCount: w.notifyCount,
    createdAt: w.createdAt,
    rateRitPerHour: ORACAST_RATE_RIT_PER_HOUR,
  };
}

/**
 * Process due watches: bill time, send Telegram when frequency elapsed.
 */
export async function tickOracastWatches(opts?: {
  onlyOwner?: string;
  max?: number;
}): Promise<{
  scanned: number;
  notified: number;
  paused: number;
  results: Array<{
    id: string;
    ok: boolean;
    skipped?: string;
    error?: string;
    price?: number;
  }>;
}> {
  const all = await listAllActiveWatches();
  const filtered = opts?.onlyOwner
    ? all.filter(
        (w) => w.owner.toLowerCase() === opts.onlyOwner!.toLowerCase()
      )
    : all;
  const max = opts?.max ?? 40;
  const slice = filtered.slice(0, max);
  const results: Array<{
    id: string;
    ok: boolean;
    skipped?: string;
    error?: string;
    price?: number;
  }> = [];
  let notified = 0;
  let paused = 0;
  const now = Date.now();

  for (const raw of slice) {
    let w = { ...raw };
    try {
      w = applyBilling(w, now);
      if (!w.active || BigInt(w.depositWei) < ORACAST_RATE_WEI / BigInt(100)) {
        w.active = false;
        await saveWatch(w);
        paused += 1;
        results.push({ id: w.id, ok: false, skipped: "insufficient_balance" });
        continue;
      }

      const dueMs = w.frequencyMin * 60_000;
      const since = w.lastNotifyAt || 0;
      if (since > 0 && now - since < dueMs) {
        await saveWatch(w);
        results.push({ id: w.id, ok: false, skipped: "not_due" });
        continue;
      }

      const quote = await resolvePrice({
        coinId: w.coinId,
        contractAddress: w.contractAddress,
        chainHint: w.chainHint,
      });
      w.lastPrice = quote.price;
      w.lastSource = quote.source;

      const pref = await resolveTelegramPref(w.owner);
      if (!pref?.chatId) {
        await saveWatch(w);
        results.push({ id: w.id, ok: false, skipped: "telegram_not_linked" });
        continue;
      }

      const ch =
        quote.change24h != null
          ? `${quote.change24h >= 0 ? "+" : ""}${quote.change24h.toFixed(2)}% 24h`
          : "";
      const hrs = hoursRemaining(w.depositWei);
      const html =
        `<b>Oracast · ${escapeHtml(w.symbol)}</b>\n` +
        `${escapeHtml(w.name)}\n` +
        `Price: <b>$${escapeHtml(formatUsdPrice(quote.price))}</b>` +
        (ch ? ` · ${escapeHtml(ch)}` : "") +
        `\nSource: ${escapeHtml(quote.source)}` +
        `\nEvery ${w.frequencyMin}m · ~${hrs.toFixed(1)}h left` +
        `\n<code>${w.id}</code>`;

      await sendTelegramMessage(pref.chatId, html);
      w.lastNotifyAt = now;
      w.notifyCount = (w.notifyCount || 0) + 1;
      await saveWatch(w);
      notified += 1;
      results.push({ id: w.id, ok: true, price: quote.price });
    } catch (e) {
      results.push({
        id: w.id,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 160) : "tick failed",
      });
      try {
        await saveWatch(w);
      } catch {
        /* ignore */
      }
    }
  }

  return { scanned: slice.length, notified, paused, results };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function depositAddress(): string {
  try {
    return feeRecipient();
  } catch {
    return "";
  }
}
