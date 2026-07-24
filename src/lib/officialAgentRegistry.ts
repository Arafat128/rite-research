/**
 * Server registry for official Ritual TEE agents (Persistent / Sovereign).
 * Browser localStorage still holds UI list; this store powers closed-tab Telegram.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import path from "path";
import { resolveTelegramPref } from "@/lib/telegramPrefs";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { EXPLORER_URL } from "@/lib/ritual";

export type OfficialKind = "sovereign" | "persistent";

export type OfficialAgentServerRecord = {
  kind: OfficialKind;
  name: string;
  owner: string;
  childAddress: string;
  userSalt?: string;
  createTx?: string;
  createdAt: number;
  prompt?: string;
  model?: string;
  executor?: string;
  status?: string;
  /** Last activity signature we already alerted on */
  lastAlertKey?: string;
  lastAlertAt?: number;
  lastSeenBlock?: number;
  lastSeenState?: string;
  telegramEnabled?: boolean;
};

const ALL_KEY = "rite:official:agents_v1";
const KEY_PREFIX = "rite:official:agent:";

type G = typeof globalThis & {
  __riteOfficialAgents?: Map<string, OfficialAgentServerRecord>;
  __riteOfficialFileLoaded?: boolean;
};

function mem(): Map<string, OfficialAgentServerRecord> {
  const g = globalThis as G;
  if (!g.__riteOfficialAgents) g.__riteOfficialAgents = new Map();
  return g.__riteOfficialAgents;
}

function addrKey(a: string) {
  return a.toLowerCase();
}

function upstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

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
    if (process.env.OFFICIAL_AGENTS_PATH) return process.env.OFFICIAL_AGENTS_PATH;
    if (process.env.RITE_DATA_DIR) {
      return path.join(process.env.RITE_DATA_DIR, "official-agents.json");
    }
    return process.env.VERCEL
      ? path.join("/tmp", "rite-official-agents.json")
      : path.join(process.cwd(), ".data", "official-agents.json");
  } catch {
    return null;
  }
}

function loadFile(): void {
  const g = globalThis as G;
  if (g.__riteOfficialFileLoaded) return;
  g.__riteOfficialFileLoaded = true;
  const file = durablePath();
  if (!file || !existsSync(file)) return;
  try {
    const raw = readFileSync(file, "utf8");
    const data = JSON.parse(raw) as {
      agents?: Record<string, OfficialAgentServerRecord>;
    };
    if (data.agents) {
      for (const [k, v] of Object.entries(data.agents)) {
        if (v?.childAddress && v?.owner) mem().set(k.toLowerCase(), v);
      }
    }
  } catch (e) {
    console.warn("[officialRegistry] file load", e);
  }
}

function saveFile(): void {
  const file = durablePath();
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const agents: Record<string, OfficialAgentServerRecord> = {};
    mem().forEach((v, k) => {
      agents[k] = v;
    });
    writeFileSync(file, JSON.stringify({ agents, updatedAt: Date.now() }), "utf8");
  } catch (e) {
    console.warn("[officialRegistry] file save", e);
  }
}

async function loadRemote(): Promise<void> {
  if (!upstashConfigured()) return;
  try {
    const raw = await upstashCmd(["GET", ALL_KEY]);
    if (raw == null || raw === "") return;
    const data =
      typeof raw === "string"
        ? (JSON.parse(raw) as { agents?: Record<string, OfficialAgentServerRecord> })
        : (raw as { agents?: Record<string, OfficialAgentServerRecord> });
    if (!data.agents) return;
    for (const [k, v] of Object.entries(data.agents)) {
      if (v?.childAddress && v?.owner) mem().set(k.toLowerCase(), v);
    }
  } catch (e) {
    console.warn("[officialRegistry] remote load", e);
  }
}

async function saveRemote(): Promise<void> {
  if (!upstashConfigured()) return;
  const agents: Record<string, OfficialAgentServerRecord> = {};
  mem().forEach((v, k) => {
    agents[k] = v;
  });
  await upstashCmd([
    "SET",
    ALL_KEY,
    JSON.stringify({ agents, updatedAt: Date.now() }),
  ]);
}

export async function upsertOfficialAgent(
  rec: OfficialAgentServerRecord
): Promise<OfficialAgentServerRecord> {
  loadFile();
  await loadRemote();
  const key = addrKey(rec.childAddress);
  const prev = mem().get(key);
  const next: OfficialAgentServerRecord = {
    ...prev,
    ...rec,
    owner: rec.owner.toLowerCase(),
    childAddress: rec.childAddress.toLowerCase(),
    telegramEnabled: rec.telegramEnabled !== false,
    createdAt: rec.createdAt || prev?.createdAt || Date.now(),
  };
  // Preserve alert cursor unless explicit reset
  if (prev?.lastAlertKey && !rec.lastAlertKey) {
    next.lastAlertKey = prev.lastAlertKey;
    next.lastAlertAt = prev.lastAlertAt;
    next.lastSeenBlock = prev.lastSeenBlock;
    next.lastSeenState = prev.lastSeenState;
  }
  mem().set(key, next);
  saveFile();
  try {
    await saveRemote();
    if (upstashConfigured()) {
      await upstashCmd([
        "SET",
        `${KEY_PREFIX}${key}`,
        JSON.stringify(next),
      ]);
    }
  } catch (e) {
    console.warn("[officialRegistry] remote save", e);
  }
  return next;
}

export async function listOfficialByOwner(
  owner: string
): Promise<OfficialAgentServerRecord[]> {
  loadFile();
  await loadRemote();
  const o = owner.toLowerCase();
  return Array.from(mem().values())
    .filter((a) => a.owner.toLowerCase() === o)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAllOfficial(): Promise<OfficialAgentServerRecord[]> {
  loadFile();
  await loadRemote();
  return Array.from(mem().values());
}

type ExplorerCache = {
  persistent?: Array<{
    address?: string;
    info?: {
      owner?: string;
      agentAddress?: string;
      lastHeartbeatBlock?: number;
      heartbeatTimeout?: number;
      state?: string;
      isAlive?: boolean;
      latestManifestCID?: string;
      lastExecutor?: string;
    };
  }>;
  sovereign?: Array<{
    address?: string;
    lastActivityBlock?: number;
  }>;
  currentBlock?: number;
  lastUpdated?: string;
};

async function fetchExplorerCache(): Promise<ExplorerCache | null> {
  try {
    const res = await fetch(
      "https://explorer.ritualfoundation.org/api/agents/cache",
      { cache: "no-store", signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return null;
    return (await res.json()) as ExplorerCache;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function explorerAgentUrl(address: string): string {
  return `${EXPLORER_URL.replace(/\/$/, "")}/address/${address}`;
}

/**
 * Poll explorer for official agent activity and Telegram on changes.
 * Safe no-op when no agents registered or Telegram missing.
 */
export async function tickOfficialAgentAlerts(opts?: {
  onlyOwner?: string;
  max?: number;
}): Promise<{
  scanned: number;
  alerted: number;
  results: Array<{
    address: string;
    ok: boolean;
    skipped?: string;
    error?: string;
    alertKey?: string;
  }>;
}> {
  loadFile();
  await loadRemote();

  let agents = await listAllOfficial();
  if (opts?.onlyOwner) {
    const o = opts.onlyOwner.toLowerCase();
    agents = agents.filter((a) => a.owner === o);
  }
  agents = agents.filter((a) => a.telegramEnabled !== false);
  const max = opts?.max ?? 40;
  const slice = agents.slice(0, max);

  const results: Array<{
    address: string;
    ok: boolean;
    skipped?: string;
    error?: string;
    alertKey?: string;
  }> = [];
  let alerted = 0;

  if (slice.length === 0) {
    return { scanned: 0, alerted: 0, results: [] };
  }
  if (!telegramConfigured()) {
    return {
      scanned: slice.length,
      alerted: 0,
      results: slice.map((a) => ({
        address: a.childAddress,
        ok: false,
        skipped: "telegram_not_configured",
      })),
    };
  }

  const cache = await fetchExplorerCache();
  if (!cache) {
    return {
      scanned: slice.length,
      alerted: 0,
      results: slice.map((a) => ({
        address: a.childAddress,
        ok: false,
        skipped: "explorer_cache_unavailable",
      })),
    };
  }

  const pMap = new Map<string, NonNullable<ExplorerCache["persistent"]>[0]>();
  for (const p of cache.persistent || []) {
    const a = (p.address || p.info?.agentAddress || "").toLowerCase();
    if (a) pMap.set(a, p);
  }
  const sMap = new Map<string, NonNullable<ExplorerCache["sovereign"]>[0]>();
  for (const s of cache.sovereign || []) {
    const a = (s.address || "").toLowerCase();
    if (a) sMap.set(a, s);
  }

  for (const rec of slice) {
    const addr = rec.childAddress.toLowerCase();
    try {
      let alertKey = "";
      let title = "";
      let body = "";
      let block = 0;
      let state = "";

      if (rec.kind === "persistent") {
        const hit = pMap.get(addr);
        if (!hit) {
          // Not in heartbeat registry yet — launch ping once
          alertKey = `launch:${rec.createTx || rec.createdAt}`;
          title = "Persistent agent registered";
          body =
            `Not yet listed on AgentHeartbeat explorer cache.\n` +
            `Status: ${escapeHtml(rec.status || "launched")}`;
        } else {
          const hb = Number(hit.info?.lastHeartbeatBlock || 0);
          const st = String(
            hit.info?.state ||
              (hit.info?.isAlive === true
                ? "MONITORED"
                : hit.info?.isAlive === false
                  ? "FAILED"
                  : "UNKNOWN")
          ).toUpperCase();
          block = hb;
          state = st;
          alertKey = `p:${hb}:${st}:${String(hit.info?.latestManifestCID || "").slice(0, 48)}`;
          title = `Persistent · ${st}`;
          body =
            `Heartbeat block: <b>${hb || "—"}</b>\n` +
            `State: <b>${escapeHtml(st)}</b>\n` +
            (hit.info?.latestManifestCID
              ? `Manifest: <code>${escapeHtml(
                  String(hit.info.latestManifestCID).slice(0, 80)
                )}</code>\n`
              : "") +
            (hit.info?.lastExecutor
              ? `Executor: <code>${escapeHtml(
                  String(hit.info.lastExecutor).slice(0, 12)
                )}…</code>\n`
              : "");
        }
      } else {
        // sovereign
        const hit = sMap.get(addr);
        if (!hit) {
          alertKey = `launch:${rec.createTx || rec.createdAt}`;
          title = "Sovereign agent registered";
          body =
            `Not yet listed on scheduled sovereign explorer cache.\n` +
            `Status: ${escapeHtml(rec.status || "launched")}`;
        } else {
          const act = Number(hit.lastActivityBlock || 0);
          block = act;
          state = "ACTIVE";
          alertKey = `s:${act}`;
          title = "Sovereign · activity";
          body = `Last activity block: <b>${act || "—"}</b>\n`;
        }
      }

      if (!alertKey) {
        results.push({ address: addr, ok: false, skipped: "no_signal" });
        continue;
      }

      // Skip if already alerted for this exact activity
      if (rec.lastAlertKey === alertKey) {
        // Still refresh seen fields
        rec.lastSeenBlock = block || rec.lastSeenBlock;
        rec.lastSeenState = state || rec.lastSeenState;
        mem().set(addr, rec);
        results.push({
          address: addr,
          ok: false,
          skipped: "already_alerted",
          alertKey,
        });
        continue;
      }

      // First registration: send launch notice only once
      const isLaunchOnly = alertKey.startsWith("launch:");
      if (isLaunchOnly && rec.lastAlertKey?.startsWith("launch:")) {
        results.push({
          address: addr,
          ok: false,
          skipped: "already_alerted",
          alertKey,
        });
        continue;
      }

      const pref = await resolveTelegramPref(rec.owner);
      if (!pref?.chatId) {
        results.push({
          address: addr,
          ok: false,
          skipped: "telegram_not_linked",
        });
        continue;
      }
      if (pref.enabled === false) {
        results.push({
          address: addr,
          ok: false,
          skipped: "telegram_disabled",
        });
        continue;
      }

      const kindLabel =
        rec.kind === "persistent" ? "Persistent (0x0820)" : "Sovereign (0x080C)";
      const html =
        `<b>Rite · Official Ritual agent</b>\n` +
        `<b>${escapeHtml(rec.name)}</b> · ${kindLabel}\n` +
        `${escapeHtml(title)}\n` +
        body +
        `\n<code>${escapeHtml(addr)}</code>\n` +
        `<a href="${escapeHtml(explorerAgentUrl(addr))}">Open on Ritual ↗</a>`;

      await sendTelegramMessage(pref.chatId, html);

      rec.lastAlertKey = alertKey;
      rec.lastAlertAt = Date.now();
      rec.lastSeenBlock = block || rec.lastSeenBlock;
      rec.lastSeenState = state || rec.lastSeenState;
      mem().set(addr, rec);
      saveFile();
      try {
        await saveRemote();
      } catch {
        /* keep memory/file */
      }

      alerted += 1;
      results.push({ address: addr, ok: true, alertKey });
    } catch (e) {
      results.push({
        address: addr,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 140) : "tick failed",
      });
    }
  }

  // Persist any soft lastSeen updates
  try {
    await saveRemote();
    saveFile();
  } catch {
    /* ignore */
  }

  return { scanned: slice.length, alerted, results };
}

export function publicOfficial(a: OfficialAgentServerRecord) {
  return {
    kind: a.kind,
    name: a.name,
    owner: a.owner,
    childAddress: a.childAddress,
    createdAt: a.createdAt,
    model: a.model,
    status: a.status,
    telegramEnabled: a.telegramEnabled !== false,
    lastAlertAt: a.lastAlertAt,
    lastSeenBlock: a.lastSeenBlock,
    lastSeenState: a.lastSeenState,
    explorerUrl: explorerAgentUrl(a.childAddress),
  };
}
