/**
 * Oracast price-watch subscriptions with prepaid RIT.
 *
 * Billing model (fixed — no silent drain):
 * - Deposit credits balance (wei).
 * - Charge ONLY on successful Telegram delivery:
 *   cost = ratePerHour × (frequencyMin / 60)
 * - Never burn balance for wall-clock idle time (that wiped deposits when
 *   the tab reopened after hours without a server tick).
 *
 * Storage (unattended requires durability):
 * 1) Upstash Redis when UPSTASH_REDIS_REST_* is set (multi-instance Vercel)
 * 2) Durable JSON file (.data / /tmp / RITE_DATA_DIR)
 * 3) In-memory hot cache
 *
 * Ticks: /api/oracast/tick + /api/agent/cron (Bearer CRON_SECRET) + browser poke.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  createPublicClient,
  formatEther,
  http,
  parseEther,
  type Hex,
} from "viem";
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
  ORACAST_MIN_DEPOSIT_RIT,
  ORACAST_RATE_RIT_PER_HOUR,
} from "@/lib/oracastConstants";

export {
  FREQ_OPTIONS_MIN,
  ORACAST_MIN_DEPOSIT_RIT,
  ORACAST_RATE_RIT_PER_HOUR,
};

export const ORACAST_RATE_WEI = parseEther(
  String(ORACAST_RATE_RIT_PER_HOUR)
);

export const ORACAST_MIN_DEPOSIT_WEI = parseEther(
  String(ORACAST_MIN_DEPOSIT_RIT)
);

export type OracastWatch = {
  id: string;
  owner: string;
  coinId?: string;
  contractAddress?: string;
  chainHint?: string;
  symbol: string;
  name: string;
  frequencyMin: number;
  /** Remaining prepaid balance (wei string) */
  depositWei: string;
  active: boolean;
  lastNotifyAt: number;
  lastPrice?: number;
  lastSource?: string;
  createdAt: number;
  fundedTxs: string[];
  notifyCount: number;
  /** Schema version for migrations */
  v?: number;
};

const KEY_PREFIX = "rite:oracast:watch:";
const INDEX_KEY = "rite:oracast:watch_index";
const TX_KEY_PREFIX = "rite:oracast:tx:";
const WATCH_VERSION = 2;

type G = typeof globalThis & {
  __riteOracastWatches?: Map<string, OracastWatch>;
  __riteOracastTx?: Set<string>;
  __riteOracastFileLoaded?: boolean;
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

/** Upstash REST: POST body = Redis command array (handles JSON values safely). */
async function upstashCmd(cmd: (string | number)[]): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result;
}

function durablePath(): string | null {
  try {
    if (process.env.ORACAST_WATCHES_PATH) return process.env.ORACAST_WATCHES_PATH;
    if (process.env.RITE_DATA_DIR) {
      return path.join(process.env.RITE_DATA_DIR, "oracast-watches.json");
    }
    return process.env.VERCEL
      ? path.join("/tmp", "rite-oracast-watches.json")
      : path.join(process.cwd(), ".data", "oracast-watches.json");
  } catch {
    return null;
  }
}

type DurableBlob = {
  watches: Record<string, OracastWatch>;
  usedTx: string[];
};

function loadDurableFile(): void {
  const g = globalThis as G;
  if (g.__riteOracastFileLoaded) return;
  g.__riteOracastFileLoaded = true;
  const file = durablePath();
  if (!file || !existsSync(file)) return;
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as DurableBlob;
    const m = mem();
    if (data.watches) {
      for (const w of Object.values(data.watches)) {
        if (w?.id && w?.owner) m.set(w.id, migrateWatch(w));
      }
    }
    if (Array.isArray(data.usedTx)) {
      for (const t of data.usedTx) memTx().add(t.toLowerCase());
    }
  } catch (e) {
    console.warn("[oracastWatch] durable load failed", e);
  }
}

function saveDurableFile(): void {
  const file = durablePath();
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const watches: Record<string, OracastWatch> = {};
    mem().forEach((w, id) => {
      watches[id] = w;
    });
    const blob: DurableBlob = {
      watches,
      usedTx: Array.from(memTx()).slice(-500),
    };
    writeFileSync(file, JSON.stringify(blob), "utf8");
  } catch (e) {
    console.warn("[oracastWatch] durable save failed", e);
  }
}

/** Drop wall-clock billing fields from v1. */
function migrateWatch(w: OracastWatch): OracastWatch {
  const next = { ...w, v: WATCH_VERSION };
  // Reactivate if still funded (v1 may have set active=false after catch-up burn)
  try {
    if (BigInt(next.depositWei || "0") > BigInt(0) && next.active === false) {
      // leave paused if user paused; only revive if deposit remaining and was auto-paused
      // Heuristic: if lastNotifyAt is 0 or deposit still large, allow active if deposit > 0
      // Safer: only set active true when deposit covers at least one alert
      if (BigInt(next.depositWei) >= costPerAlertWei(next.frequencyMin)) {
        // Don't force active — user may have paused. If notifyCount>0 and deposit left, keep as stored.
      }
    }
  } catch {
    /* ignore */
  }
  return next;
}

function newId(): string {
  return `ow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** RIT cost for one successful alert at this frequency. */
export function costPerAlertWei(frequencyMin: number): bigint {
  const mins = Math.max(1, Number(frequencyMin) || 60);
  // rateWei * mins / 60
  return (ORACAST_RATE_WEI * BigInt(mins)) / BigInt(60);
}

export function hoursRemaining(depositWei: string): number {
  try {
    const d = BigInt(depositWei || "0");
    if (d <= BigInt(0) || ORACAST_RATE_WEI <= BigInt(0)) return 0;
    // Remaining prepaid hours at hourly rate (independent of frequency)
    return Number(d) / Number(ORACAST_RATE_WEI);
  } catch {
    return 0;
  }
}

export function alertsRemaining(
  depositWei: string,
  frequencyMin: number
): number {
  try {
    const cost = costPerAlertWei(frequencyMin);
    if (cost <= BigInt(0)) return 0;
    return Number(BigInt(depositWei || "0") / cost);
  } catch {
    return 0;
  }
}

export async function getWatch(id: string): Promise<OracastWatch | null> {
  loadDurableFile();
  if (upstashConfigured()) {
    try {
      const raw = await upstashCmd(["GET", `${KEY_PREFIX}${id}`]);
      if (raw != null && raw !== "") {
        const w =
          typeof raw === "string"
            ? (JSON.parse(raw) as OracastWatch)
            : (raw as OracastWatch);
        const m = migrateWatch(w);
        mem().set(m.id, m);
        return m;
      }
    } catch (e) {
      console.warn("[oracastWatch] get remote", e);
    }
  }
  const local = mem().get(id);
  return local ? migrateWatch(local) : null;
}

export async function saveWatch(w: OracastWatch): Promise<void> {
  loadDurableFile();
  const next = migrateWatch({ ...w, v: WATCH_VERSION });
  mem().set(next.id, next);
  saveDurableFile();

  if (upstashConfigured()) {
    try {
      await upstashCmd([
        "SET",
        `${KEY_PREFIX}${next.id}`,
        JSON.stringify(next),
      ]);
      await upstashCmd([
        "SADD",
        `${INDEX_KEY}:${next.owner.toLowerCase()}`,
        next.id,
      ]);
      await upstashCmd(["SADD", INDEX_KEY, next.id]);
    } catch (e) {
      console.error("[oracastWatch] CRITICAL remote save failed", e);
      // Still have file + memory — throw only if neither path durable on multi-instance
      if (process.env.VERCEL && !durablePath()) {
        throw new Error(
          "Could not persist watch (configure UPSTASH_REDIS_REST_URL + TOKEN)"
        );
      }
    }
  } else if (process.env.VERCEL) {
    console.warn(
      "[oracastWatch] No Upstash on Vercel — watches may not survive cold starts. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN."
    );
  }
}

export async function listWatchesByOwner(
  owner: string
): Promise<OracastWatch[]> {
  loadDurableFile();
  const o = owner.toLowerCase();
  const byId = new Map<string, OracastWatch>();

  if (upstashConfigured()) {
    try {
      const ids = (await upstashCmd([
        "SMEMBERS",
        `${INDEX_KEY}:${o}`,
      ])) as string[] | null;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const w = await getWatch(id);
          if (w && w.owner.toLowerCase() === o) byId.set(w.id, w);
        }
      }
    } catch (e) {
      console.warn("[oracastWatch] list remote", e);
    }
  }

  for (const w of Array.from(mem().values())) {
    if (w.owner.toLowerCase() === o) byId.set(w.id, migrateWatch(w));
  }

  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAllActiveWatches(): Promise<OracastWatch[]> {
  loadDurableFile();
  const byId = new Map<string, OracastWatch>();

  if (upstashConfigured()) {
    try {
      const ids = (await upstashCmd(["SMEMBERS", INDEX_KEY])) as
        | string[]
        | null;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const w = await getWatch(id);
          if (w?.active && BigInt(w.depositWei || "0") > BigInt(0)) {
            byId.set(w.id, w);
          }
        }
      }
    } catch (e) {
      console.warn("[oracastWatch] listAll remote", e);
    }
  }

  for (const w of Array.from(mem().values())) {
    const m = migrateWatch(w);
    if (m.active && BigInt(m.depositWei || "0") > BigInt(0)) {
      byId.set(m.id, m);
    }
  }

  return Array.from(byId.values());
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
  loadDurableFile();
  const h = txHash.toLowerCase();
  if (memTx().has(h)) return true;
  if (upstashConfigured()) {
    try {
      const v = await upstashCmd(["GET", `${TX_KEY_PREFIX}${h}`]);
      return v != null && v !== "";
    } catch {
      return false;
    }
  }
  return false;
}

async function markTxUsed(txHash: string): Promise<void> {
  loadDurableFile();
  const h = txHash.toLowerCase();
  memTx().add(h);
  saveDurableFile();
  if (upstashConfigured()) {
    try {
      await upstashCmd(["SET", `${TX_KEY_PREFIX}${h}`, "1"]);
    } catch (e) {
      console.warn("[oracastWatch] mark tx remote", e);
    }
  }
}

/** Verify native RIT transfer to fee recipient on Ritual. */
export async function verifyDepositTx(opts: {
  txHash: Hex;
  owner: string;
  minValueWei: bigint;
  /** When true, allow re-import after storage loss (tx already credited). */
  allowUsed?: boolean;
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
  if (tx.value < opts.minValueWei) {
    throw new Error(
      `Deposit too small: got ${formatEther(tx.value)} RIT, need ≥ ${formatEther(opts.minValueWei)} RIT`
    );
  }
  if (!opts.allowUsed && (await txAlreadyUsed(opts.txHash))) {
    throw new Error("This deposit transaction was already used");
  }
  return { valueWei: tx.value };
}

export async function createWatch(
  input: CreateWatchInput
): Promise<OracastWatch> {
  loadDurableFile();
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
  if (depositWei < ORACAST_MIN_DEPOSIT_WEI) {
    throw new Error(
      `Deposit must be at least ${ORACAST_MIN_DEPOSIT_RIT} RIT`
    );
  }

  const quote = await resolvePrice({
    coinId: input.coinId,
    contractAddress: input.contractAddress,
    chainHint: input.chainHint,
  });

  const { valueWei } = await verifyDepositTx({
    txHash: input.txHash,
    owner,
    minValueWei: depositWei < ORACAST_MIN_DEPOSIT_WEI
      ? ORACAST_MIN_DEPOSIT_WEI
      : depositWei,
  });

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
    depositWei: valueWei.toString(),
    active: true,
    lastNotifyAt: 0,
    lastPrice: quote.price,
    lastSource: quote.source,
    createdAt: now,
    fundedTxs: [input.txHash.toLowerCase()],
    notifyCount: 0,
    v: WATCH_VERSION,
  };
  await saveWatch(w);
  return w;
}

/**
 * Re-hydrate a watch after serverless memory loss using client backup + on-chain txs.
 * Does not double-credit: deposit = sum of verified txs (once).
 */
export async function importWatchBackup(opts: {
  owner: string;
  watch: Partial<OracastWatch> & {
    id: string;
    symbol: string;
    name: string;
    frequencyMin: number;
    fundedTxs: string[];
    /** Human deposit remaining from client backup */
    depositRit?: string;
  };
}): Promise<OracastWatch> {
  loadDurableFile();
  const owner = opts.owner.toLowerCase();
  if (opts.watch.owner && opts.watch.owner.toLowerCase() !== owner) {
    throw new Error("Watch owner mismatch");
  }

  const existing = await getWatch(opts.watch.id);
  if (existing && existing.owner.toLowerCase() === owner) {
    return existing;
  }

  // Find any of owner's watches with same funded tx
  const mine = await listWatchesByOwner(owner);
  for (const m of mine) {
    for (const tx of opts.watch.fundedTxs || []) {
      if (m.fundedTxs?.includes(tx.toLowerCase())) return m;
    }
  }

  let total = BigInt(0);
  const txs: string[] = [];
  for (const raw of opts.watch.fundedTxs || []) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) continue;
    try {
      const { valueWei } = await verifyDepositTx({
        txHash: raw as Hex,
        owner,
        minValueWei: ORACAST_MIN_DEPOSIT_WEI,
        allowUsed: true,
      });
      total += valueWei;
      txs.push(raw.toLowerCase());
      await markTxUsed(raw);
    } catch (e) {
      console.warn("[oracastWatch] import tx skip", raw.slice(0, 12), e);
    }
  }
  if (total <= BigInt(0) || txs.length === 0) {
    throw new Error(
      "Could not restore watch — deposit txs not found on-chain for this wallet"
    );
  }

  // Prefer remaining balance from client backup if still ≤ verified on-chain deposits
  let depositWei = total;
  try {
    if (opts.watch.depositWei) {
      const bak = BigInt(opts.watch.depositWei);
      if (bak > BigInt(0) && bak <= total) depositWei = bak;
    } else if (opts.watch.depositRit) {
      const bak = parseEther(String(opts.watch.depositRit));
      if (bak > BigInt(0) && bak <= total) depositWei = bak;
    }
  } catch {
    /* use total */
  }

  const now = Date.now();
  const w: OracastWatch = {
    id: opts.watch.id || newId(),
    owner,
    coinId: opts.watch.coinId,
    contractAddress: opts.watch.contractAddress,
    chainHint: opts.watch.chainHint,
    symbol: opts.watch.symbol,
    name: opts.watch.name,
    frequencyMin: opts.watch.frequencyMin || 60,
    depositWei: depositWei.toString(),
    active: opts.watch.active !== false,
    lastNotifyAt: opts.watch.lastNotifyAt || 0,
    lastPrice: opts.watch.lastPrice,
    lastSource: opts.watch.lastSource,
    createdAt: opts.watch.createdAt || now,
    fundedTxs: txs,
    notifyCount: opts.watch.notifyCount || 0,
    v: WATCH_VERSION,
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
  if (!w) throw new Error("Watch not found — try restore from this browser first");
  if (w.owner.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error("Not your watch");
  }
  let depositWei: bigint;
  try {
    depositWei = parseEther(String(opts.depositRit || "0"));
  } catch {
    throw new Error("Invalid amount");
  }
  if (depositWei < ORACAST_MIN_DEPOSIT_WEI) {
    throw new Error(
      `Top-up must be at least ${ORACAST_MIN_DEPOSIT_RIT} RIT`
    );
  }
  const { valueWei } = await verifyDepositTx({
    txHash: opts.txHash,
    owner: opts.owner,
    minValueWei: depositWei,
  });
  await markTxUsed(opts.txHash);
  w.depositWei = (BigInt(w.depositWei) + valueWei).toString();
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
  }
  await saveWatch(w);
  return w;
}

export function publicWatch(w: OracastWatch) {
  const cost = costPerAlertWei(w.frequencyMin);
  const hrs = hoursRemaining(w.depositWei);
  const alerts = alertsRemaining(w.depositWei, w.frequencyMin);
  const bal = BigInt(w.depositWei || "0");
  return {
    id: w.id,
    owner: w.owner,
    coinId: w.coinId,
    contractAddress: w.contractAddress,
    symbol: w.symbol,
    name: w.name,
    frequencyMin: w.frequencyMin,
    depositRit: formatEther(bal),
    hoursRemaining: Math.floor(hrs * 10) / 10,
    alertsRemaining: alerts,
    costPerAlertRit: formatEther(cost),
    active: w.active && bal >= cost,
    lastNotifyAt: w.lastNotifyAt,
    lastPrice: w.lastPrice,
    lastSource: w.lastSource,
    notifyCount: w.notifyCount,
    createdAt: w.createdAt,
    rateRitPerHour: ORACAST_RATE_RIT_PER_HOUR,
    fundedTxs: w.fundedTxs,
    durable: upstashConfigured() || Boolean(durablePath()),
  };
}

/**
 * Process due watches — charge only after successful Telegram send.
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
  backend: string;
}> {
  loadDurableFile();
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
    const w = migrateWatch({ ...raw });
    try {
      if (!w.active) {
        results.push({ id: w.id, ok: false, skipped: "paused" });
        continue;
      }

      const cost = costPerAlertWei(w.frequencyMin);
      let bal = BigInt(w.depositWei || "0");
      if (bal < cost) {
        w.active = false;
        await saveWatch(w);
        paused += 1;
        results.push({ id: w.id, ok: false, skipped: "insufficient_balance" });
        continue;
      }

      const dueMs = w.frequencyMin * 60_000;
      const since = w.lastNotifyAt || 0;
      // First alert ASAP; then respect frequency
      if (since > 0 && now - since < dueMs) {
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
        // Do NOT burn balance when Telegram missing
        await saveWatch(w);
        results.push({ id: w.id, ok: false, skipped: "telegram_not_linked" });
        continue;
      }

      const ch =
        quote.change24h != null
          ? `${quote.change24h >= 0 ? "+" : ""}${quote.change24h.toFixed(2)}% 24h`
          : "";
      const left = alertsRemaining(w.depositWei, w.frequencyMin);
      const html =
        `<b>Oracast · ${escapeHtml(w.symbol)}</b>\n` +
        `${escapeHtml(w.name)}\n` +
        `Price: <b>$${escapeHtml(formatUsdPrice(quote.price))}</b>` +
        (ch ? ` · ${escapeHtml(ch)}` : "") +
        `\nSource: ${escapeHtml(quote.source)}` +
        `\nEvery ${w.frequencyMin}m · ~${left} alerts left` +
        `\n<code>${w.id}</code>`;

      await sendTelegramMessage(pref.chatId, html);

      // Charge only after successful send
      bal = BigInt(w.depositWei || "0") - cost;
      if (bal < BigInt(0)) bal = BigInt(0);
      w.depositWei = bal.toString();
      w.lastNotifyAt = now;
      w.notifyCount = (w.notifyCount || 0) + 1;
      if (bal < cost) w.active = false;
      await saveWatch(w);
      notified += 1;
      results.push({ id: w.id, ok: true, price: quote.price });
    } catch (e) {
      results.push({
        id: w.id,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 160) : "tick failed",
      });
      // Do not burn on failure — only refresh price fields if we set them
      try {
        await saveWatch(w);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    scanned: slice.length,
    notified,
    paused,
    results,
    backend: upstashConfigured()
      ? "upstash"
      : durablePath()
        ? "file"
        : "memory",
  };
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

export function storageHint(): string {
  if (upstashConfigured()) return "upstash";
  if (process.env.VERCEL) {
    return "vercel-ephemeral — set UPSTASH_REDIS_REST_URL + TOKEN for closed-tab alerts";
  }
  return durablePath() ? "file" : "memory";
}
