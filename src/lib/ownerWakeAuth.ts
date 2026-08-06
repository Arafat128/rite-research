/**
 * Browser auto-wake owner proof (not CRON_SECRET).
 * Decision: short-lived signed message (5 min) bound to owner + chain + purpose.
 * Prevents attackers from waking arbitrary owners and burning keeper gas.
 *
 * Nonces are NOT server-consumed (only verified) so the same signed payload
 * can be reused until expiry — avoids MetaMask pop every poll interval.
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

/** Browser session cache — reuse until ~45s before expiry */
let authCache: (AutoWakeAuth & { owner: string }) | null = null;

/**
 * Get (or refresh) a short-lived auto-wake signature for `owner`.
 * `sign` is typically wagmi `signMessageAsync({ message })`.
 */
export async function getAutoWakeAuth(
  owner: string,
  sign: (message: string) => Promise<string>
): Promise<AutoWakeAuth> {
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
  const nonce =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expiry = now + 5 * 60;
  const message = buildAutoWakeMessage({ owner, nonce, expiry });
  const signature = await sign(message);
  authCache = { owner: ownerKey, signature, nonce, expiry };
  return { signature, nonce, expiry };
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
