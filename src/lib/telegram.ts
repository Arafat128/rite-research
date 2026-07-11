/**
 * Telegram Bot API helpers (server-only).
 * Docs: https://core.telegram.org/bots/api
 */

import { EXPLORER_URL as EXPLORER } from "@/lib/ritual";
import {
  resolveTelegramPref,
  shouldNotifyAgent,
  type TelegramPref,
} from "@/lib/telegramPrefs";
import {
  snapshotCellHref,
  snapshotCellText,
  type SnapshotCell,
} from "@/lib/surfData";
import { sanitizeHttpUrl } from "@/lib/safeUrl";

const API = "https://api.telegram.org";
/** Telegram message hard limit */
const TG_MAX = 4096;

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function telegramBotUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "").replace(
    /^@/,
    ""
  );
}

async function botApi<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result as T;
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts?: { disablePreview?: boolean }
): Promise<void> {
  await botApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, TG_MAX),
    parse_mode: "HTML",
    // Many article links — previews would spam; keep text clean
    disable_web_page_preview: opts?.disablePreview ?? true,
  });
}

export type TickNotifyPayload = {
  owner: string;
  agentId: string;
  agentName?: string;
  runCount: string;
  summary: string;
  kindLabel?: string;
  target?: string;
  txHash?: string;
  died?: boolean;
  /** Same row shape as site DataSnapshotCard (headlines with href, prices, etc.) */
  rows?: Array<Record<string, SnapshotCell>>;
  highlights?: Array<{ label: string; value: string }>;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for use inside double-quoted HTML attribute (href) */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function tgLink(href: string, label: string): string {
  const safe = sanitizeHttpUrl(href);
  if (!safe) return escapeHtml(label);
  // Telegram HTML: <a href="...">text</a>
  return `<a href="${escapeAttr(safe)}">${escapeHtml(label)}</a>`;
}

/**
 * Prefer Headline / Title / Name columns; else first cell that has an href.
 */
function pickPrimaryCell(
  row: Record<string, SnapshotCell>
): { key: string; cell: SnapshotCell } | null {
  const keys = Object.keys(row);
  const prefer = ["Headline", "Title", "Name", "Article", "Link"];
  for (const p of prefer) {
    if (p in row) return { key: p, cell: row[p] };
  }
  for (const k of keys) {
    if (snapshotCellHref(row[k])) return { key: k, cell: row[k] };
  }
  if (keys[0]) return { key: keys[0], cell: row[keys[0]] };
  return null;
}

function formatRowLine(
  row: Record<string, SnapshotCell>,
  index: number
): string {
  const primary = pickPrimaryCell(row);
  if (!primary) return `${index}. —`;

  const text = snapshotCellText(primary.cell).trim() || "—";
  const href = snapshotCellHref(primary.cell);
  const titlePart = href
    ? tgLink(href, text.slice(0, 220))
    : escapeHtml(text.slice(0, 220));

  // Secondary meta: Source, Project, Time, etc. (not the primary col)
  const metaKeys = Object.keys(row).filter(
    (k) =>
      k !== primary.key &&
      !/^raw$/i.test(k) &&
      snapshotCellText(row[k]).trim()
  );
  const meta = metaKeys
    .slice(0, 4)
    .map((k) => {
      const t = snapshotCellText(row[k]).trim();
      const h = snapshotCellHref(row[k]);
      if (h) return tgLink(h, t.slice(0, 80));
      return escapeHtml(t.slice(0, 80));
    })
    .filter(Boolean)
    .join(" · ");

  if (meta) {
    return `<b>${index}.</b> ${titlePart}\n   <i>${meta}</i>`;
  }
  return `<b>${index}.</b> ${titlePart}`;
}

/**
 * Build a readable Telegram HTML message that mirrors the site tick card:
 * header + highlights + up to 8 row lines with clickable article links.
 */
export function formatTickTelegramMessage(p: TickNotifyPayload): string {
  const stream = [p.kindLabel, p.target && p.target !== "_" ? p.target : ""]
    .filter(Boolean)
    .join(" · ");

  const lines: string[] = [
    `<b>Rite · Agent tick</b>`,
    `<i>Type: Data agent · scheduled stream snapshot (not a research report)</i>`,
    ``,
    `Agent <b>#${escapeHtml(String(p.agentId))}</b>${
      p.agentName ? ` · ${escapeHtml(p.agentName)}` : ""
    }`,
  ];
  if (stream) lines.push(`Data stream: <b>${escapeHtml(stream)}</b>`);
  lines.push(
    `Tick <b>#${escapeHtml(String(p.runCount))}</b>${
      p.died ? " · <b>DIED</b> (sovereign complete)" : ""
    }`
  );
  lines.push(``);

  if (p.summary) {
    lines.push(escapeHtml(p.summary.slice(0, 280)));
  }

  if (p.highlights && p.highlights.length > 0) {
    lines.push(``);
    lines.push(
      p.highlights
        .slice(0, 6)
        .map(
          (h) =>
            `<b>${escapeHtml(h.label)}</b>: ${escapeHtml(String(h.value).slice(0, 64))}`
        )
        .join(" · ")
    );
  }

  const rows = Array.isArray(p.rows) ? p.rows.slice(0, 8) : [];
  if (rows.length > 0) {
    lines.push(``);
    // News-style: numbered clickable headlines
    const hasHeadline = rows.some(
      (r) =>
        "Headline" in r ||
        "Title" in r ||
        Object.values(r).some((c) => snapshotCellHref(c))
    );
    if (hasHeadline) {
      lines.push(`<b>Headlines</b> (${rows.length}) — tap to open source:`);
    } else {
      lines.push(`<b>Data</b> (${rows.length} rows):`);
    }
    lines.push(``);
    rows.forEach((row, i) => {
      lines.push(formatRowLine(row, i + 1));
      if (i < rows.length - 1) lines.push(``);
    });
  }

  if (p.txHash) {
    const base = (EXPLORER || "https://explorer.ritualfoundation.org").replace(
      /\/$/,
      ""
    );
    const txUrl = `${base}/tx/${p.txHash}`;
    lines.push(``, tgLink(txUrl, "Seal tx ↗"));
  }

  // Fit under Telegram limit (leave headroom for parse tags)
  let out = lines.join("\n");
  if (out.length > TG_MAX - 20) {
    out = out.slice(0, TG_MAX - 40) + "\n…";
  }
  return out;
}

/**
 * Notify owner if Telegram is linked and agent matches filter.
 * Never throws to callers (log only).
 */
export async function notifyAgentTick(
  p: TickNotifyPayload
): Promise<{ sent: boolean; reason?: string }> {
  if (!telegramConfigured()) {
    return { sent: false, reason: "telegram_not_configured" };
  }
  // Resolve across instances (Upstash) — do not rely on in-memory only
  const pref = await resolveTelegramPref(p.owner);
  if (!pref) return { sent: false, reason: "not_linked" };
  if (!shouldNotifyAgent(pref, p.agentId)) {
    return { sent: false, reason: "filtered" };
  }
  try {
    await sendTelegramMessage(pref.chatId, formatTickTelegramMessage(p));
    return { sent: true };
  } catch (e) {
    console.warn("[telegram] send failed", e);
    return {
      sent: false,
      reason: e instanceof Error ? e.message.slice(0, 120) : "send_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Research report DMs (after settle + reveal)
// ---------------------------------------------------------------------------

export type ResearchNotifyPayload = {
  owner: string;
  researchId: string;
  /** User prompt (optional, truncated in DM) */
  prompt?: string;
  report: string;
  resultHash?: string;
};

/** Avoid double-DM if reveal is called twice for the same id (warm instance). */
const gTg = globalThis as typeof globalThis & {
  __riteTgResearchSent?: Map<string, number>;
};

function researchAlreadySent(researchId: string): boolean {
  if (!gTg.__riteTgResearchSent) gTg.__riteTgResearchSent = new Map();
  const at = gTg.__riteTgResearchSent.get(researchId);
  if (at && Date.now() - at < 24 * 60 * 60 * 1000) return true;
  return false;
}

function markResearchSent(researchId: string): void {
  if (!gTg.__riteTgResearchSent) gTg.__riteTgResearchSent = new Map();
  gTg.__riteTgResearchSent.set(researchId, Date.now());
  // prune old
  if (gTg.__riteTgResearchSent.size > 500) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    Array.from(gTg.__riteTgResearchSent.entries()).forEach(([k, v]) => {
      if (v < cutoff) gTg.__riteTgResearchSent!.delete(k);
    });
  }
}

/** Light markdown → Telegram HTML (safe subset). */
function mdLineToTelegramHtml(line: string): string {
  const t = line.trimEnd();
  if (!t.trim()) return "";
  // skip pure table separators
  if (/^\s*\|?[\s|:\-]+\|?\s*$/.test(t) && t.includes("-")) return "";

  const heading = t.match(/^#{1,4}\s+(.+)$/);
  if (heading) {
    return `<b>${escapeHtml(heading[1].trim())}</b>`;
  }

  // strip leading list markers for cleaner DM
  const body = t.replace(/^[-*+]\s+/, "• ").replace(/^\d+\.\s+/, (m) => m);

  // [label](url)
  const withLinks: string[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(body)) !== null) {
    withLinks.push(formatMdInline(body.slice(last, m.index)));
    withLinks.push(tgLink(m[2], m[1]));
    last = m.index + m[0].length;
  }
  withLinks.push(formatMdInline(body.slice(last)));
  return withLinks.join("");
}

function formatMdInline(s: string): string {
  // **bold**
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts
    .map((p) => {
      const bm = p.match(/^\*\*(.+)\*\*$/);
      if (bm) return `<b>${escapeHtml(bm[1])}</b>`;
      return escapeHtml(p);
    })
    .join("");
}

/**
 * Split report into Telegram-sized HTML chunks (≤ ~3500 body chars each).
 */
export function formatResearchTelegramMessages(
  p: ResearchNotifyPayload
): string[] {
  const header = [
    `<b>Rite · Research report</b>`,
    `<i>Type: Pay-per-prompt research · full report (not an agent tick)</i>`,
    ``,
    `Research <b>#${escapeHtml(String(p.researchId))}</b>`,
  ];
  if (p.prompt?.trim()) {
    header.push(
      `Prompt: <i>${escapeHtml(p.prompt.trim().slice(0, 180))}${
        p.prompt.trim().length > 180 ? "…" : ""
      }</i>`
    );
  }
  header.push(``, `<b>—— Report ——</b>`, ``);

  const headerText = header.join("\n");
  const raw = String(p.report || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\uFEFF/, "")
    .trim();
  // unwrap whole-doc fence if present
  const fence = raw.match(/^```(?:markdown|md|gfm)?\s*\n([\s\S]*?)\n```\s*$/i);
  const bodyMd = fence ? fence[1].trim() : raw;

  const bodyLines = bodyMd.split("\n").map(mdLineToTelegramHtml);
  const body = bodyLines.filter((l, idx, arr) => {
    // collapse runs of empty lines
    if (l === "" && arr[idx - 1] === "") return false;
    return true;
  });

  const chunks: string[] = [];
  const maxBody = 3200;
  let part = 0;
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    if (!buf.length) return;
    part += 1;
    const prefix =
      part === 1
        ? headerText
        : `<b>Rite · Research report</b> <i>(continued ${part})</i>\n` +
          `Research <b>#${escapeHtml(String(p.researchId))}</b>\n\n`;
    let msg = prefix + buf.join("\n");
    if (msg.length > TG_MAX - 20) {
      msg = msg.slice(0, TG_MAX - 40) + "\n…";
    }
    chunks.push(msg);
    buf = [];
    bufLen = 0;
  };

  for (const line of body) {
    const add = (line.length || 1) + 1;
    if (bufLen + add > maxBody && buf.length) flush();
    buf.push(line);
    bufLen += add;
  }
  flush();

  if (chunks.length === 0) {
    chunks.push(headerText + "<i>(empty report)</i>");
  }
  return chunks;
}

/**
 * DM full research report after settle+reveal when Telegram is linked.
 * Never throws to callers.
 */
export async function notifyResearchReport(
  p: ResearchNotifyPayload
): Promise<{ sent: boolean; reason?: string; parts?: number }> {
  if (!telegramConfigured()) {
    return { sent: false, reason: "telegram_not_configured" };
  }
  if (researchAlreadySent(p.researchId)) {
    return { sent: false, reason: "already_sent" };
  }
  const pref = await resolveTelegramPref(p.owner);
  if (!pref) return { sent: false, reason: "not_linked" };
  if (!pref.enabled) return { sent: false, reason: "disabled" };

  try {
    const parts = formatResearchTelegramMessages(p);
    for (const text of parts) {
      await sendTelegramMessage(pref.chatId, text);
      // small gap so Telegram order stays stable
      if (parts.length > 1) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    markResearchSent(p.researchId);
    return { sent: true, parts: parts.length };
  } catch (e) {
    console.warn("[telegram] research send failed", e);
    return {
      sent: false,
      reason: e instanceof Error ? e.message.slice(0, 120) : "send_failed",
    };
  }
}

export type { TelegramPref };
