/**
 * Ritual LLM precompile (0x0802) — structured snapshot for custom agent streams.
 * Same app architecture: off-chain data → digest → runTick.
 * Uses KEEPER_PRIVATE_KEY (or fails clearly if not configured).
 */

import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  parseEther,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ritualChain, RPC_URL } from "@/lib/ritual";

const LLM_PRECOMPILE =
  "0x0000000000000000000000000000000000000802" as Address;
const TEE_SERVICE_REGISTRY =
  "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F" as Address;
const RITUAL_WALLET =
  "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948" as Address;
const CAPABILITY_LLM = 1;
const PRECOMPILE_CALLED_TOPIC = keccak256(
  toHex("PrecompileCalled(address,bytes,bytes)")
);

const LLM_PARAM_TYPES = parseAbiParameters(
  [
    "address, bytes[], uint256, bytes[], bytes,",
    "string, string, int256, string, bool, int256, string, string,",
    "uint256, bool, int256, string, bytes, int256, string, string, bool,",
    "int256, bytes, bytes, int256, int256, string, bool,",
    "(string,string,string)",
  ].join("")
);

export type RitualLlmSnapshotShape = {
  summary: string;
  rows: Array<Record<string, string | number | null>>;
  highlights: Array<{ label: string; value: string }>;
};

function normalizePk(raw: string): Hex {
  const t = raw.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as Hex;
}

function publicClient() {
  return createPublicClient({
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 60_000, retryCount: 2 }),
  });
}

async function resolveExecutor(client: ReturnType<typeof publicClient>): Promise<Address> {
  const fromEnv = (process.env.RITUAL_LLM_EXECUTOR || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(fromEnv)) return fromEnv as Address;

  const services = (await client.readContract({
    address: TEE_SERVICE_REGISTRY,
    abi: [
      {
        name: "getServicesByCapability",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "capability", type: "uint8" },
          { name: "checkValidity", type: "bool" },
        ],
        outputs: [
          {
            name: "services",
            type: "tuple[]",
            components: [
              {
                name: "node",
                type: "tuple",
                components: [
                  { name: "paymentAddress", type: "address" },
                  { name: "teeAddress", type: "address" },
                  { name: "teeType", type: "uint8" },
                  { name: "publicKey", type: "bytes" },
                  { name: "endpoint", type: "string" },
                  { name: "certPubKeyHash", type: "bytes32" },
                  { name: "capability", type: "uint8" },
                ],
              },
              { name: "isValid", type: "bool" },
              { name: "workloadId", type: "bytes32" },
            ],
          },
        ],
      },
    ] as const,
    functionName: "getServicesByCapability",
    args: [CAPABILITY_LLM, true],
  })) as unknown as Array<{ node: { teeAddress: Address }; isValid: boolean }>;

  const live = services.find((s) => s.isValid && s.node?.teeAddress);
  if (!live) {
    throw new Error(
      "No valid Ritual LLM executor. Set RITUAL_LLM_EXECUTOR or ensure TEEServiceRegistry has LLM services."
    );
  }
  return live.node.teeAddress;
}

function buildMessages(userPrompt: string): string {
  const system = [
    "You produce SHORT structured market/radar snapshots for automated crypto agents.",
    "Reply with ONLY valid JSON (no markdown fences) matching:",
    '{"summary":"1-2 sentences","highlights":[{"label":"string","value":"string"}],"rows":[{"ColA":"...","ColB":"..."}]}',
    "Max 6 highlights, max 8 rows. Be concise. If you lack live data, say so in summary and give qualitative rows only.",
    "Never invent exact prices as facts without labeling them estimates.",
  ].join(" ");

  return JSON.stringify([
    { role: "system", content: system },
    {
      role: "user",
      content: `Custom agent stream request:\n${userPrompt.slice(0, 400)}\n\nReturn JSON only.`,
    },
  ]);
}

function encodeLlmRequest(executor: Address, messagesJson: string): Hex {
  return encodeAbiParameters(LLM_PARAM_TYPES, [
    executor,
    [],
    BigInt(300), // ttl blocks
    [],
    "0x",
    messagesJson,
    "zai-org/GLM-4.7-FP8",
    BigInt(0),
    "",
    false,
    BigInt(4096), // maxCompletionTokens (reasoning model needs headroom)
    "",
    "",
    BigInt(1),
    true,
    BigInt(0),
    "medium",
    "0x",
    BigInt(-1),
    "auto",
    "",
    false, // stream
    BigInt(200), // temperature 0.2 × 1000 — more structured
    "0x",
    "0x",
    BigInt(-1),
    BigInt(1000),
    "",
    false,
    // Empty StorageRef — no GCS session required for one-shot ticks
    ["", "", ""],
  ]);
}

function extractLlmResult(receipt: TransactionReceipt): Hex | null {
  for (const log of receipt.logs) {
    if (log.topics[0] !== PRECOMPILE_CALLED_TOPIC) continue;
    try {
      const [addr, , output] = decodeAbiParameters(
        parseAbiParameters("address, bytes, bytes"),
        log.data
      );
      if ((addr as string).toLowerCase() !== LLM_PRECOMPILE.toLowerCase()) {
        continue;
      }
      try {
        const [, actual] = decodeAbiParameters(
          parseAbiParameters("bytes, bytes"),
          output as Hex
        );
        return actual as Hex;
      } catch {
        return output as Hex;
      }
    } catch {
      /* next log */
    }
  }
  return null;
}

function parseCompletionToShape(content: string): RitualLlmSnapshotShape {
  let text = content.trim();
  // strip optional fences / think blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  const parsed = JSON.parse(text) as {
    summary?: string;
    highlights?: Array<{ label?: string; value?: string }>;
    rows?: Array<Record<string, unknown>>;
  };

  const summary = String(parsed.summary || "Custom Ritual LLM snapshot").slice(
    0,
    400
  );
  const highlights = (Array.isArray(parsed.highlights) ? parsed.highlights : [])
    .slice(0, 6)
    .map((h) => ({
      label: String(h?.label || "—").slice(0, 40),
      value: String(h?.value || "—").slice(0, 80),
    }));
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .slice(0, 8)
    .map((row) => {
      const out: Record<string, string | number | null> = {};
      if (row && typeof row === "object") {
        for (const [k, v] of Object.entries(row)) {
          if (v == null) out[k] = null;
          else if (typeof v === "number") out[k] = v;
          else out[k] = String(v).slice(0, 200);
        }
      }
      return out;
    });

  if (!highlights.length) {
    highlights.push({ label: "Source", value: "Ritual LLM" });
  }
  if (!rows.length) {
    rows.push({ Note: summary.slice(0, 120) });
  }

  return { summary, highlights, rows };
}

function extractTextFromCompletionData(completionData: Hex): string {
  // Nested ABI decode CompletionData → choices → message content
  try {
    const [, , , , , , choicesCount, choicesData] = decodeAbiParameters(
      parseAbiParameters(
        "string, string, uint256, string, string, string, uint256, bytes[], bytes"
      ),
      completionData
    );
    if (choicesCount > BigInt(0) && choicesData.length > 0) {
      const [, , messageData] = decodeAbiParameters(
        parseAbiParameters("uint256, string, bytes"),
        choicesData[0]
      );
      const [, content] = decodeAbiParameters(
        parseAbiParameters("string, string, string, uint256, bytes[]"),
        messageData
      );
      return content;
    }
  } catch {
    /* try raw utf8 */
  }
  try {
    // sometimes completion is plain string abi
    const [s] = decodeAbiParameters(parseAbiParameters("string"), completionData);
    return s;
  } catch {
    /* fall through */
  }
  // last resort: strip non-printable
  const raw = Buffer.from(completionData.slice(2), "hex").toString("utf8");
  return raw.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ").trim();
}

/**
 * Run one Ritual LLM completion and shape a Rite data snapshot.
 */
export async function generateRitualLlmSnapshot(
  userPrompt: string
): Promise<RitualLlmSnapshotShape & { endpoint: string }> {
  const pk = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error(
      "Custom Ritual LLM stream needs KEEPER_PRIVATE_KEY (pays gas + LLM fees)."
    );
  }

  const account = privateKeyToAccount(normalizePk(pk));
  const client = publicClient();
  const wallet = createWalletClient({
    account,
    chain: ritualChain,
    transport: http(RPC_URL, { timeout: 120_000 }),
  });

  const executor = await resolveExecutor(client);
  const messagesJson = buildMessages(userPrompt);
  const data = encodeLlmRequest(executor, messagesJson);

  // Ensure RitualWallet has some balance (best-effort deposit if empty)
  try {
    const bal = (await client.readContract({
      address: RITUAL_WALLET,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    if (bal < parseEther("0.05")) {
      const dep = await wallet.writeContract({
        address: RITUAL_WALLET,
        abi: [
          {
            name: "deposit",
            type: "function",
            stateMutability: "payable",
            inputs: [{ name: "lockDuration", type: "uint256" }],
            outputs: [],
          },
        ] as const,
        functionName: "deposit",
        args: [BigInt(5000)],
        value: parseEther("0.1"),
        chain: ritualChain,
        account,
      });
      await client.waitForTransactionReceipt({ hash: dep, timeout: 90_000 });
    }
  } catch (e) {
    console.warn("[ritualLlm] RitualWallet deposit skipped/failed", e);
  }

  const hash = await wallet.sendTransaction({
    to: LLM_PRECOMPILE,
    data,
    gas: BigInt(3_000_000),
    chain: ritualChain,
    account,
  });

  // Poll for settlement (short-running async may need a few blocks)
  let resultHex: Hex | null = null;
  for (let i = 0; i < 12; i++) {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
      confirmations: i === 0 ? 1 : 0,
    });
    resultHex = extractLlmResult(receipt);
    if (resultHex) break;
    await new Promise((r) => setTimeout(r, 1500));
    // re-fetch receipt
    const again = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (again) resultHex = extractLlmResult(again);
    if (resultHex) break;
  }

  if (!resultHex) {
    throw new Error(
      "Ritual LLM: no PrecompileCalled result yet (executor timeout or still settling). Retry wake."
    );
  }

  const [hasError, completionData, , errorMessage] = decodeAbiParameters(
    parseAbiParameters("bool, bytes, bytes, string, (string,string,string)"),
    resultHex
  );

  if (hasError) {
    throw new Error(
      `Ritual LLM error: ${errorMessage || "unknown"}`.slice(0, 240)
    );
  }

  const content = extractTextFromCompletionData(completionData as Hex);
  if (!content || content.length < 2) {
    throw new Error("Ritual LLM returned empty content");
  }

  const shaped = parseCompletionToShape(content);
  return {
    ...shaped,
    endpoint: `ritual-llm:0x0802:${hash.slice(0, 12)}`,
  };
}

export function isCustomRitualKind(id: string): boolean {
  return id === "custom_ritual_llm";
}
