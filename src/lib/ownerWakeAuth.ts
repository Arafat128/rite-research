/**
 * Browser auto-wake owner proof (not CRON_SECRET).
 * Decision: short-lived signed message (5 min) bound to owner + chain + purpose.
 * Prevents attackers from waking arbitrary owners and burning keeper gas.
 *
 * Nonces are NOT server-consumed (only verified) so the same signed payload
 * can be reused until expiry — avoids MetaMask pop every poll interval.
 *
 * UX: never auto-prompt the wallet. Cache signatures in sessionStorage after
 * an explicit opt-in sign. Peeks never call signMessage.
 */
import { verifyMessage, type Address, type Hex } from "viem";

export function buildAutoWakeMessage(opts: {
  owner: string;
  expiry: number;
  nonce: string;
}): string {
  return [
    "Rite agent auto-wake v1",
    "domain:rite.ritual",
    "chainId:1979",
    `owner:${opts.owner.toLowerCase()}`,
    `nonce:${opts.nonce}`,
    `expiry:${opts.expiry}`,
  ].join("\n");
}

export type AutoWakeAuth = {
  signature: string;
  nonce: string;
  expiry: number;
};

const SS_AUTH = "rite_auto_wake_auth_v1";
const SS_DECLINED = "rite_auto_wake_declined_v1";

/** In-memory cache — reuse until ~45s before expiry */
let authCache: (AutoWakeAuth & { owner: string }) | null = null;

function loadSessionAuth(ownerKey: string): AutoWakeAuth | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${SS_AUTH}:${ownerKey}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as AutoWakeAuth & { owner?: string };
    const now = Math.floor(Date.now() / 1000);
    if (!p?.signature || !p.nonce || !p.expiry || p.expiry <= now + 45) {
      sessionStorage.removeItem(`${SS_AUTH}:${ownerKey}`);
      return null;
    }
    return { signature: p.signature, nonce: p.nonce, expiry: p.expiry };
  } catch {
    return null;
  }
}

function saveSessionAuth(ownerKey: string, auth: AutoWakeAuth) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      `${SS_AUTH}:${ownerKey}`,
      JSON.stringify({ ...auth, owner: ownerKey })
    );
  } catch {
    /* private mode */
  }
}

/** True if user rejected a sign prompt this browser session (no re-spam). */
export function isAutoWakeDeclined(owner: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(`${SS_DECLINED}:${owner.toLowerCase()}`) === "1";
  } catch {
    return false;
  }
}

export function markAutoWakeDeclined(owner: string) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${SS_DECLINED}:${owner.toLowerCase()}`, "1");
  } catch {
    /* */
  }
}

export function clearAutoWakeDeclined(owner: string) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${SS_DECLINED}:${owner.toLowerCase()}`);
  } catch {
    /* */
  }
}

/**
 * Return a still-valid cached auth without opening the wallet.
 * Used by background pollers — never prompts.
 */
export function peekAutoWakeAuth(owner: string): AutoWakeAuth | null {
  const now = Math.floor(Date.now() / 1000);
  const ownerKey = owner.toLowerCase();
  if (
    authCache &&
    authCache.owner === ownerKey &&
    authCache.expiry > now + 45
  ) {
    return {
      signature: authCache.signature,
      nonce: authCache.nonce,
      expiry: authCache.expiry,
    };
  }
  const ss = loadSessionAuth(ownerKey);
  if (ss) {
    authCache = { owner: ownerKey, ...ss };
    return ss;
  }
  return null;
}

/**
 * Explicit opt-in: request a fresh wallet signature and cache it.
 * Call only from a user click handler (Enable auto-wake).
 */
export async function requestAutoWakeAuth(
  owner: string,
  sign: (message: string) => Promise<string>
): Promise<AutoWakeAuth> {
  const ownerKey = owner.toLowerCase();
  clearAutoWakeDeclined(ownerKey);
  const nonce =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expiry = Math.floor(Date.now() / 1000) + 5 * 60;
  const message = buildAutoWakeMessage({ owner, nonce, expiry });
  const signature = await sign(message);
  const auth = { signature, nonce, expiry };
  authCache = { owner: ownerKey, ...auth };
  saveSessionAuth(ownerKey, auth);
  return auth;
}

/**
 * Get cached auth, or refresh via `sign` only when `allowPrompt` is true.
 * Default allowPrompt=false so background polls never open MetaMask.
 */
export async function getAutoWakeAuth(
  owner: string,
  sign: (message: string) => Promise<string>,
  opts?: { allowPrompt?: boolean }
): Promise<AutoWakeAuth | null> {
  const cached = peekAutoWakeAuth(owner);
  if (cached) return cached;
  if (!opts?.allowPrompt) return null;
  if (isAutoWakeDeclined(owner)) return null;
  try {
    return await requestAutoWakeAuth(owner, sign);
  } catch (e) {
    markAutoWakeDeclined(owner);
    throw e;
  }
}

export async function verifyAutoWakeSig(opts: {
  owner: Address;
  signature?: Hex | string;
  nonce?: string;
  expiry?: number;
}): Promise<string | null> {
  if (!opts.signature || !opts.nonce || !opts.expiry) {
    return "Wallet signature required for auto-wake (owner, signature, nonce, expiry)";
  }
  const now = Math.floor(Date.now() / 1000);
  if (opts.expiry < now) return "Auto-wake signature expired — refresh the My Agents tab";
  if (opts.expiry > now + 10 * 60) return "Auto-wake expiry too far in the future";
  if (opts.nonce.length < 8 || opts.nonce.length > 128) return "Invalid auto-wake nonce";

  const message = buildAutoWakeMessage({
    owner: opts.owner,
    expiry: opts.expiry,
    nonce: opts.nonce,
  });
  try {
    const ok = await verifyMessage({
      address: opts.owner,
      message,
      signature: opts.signature as Hex,
    });
    if (!ok) return "Invalid auto-wake wallet signature";
  } catch {
    return "Could not verify auto-wake signature";
  }
  return null;
}
