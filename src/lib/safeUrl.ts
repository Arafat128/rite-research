/**
 * Client-safe URL helpers (no next/server imports).
 */

/** Allow only http(s) absolute URLs — blocks javascript:, data:, etc. */
export function sanitizeHttpUrl(
  href: string | undefined | null
): string | undefined {
  if (!href || typeof href !== "string") return undefined;
  const t = href.trim();
  if (t.length > 2048) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
