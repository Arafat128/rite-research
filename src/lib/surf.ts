/**
 * Surf 2.0 Responses API (server-side only).
 *
 * POST {SURF_API_BASE_URL}/responses
 * Models: surf-1.5 | surf-1.5-instant | surf-1.5-thinking
 */

import { resolveSurfBaseUrl } from "@/lib/security";

export type SurfResearchModel =
  | "surf-1.5"
  | "surf-1.5-instant"
  | "surf-1.5-thinking";

export type SurfResearchResult = {
  content: string;
  model: string;
  raw?: unknown;
};

/** Instant is faster — better for Vercel serverless limits. Override with SURF_MODEL. */
const DEFAULT_MODEL: SurfResearchModel = "surf-1.5-instant";

/**
 * Vercel research route maxDuration is 300s — leave headroom for pay-verify + seal.
 * Default 270s (was 240s). Override: SURF_FETCH_TIMEOUT_MS.
 */
const SURF_FETCH_MS = Math.min(
  285_000,
  Math.max(10_000, Number(process.env.SURF_FETCH_TIMEOUT_MS || 270_000) || 270_000)
);

const ALLOWED_MODELS = new Set<string>([
  "surf-1.5",
  "surf-1.5-instant",
  "surf-1.5-thinking",
]);

function baseUrl() {
  return resolveSurfBaseUrl(process.env.SURF_API_BASE_URL);
}

export function resolveSurfModel(requested?: string | null): SurfResearchModel {
  const req = (requested || "").trim();
  if (req && ALLOWED_MODELS.has(req)) return req as SurfResearchModel;
  const env = (process.env.SURF_MODEL || DEFAULT_MODEL).trim();
  return (ALLOWED_MODELS.has(env) ? env : DEFAULT_MODEL) as SurfResearchModel;
}

/** User-facing timeout / payment-safe message (no seal confusion). */
export function surfTimeoutMessage(seconds = Math.round(SURF_FETCH_MS / 1000)): string {
  return (
    `Surf research timed out after ${seconds}s (model still running or overloaded). ` +
    `Your RIT fee is already on-chain — no extra pay needed. ` +
    `Open Paid credits → Claim free report with the exact same prompt to retry.`
  );
}

function apiKey() {
  const k = process.env.SURF_API_KEY;
  if (!k) throw new Error("SURF_API_KEY is not configured");
  return k;
}

function extractText(json: Record<string, unknown>): string | null {
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text;
  }
  if (typeof json.response === "string" && json.response.trim()) {
    return json.response;
  }
  if (typeof json.content === "string" && json.content.trim()) {
    return json.content;
  }

  const output = json.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.text === "string") parts.push(row.text);
      const content = row.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const cell = c as Record<string, unknown>;
          if (typeof cell.text === "string") parts.push(cell.text);
          if (typeof cell.output_text === "string") parts.push(cell.output_text);
        }
      }
      if (typeof row.output_text === "string") parts.push(row.output_text);
    }
    if (parts.length) return parts.join("\n\n");
  }

  const choices = json.choices as
    | Array<{ message?: { content?: string }; text?: string }>
    | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  if (choices?.[0]?.text) return choices[0].text;

  return null;
}

export type RunSurfResearchOpts = {
  prompt: string;
  /** Override model (instant / thinking). Defaults to SURF_MODEL env. */
  model?: string | null;
  /** Extra system guidance for heavy prompts */
  depth?: "standard" | "deep";
};

/**
 * Call Surf Responses API with a hard timeout (prevents hanging until Vercel 504).
 */
export async function runSurfResearch(
  promptOrOpts: string | RunSurfResearchOpts
): Promise<SurfResearchResult> {
  const opts: RunSurfResearchOpts =
    typeof promptOrOpts === "string"
      ? { prompt: promptOrOpts }
      : promptOrOpts;
  const prompt = opts.prompt;
  const key = apiKey();
  const model = resolveSurfModel(opts.model);
  const url = `${baseUrl()}/responses`;

  // Adaptive outline — do NOT force Overview/Tokenomics/Catalysts/Risks/Conclusion
  // for every prompt; many queries need a different structure.
  const system = [
    "You are a senior crypto research analyst.",
    "Write clean GitHub-Flavored Markdown only. Do not wrap the entire report in a code fence.",
    "Use ## headings, **bold**, lists, and GFM tables (| col | with | --- | separator rows) when tables help.",
    "Structure the report to fit THIS user question — invent clear section headings that match the topic.",
    "Do NOT force a fixed template (Overview / Tokenomics / Catalysts / Risks / Conclusion) on every report.",
    "Include those classic sections only when they genuinely help; skip anything irrelevant.",
    "Examples of alternate outlines: protocol design, competitive map, on-chain metrics, timeline,",
    "regulatory notes, how-to / mechanics, narrative analysis, or a short Q&A — whatever answers the prompt best.",
    "Be concise, factual, and specific. Prefer evidence over hype. End with Sources or Key references when you cite claims.",
    "If the question needs on-chain forensics and you lack live chain data, say what you can verify vs what is uncertain — do not invent transactions.",
    opts.depth === "deep"
      ? "Deep mode: reason carefully, cross-check claims, prefer structured tables for addresses/contracts when relevant."
      : "Standard mode: answer efficiently; prioritize clarity over exhaustive depth.",
  ]
    .filter(Boolean)
    .join(" ");

  // Keep body minimal — extra fields can 400 on some Surf gateways
  const body: Record<string, unknown> = {
    model,
    instructions: system,
    input: prompt.slice(0, 4000),
    temperature: opts.depth === "deep" ? 0.25 : 0.3,
    stream: false,
  };
  const maxTok = process.env.SURF_MAX_OUTPUT_TOKENS;
  if (maxTok && Number(maxTok) > 0) {
    body.max_output_tokens = Number(maxTok);
  }

  // Thinking models need the full window; instant can use a slightly tighter cap
  const fetchMs =
    model === "surf-1.5-thinking"
      ? SURF_FETCH_MS
      : Math.min(SURF_FETCH_MS, 240_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      const err = new Error(surfTimeoutMessage(Math.round(fetchMs / 1000)));
      (err as Error & { code?: string }).code = "SURF_TIMEOUT";
      throw err;
    }
    throw new Error(
      `Surf network error: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Gateway HTML 504/502 bodies
    if (res.status === 504 || res.status === 502 || res.status === 524) {
      const err = new Error(
        `Surf/gateway timed out (HTTP ${res.status}). ` +
          `Payment is safe — Claim free report with the exact same prompt (no second fee).`
      );
      (err as Error & { code?: string }).code = "SURF_TIMEOUT";
      throw err;
    }
    throw new Error(
      `Surf API non-JSON (${res.status}): ${text.slice(0, 200) || res.statusText}`
    );
  }

  if (!res.ok) {
    const errObj = json.error as { message?: string } | string | undefined;
    const msg =
      (typeof errObj === "object" && errObj?.message) ||
      (typeof errObj === "string" ? errObj : undefined) ||
      (typeof json.message === "string" ? json.message : undefined) ||
      (typeof json.detail === "string" ? json.detail : undefined) ||
      text.slice(0, 200) ||
      res.statusText;
    throw new Error(`Surf API ${res.status}: ${msg}`);
  }

  const content = extractText(json);
  if (!content) {
    throw new Error(
      "Surf /responses returned an unexpected shape — check SURF_MODEL and response body"
    );
  }

  return {
    content,
    model: typeof json.model === "string" ? json.model : model,
    raw: json,
  };
}
