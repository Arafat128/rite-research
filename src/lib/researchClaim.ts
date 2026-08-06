/**
 * Research claim / reveal message format (client + server).
 * Decision: keep EIP-191 human-readable message (no new wallet UX) but bind
 * chainId + domain + app id; nonces are consumed in durable KV (see researchSeal).
 */

export const RESEARCH_CLAIM_DOMAIN = "rite.ritual";
export const RESEARCH_CLAIM_CHAIN_ID = 1979;

export function buildClaimMessage(opts: {
  researchId: string;
  promptHash: string;
  nonce: string;
  expiry: number;
  /** Purpose tag so claim ≠ reveal can share format safely */
  purpose?: "claim" | "reveal";
}): string {
  const purpose = opts.purpose || "claim";
  return [
    "Rite research claim v2",
    `domain:${RESEARCH_CLAIM_DOMAIN}`,
    `chainId:${RESEARCH_CLAIM_CHAIN_ID}`,
    `purpose:${purpose}`,
    `researchId:${opts.researchId}`,
    `promptHash:${opts.promptHash.toLowerCase()}`,
    `nonce:${opts.nonce}`,
    `expiry:${opts.expiry}`,
  ].join("\n");
}
