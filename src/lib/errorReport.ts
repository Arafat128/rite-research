/**
 * User-facing error reports for support feedback.
 * Friendly message for the UI + a compact copyable package (code + context)
 * so issues can be fixed quickly without exposing secrets or ops notes.
 */

export type ErrorReport = {
  /** Short code users can quote, e.g. RITE-A3F29C */
  code: string;
  when: string;
  /** Stable location tag: agent.wake, research.pay, telegram.link, … */
  where: string;
  /** Safe, human message shown in the UI */
  userMessage: string;
  /** Technical detail (sanitized) for the copy package */
  detail: string;
  chainId?: string;
  wallet?: string;
  agentId?: string;
  url?: string;
  appVersion: string;
};

export type BuildErrorOpts = {
  where: string;
  /** Override friendly message; otherwise derived from error */
  userMessage?: string;
  chainId?: number | string | null;
  wallet?: string | null;
  agentId?: string | number | bigint | null;
  /** Optional domain decoder (e.g. Radar reverts) */
  decode?: (e: unknown) => string | null | undefined;
};

const APP_VERSION =
  (typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_APP_VERSION || process.env.npm_package_version)) ||
  "0.1.0";

/** Wallet reject / cancel — not a bug, no support report needed. */
export function isUserRejection(text: string): boolean {
  return /user rejected|user denied|rejected the request|request rejected|denied transaction|cancelled|canceled|user cancel/i.test(
    text
  );
}

/** Extract raw text from unknown thrown values (viem, fetch, Error). */
export function extractErrorText(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.shortMessage === "string" && o.shortMessage) {
      return o.shortMessage;
    }
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.details === "string" && o.details) return o.details;
    try {
      return JSON.stringify(e).slice(0, 500);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

/** Strip secrets / internal noise from text that users might copy. */
export function sanitizeErrorDetail(raw: string): string {
  let s = String(raw || "")
    .replace(/\r\n/g, "\n")
    .trim();

  // Private keys / long hex secrets (64+ hex after 0x)
  s = s.replace(/0x[a-fA-F0-9]{64,}/g, "0x[redacted]");
  // Bearer / API tokens
  s = s.replace(
    /(api[_-]?key|token|secret|authorization|bearer)\s*[:=]\s*\S+/gi,
    "$1=[redacted]"
  );
  // Common env var dumps
  s = s.replace(
    /\b(KEEPER_PRIVATE_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|UPSTASH_REDIS_REST_TOKEN|CRON_SECRET|SURF_API_KEY)\b[^\s]*/gi,
    "[env redacted]"
  );

  // Collapse huge stack traces
  if (s.length > 600) s = s.slice(0, 600) + "…";
  return s || "No detail";
}

/**
 * Prefer a short, actionable user message.
 * Keep technical codes out of the headline when possible.
 */
export function friendlyUserMessage(raw: string): string {
  const t = raw.trim();
  if (!t) return "Something went wrong. Please try again.";
  if (isUserRejection(t)) return "Transaction cancelled in wallet.";
  if (/UnknownAgent|0x0df2949d|function ["']?getAgent/i.test(t)) {
    return "Agent not found on-chain yet. Click Refresh — if you just deployed, wait a few seconds and open My Agents again.";
  }
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(t)) {
    return "Not enough RIT in your wallet for this action (including gas).";
  }
  if (/network|fetch failed|failed to fetch|timeout|timed out|ECONNRESET|503|502|504/i.test(t)) {
    return "Network issue — check your connection and try again.";
  }
  if (/wrong chain|chain mismatch|switch.*chain|chain id/i.test(t)) {
    return "Wrong network — switch your wallet to Ritual Chain.";
  }
  if (/not been authorized|Failed to connect to MetaMask/i.test(t)) {
    return "Wallet not connected to this site. Open your wallet and connect.";
  }
  // Already human-ish (decoded Radar hints, etc.)
  if (t.length <= 220 && !/^Error:|0x[a-f0-9]{8}/i.test(t)) {
    return t;
  }
  return t.length > 200 ? t.slice(0, 200) + "…" : t;
}

function shortCode(): string {
  const n =
    typeof crypto !== "undefined" && "getRandomValues" in crypto
      ? crypto.getRandomValues(new Uint32Array(1))[0]!
      : Math.floor(Math.random() * 0xffffff);
  return `RITE-${(n >>> 0).toString(16).toUpperCase().padStart(6, "0").slice(0, 6)}`;
}

function shortenWallet(addr?: string | null): string | undefined {
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return undefined;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function buildErrorReport(
  e: unknown,
  opts: BuildErrorOpts
): ErrorReport {
  const decoded = opts.decode?.(e)?.trim() || "";
  const raw = decoded || extractErrorText(e);
  const detail = sanitizeErrorDetail(raw);
  const userMessage =
    opts.userMessage?.trim() || friendlyUserMessage(detail);

  const agent =
    opts.agentId != null && opts.agentId !== ""
      ? String(opts.agentId)
      : undefined;

  return {
    code: shortCode(),
    when: new Date().toISOString(),
    where: opts.where,
    userMessage,
    detail,
    chainId:
      opts.chainId != null && opts.chainId !== ""
        ? String(opts.chainId)
        : undefined,
    wallet: shortenWallet(opts.wallet),
    agentId: agent,
    url: typeof window !== "undefined" ? window.location.href.slice(0, 200) : undefined,
    appVersion: APP_VERSION,
  };
}

/** Full package users paste back to support. */
export function formatErrorReport(r: ErrorReport): string {
  const lines = [
    "--- Rite error report ---",
    `Code: ${r.code}`,
    `When: ${r.when}`,
    `Where: ${r.where}`,
    `Message: ${r.userMessage}`,
    `Detail: ${r.detail}`,
  ];
  if (r.chainId) lines.push(`Chain: ${r.chainId}`);
  if (r.wallet) lines.push(`Wallet: ${r.wallet}`);
  if (r.agentId) lines.push(`Agent: #${r.agentId}`);
  if (r.url) lines.push(`URL: ${r.url}`);
  lines.push(`App: rite@${r.appVersion}`);
  lines.push("--- end ---");
  return lines.join("\n");
}

export async function copyErrorReport(r: ErrorReport): Promise<boolean> {
  const text = formatErrorReport(r);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Session buffer of recent reports (for boundary / last-error recovery). */
const RECENT_MAX = 8;
let recentReports: ErrorReport[] = [];

export function rememberErrorReport(r: ErrorReport) {
  recentReports = [r, ...recentReports].slice(0, RECENT_MAX);
  try {
    sessionStorage.setItem(
      "rite_last_error_v1",
      JSON.stringify({ code: r.code, when: r.when, where: r.where })
    );
  } catch {
    /* ignore */
  }
}

export function getRecentErrorReports(): ErrorReport[] {
  return recentReports.slice();
}
