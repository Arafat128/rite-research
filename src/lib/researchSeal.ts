/**
 * Encrypt research reports so the API never returns plaintext before settle.
 * Sealed blobs + locks + nonces prefer durable KV (Upstash / file).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { kvDel, kvGet, kvSet, kvSetNx } from "@/lib/durableKv";

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

const memLocks = new Map<string, Promise<unknown>>();
const memCache = new Map<
  string,
  { report: string; resultHash: string; sealed?: string; at: number }
>();

const CACHE_TTL_SEC = 60 * 60 * 24 * 7; // 7 days durable
const CACHE_TTL_MS = CACHE_TTL_SEC * 1000;
const LOCK_TTL_SEC = 180;

export async function withResearchLock<T>(
  researchId: string,
  fn: () => Promise<T>
): Promise<T> {
  // Instance-local coalesce
  const existing = memLocks.get(researchId) as Promise<T> | undefined;
  if (existing) return existing;

  const lockKey = `rite:rlock:${researchId}`;
  const token = randomBytes(8).toString("hex");
  let acquired = false;
  for (let i = 0; i < 40; i++) {
    acquired = await kvSetNx(lockKey, token, LOCK_TTL_SEC);
    if (acquired) break;
    await new Promise((r) => setTimeout(r, 250 + i * 50));
  }
  if (!acquired) {
    // Peer may have finished — allow fn to hit durable cache; else fail closed
    const cached = await getCachedReport(researchId);
    if (!cached) {
      throw new Error(
        "Research busy for this id — retry claim in a few seconds (no second fee)"
      );
    }
  }

  // Hold promise so finally can drop memLocks entry (TDZ-safe)
  let p!: Promise<T>;
  p = (async () => {
    try {
      // fn is idempotent: first line should check getCachedReport
      return await fn();
    } finally {
      if (acquired) {
        const cur = await kvGet(lockKey);
        if (cur === token) await kvDel(lockKey);
      }
      if (memLocks.get(researchId) === p) memLocks.delete(researchId);
    }
  })();
  memLocks.set(researchId, p as Promise<unknown>);
  return p;
}

export async function cacheReport(
  researchId: string,
  resultHash: string,
  report: string,
  sealedReport?: string
) {
  const sealed = sealedReport || sealReport(researchId, report);
  memCache.set(researchId, {
    report,
    resultHash: resultHash.toLowerCase(),
    sealed,
    at: Date.now(),
  });
  const payload = JSON.stringify({
    report,
    resultHash: resultHash.toLowerCase(),
    sealed,
    at: Date.now(),
  });
  await kvSet(`rite:report:${researchId}`, payload, CACHE_TTL_SEC);
  await kvSet(
    `rite:sealed:${researchId}`,
    JSON.stringify({ sealed, resultHash: resultHash.toLowerCase() }),
    CACHE_TTL_SEC
  );
}

export async function getCachedReport(
  researchId: string
): Promise<{ report: string; resultHash: string; sealed?: string } | null> {
  const hit = memCache.get(researchId);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
    return {
      report: hit.report,
      resultHash: hit.resultHash,
      sealed: hit.sealed,
    };
  }
  const raw = await kvGet(`rite:report:${researchId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      report: string;
      resultHash: string;
      sealed?: string;
      at?: number;
    };
    if (!parsed.report || !parsed.resultHash) return null;
    memCache.set(researchId, {
      report: parsed.report,
      resultHash: parsed.resultHash,
      sealed: parsed.sealed,
      at: parsed.at || Date.now(),
    });
    return {
      report: parsed.report,
      resultHash: parsed.resultHash,
      sealed: parsed.sealed,
    };
  } catch {
    return null;
  }
}

export async function getSealedReportStore(
  researchId: string
): Promise<{ sealed: string; resultHash: string } | null> {
  const raw = await kvGet(`rite:sealed:${researchId}`);
  if (raw) {
    try {
      const p = JSON.parse(raw) as { sealed: string; resultHash: string };
      if (p.sealed && p.resultHash) return p;
    } catch {
      /* */
    }
  }
  const full = await getCachedReport(researchId);
  if (full?.sealed) {
    return { sealed: full.sealed, resultHash: full.resultHash };
  }
  return null;
}

/** Consume claim/reveal nonce once (durable). Returns false if already used/invalid. */
export async function consumeResearchNonce(
  researcher: string,
  nonce: string
): Promise<boolean> {
  if (!nonce || nonce.length < 8 || nonce.length > 128) return false;
  const key = `rite:nonce:${researcher.toLowerCase()}:${nonce}`;
  const ok = await kvSetNx(key, "1", 60 * 60); // 1h retention
  return ok;
}

export { buildClaimMessage } from "@/lib/researchClaim";
