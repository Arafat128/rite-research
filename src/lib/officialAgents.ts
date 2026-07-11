/**
 * Official Ritual Persistent (0x0820) + Sovereign (0x080C) agent launch helpers.
 * Factory-backed compressed launches — separate product from Rite Radar data agents.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseEther,
  stringToBytes,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { encrypt, ECIES_CONFIG } from "eciesjs";
import { getRitualReadClient, RPC_URL, ritualChain } from "@/lib/ritual";

// Force ECIES nonce length required by Ritual executors
ECIES_CONFIG.symmetricNonceLength = 12;

export const SOVEREIGN_FACTORY = (process.env
  .NEXT_PUBLIC_SOVEREIGN_FACTORY ||
  "0x9dC4C054e53bCc4Ce0A0Ff09E890A7a8e817f304") as Address;

export const PERSISTENT_FACTORY = (process.env
  .NEXT_PUBLIC_PERSISTENT_FACTORY ||
  "0xD4AA9D55215dc8149Af57605e70921Ea16b73591") as Address;

export const TEE_SERVICE_REGISTRY = (process.env
  .NEXT_PUBLIC_TEE_SERVICE_REGISTRY ||
  "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F") as Address;

export const ASYNC_DELIVERY = (process.env.NEXT_PUBLIC_ASYNC_DELIVERY ||
  "0x5A16214fF555848411544b005f7Ac063742f39F6") as Address;

export type OfficialKind = "sovereign" | "persistent";

export type TeeExecutor = {
  teeAddress: Address;
  publicKey: Hex;
  paymentAddress: Address;
  endpoint: string;
};

const teeRegistryAbi = [
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
        name: "",
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
] as const;

const StorageRefComponents = [
  { name: "platform", type: "string" },
  { name: "path", type: "string" },
  { name: "keyRef", type: "string" },
] as const;

/** Shared SovereignAgentParams components (factory + harness). */
export const sovereignParamsComponents = [
  { name: "executor", type: "address" },
  { name: "ttl", type: "uint256" },
  { name: "userPublicKey", type: "bytes" },
  { name: "pollIntervalBlocks", type: "uint64" },
  { name: "maxPollBlock", type: "uint64" },
  { name: "taskIdMarker", type: "string" },
  { name: "deliveryTarget", type: "address" },
  { name: "deliverySelector", type: "bytes4" },
  { name: "deliveryGasLimit", type: "uint256" },
  { name: "deliveryMaxFeePerGas", type: "uint256" },
  { name: "deliveryMaxPriorityFeePerGas", type: "uint256" },
  { name: "cliType", type: "uint16" },
  { name: "prompt", type: "string" },
  { name: "encryptedSecrets", type: "bytes" },
  {
    name: "convoHistory",
    type: "tuple",
    components: [...StorageRefComponents],
  },
  {
    name: "output",
    type: "tuple",
    components: [...StorageRefComponents],
  },
  {
    name: "skills",
    type: "tuple[]",
    components: [...StorageRefComponents],
  },
  {
    name: "systemPrompt",
    type: "tuple",
    components: [...StorageRefComponents],
  },
  { name: "model", type: "string" },
  { name: "tools", type: "string[]" },
  { name: "maxTurns", type: "uint16" },
  { name: "maxTokens", type: "uint32" },
  { name: "rpcUrls", type: "string" },
] as const;

export const sovereignScheduleComponents = [
  { name: "schedulerGas", type: "uint32" },
  { name: "frequency", type: "uint32" },
  { name: "schedulerTtl", type: "uint32" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "maxPriorityFeePerGas", type: "uint256" },
  { name: "value", type: "uint256" },
] as const;

export const sovereignRollingComponents = [
  { name: "windowNumCalls", type: "uint32" },
  { name: "rolloverThresholdBps", type: "uint16" },
  { name: "rolloverRetryEveryCalls", type: "uint16" },
] as const;

export const sovereignFactoryAbi = [
  {
    name: "predictHarness",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "userSalt", type: "bytes32" },
    ],
    outputs: [
      { name: "harness", type: "address" },
      { name: "childSalt", type: "bytes32" },
    ],
  },
  {
    name: "predictCompressedHarness",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "userSalt", type: "bytes32" },
    ],
    outputs: [
      { name: "harness", type: "address" },
      { name: "compressedSalt", type: "bytes32" },
      { name: "childSalt", type: "bytes32" },
    ],
  },
  {
    name: "deployHarness",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "userSalt", type: "bytes32" }],
    outputs: [{ name: "harness", type: "address" }],
  },
  {
    name: "launchSovereignCompressed",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "userSalt", type: "bytes32" },
      { name: "executor", type: "address" },
      { name: "dkmsTtl", type: "uint64" },
      { name: "dkmsFunding", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [...sovereignParamsComponents],
      },
      {
        name: "schedule",
        type: "tuple",
        components: [...sovereignScheduleComponents],
      },
      { name: "schedulerLockDuration", type: "uint256" },
      { name: "schedulerFunding", type: "uint256" },
      { name: "windowNumCalls", type: "uint32" },
    ],
    outputs: [
      { name: "harness", type: "address" },
      { name: "dkmsPaymentAddress", type: "address" },
      { name: "schedulerCallId", type: "uint256" },
    ],
  },
] as const;

/** Child harness deployed by SovereignAgentFactory */
export const sovereignHarnessAbi = [
  {
    name: "configureFundAndStart",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [...sovereignParamsComponents],
      },
      {
        name: "schedule",
        type: "tuple",
        components: [...sovereignScheduleComponents],
      },
      {
        name: "rolling",
        type: "tuple",
        components: [...sovereignRollingComponents],
      },
      { name: "schedulerLockDuration", type: "uint256" },
    ],
    outputs: [{ name: "schedulerCallId", type: "uint256" }],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "configured",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

export const persistentFactoryAbi = [
  {
    name: "predictCompressedLauncher",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "userSalt", type: "bytes32" },
    ],
    outputs: [
      { name: "launcher", type: "address" },
      { name: "compressedSalt", type: "bytes32" },
      { name: "childSalt", type: "bytes32" },
    ],
  },
  {
    name: "launchPersistentCompressed",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "userSalt", type: "bytes32" },
      { name: "executor", type: "address" },
      { name: "dkmsTtl", type: "uint64" },
      { name: "dkmsFunding", type: "uint256" },
      { name: "persistentInput", type: "bytes" },
      {
        name: "schedule",
        type: "tuple",
        components: [
          { name: "schedulerGas", type: "uint32" },
          { name: "schedulerTtl", type: "uint32" },
          { name: "maxFeePerGas", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "value", type: "uint256" },
        ],
      },
      { name: "schedulerLockDuration", type: "uint256" },
      { name: "schedulerFunding", type: "uint256" },
    ],
    outputs: [
      { name: "launcher", type: "address" },
      { name: "dkmsPaymentAddress", type: "address" },
      { name: "callId", type: "uint256" },
    ],
  },
] as const;

const emptyRef = { platform: "", path: "", keyRef: "" } as const;

export const SOVEREIGN_DELIVERY_SELECTOR = toFunctionSelector(
  "onSovereignAgentResult(bytes32,bytes)"
);
export const PERSISTENT_DELIVERY_SELECTOR = toFunctionSelector(
  "onPersistentAgentResult(bytes32,bytes)"
);

/** CLI / harness types for sovereign */
export const CLI_TYPE = {
  CLAUDE_CODE: 0,
  CRUSH: 5,
  ZEROCLAW: 6,
} as const;

export const LLM_PROVIDER_ENUM = {
  ANTHROPIC: 0,
  OPENAI: 1,
  GEMINI: 2,
  XAI: 3,
  OPENROUTER: 4,
} as const;

export function makeUserSalt(seed: string): Hex {
  return keccak256(stringToBytes(seed));
}

export async function findHealthyExecutor(
  client?: PublicClient
): Promise<TeeExecutor> {
  const c = client || getRitualReadClient();
  const services = await c.readContract({
    address: TEE_SERVICE_REGISTRY,
    abi: teeRegistryAbi,
    functionName: "getServicesByCapability",
    args: [0, true], // HTTP_CALL
  });

  const ok = services.find(
    (s) =>
      s.isValid &&
      s.node.teeAddress &&
      s.node.teeAddress !== "0x0000000000000000000000000000000000000000" &&
      s.node.publicKey &&
      s.node.publicKey !== "0x"
  );
  if (!ok) {
    throw new Error(
      "No healthy Ritual TEE executor available right now. Try again in a few minutes."
    );
  }
  return {
    teeAddress: ok.node.teeAddress,
    publicKey: ok.node.publicKey,
    paymentAddress: ok.node.paymentAddress,
    endpoint: ok.node.endpoint,
  };
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
}

/** Encrypt JSON secrets to executor public key (ECIES nonce 12). */
export function encryptSecretsToExecutor(
  executorPublicKey: Hex,
  secrets: Record<string, string>
): Hex {
  ECIES_CONFIG.symmetricNonceLength = 12;
  const json = JSON.stringify(secrets);
  const key = executorPublicKey.startsWith("0x")
    ? executorPublicKey.slice(2)
    : executorPublicKey;
  // eciesjs accepts hex public key; payload as Uint8Array (browser-safe)
  const encrypted = encrypt(
    key,
    new TextEncoder().encode(json)
  ) as Uint8Array;
  return bytesToHex(encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted));
}

/** Two-step path: harness owned by user EOA (recommended). */
export async function predictSovereignHarness(
  owner: Address,
  userSalt: Hex,
  client?: PublicClient
): Promise<Address> {
  const c = client || getRitualReadClient();
  const [harness] = (await c.readContract({
    address: SOVEREIGN_FACTORY,
    abi: sovereignFactoryAbi,
    functionName: "predictHarness",
    args: [owner, userSalt],
  })) as [Address, Hex];
  return harness;
}

/** Compressed path: harness owned via factory intermediate salt. */
export async function predictSovereignCompressedHarness(
  owner: Address,
  userSalt: Hex,
  client?: PublicClient
): Promise<Address> {
  const c = client || getRitualReadClient();
  const [harness] = (await c.readContract({
    address: SOVEREIGN_FACTORY,
    abi: sovereignFactoryAbi,
    functionName: "predictCompressedHarness",
    args: [owner, userSalt],
  })) as [Address, Hex, Hex];
  return harness;
}

export async function predictPersistentLauncher(
  owner: Address,
  userSalt: Hex,
  client?: PublicClient
): Promise<Address> {
  const c = client || getRitualReadClient();
  const [launcher] = (await c.readContract({
    address: PERSISTENT_FACTORY,
    abi: persistentFactoryAbi,
    functionName: "predictCompressedLauncher",
    args: [owner, userSalt],
  })) as [Address, Hex, Hex];
  return launcher;
}

export type SovereignLaunchParams = {
  owner: Address;
  name: string;
  prompt: string;
  /** Default: ritual GLM via ZeroClaw (no external API key) */
  model?: string;
  cliType?: number;
  /** Extra secrets; always merges LLM_PROVIDER */
  secrets?: Record<string, string>;
  useRitualLlm?: boolean;
  anthropicKey?: string;
  schedulerFundingRit?: string;
  dkmsFundingRit?: string;
  windowNumCalls?: number;
  frequency?: number;
};

export type BuiltSovereignTwoStep = {
  userSalt: Hex;
  harness: Address;
  executor: TeeExecutor;
  /** Funding for configureFundAndStart (RitualWallet deposit on harness) */
  configureValue: bigint;
  model: string;
  params: Record<string, unknown>;
  schedule: Record<string, unknown>;
  rolling: {
    windowNumCalls: number;
    rolloverThresholdBps: number;
    rolloverRetryEveryCalls: number;
  };
  schedulerLockDuration: bigint;
  gasDeploy: bigint;
  gasConfigure: bigint;
};

/**
 * Build two-step Sovereign launch (more reliable than compressed):
 * 1) factory.deployHarness(userSalt)
 * 2) harness.configureFundAndStart{value}(params, schedule, rolling, lock)
 *
 * Avoids factory-inline DKMS extraction (common compressed-path revert).
 */
export async function buildSovereignTwoStepLaunch(
  p: SovereignLaunchParams,
  client?: PublicClient
): Promise<BuiltSovereignTwoStep> {
  const c = client || getRitualReadClient();
  const executor = await findHealthyExecutor(c);
  const userSalt = makeUserSalt(
    `rite-sov:${p.owner.toLowerCase()}:${p.name}:${Date.now()}`
  );
  // Two-step uses predictHarness(owner, salt) — NOT compressed predict
  const harness = await predictSovereignHarness(p.owner, userSalt, c);

  const useRitual = p.useRitualLlm !== false && !p.anthropicKey;
  const secrets: Record<string, string> = {
    ...(p.secrets || {}),
  };
  if (useRitual) {
    secrets.LLM_PROVIDER = "ritual";
  } else if (p.anthropicKey) {
    secrets.LLM_PROVIDER = "anthropic";
    secrets.ANTHROPIC_API_KEY = p.anthropicKey;
  } else {
    secrets.LLM_PROVIDER = secrets.LLM_PROVIDER || "ritual";
  }

  const encryptedSecrets = encryptSecretsToExecutor(
    executor.publicKey,
    secrets
  );

  const model =
    p.model ||
    (useRitual || secrets.LLM_PROVIDER === "ritual"
      ? "zai-org/GLM-4.7-FP8"
      : "claude-sonnet-4-5-20250929");

  const cliType =
    p.cliType ??
    (secrets.LLM_PROVIDER === "ritual"
      ? CLI_TYPE.ZEROCLAW
      : CLI_TYPE.CRUSH);

  // Keep lifespan safely under Scheduler MAX_LIFESPAN (10_000):
  // frequency * windowNumCalls <= 10000
  const windowNumCalls = p.windowNumCalls ?? 3;
  const frequency = p.frequency ?? 2000;
  if (frequency * windowNumCalls > 10_000) {
    throw new Error(
      `Invalid schedule: frequency×window (${frequency}×${windowNumCalls}) exceeds 10000 block lifespan`
    );
  }

  const schedulerFunding = parseEther(p.schedulerFundingRit || "2");

  const params = {
    executor: executor.teeAddress,
    ttl: BigInt(500),
    userPublicKey: "0x" as Hex,
    pollIntervalBlocks: BigInt(5),
    maxPollBlock: BigInt(6000),
    taskIdMarker: "RITE_SOVEREIGN",
    deliveryTarget: harness,
    deliverySelector: SOVEREIGN_DELIVERY_SELECTOR,
    deliveryGasLimit: BigInt(3_000_000),
    deliveryMaxFeePerGas: BigInt(20_000_000_000),
    deliveryMaxPriorityFeePerGas: BigInt(1_000_000_000),
    cliType,
    prompt: p.prompt || `You are ${p.name}, a Ritual sovereign agent for Rite.`,
    encryptedSecrets,
    convoHistory: emptyRef,
    output: emptyRef,
    skills: [] as Array<typeof emptyRef>,
    systemPrompt: emptyRef,
    model,
    tools: [] as string[],
    maxTurns: 50,
    maxTokens: 8192,
    rpcUrls: JSON.stringify({ ritual: RPC_URL }),
  };

  // schedulerGas is gas for each scheduled wake callback — keep moderate
  const schedule = {
    schedulerGas: 1_500_000,
    frequency,
    schedulerTtl: 500,
    maxFeePerGas: BigInt(20_000_000_000),
    maxPriorityFeePerGas: BigInt(1_000_000_000),
    value: BigInt(0),
  };

  const rolling = {
    windowNumCalls,
    rolloverThresholdBps: 5000,
    rolloverRetryEveryCalls: 1,
  };

  return {
    userSalt,
    harness,
    executor,
    configureValue: schedulerFunding,
    model,
    params,
    schedule,
    rolling,
    schedulerLockDuration: BigInt(100_000),
    gasDeploy: BigInt(1_000_000),
    gasConfigure: BigInt(4_000_000),
  };
}

/** @deprecated prefer buildSovereignTwoStepLaunch — kept for tests */
export async function buildSovereignCompressedLaunch(
  p: SovereignLaunchParams,
  client?: PublicClient
) {
  const two = await buildSovereignTwoStepLaunch(p, client);
  return {
    userSalt: two.userSalt,
    harness: two.harness,
    executor: two.executor,
    value: two.configureValue,
    gasLimit: two.gasConfigure,
    factory: SOVEREIGN_FACTORY,
    args: [] as unknown[],
    twoStep: two,
  };
}

/** Decode common factory/harness revert strings for user reports. */
export function explainSovereignRevert(raw: string): string {
  const t = raw || "";
  if (/InvalidDeliveryTarget/i.test(t)) {
    return "Harness address mismatch — refresh and try again (delivery target bug).";
  }
  if (/InvalidValue/i.test(t)) {
    return "msg.value must equal funding total. Check Scheduler funding field.";
  }
  if (/InvalidDkmsOutput|DkmsFunding/i.test(t)) {
    return "DKMS derivation failed on this executor — try again (different TEE node).";
  }
  if (/ScheduleLifespanExceeded|lifespan/i.test(t)) {
    return "Schedule lifespan too long (frequency × window > 10000 blocks).";
  }
  if (/AlreadyRunning|already configured|configured/i.test(t)) {
    return "This harness is already configured. Use a new agent name.";
  }
  if (/insufficient funds|exceeds the balance/i.test(t)) {
    return "Not enough RIT in wallet for funding + gas.";
  }
  if (/out of gas|OutOfGas/i.test(t)) {
    return "Transaction ran out of gas — retry (we use higher limits now).";
  }
  if (/execution reverted/i.test(t) && t.length < 80) {
    return "On-chain revert. Ensure ≥2 RIT for scheduler funding + gas, then retry.";
  }
  return t.slice(0, 280);
}

export type PersistentLaunchParams = {
  owner: Address;
  name: string;
  model?: string;
  /** Provider enum 0-4 */
  provider?: number;
  llmApiKey?: string;
  hfToken?: string;
  hfRepoId?: string;
  schedulerFundingRit?: string;
  dkmsFundingRit?: string;
};

export type BuiltPersistentLaunch = {
  userSalt: Hex;
  launcher: Address;
  executor: TeeExecutor;
  value: bigint;
  args: readonly unknown[];
  gasLimit: bigint;
  factory: Address;
};

const PERSISTENT_INPUT_ABI = parseAbiParameters(
  [
    "address",
    "bytes[]",
    "uint256",
    "bytes[]",
    "bytes",
    "uint64",
    "address",
    "bytes4",
    "uint256",
    "uint256",
    "uint256",
    "uint256",
    "uint8",
    "string",
    "string",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "(string,string,string)",
    "string",
    "string",
    "uint16",
  ].join(", ")
);

export async function buildPersistentCompressedLaunch(
  p: PersistentLaunchParams,
  client?: PublicClient
): Promise<BuiltPersistentLaunch> {
  const c = client || getRitualReadClient();
  const executor = await findHealthyExecutor(c);
  const userSalt = makeUserSalt(
    `rite-per:${p.owner.toLowerCase()}:${p.name}:${Date.now()}`
  );
  const launcher = await predictPersistentLauncher(p.owner, userSalt, c);

  if (!p.llmApiKey?.trim()) {
    throw new Error(
      "Persistent agents need an LLM API key (Anthropic / OpenAI / Gemini / OpenRouter). Ritual gateway is sovereign-only."
    );
  }
  if (!p.hfToken?.trim() || !p.hfRepoId?.trim()) {
    throw new Error(
      "Persistent agents need HuggingFace DA: token + repo (user/repo) for memory/checkpoints."
    );
  }

  const provider = p.provider ?? LLM_PROVIDER_ENUM.ANTHROPIC;
  const providerKeyName =
    provider === LLM_PROVIDER_ENUM.OPENAI
      ? "OPENAI_API_KEY"
      : provider === LLM_PROVIDER_ENUM.GEMINI
        ? "GEMINI_API_KEY"
        : provider === LLM_PROVIDER_ENUM.OPENROUTER
          ? "OPENROUTER_API_KEY"
          : "ANTHROPIC_API_KEY";

  const secrets: Record<string, string> = {
    [providerKeyName]: p.llmApiKey.trim(),
    HF_TOKEN: p.hfToken.trim(),
  };

  const encrypted = encryptSecretsToExecutor(executor.publicKey, secrets);
  const model =
    p.model ||
    (provider === LLM_PROVIDER_ENUM.OPENAI
      ? "gpt-4o-mini"
      : provider === LLM_PROVIDER_ENUM.GEMINI
        ? "gemini-2.5-flash"
        : "claude-sonnet-4-5-20250929");

  const repo = p.hfRepoId.trim();
  const hf = (path: string) =>
    ({ platform: "hf", path: `${repo}/${path}`, keyRef: "HF_TOKEN" }) as const;

  const persistentInput = encodeAbiParameters(PERSISTENT_INPUT_ABI, [
    executor.teeAddress,
    [encrypted],
    BigInt(300),
    [] as Hex[],
    "0x" as Hex,
    BigInt(600),
    launcher,
    PERSISTENT_DELIVERY_SELECTOR,
    BigInt(500_000),
    BigInt(1_000_000_000),
    BigInt(100_000_000),
    BigInt(0),
    provider,
    model,
    providerKeyName,
    hf("manifest.json"),
    hf("SOUL.md"),
    emptyRef,
    emptyRef,
    hf("MEMORY.md"),
    hf("IDENTITY.md"),
    hf("TOOLS.md"),
    emptyRef,
    "",
    JSON.stringify({ ritual: RPC_URL }),
    0, // ZeroClaw runtime
  ]);

  // DKMS funding must be real for heartbeats; default lower for UX with warning in UI
  const dkmsFunding = parseEther(p.dkmsFundingRit || "50");
  const schedulerFunding = parseEther(p.schedulerFundingRit || "5");

  const schedule = {
    schedulerGas: 3_000_000,
    schedulerTtl: 500,
    maxFeePerGas: BigInt(1_000_000_000),
    maxPriorityFeePerGas: BigInt(100_000_000),
    value: BigInt(0),
  };

  return {
    userSalt,
    launcher,
    executor,
    value: dkmsFunding + schedulerFunding,
    gasLimit: BigInt(10_000_000),
    factory: PERSISTENT_FACTORY,
    args: [
      userSalt,
      executor.teeAddress,
      BigInt(300),
      dkmsFunding,
      persistentInput,
      schedule,
      BigInt(100_000),
      schedulerFunding,
    ],
  };
}

export function encodeSovereignLaunchData(args: readonly unknown[]): Hex {
  return encodeFunctionData({
    abi: sovereignFactoryAbi,
    functionName: "launchSovereignCompressed",
    args: args as never,
  });
}

export function encodePersistentLaunchData(args: readonly unknown[]): Hex {
  return encodeFunctionData({
    abi: persistentFactoryAbi,
    functionName: "launchPersistentCompressed",
    args: args as never,
  });
}

export { ritualChain };
