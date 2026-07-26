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
import { privateKeyToAccount } from "viem/accounts";
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

/** Full units of this = 1 bounty poll interaction (matches hourly Oracast rate). */
export const ORACAST_INTERACTION_RIT = ORACAST_RATE_RIT_PER_HOUR;
export const ORACAST_INTERACTION_WEI = ORACAST_RATE_WEI;

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
  /** Total RIT charged from this watch (wei) — bounty poll uses 0.005 RIT units */
  consumedWei?: string;
  /** How many full 0.005 RIT bounty interactions already credited on-chain */
  bountyCreditsIssued?: number;
  /** Schema version for migrations */
  v?: number;
};

const KEY_PREFIX = "rite:oracast:watch:";
const INDEX_KEY = "rite:oracast:watch_index";
const TX_KEY_PREFIX = "rite:oracast:tx:";
/** Single blob — more reliable than SADD indexes across cold starts */
const ALL_BLOB_KEY = "rite:oracast:all_v2";
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

type AllBlob = {
  watches: Record<string, OracastWatch>;
  usedTx?: string[];
  updatedAt?: number;
};

async function loadAllBlobFromUpstash(): Promise<void> {
  if (!upstashConfigured()) return;
  try {
    const raw = await upstashCmd(["GET", ALL_BLOB_KEY]);
    if (raw == null || raw === "") return;
    const blob =
      typeof raw === "string"
        ? (JSON.parse(raw) as AllBlob)
        : (raw as AllBlob);
    if (!blob?.watches) return;
    for (const w of Object.values(blob.watches)) {
      if (w?.id && w?.owner) mem().set(w.id, migrateWatch(w));
    }
    if (Array.isArray(blob.usedTx)) {
      for (const t of blob.usedTx) memTx().add(String(t).toLowerCase());
    }
  } catch (e) {
    console.warn("[oracastWatch] load all blob failed", e);
  }
}

async function saveAllBlobToUpstash(opts?: {
  /** Ids to drop even if still present on remote (cancel / withdraw). */
  removeIds?: string[];
}): Promise<void> {
  if (!upstashConfigured()) return;
  // Merge remote blob so concurrent serverless saves cannot drop other watches
  let remoteWatches: Record<string, OracastWatch> = {};
  let remoteTx: string[] = [];
  try {
    const raw = await upstashCmd(["GET", ALL_BLOB_KEY]);
    if (raw != null && raw !== "") {
      const prev =
        typeof raw === "string"
          ? (JSON.parse(raw) as AllBlob)
          : (raw as AllBlob);
      if (prev?.watches) remoteWatches = { ...prev.watches };
      if (Array.isArray(prev?.usedTx)) remoteTx = prev.usedTx.map(String);
    }
  } catch {
    /* use mem only */
  }
  const watches: Record<string, OracastWatch> = { ...remoteWatches };
  mem().forEach((w, id) => {
    watches[id] = w;
  });
  for (const id of opts?.removeIds || []) {
    delete watches[id];
  }
  const used = new Set<string>([
    ...remoteTx.map((t) => t.toLowerCase()),
    ...Array.from(memTx()).map((t) => t.toLowerCase()),
  ]);
  const blob: AllBlob = {
    watches,
    usedTx: Array.from(used).slice(-500),
    updatedAt: Date.now(),
  };
  await upstashCmd(["SET", ALL_BLOB_KEY, JSON.stringify(blob)]);
}

function assertDurableOnVercel(): void {
  if (process.env.VERCEL && !upstashConfigured()) {
    throw new Error(
      "Closed-tab Oracast needs Upstash. On Vercel set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Production), then Redeploy."
    );
  }
}

export async function getWatch(id: string): Promise<OracastWatch | null> {
  loadDurableFile();
  await loadAllBlobFromUpstash();
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
  await loadAllBlobFromUpstash();
  const next = migrateWatch({ ...w, v: WATCH_VERSION });
  mem().set(next.id, next);
  saveDurableFile();

  if (upstashConfigured()) {
    try {
      // Per-key + full blob (blob is source of truth for cron listAll)
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
      await saveAllBlobToUpstash();
    } catch (e) {
      console.error("[oracastWatch] CRITICAL remote save failed", e);
      throw new Error(
        "Could not save watch to Upstash. Check UPSTASH_REDIS_REST_URL/TOKEN on Vercel Production and redeploy."
      );
    }
  } else if (process.env.VERCEL) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN required on Vercel for Oracast (closed-tab alerts)."
    );
  }
}

export async function listWatchesByOwner(
  owner: string
): Promise<OracastWatch[]> {
  loadDurableFile();
  await loadAllBlobFromUpstash();
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
  await loadAllBlobFromUpstash();
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

/** Diagnostics for UI / health (no secrets). */
export async function getOracastRuntimeStatus(): Promise<{
  upstash: boolean;
  telegramBot: boolean;
  storage: string;
  activeWatches: number;
  totalWatches: number;
  vercel: boolean;
  closedTabReady: boolean;
  hint: string;
}> {
  loadDurableFile();
  await loadAllBlobFromUpstash();
  const all = Array.from(mem().values());
  const active = all.filter(
    (w) => w.active && BigInt(w.depositWei || "0") > BigInt(0)
  );
  // Prefer remote count if upstash
  let activeCount = active.length;
  let totalCount = all.length;
  try {
    const remote = await listAllActiveWatches();
    activeCount = remote.length;
    if (upstashConfigured()) {
      const raw = await upstashCmd(["GET", ALL_BLOB_KEY]);
      if (raw) {
        const blob =
          typeof raw === "string"
            ? (JSON.parse(raw) as AllBlob)
            : (raw as AllBlob);
        totalCount = Object.keys(blob.watches || {}).length;
      }
    }
  } catch {
    /* keep mem counts */
  }

  const upstash = upstashConfigured();
  const telegramBot = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  const closedTabReady = upstash && telegramBot;
  let hint = "OK — closed-tab alerts need GitHub Agent keeper or external cron poking /api/oracast/tick";
  if (!upstash) {
    hint =
      "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN on Vercel Production and Redeploy";
  } else if (!telegramBot) {
    hint = "Set TELEGRAM_BOT_TOKEN on Vercel";
  } else {
    hint =
      "Storage OK. Enable GitHub Action “Agent keeper” (APP_URL + CRON_SECRET) so ticks run with the tab closed. Re-open Oracast Alert once after deploy to restore watches.";
  }

  return {
    upstash,
    telegramBot,
    storage: storageHint(),
    activeWatches: activeCount,
    totalWatches: totalCount,
    vercel: Boolean(process.env.VERCEL),
    closedTabReady,
    hint,
  };
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
  assertDurableOnVercel();
  loadDurableFile();
  await loadAllBlobFromUpstash();
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

/** Fully remove a watch from memory + Upstash (stops alerts). */
export async function deleteWatchRecord(
  watchId: string,
  owner: string
): Promise<void> {
  loadDurableFile();
  await loadAllBlobFromUpstash();
  const w = mem().get(watchId) || (await getWatch(watchId));
  if (!w) return;
  if (w.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Not your watch");
  }
  mem().delete(watchId);
  saveDurableFile();
  if (upstashConfigured()) {
    try {
      await upstashCmd(["DEL", `${KEY_PREFIX}${watchId}`]);
      await upstashCmd(["SREM", INDEX_KEY, watchId]);
      await upstashCmd([
        "SREM",
        `${INDEX_KEY}:${owner.toLowerCase()}`,
        watchId,
      ]);
      await saveAllBlobToUpstash({ removeIds: [watchId] });
    } catch (e) {
      console.error("[oracastWatch] delete remote failed", e);
      throw new Error("Could not delete watch from storage");
    }
  }
}

function normalizeRefundPk(raw: string): `0x${string}` {
  const t = raw.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as `0x${string}`;
}

/**
 * Private key that holds prepaid Oracast deposits (must be fee recipient).
 * Env (server-only, never NEXT_PUBLIC_):
 *   ORACAST_REFUND_PRIVATE_KEY  preferred
 *   FEE_RECIPIENT_PRIVATE_KEY   alias
 */
export function oracastRefundConfigured(): boolean {
  return Boolean(
    process.env.ORACAST_REFUND_PRIVATE_KEY?.trim() ||
      process.env.FEE_RECIPIENT_PRIVATE_KEY?.trim()
  );
}

/** Public diagnostics — no secrets / no full addresses required. */
export function oracastRefundPublicStatus(): {
  configured: boolean;
  feeRecipient: string;
  matchesFeeRecipient?: boolean;
} {
  const fee = (FEE_RECIPIENT || "").toLowerCase();
  const base = {
    configured: oracastRefundConfigured(),
    feeRecipient: fee,
  };
  if (!base.configured) return base;
  try {
    const pk =
      process.env.ORACAST_REFUND_PRIVATE_KEY?.trim() ||
      process.env.FEE_RECIPIENT_PRIVATE_KEY?.trim() ||
      "";
    const acc = privateKeyToAccount(normalizeRefundPk(pk));
    return {
      ...base,
      matchesFeeRecipient: acc.address.toLowerCase() === fee,
    };
  } catch {
    return { ...base, matchesFeeRecipient: false };
  }
}

/**
 * Cancel live alert and refund remaining prepaid RIT to the owner.
 * Deposits were native transfers to fee recipient — refunds MUST be signed
 * by the same fee-recipient key (ORACAST_REFUND_PRIVATE_KEY).
 */
export async function cancelAndWithdrawWatch(opts: {
  watchId: string;
  owner: string;
}): Promise<{
  deleted: boolean;
  refundedRit: string;
  refundedWei: string;
  txHash?: string;
  skippedRefund?: string;
}> {
  const owner = opts.owner.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(owner)) {
    throw new Error("Invalid owner");
  }
  const w = await getWatch(opts.watchId);
  if (!w) throw new Error("Watch not found");
  if (w.owner.toLowerCase() !== owner) {
    throw new Error("Not your watch");
  }
  // Guard watch id shape (prevent odd store keys)
  if (!/^ow_[a-z0-9]+_[a-z0-9]+$/i.test(opts.watchId)) {
    throw new Error("Invalid watch id");
  }

  let bal = BigInt(0);
  try {
    bal = BigInt(w.depositWei || "0");
  } catch {
    bal = BigInt(0);
  }

  // Stop ticks immediately so balance cannot be spent during refund
  w.active = false;
  await saveWatch(w);

  // Dust below ~1e12 wei (~0.000001 RIT) — just delete, no chain send
  const dust = BigInt(1_000_000_000_000);
  if (bal <= dust) {
    await deleteWatchRecord(opts.watchId, owner);
    return {
      deleted: true,
      refundedRit: "0",
      refundedWei: "0",
      skippedRefund: bal > BigInt(0) ? "dust" : "empty",
    };
  }

  const pkRaw =
    process.env.ORACAST_REFUND_PRIVATE_KEY?.trim() ||
    process.env.FEE_RECIPIENT_PRIVATE_KEY?.trim();
  if (!pkRaw) {
    // Leave paused with balance so admin can configure key + user retries
    throw new Error(
      "Refunds not configured. Set ORACAST_REFUND_PRIVATE_KEY on Vercel to the fee-recipient wallet private key, then Redeploy and retry Cancel & withdraw. Alert is paused."
    );
  }

  const { createWalletClient } = await import("viem");
  const account = privateKeyToAccount(normalizeRefundPk(pkRaw));
  const fee = feeRecipient().toLowerCase();
  // Hard security: never send from a key that is not the deposit treasury
  if (account.address.toLowerCase() !== fee) {
    throw new Error(
      `Refund key address ${account.address.slice(0, 10)}… does not match fee recipient ${fee.slice(0, 10)}… — refusing to send. Fix ORACAST_REFUND_PRIVATE_KEY.`
    );
  }

  const client = createPublicClient({
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 25_000, retryCount: 2 }),
  });
  const wallet = createWalletClient({
    account,
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 60_000 }),
  });

  const gasLimit = BigInt(35_000);
  const block = await client.getBlock({ blockTag: "latest" });
  const base = block.baseFeePerGas ?? BigInt(1);
  const maxPriorityFeePerGas = BigInt(1_000_000);
  let maxFeePerGas = base * BigInt(3) + maxPriorityFeePerGas;
  if (maxFeePerGas < BigInt(10_000_000)) maxFeePerGas = BigInt(10_000_000);
  if (maxFeePerGas > BigInt(5_000_000_000)) maxFeePerGas = BigInt(5_000_000_000);

  const gasCost = gasLimit * maxFeePerGas;
  const walletBal = await client.getBalance({ address: account.address });
  // Keep a small gas reserve on treasury so the key remains usable
  const gasReserve = parseEther("0.02");
  if (walletBal < bal + gasCost + gasReserve) {
    throw new Error(
      `Treasury refund wallet low on RIT (have ${formatEther(walletBal)}, need ~${formatEther(bal + gasCost + gasReserve)} incl. 0.02 gas reserve). Top up fee recipient.`
    );
  }

  // Zero ledger before send so a double-click cannot double-pay
  const refundWei = bal;
  w.depositWei = "0";
  await saveWatch(w);

  let txHash: `0x${string}`;
  try {
    const nonce = await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    txHash = await wallet.sendTransaction({
      account,
      chain: ritualChain,
      to: owner as `0x${string}`,
      value: refundWei,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      type: "eip1559",
    });
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      timeout: 120_000,
    });
    if (receipt.status !== "success") {
      // Restore balance so user can retry
      w.depositWei = refundWei.toString();
      w.active = false;
      await saveWatch(w);
      throw new Error("Refund transaction reverted on-chain");
    }
  } catch (e) {
    // Restore prepaid balance if we zeroed but send failed
    try {
      const cur = await getWatch(opts.watchId);
      if (cur && BigInt(cur.depositWei || "0") === BigInt(0)) {
        cur.depositWei = refundWei.toString();
        cur.active = false;
        await saveWatch(cur);
      }
    } catch {
      /* best effort */
    }
    throw e instanceof Error
      ? e
      : new Error("Refund send failed");
  }

  await deleteWatchRecord(opts.watchId, owner);

  return {
    deleted: true,
    refundedRit: formatEther(refundWei),
    refundedWei: refundWei.toString(),
    txHash,
  };
}

/**
 * Delete alert only. Remaining prepaid balance is refunded when possible;
 * if refund key missing and balance remains, rejects (use cancelAndWithdraw).
 */
export async function deleteOracastWatch(opts: {
  watchId: string;
  owner: string;
  /** When true (default), refund remaining then delete. */
  withdraw?: boolean;
}): Promise<{
  deleted: boolean;
  refundedRit: string;
  refundedWei: string;
  txHash?: string;
  skippedRefund?: string;
}> {
  if (opts.withdraw === false) {
    const w = await getWatch(opts.watchId);
    if (!w) throw new Error("Watch not found");
    if (w.owner.toLowerCase() !== opts.owner.toLowerCase()) {
      throw new Error("Not your watch");
    }
    let bal = BigInt(0);
    try {
      bal = BigInt(w.depositWei || "0");
    } catch {
      bal = BigInt(0);
    }
    if (bal > BigInt(1_000_000_000_000)) {
      throw new Error(
        "This watch still has prepaid RIT. Use Cancel & withdraw to refund and remove it."
      );
    }
    await deleteWatchRecord(opts.watchId, opts.owner);
    return {
      deleted: true,
      refundedRit: "0",
      refundedWei: "0",
      skippedRefund: "empty",
    };
  }
  return cancelAndWithdrawWatch(opts);
}

export function publicWatch(w: OracastWatch) {
  const cost = costPerAlertWei(w.frequencyMin);
  const hrs = hoursRemaining(w.depositWei);
  const alerts = alertsRemaining(w.depositWei, w.frequencyMin);
  const bal = BigInt(w.depositWei || "0");
  const last = Number(w.lastNotifyAt || 0);
  const dueMs = Math.max(1, Number(w.frequencyMin) || 60) * 60_000;
  const nextNotifyAt =
    last > 0 ? last + dueMs : w.active && bal >= cost ? Date.now() : 0;
  const now = Date.now();
  let nextLabel = "—";
  if (!w.active || bal < cost) {
    nextLabel = bal < cost ? "fund to resume" : "paused";
  } else if (last <= 0) {
    nextLabel = "due now";
  } else if (now >= nextNotifyAt) {
    nextLabel = "due now";
  } else {
    const sec = Math.ceil((nextNotifyAt - now) / 1000);
    if (sec < 60) nextLabel = `in ${sec}s`;
    else if (sec < 3600) nextLabel = `in ${Math.ceil(sec / 60)}m`;
    else nextLabel = `in ${Math.ceil(sec / 3600)}h`;
  }
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
    nextNotifyAt,
    nextLabel,
    lastPrice: w.lastPrice,
    lastSource: w.lastSource,
    notifyCount: w.notifyCount,
    createdAt: w.createdAt,
    rateRitPerHour: ORACAST_RATE_RIT_PER_HOUR,
    fundedTxs: w.fundedTxs,
    durable: upstashConfigured() || Boolean(durablePath()),
    consumedRit: (() => {
      try {
        return formatEther(BigInt(w.consumedWei || "0"));
      } catch {
        return "0";
      }
    })(),
    bountyCreditsIssued: Number(w.bountyCreditsIssued || 0),
    /** Full 0.005 RIT units toward next bounty interaction */
    bountyUnitsEarned: (() => {
      try {
        return Number(BigInt(w.consumedWei || "0") / ORACAST_INTERACTION_WEI);
      } catch {
        return 0;
      }
    })(),
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
    bountyOk?: boolean;
    bountyReason?: string;
    bountyTx?: string;
    bountyCreditsThisTick?: number;
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
    bountyOk?: boolean;
    bountyReason?: string;
    bountyTx?: string;
    bountyCreditsThisTick?: number;
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
      if (pref.enabled === false) {
        results.push({ id: w.id, ok: false, skipped: "telegram_disabled" });
        continue;
      }

      const ch =
        quote.change24h != null
          ? `${quote.change24h >= 0 ? "+" : ""}${quote.change24h.toFixed(2)}% 24h`
          : "";
      const left = alertsRemaining(w.depositWei, w.frequencyMin);
      const html =
        `<b>Oracast Alert · ${escapeHtml(w.symbol)}</b>\n` +
        `${escapeHtml(w.name)}\n` +
        `Price: <b>$${escapeHtml(formatUsdPrice(quote.price))}</b>` +
        (ch ? ` · ${escapeHtml(ch)}` : "") +
        `\nSource: ${escapeHtml(quote.source)}` +
        `\nEvery ${w.frequencyMin}m · ~${left} alerts left` +
        `\n<code>${w.id}</code>`;

      await sendTelegramMessage(pref.chatId, html);

      // Charge + persist IMMEDIATELY after successful send so frequency /
      // balance survive even if bounty chain work times out later.
      bal = BigInt(w.depositWei || "0") - cost;
      if (bal < BigInt(0)) bal = BigInt(0);
      w.depositWei = bal.toString();
      w.lastNotifyAt = now;
      w.notifyCount = (w.notifyCount || 0) + 1;
      if (bal < cost) w.active = false;

      let consumed = BigInt(0);
      try {
        consumed = BigInt(w.consumedWei || "0") + cost;
      } catch {
        consumed = cost;
      }
      w.consumedWei = consumed.toString();

      // Critical path: durable lastNotifyAt before any on-chain bounty
      await saveWatch(w);
      notified += 1;

      let bountyCredits = Number(w.bountyCreditsIssued || 0);
      if (!Number.isFinite(bountyCredits) || bountyCredits < 0) bountyCredits = 0;
      const earned = Number(consumed / ORACAST_INTERACTION_WEI);
      const dueCredits = Math.max(0, earned - bountyCredits);

      let bountyOk = true;
      let bountyReason: string | undefined;
      let bountyTx: string | undefined;
      let bountyCreditsThisTick = 0;

      if (dueCredits > 0) {
        try {
          const { creditOracastBountyInteraction } = await import(
            "@/lib/oracastBounty"
          );
          // Cap 1 per tick — chain credit must never delay next price DMs
          const toCredit = Math.min(dueCredits, 1);
          for (let i = 0; i < toCredit; i++) {
            const bounty = await Promise.race([
              creditOracastBountyInteraction(w.owner),
              new Promise<{ ok: false; reason: string }>((resolve) =>
                setTimeout(
                  () => resolve({ ok: false, reason: "bounty_timeout" }),
                  12_000
                )
              ),
            ]);
            if (bounty.ok) {
              bountyCredits += 1;
              bountyCreditsThisTick += 1;
              if ("txHash" in bounty && bounty.txHash) bountyTx = bounty.txHash;
            } else {
              bountyOk = false;
              bountyReason =
                ("reason" in bounty && bounty.reason) || "credit_failed";
              break;
            }
          }
          if (dueCredits > toCredit && bountyOk) {
            bountyReason = "deferred_remaining";
          }
          if (bountyCreditsThisTick > 0) {
            w.bountyCreditsIssued = bountyCredits;
            await saveWatch(w);
          }
        } catch (be) {
          bountyOk = false;
          bountyReason =
            be instanceof Error ? be.message.slice(0, 80) : "bounty_error";
          console.warn("[oracastWatch] bounty credit error", bountyReason);
        }
      }

      results.push({
        id: w.id,
        ok: true,
        price: quote.price,
        bountyOk: dueCredits === 0 ? true : bountyOk,
        bountyReason:
          dueCredits === 0
            ? `need_${ORACAST_INTERACTION_RIT}_rit_consumed`
            : bountyReason,
        bountyTx,
        bountyCreditsThisTick,
      });
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
