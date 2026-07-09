/**
 * Surf 2.0 Responses API (server-side only).
 *
 * POST {SURF_API_BASE_URL}/responses
 * Models: surf-1.5 | surf-1.5-instant | surf-1.5-thinking
 */

import { resolveSurfBaseUrl } from "@/lib/security";

export type SurfResearchResult = {
  content: string;
  model: string;
  raw?: unknown;
};

/** Instant is faster — better for Vercel serverless limits. Override with SURF_MODEL. */
const DEFAULT_MODEL = "surf-1.5-instant";

/** Keep under Vercel maxDuration with room for RPC verify */
const SURF_FETCH_MS = Math.min(
  300_000,
  Math.max(10_000, Number(process.env.SURF_FETCH_TIMEOUT_MS || 240_000) || 240_000)
);

const ALLOWED_MODELS = new Set([
  "surf-1.5",
  "surf-1.5-instant",
  "surf-1.5-thinking",
]);

function baseUrl() {
  return resolveSurfBaseUrl(process.env.SURF_API_BASE_URL);
}

function modelId() {
  const m = (process.env.SURF_MODEL || DEFAULT_MODEL).trim();
  return ALLOWED_MODELS.has(m) ? m : DEFAULT_MODEL;
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

/**
 * Call Surf Responses API with a hard timeout (prevents hanging until Vercel 504).
 */
export async function runSurfResearch(prompt: string): Promise<SurfResearchResult> {
  const key = apiKey();
  const model = modelId();
  const url = `${baseUrl()}/responses`;

  const system =
    "Senior crypto research analyst. Clean GitHub-Flavored Markdown only. " +
    "No code fences around the whole report. Use ## headings, **bold**, GFM tables " +
    "(| col | with | --- | separator). Sections: Overview, Tokenomics, Catalysts, " +
    "Risks (Risk | Severity | Why It Matters), Conclusion, Sources. Be concise and factual.";

  // Keep body minimal — extra fields can 400 on some Surf gateways
  const body: Record<string, unknown> = {
    model,
    instructions: system,
    input: prompt.slice(0, 4000),
    temperature: 0.3,
    stream: false,
  };
  const maxTok = process.env.SURF_MAX_OUTPUT_TOKENS;
  if (maxTok && Number(maxTok) > 0) {
    body.max_output_tokens = Number(maxTok);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SURF_FETCH_MS);

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
      throw new Error(
        `Surf research timed out after ${Math.round(SURF_FETCH_MS / 1000)}s. ` +
          `Your fee is still on-chain — use Claim free report with the same prompt.`
      );
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
      throw new Error(
        `Surf/gateway timed out (HTTP ${res.status}). Payment is safe — Claim free report with the same prompt.`
      );
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
