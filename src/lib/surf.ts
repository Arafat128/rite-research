/**
 * Surf 2.0 Responses API (server-side only).
 *
 * Chat completions was removed (HTTP 410). Use:
 *   POST {SURF_API_BASE_URL}/responses
 *
 * Base default: https://api.asksurf.ai/gateway/v1
 * Auth: Authorization: Bearer SURF_API_KEY
 * Models: surf-1.5 | surf-1.5-instant | surf-1.5-thinking
 *
 * Docs: https://agents.asksurf.ai/docs · https://docs.asksurf.ai
 */

export type SurfResearchResult = {
  content: string;
  model: string;
  raw?: unknown;
};

const DEFAULT_BASE = "https://api.asksurf.ai/gateway/v1";
const DEFAULT_MODEL = "surf-1.5";

function baseUrl() {
  return (process.env.SURF_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function modelId() {
  return process.env.SURF_MODEL || DEFAULT_MODEL;
}

function apiKey() {
  const k = process.env.SURF_API_KEY;
  if (!k) throw new Error("SURF_API_KEY is not configured");
  return k;
}

function extractText(json: Record<string, unknown>): string | null {
  // OpenAI Responses API common fields
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text;
  }
  if (typeof json.response === "string" && json.response.trim()) {
    return json.response;
  }
  if (typeof json.content === "string" && json.content.trim()) {
    return json.content;
  }

  // output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }]
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

  // Legacy chat.completions shape (if proxy still returns it)
  const choices = json.choices as
    | Array<{ message?: { content?: string }; text?: string }>
    | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  if (choices?.[0]?.text) return choices[0].text;

  return null;
}

/**
 * Call Surf Responses API (required after chat/completions 410 removal).
 */
export async function runSurfResearch(prompt: string): Promise<SurfResearchResult> {
  const key = apiKey();
  const model = modelId();
  const url = `${baseUrl()}/responses`;

  const system =
    "You are a senior crypto research analyst powered by Surf. " +
    "Write concise, structured project research using clean GitHub-Flavored Markdown. " +
    "Rules: " +
    "(1) Use ## and ### headings — never wrap the whole report in a code fence. " +
    "(2) Use real GFM tables with a header row and a | --- | separator row. " +
    "(3) Use **bold** for labels, numbered lists for catalysts, bullet lists for bullets. " +
    "(4) Sections: Overview, Tokenomics, Catalysts, Risks (table: Risk | Severity | Why It Matters), Conclusion, Sources. " +
    "(5) Be factual; flag uncertainty. Do not emit raw HTML.";

  // OpenAI Responses API body (string input + instructions is widely supported)
  const body = {
    model,
    instructions: system,
    input: prompt,
    temperature: 0.3,
    stream: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Surf API non-JSON (${res.status}): ${text.slice(0, 280) || res.statusText}`
    );
  }

  if (!res.ok) {
    const errObj = json.error as { message?: string } | string | undefined;
    const msg =
      (typeof errObj === "object" && errObj?.message) ||
      (typeof errObj === "string" ? errObj : undefined) ||
      (typeof json.message === "string" ? json.message : undefined) ||
      (typeof json.detail === "string" ? json.detail : undefined) ||
      text.slice(0, 280) ||
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
