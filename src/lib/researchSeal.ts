/**
 * Encrypt research reports so the API never returns plaintext before settle.
 * Client holds sealed blob; /api/research/reveal decrypts only after on-chain seal.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

function sealKey(researchId: string): Buffer {
  const secret =
    process.env.REPORT_SEAL_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SURF_API_KEY ||
    "rite-dev-seal-not-for-prod";
  return createHash("sha256")
    .update(`rite-report-v1|${secret}|${researchId}`)
    .digest();
}

/** AES-256-GCM seal → base64(iv|tag|ciphertext) */
export function sealReport(researchId: string, report: string): string {
  const key = sealKey(researchId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(report, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function unsealReport(researchId: string, sealed: string): string {
  const buf = Buffer.from(sealed, "base64url");
  if (buf.length < 12 + 16 + 1) throw new Error("Invalid sealed report");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = sealKey(researchId);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8"
  );
}

/** In-memory locks + short cache (per instance) */
const locks = new Map<string, Promise<unknown>>();
const reportCache = new Map<
  string,
  { report: string; resultHash: string; at: number }
>();

const CACHE_TTL_MS = 60 * 60 * 1000;

export async function withResearchLock<T>(
  researchId: string,
  fn: () => Promise<T>
): Promise<T> {
  const existing = locks.get(researchId) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => {
    if (locks.get(researchId) === p) locks.delete(researchId);
  });
  locks.set(researchId, p as Promise<unknown>);
  return p;
}

export function cacheReport(
  researchId: string,
  resultHash: string,
  report: string
) {
  reportCache.set(researchId, {
    report,
    resultHash: resultHash.toLowerCase(),
    at: Date.now(),
  });
}

export function getCachedReport(
  researchId: string
): { report: string; resultHash: string } | null {
  const hit = reportCache.get(researchId);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    reportCache.delete(researchId);
    return null;
  }
  return { report: hit.report, resultHash: hit.resultHash };
}

export { buildClaimMessage } from "@/lib/researchClaim";
