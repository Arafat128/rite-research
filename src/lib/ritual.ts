import {
  createPublicClient,
  defineChain,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const RESEARCH_FEE = parseEther(
  process.env.NEXT_PUBLIC_RESEARCH_FEE || "0.005"
);

export const FEE_RECIPIENT = (process.env.NEXT_PUBLIC_FEE_RECIPIENT ||
  "0x0000000000000000000000000000000000000000") as Address;

export const RESEARCH_CONTRACT = (process.env.NEXT_PUBLIC_RESEARCH_CONTRACT ||
  "") as Address;

export const RADAR_CONTRACT = (process.env.NEXT_PUBLIC_RADAR_CONTRACT ||
  "") as Address;

export const BOUNTY_CONTRACT = (process.env.NEXT_PUBLIC_BOUNTY_CONTRACT ||
  "") as Address;

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.ritualfoundation.org";

export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ||
  "https://explorer.ritualfoundation.org";

export const ritualChain = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID || 1979),
  name: "Ritual Testnet",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Ritual Explorer", url: EXPLORER_URL },
  },
});

/**
 * Direct Ritual RPC client for contract reads.
 * Prefer this over wagmi usePublicClient — wallet chain / connector
 * state can make wagmi's client undefined or point at the wrong network.
 *
 * Pass forceNew=true to drop a stuck keep-alive connection (flaky RPC).
 */
let _ritualReadClient: PublicClient | null = null;

export function getRitualReadClient(forceNew = false): PublicClient {
  if (forceNew || !_ritualReadClient) {
    _ritualReadClient = createPublicClient({
      chain: ritualChain,
      transport: http(RPC_URL, {
        timeout: 30_000,
        retryCount: 3,
        retryDelay: 400,
      }),
    });
  }
  return _ritualReadClient;
}

export const researchDeskAbi = [
  {
    type: "function",
    name: "payForResearch",
    stateMutability: "payable",
    inputs: [{ name: "promptHash", type: "bytes32" }],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "settleResearch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "resultHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "researchFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getRecord",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "researcher", type: "address" },
          { name: "feePaid", type: "uint256" },
          { name: "paidAt", type: "uint256" },
          { name: "settledAt", type: "uint256" },
          { name: "promptHash", type: "bytes32" },
          { name: "resultHash", type: "bytes32" },
          { name: "settled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "researcherCount",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "researcherIds",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "event",
    name: "ResearchPaid",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "researcher", type: "address", indexed: true },
      { name: "promptHash", type: "bytes32", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

export function txUrl(hash: Hex | string) {
  return `${EXPLORER_URL}/tx/${hash}`;
}

/** Auto-bounty pool — 50% of research + agent fees; one winner per round */
export const bountyPoolAbi = [
  {
    type: "function",
    name: "lastWinnerInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "winner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "finalizedAt", type: "uint256" },
      { name: "wonRoundId", type: "uint256" },
      { name: "currentPool", type: "uint256" },
      { name: "currentEntrants", type: "uint256" },
      { name: "currentRoundId", type: "uint256" },
      { name: "ready", type: "bool" },
      { name: "interactions", type: "uint256" },
      { name: "threshold", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "poolBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "entrantCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "interactionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "interactionThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "interactionsRemaining",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "points",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "canFinalize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "finalizeRound",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      { name: "winner", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "lastWinner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "lastPayout",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastFinalizedAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastRoundId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalPaidOut",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "WinnerPaid",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "entrants", type: "uint256", indexed: false },
      { name: "totalPoints", type: "uint256", indexed: false },
      { name: "interactions", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AutoFinalized",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Credited",
    inputs: [
      { name: "roundId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "newPoints", type: "uint256", indexed: false },
      { name: "interactionCount", type: "uint256", indexed: false },
      { name: "feeder", type: "address", indexed: true },
    ],
  },
] as const;

export function addressUrl(addr: string) {
  return `${EXPLORER_URL}/address/${addr}`;
}

export const STATUS_LABELS = [
  "None",
  "Active",
  "Paused",
  "OutOfFunds",
  "Dead",
] as const;

/** On-chain agent class */
export const AGENT_KIND = {
  Persistent: 0,
  Sovereign: 1,
} as const;

export type AgentKindId = (typeof AGENT_KIND)[keyof typeof AGENT_KIND];

export const AGENT_KIND_LABELS = ["Persistent", "Sovereign"] as const;

/** Deploy fees (must match RadarAgent.sol constants) */
export const PERSISTENT_DEPLOY_FEE = parseEther("0.1");
export const SOVEREIGN_DEPLOY_FEE = parseEther("0.01");
export const SOVEREIGN_MAX_RUNS = 3;

export function deployFeeForKind(kind: AgentKindId) {
  return kind === AGENT_KIND.Persistent
    ? PERSISTENT_DEPLOY_FEE
    : SOVEREIGN_DEPLOY_FEE;
}

export const radarAgentAbi = [
  {
    type: "function",
    name: "createAgent",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "wakeIntervalBlocks", type: "uint256" },
      { name: "kind", type: "uint8" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "deployFee",
    stateMutability: "pure",
    inputs: [{ name: "kind", type: "uint8" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "PERSISTENT_DEPLOY_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "SOVEREIGN_DEPLOY_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "SOVEREIGN_MAX_RUNS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ticksRemaining",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "fundAgent",
    stateMutability: "payable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "killAgent",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setActive",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setWatchlist",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "topics", type: "string[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setWakeInterval",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "blocks_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "runTick",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "digest", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "runFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "status", type: "uint8" },
          { name: "kind", type: "uint8" },
          { name: "balance", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "lastRunAt", type: "uint256" },
          { name: "runCount", type: "uint256" },
          { name: "maxRuns", type: "uint256" },
          { name: "wakeIntervalBlocks", type: "uint256" },
          { name: "name", type: "string" },
          { name: "lastDigest", type: "bytes32" },
          { name: "lastTopic", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getWatchlist",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "string[]" }],
  },
  {
    type: "function",
    name: "ownerAgentCount",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerAgentIds",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "nextAgentId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "AgentCreated",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "kind", type: "uint8", indexed: false },
      { name: "deployFee", type: "uint256", indexed: false },
      { name: "fundedBalance", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AgentDied",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "kind", type: "uint8", indexed: false },
      { name: "runCount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AgentTick",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "topic", type: "string", indexed: false },
      { name: "digest", type: "bytes32", indexed: false },
      { name: "feePaid", type: "uint256", indexed: false },
      { name: "runCount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StatusChanged",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "status", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AgentKilled",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "UnknownAgent", inputs: [] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "BadStatus", inputs: [] },
  { type: "error", name: "AgentIsDead", inputs: [] },
  { type: "error", name: "InsufficientPayment", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "EmptyWatchlist", inputs: [] },
] as const;
