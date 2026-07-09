"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { ReactNode } from "react";

function isPipeRow(t: string): boolean {
  const s = t.trim();
  if (!s.includes("|") || /^#{1,6}\s/.test(s) || /^```/.test(s)) return false;
  return (s.match(/\|/g) || []).length >= 2;
}

function isSepRow(t: string): boolean {
  const s = t.trim();
  return isPipeRow(s) && /^[\s|:\-]+$/.test(s) && s.includes("-");
}

function formatPipeRow(t: string): string {
  const s = t.trim();
  if (isSepRow(s)) {
    const cells = s
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => {
        const cell = c.trim();
        if (/^:?-+:?$/.test(cell)) return cell.includes(":") ? cell : "---";
        return "---";
      });
    return `| ${cells.join(" | ")} |`;
  }
  let row = s;
  if (!row.startsWith("|")) row = `| ${row}`;
  if (!row.endsWith("|")) row = `${row} |`;
  const cells = row
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  return `| ${cells.join(" | ")} |`;
}

function colCount(row: string): number {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|").length;
}

/**
 * Clean Surf/LLM quirks so GFM (headings, bold, tables) actually parse.
 * Critical: table rows must stay contiguous — blank lines between pipe rows
 * break GFM table parsing and leave raw | ... | text on screen.
 */
export function normalizeReportMarkdown(raw: string): string {
  let s = String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  // Unwrap whole-doc fences: ```markdown ... ```
  const wholeFence = s.match(
    /^```(?:markdown|md|gfm)?\s*\n([\s\S]*?)\n```\s*$/i
  );
  if (wholeFence) s = wholeFence[1].trim();

  // Unwrap large fenced markdown blocks (common Surf habit)
  s = s.replace(
    /```(?:markdown|md|gfm)?\s*\n([\s\S]*?)```/gi,
    (_m, inner: string) => {
      const body = String(inner).trim();
      if (
        /^#{1,4}\s/m.test(body) ||
        /^\|.+\|/m.test(body) ||
        /\*\*[^*]+\*\*/.test(body) ||
        body.split("\n").length >= 4
      ) {
        return `\n\n${body}\n\n`;
      }
      return _m;
    }
  );

  // Drop leftover lone fence lines
  s = s
    .split("\n")
    .filter((line) => !/^```(?:markdown|md|gfm)?\s*$/i.test(line.trim()))
    .join("\n");

  // Blank line before ATX headings
  s = s.replace(/([^\n])\n(#{1,6}\s+\S)/g, "$1\n\n$2");

  const lines = s.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const t = rawLine.trim();

    // Collapse runs of blank lines later; keep single blanks for now
    if (t === "") {
      // Never leave a blank between two pipe rows
      const prevNonEmpty = [...out].reverse().find((l) => l.trim() !== "");
      const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim() !== "");
      if (
        prevNonEmpty &&
        nextNonEmpty &&
        isPipeRow(prevNonEmpty) &&
        isPipeRow(nextNonEmpty)
      ) {
        continue; // skip blank inside table
      }
      out.push("");
      continue;
    }

    if (!isPipeRow(t)) {
      out.push(rawLine);
      continue;
    }

    // Starting a table: ensure one blank line after prior prose
    const prevNonEmpty = [...out].reverse().find((l) => l.trim() !== "");
    if (prevNonEmpty && !isPipeRow(prevNonEmpty)) {
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
    }

    // Continuing a table: strip accidental blanks above
    while (out.length && out[out.length - 1].trim() === "" && prevNonEmpty && isPipeRow(prevNonEmpty)) {
      out.pop();
    }

    out.push(formatPipeRow(t));
  }

  // Inject missing separator after header when next is data row
  const withSep: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const next = out[i + 1];
    withSep.push(cur);

    if (!next) continue;
    if (!isPipeRow(cur) || isSepRow(cur)) continue;
    if (!isPipeRow(next) || isSepRow(next)) continue;

    // cur is pipe, next is pipe data — inject sep only at table start
    const prev = withSep.length >= 2 ? withSep[withSep.length - 2] : "";
    if (!isPipeRow(prev)) {
      withSep.push(
        `| ${Array.from({ length: colCount(cur) }, () => "---").join(" | ")} |`
      );
    }
  }

  s = withSep.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Autolink bare URLs in list items / lines (Sources often come unlinked)
  s = s
    .split("\n")
    .map((line) => {
      // Already markdown link → leave
      if (/\[[^\]]+\]\([^)]+\)/.test(line)) return line;
      // Convert "Title - https://..." or trailing bare URL
      return line.replace(
        /(^|[\s(])(https?:\/\/[^\s)<>"]+)/g,
        (_m, pre: string, url: string) => {
          const clean = url.replace(/[.,;:!?)]+$/, "");
          const trail = url.slice(clean.length);
          return `${pre}[${clean}](${clean})${trail}`;
        }
      );
    })
    .join("\n");

  return s;
}

function severityTone(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === "high" || t === "critical" || t === "severe") {
    return "bg-red-500/15 text-red-200 border-red-400/30";
  }
  if (t === "medium-high" || t === "med-high" || t === "elevated") {
    return "bg-orange-500/15 text-orange-100 border-orange-400/30";
  }
  if (t === "medium" || t === "med" || t === "moderate") {
    return "bg-amber-500/15 text-amber-100 border-amber-400/30";
  }
  if (t === "low" || t === "minor") {
    return "bg-emerald-500/15 text-emerald-100 border-emerald-400/30";
  }
  return null;
}

function cellText(children: ReactNode): string {
  if (children == null) return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(cellText).join("");
  }
  if (typeof children === "object" && children !== null && "props" in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return cellText(props?.children);
  }
  return "";
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-7 border-b border-[#c8ff4a]/25 pb-2 text-[1.35rem] font-semibold tracking-tight text-[#c8ff4a] first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-7 border-b border-white/10 pb-1.5 text-[1.1rem] font-semibold tracking-tight text-[#c8ff4a] first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 text-[0.98rem] font-semibold text-[#d4ff9a]">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-sm font-semibold text-[#e8f5e0]">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-[14.5px] leading-[1.75] text-[#d8e8d2] last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-[#f2ffe6]">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-[#cfe8c8]">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline break-words font-medium text-[#b8f53a] underline decoration-[#b8f53a]/45 underline-offset-[3px] hover:text-[#d4ff6a]"
      title={href}
    >
      {children}
      <span className="ml-0.5 text-[10px] opacity-60" aria-hidden>
        ↗
      </span>
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-4 list-disc space-y-2 pl-5 text-[14.5px] leading-[1.7] text-[#d8e8d2] marker:text-[#c8ff4a]/85">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-4 list-decimal space-y-2.5 pl-5 text-[14.5px] leading-[1.7] text-[#d8e8d2] marker:font-semibold marker:text-[#c8ff4a]/90">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1 [&>p]:mb-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-r-lg border-l-[3px] border-[#c8ff4a]/55 bg-black/25 py-2 pl-4 pr-3 text-[14px] leading-7 text-[#cfe0c8]">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return (
        <code className="block whitespace-pre-wrap font-mono text-[12.5px] leading-6 text-[#e8f5e0]">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-md border border-white/10 bg-black/45 px-1.5 py-0.5 font-mono text-[12.5px] text-[#d4ff9a]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-xl border border-white/10 bg-black/45 p-3.5">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-7 border-white/10" />,
  table: ({ children }) => (
    <div className="report-table-wrap my-5 w-full overflow-x-auto rounded-xl border border-[#c8ff4a]/22 bg-[#06180e]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <table className="report-table w-full min-w-[520px] border-collapse text-left">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-[#0d2818]">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-white/[0.07]">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="transition-colors even:bg-white/[0.015] hover:bg-[#c8ff4a]/[0.035]">
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-[#c8ff4a]/28 px-3.5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[#c8ff4a]">
      {children}
    </th>
  ),
  td: ({ children }) => {
    const text = cellText(children);
    const tone = severityTone(text);
    if (tone) {
      return (
        <td className="align-middle px-3.5 py-3">
          <span
            className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone}`}
          >
            {text}
          </span>
        </td>
      );
    }
    return (
      <td className="align-top px-3.5 py-3 text-[13.5px] leading-6 text-[#d8e8d2]">
        {children}
      </td>
    );
  },
};

export function ResearchReport({ content }: { content: string }) {
  const md = normalizeReportMarkdown(content || "");
  if (!md) return null;

  return (
    <article className="glass report-md mt-8 w-full max-w-3xl rounded-2xl p-5 sm:p-7">
      <div className="mb-5 flex items-center justify-between gap-3 border-b border-[#c8ff4a]/15 pb-3">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold text-[#c8ff4a]">
          Research report
        </h2>
        <span className="rounded-full border border-white/10 bg-black/30 px-2.5 py-0.5 text-[10px] uppercase tracking-wide text-white/45">
          Surf AI
        </span>
      </div>
      <div className="report-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {md}
        </ReactMarkdown>
      </div>
    </article>
  );
}
