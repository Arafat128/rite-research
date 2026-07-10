/** Shared claim message format (client + server). No Node crypto. */

export function buildClaimMessage(opts: {
  researchId: string;
  promptHash: string;
  nonce: string;
  expiry: number;
}): string {
  return [
    "Rite research claim",
    `researchId:${opts.researchId}`,
    `promptHash:${opts.promptHash.toLowerCase()}`,
    `nonce:${opts.nonce}`,
    `expiry:${opts.expiry}`,
  ].join("\n");
}
