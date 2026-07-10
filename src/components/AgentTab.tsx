"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
  useBalance,
} from "wagmi";
import {
  formatEther,
  parseEther,
  keccak256,
  stringToBytes,
  decodeEventLog,
} from "viem";
import {
  RADAR_CONTRACT,
  radarAgentAbi,
  STATUS_LABELS,
  ritualChain,
  addressUrl,
  txUrl,
  RESEARCH_FEE,
  AGENT_KIND,
  AGENT_KIND_LABELS,
  PERSISTENT_DEPLOY_FEE,
  SOVEREIGN_DEPLOY_FEE,
  SOVEREIGN_MAX_RUNS,
  deployFeeForKind,
  getRitualReadClient,
  type AgentKindId,
} from "@/lib/ritual";
import {
  DATA_KINDS,
  decodeAgentTrack,
  encodeAgentTrack,
  snapshotCellHref,
  snapshotCellText,
  type DataKindId,
  type SnapshotCell,
  type SurfDataSnapshot,
} from "@/lib/surfData";
import { sanitizeHttpUrl } from "@/lib/safeUrl";
import {
  BLOCK_TIME_SEC,
  computeDue,
  formatChainTime,
  formatCountdown,
  formatInterval,
  scheduleToBlocks,
  type ScheduleUnit,
} from "@/lib/agentSchedule";
import {
  getAppAgent,
  isAgentClosed,
  listTicks,
  markAgentClosed,
  registerAppAgent,
  saveTick,
  type TickRecord,
} from "@/lib/agentStore";
import { mergeTickRecords, tickFromAgentState } from "@/lib/agentTicks";
import {
  pingRadar,
  readAgent as readAgentOnChain,
  readOwnerAgentCount,
  readOwnerAgentIds,
  readTicksRemaining,
  readWatchlist,
  readNextAgentId,
  type AgentView,
} from "@/lib/radarRead";
import {
  assertWalletCanPayGas,
  decodeRadarRevert,
  isMissingKillFunctionError,
  prepareRadarWrite,
  radarHasKnownKill,
  supportsKillAgent,
} from "@/lib/radarWrite";
import { useToast } from "@/components/ToastProvider";
import { TelegramNotifyCard } from "@/components/TelegramNotifyCard";

/** Load chain/keeper ticks and merge with this browser's localStorage history. */
async function loadMergedTicks(
  agentId: string,
  agent?: AgentView | null
): Promise<TickRecord[]> {
  const local = listTicks(agentId);
  let remote: TickRecord[] = [];
  try {
    const res = await fetch(
      `/api/agent/ticks?agentId=${encodeURIComponent(agentId)}`,
      { cache: "no-store" }
    );
    if (res.ok) {
      const data = (await res.json()) as { ticks?: TickRecord[] };
      remote = Array.isArray(data.ticks) ? data.ticks : [];
    }
  } catch {
    /* RPC / API flaky — keep local */
  }
  let merged = mergeTickRecords(local, remote);
  if (merged.length === 0 && agent && agent.runCount > BigInt(0)) {
    const fromState = tickFromAgentState({
      agentId,
      runCount: agent.runCount,
      lastRunAt: agent.lastRunAt,
      lastTopic: agent.lastTopic,
      lastDigest: agent.lastDigest,
    });
    if (fromState) merged = [fromState];
  }
  return merged;
}

/** Deploy tab steps only */
const DEPLOY_FLOW = [
  { n: 1, t: "Class", d: "Persistent or Sovereign" },
  { n: 2, t: "Stream", d: "Lock one Data API kind" },
  { n: 3, t: "Deploy", d: "Pay fee + fund balance" },
] as const;

/** Manage tab steps (live agent) */
const MANAGE_FLOW = [
  { n: 1, t: "Select", d: "Pick a live agent" },
  { n: 2, t: "Activate", d: "Status → LIVE" },
  { n: 3, t: "Fund", d: "Keep run balance" },
  { n: 4, t: "Wake", d: "Data API → seal tick" },
] as const;

function statusColor(s: number) {
  if (s === 1) return "bg-emerald-400 text-black";
  if (s === 2) return "bg-amber-300 text-black";
  if (s === 3) return "bg-red-400 text-black";
  if (s === 4) return "bg-zinc-500 text-white";
  return "bg-white/20 text-white";
}

function statusText(s: number) {
  if (s === 1) return "LIVE";
  if (s === 4) return "DEAD";
  return STATUS_LABELS[s] || "?";
}

function errMsg(e: unknown, context?: string) {
  // Prefer decoded Radar reverts / gas hints over raw MetaMask noise
  const decoded = decodeRadarRevert(e, context);
  if (decoded && decoded !== "undefined") return decoded;
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === "object" && "shortMessage" in e) {
    return String((e as { shortMessage?: string }).shortMessage);
  }
  return String(e);
}

function fmtMaxUint(n: bigint): string {
  // ticksRemaining returns type(uint256).max for persistent
  if (n > BigInt(1_000_000)) return "∞";
  return n.toString();
}

export function AgentTab({
  mode = "deploy",
}: {
  /** deploy = create agents · manage = live agents only */
  mode?: "deploy" | "manage";
}) {
  const { address, isConnected, chainId } = useAccount();
  // Wagmi client only for waitForTransactionReceipt after writes
  const publicClient = usePublicClient({ chainId: ritualChain.id });
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: walletBal } = useBalance({
    address,
    chainId: ritualChain.id,
  });
  const { writeContractAsync, isPending: writing } = useWriteContract();
  const toast = useToast();

  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [agentIds, setAgentIds] = useState<bigint[]>([]);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [ticksLeft, setTicksLeft] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [ticking, setTicking] = useState(false);

  // deploy form
  const [agentKind, setAgentKind] = useState<AgentKindId>(AGENT_KIND.Persistent);
  const [name, setName] = useState("Price Radar");
  const [dataKind, setDataKind] = useState<DataKindId>("market_price");
  const [target, setTarget] = useState("BTC");
  const [extraFund, setExtraFund] = useState("0.02");
  const [schedValue, setSchedValue] = useState("15");
  const [schedUnit, setSchedUnit] = useState<ScheduleUnit>("minutes");
  const [editSchedValue, setEditSchedValue] = useState("15");
  const [editSchedUnit, setEditSchedUnit] = useState<ScheduleUnit>("minutes");
  const [fundAmt, setFundAmt] = useState("0.01");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));

  const [networkLive, setNetworkLive] = useState(0);
  const [networkTotal, setNetworkTotal] = useState(0);
  const [ticks, setTicks] = useState<TickRecord[]>([]);
  const [lastSnapshot, setLastSnapshot] = useState<SurfDataSnapshot | null>(
    null
  );
  /** Lightweight status map for agent chips (avoid full panel for dead) */
  const [agentMeta, setAgentMeta] = useState<
    Record<
      string,
      { status: number; kind: number; name: string; balance: string }
    >
  >({});
  /** False on older Radar deploys without killAgent in bytecode */
  const [canKillOnChain, setCanKillOnChain] = useState<boolean | null>(null);

  /** On-chain Dead OR soft-closed (withdraw+pause on contracts without killAgent) */
  const agentFinished =
    agent != null &&
    selectedId != null &&
    (agent.status === 4 || isAgentClosed(selectedId.toString()));

  const wrongChain = isConnected && chainId !== ritualChain.id;
  const dataDef = DATA_KINDS.find((k) => k.id === dataKind)!;
  const track = useMemo(() => decodeAgentTrack(watchlist), [watchlist]);
  const deployFee = deployFeeForKind(agentKind);
  const extraFundWei = useMemo(() => {
    try {
      return parseEther(extraFund || "0");
    } catch {
      return BigInt(0);
    }
  }, [extraFund]);
  const totalDeployValue = deployFee + extraFundWei;

  const wakeBlocksForCreate = useMemo(
    () =>
      scheduleToBlocks({
        value: Number(schedValue) || 1,
        unit: schedUnit,
      }),
    [schedValue, schedUnit]
  );

  const dueInfo = useMemo(() => {
    if (!agent) return null;
    return computeDue(agent.lastRunAt, agent.wakeIntervalBlocks, nowTick);
  }, [agent, nowTick]);

  // Live countdown for schedule
  useEffect(() => {
    const t = setInterval(
      () => setNowTick(Math.floor(Date.now() / 1000)),
      1000
    );
    return () => clearInterval(t);
  }, []);

  // Sync edit schedule fields when agent loads
  useEffect(() => {
    if (!agent) return;
    const blocks = Number(agent.wakeIntervalBlocks);
    const sec = blocks * BLOCK_TIME_SEC;
    if (sec >= 3600 && sec % 3600 < BLOCK_TIME_SEC * 2) {
      setEditSchedUnit("hours");
      setEditSchedValue(String(Math.max(1, Math.round(sec / 3600))));
    } else if (sec >= 60) {
      setEditSchedUnit("minutes");
      setEditSchedValue(String(Math.max(1, Math.round(sec / 60))));
    } else {
      setEditSchedUnit("blocks");
      setEditSchedValue(String(Math.max(1, blocks)));
    }
  }, [agent?.wakeIntervalBlocks, selectedId]);

  const { data: runFee } = useReadContract({
    address: RADAR_CONTRACT || undefined,
    abi: radarAgentAbi,
    functionName: "runFee",
    query: { enabled: Boolean(RADAR_CONTRACT) },
  });
  const fee = runFee ?? RESEARCH_FEE;
  const feeLabel = formatEther(fee);

  const refreshNetwork = useCallback(async () => {
    if (!RADAR_CONTRACT) return;
    try {
      const nextId = await readNextAgentId();
      const total = nextId > BigInt(1) ? Number(nextId - BigInt(1)) : 0;
      setNetworkTotal(total);

      let live = 0;
      const start = Math.max(1, total - 39);
      for (let i = start; i <= total; i++) {
        const a = await readAgentOnChain(BigInt(i));
        if (a && a.status === 1) live += 1;
      }
      setNetworkLive(live);
    } catch {
      /* ignore network scan errors — flaky RPC */
    }
  }, []);

  const refresh = useCallback(async (opts?: { soft?: boolean }) => {
    if (!address || !RADAR_CONTRACT) return;
    setLoading(true);
    if (!opts?.soft) setErr("");
    try {
      // Soft ping only — do not hard-fail the whole tab on one empty RPC response
      const ok = await pingRadar();
      if (!ok) {
        // Still try owner reads; RPC often recovers mid-flow
        console.warn("[radar] ping failed, continuing with retries");
      }

      const count = await readOwnerAgentCount(address);
      let ids: bigint[] = [];
      if (count > BigInt(0)) {
        ids = await readOwnerAgentIds(address);
      }
      setAgentIds(ids);

      // Kill support: known map first, then bytecode (never false on 0x50a3)
      try {
        const known = radarHasKnownKill();
        if (known != null) setCanKillOnChain(known);
        else setCanKillOnChain(await supportsKillAgent());
      } catch {
        setCanKillOnChain(radarHasKnownKill() ?? true);
      }

      // Load meta for chips + prefer LIVE agents for default selection
      const meta: Record<
        string,
        { status: number; kind: number; name: string; balance: string }
      > = {};
      for (const id of ids) {
        const row = await readAgentOnChain(id);
        if (row) {
          const finished =
            row.status === 4 || isAgentClosed(id.toString());
          meta[id.toString()] = {
            status: finished ? 4 : row.status,
            kind: row.kind,
            name: row.name,
            balance: row.balance.toString(),
          };
        }
      }
      setAgentMeta(meta);

      const liveIds = ids.filter((id) => meta[id.toString()]?.status !== 4);
      const selectedStillLive =
        selectedId != null &&
        liveIds.some((id) => id === selectedId);

      // Prefer live agents only — never auto-open a dead agent panel
      let pick: bigint | null = null;
      if (selectedStillLive) {
        pick = selectedId;
      } else if (liveIds.length) {
        pick = liveIds[liveIds.length - 1];
      } else {
        pick = null;
      }

      setSelectedId(pick);

      if (pick != null) {
        const a = await readAgentOnChain(pick);
        if (!a) {
          // Keep previous agent panel if soft refresh after a tick
          if (!opts?.soft) {
            setAgent(null);
            setWatchlist([]);
            setTicksLeft(null);
            setErr(
              `Agent #${pick.toString()} temporarily unreadable (RPC). Click Refresh again — your agent is still on-chain.`
            );
          }
        } else {
          setAgent(a);
          setWatchlist(await readWatchlist(pick));
          setTicksLeft(await readTicksRemaining(pick));
          setTicks(await loadMergedTicks(pick.toString(), a));
          setAgentMeta((prev) => ({
            ...prev,
            [pick!.toString()]: {
              status: a.status,
              kind: a.kind,
              name: a.name,
              balance: a.balance.toString(),
            },
          }));
        }
      } else {
        setAgent(null);
        setWatchlist([]);
        setTicks([]);
        setTicksLeft(null);
      }

      await refreshNetwork();

    } catch (e: unknown) {
      // Soft mode: never overwrite a success message with RPC noise
      if (!opts?.soft) setErr(errMsg(e));
      else console.warn("[radar] soft refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, [address, selectedId, refreshNetwork]);

  useEffect(() => {
    if (isConnected && address) void refresh();
  }, [isConnected, address, refresh]);

  useEffect(() => {
    if (!isConnected) return;
    const t = setInterval(() => {
      void refreshNetwork();
      if (selectedId != null) {
        void loadMergedTicks(selectedId.toString()).then(setTicks);
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [isConnected, selectedId, refreshNetwork]);

  useEffect(() => {
    const d = DATA_KINDS.find((k) => k.id === dataKind);
    if (d && d.targetLabel) setTarget(d.defaultTarget);
    else setTarget("_");
  }, [dataKind]);

  const deployFlowStep = useMemo(() => {
    // Deploy form progress only
    if (!isConnected) return 1;
    if (!dataKind) return 2;
    return 3;
  }, [isConnected, dataKind]);

  const manageFlowStep = useMemo(() => {
    if (!agent || agent.status === 4) return 1;
    if (agent.status !== 1) return 2;
    if (agent.balance < fee) return 3;
    return 4;
  }, [agent, fee]);

  const liveAgentIds = useMemo(
    () =>
      agentIds.filter((id) => {
        const m = agentMeta[id.toString()];
        return m && m.status !== 4 && !isAgentClosed(id.toString());
      }),
    [agentIds, agentMeta]
  );

  const deadAgentIds = useMemo(
    () =>
      agentIds.filter((id) => {
        const m = agentMeta[id.toString()];
        return !m || m.status === 4 || isAgentClosed(id.toString());
      }),
    [agentIds, agentMeta]
  );

  // Clear sticky residual/locked-dead errors when viewing My Agents
  useEffect(() => {
    if (mode !== "manage") return;
    if (err && /residual|locked|blocks withdraw after death/i.test(err)) {
      setErr("");
      setMsg("");
    }
    // only on entering manage / err change for that pattern
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function ensureWallet() {
    if (!isConnected) {
      const injected =
        connectors.find((c) => c.id === "injected") || connectors[0];
      if (!injected) throw new Error("Install MetaMask");
      connect({ connector: injected, chainId: ritualChain.id });
      throw new Error("Connect wallet, then try again");
    }
    if (wrongChain) {
      try {
        switchChain({ chainId: ritualChain.id });
      } catch {
        /* user may need to add chain manually */
      }
      throw new Error("Switch wallet network to Ritual Testnet (chain id 1979), then try again");
    }
    if (!RADAR_CONTRACT) throw new Error("NEXT_PUBLIC_RADAR_CONTRACT not set");
    if (!address) throw new Error("Wallet not ready");
  }

  async function waitTx(hash: `0x${string}`) {
    const client = publicClient ?? getRitualReadClient(true);
    return client.waitForTransactionReceipt({ hash, confirmations: 1 });
  }

  /**
   * Write to Radar with simulate + explicit legacy gasPrice.
   * Fixes MetaMask "gas unavailable" on Ritual for withdraw/kill refunds.
   */
  async function radarWrite(opts: {
    functionName:
      | "createAgent"
      | "fundAgent"
      | "withdraw"
      | "killAgent"
      | "setActive"
      | "setPaused"
      | "setWatchlist"
      | "setWakeInterval"
      | "runTick";
    args?: readonly unknown[];
    value?: bigint;
    gasFloor?: bigint;
  }) {
    if (!address) throw new Error("Wallet not ready");
    if (!RADAR_CONTRACT) throw new Error("Radar contract not configured");
    const fees = await prepareRadarWrite({
      account: address,
      functionName: opts.functionName,
      args: opts.args,
      value: opts.value,
      gasFloor: opts.gasFloor,
    });
    assertWalletCanPayGas(walletBal?.value, fees, opts.value ?? BigInt(0));
    return writeContractAsync({
      address: RADAR_CONTRACT,
      abi: radarAgentAbi,
      functionName: opts.functionName,
      args: (opts.args ?? []) as never,
      chainId: ritualChain.id,
      gas: fees.gas,
      gasPrice: fees.gasPrice,
      ...(opts.value != null ? { value: opts.value } : {}),
    } as never);
  }

  async function createAgent() {
    try {
      setErr("");
      setMsg("");
      await ensureWallet();

      const def = DATA_KINDS.find((k) => k.id === dataKind)!;
      const tgt = def.targetLabel
        ? (target || def.defaultTarget).trim()
        : def.defaultTarget;
      if (def.targetLabel && !tgt) throw new Error(`Enter ${def.targetLabel}`);

      const trackCells = encodeAgentTrack(dataKind, tgt);
      const lockedTarget = trackCells[0].split("|")[1] || tgt;
      const wake = wakeBlocksForCreate;
      const value = totalDeployValue;

      if (walletBal && walletBal.value < value) {
        throw new Error(
          `Need ${formatEther(value)} RITUAL (deploy ${formatEther(deployFee)} + fund ${formatEther(extraFundWei)})`
        );
      }

      setMsg(
        `Confirm create · ${AGENT_KIND_LABELS[agentKind]} · deploy fee ${formatEther(deployFee)} RIT…`
      );
      const hash = await radarWrite({
        functionName: "createAgent",
        args: [name || `${def.short} Agent`, wake, agentKind],
        value,
        gasFloor: BigInt(250_000),
      });
      const receipt = await waitTx(hash);
      if (receipt.status !== "success") throw new Error("Create failed");

      let newId: bigint | null = null;
      for (const log of receipt.logs) {
        try {
          const d = decodeEventLog({
            abi: radarAgentAbi,
            data: log.data,
            topics: log.topics,
          });
          if (d.eventName === "AgentCreated") {
            newId = (d.args as { agentId: bigint }).agentId;
          }
        } catch {
          /* skip */
        }
      }
      if (newId == null)
        throw new Error("Agent created but id not found in logs");

      setMsg("Locking data stream on-chain…");
      const wlHash = await radarWrite({
        functionName: "setWatchlist",
        args: [newId, trackCells],
      });
      await waitTx(wlHash);

      registerAppAgent({
        agentId: newId.toString(),
        owner: address!,
        name: name || `${def.short} Agent`,
        agentKind,
        dataKind,
        target: lockedTarget,
        createdAt: Date.now(),
        createTx: hash,
      });

      setSelectedId(newId);
      setMsg(
        `${AGENT_KIND_LABELS[agentKind]} agent #${newId} deployed · schedule ${formatInterval(wake)} · stream ${def.label}${
          def.targetLabel ? ` (${lockedTarget})` : ""
        }${
          agentKind === AGENT_KIND.Sovereign
            ? ` · dies after ${SOVEREIGN_MAX_RUNS} ticks`
            : " · never dies"
        }`
      );
      toast.success(
        `Agent #${newId} deployed`,
        "Open My Agents to activate & wake"
      );
      await refresh();
    } catch (e: unknown) {
      const m = errMsg(e);
      setErr(m);
      setMsg("");
      if (!/reject|denied|connect wallet|switch wallet/i.test(m)) {
        toast.error("Deploy failed", m);
      }
    }
  }

  async function saveSchedule() {
    if (selectedId == null) return;
    try {
      setErr("");
      await ensureWallet();
      if (agent?.status === 4) throw new Error("Agent is dead");
      const n = Number(editSchedValue);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("Enter a positive schedule value (e.g. 3 minutes)");
      }
      const blocks = scheduleToBlocks({
        value: n,
        unit: editSchedUnit,
      });
      setMsg(`Confirm setWakeInterval · ${formatInterval(blocks)}…`);
      const hash = await radarWrite({
        functionName: "setWakeInterval",
        args: [selectedId, blocks],
      });
      await waitTx(hash);
      // Optimistic UI so dashboard updates immediately
      if (agent) {
        setAgent({ ...agent, wakeIntervalBlocks: blocks });
      }
      setMsg(
        `Schedule saved on-chain: ${formatInterval(blocks)}. ` +
          (agent?.status === 1
            ? "Use Wake when due — auto-wake only if keeper cron is configured."
            : "Activate → LIVE, fund if needed, then Wake.")
      );
      toast.success("Schedule saved", formatInterval(blocks));
      await refresh({ soft: true });
    } catch (e: unknown) {
      const m = errMsg(e);
      setErr(m);
      setMsg("");
      if (!/reject|denied/i.test(m)) toast.error("Schedule save failed", m);
    }
  }

  async function fundSelected() {
    if (selectedId == null) return;
    try {
      setErr("");
      await ensureWallet();
      if (agent?.status === 4) throw new Error("Agent is dead — cannot fund");
      const value = parseEther(fundAmt || "0");
      if (value <= BigInt(0)) throw new Error("Enter fund amount > 0");
      setMsg("Confirm fundAgent in wallet…");
      const hash = await radarWrite({
        functionName: "fundAgent",
        args: [selectedId],
        value,
      });
      await waitTx(hash);
      setMsg(`Funded +${fundAmt} RITUAL`);
      toast.success("Agent funded", `+${fundAmt} RIT to agent balance`);
      await refresh();
    } catch (e: unknown) {
      const m = errMsg(e);
      setErr(m);
      setMsg("");
      if (!/reject|denied/i.test(m)) toast.error("Fund failed", m);
    }
  }

  async function withdrawSelected(amountWei?: bigint) {
    if (selectedId == null || !agent) return;
    try {
      setErr("");
      await ensureWallet();
      if (!address) throw new Error("Wallet not ready");

      // Fresh on-chain read — never trust stale UI balance for withdraw
      const live = await readAgentOnChain(selectedId);
      if (!live) {
        throw new Error(
          "Could not read agent on-chain. Check Ritual RPC and try Refresh."
        );
      }
      // Keep panel in sync so DEAD / 0 balance UI updates immediately
      setAgent(live);

      if (live.owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error(
          "Connected wallet is not the owner of this agent. Switch account in MetaMask."
        );
      }
      const bal = live.balance;
      if (bal <= BigInt(0)) {
        throw new Error(
          live.status === 4
            ? "Nothing to withdraw — this agent is dead and its balance is already 0 (refunded when it was killed). Check your wallet history for the refund, then deploy a new agent if needed."
            : "Agent on-chain balance is 0 — nothing to withdraw. Click Refresh."
        );
      }

      let amount = amountWei;
      if (amount == null) {
        const raw = withdrawAmt.trim();
        if (!raw || raw.toLowerCase() === "max" || raw === "all") {
          amount = bal;
        } else {
          amount = parseEther(raw);
        }
      }
      if (amount <= BigInt(0)) throw new Error("Enter withdraw amount > 0");
      if (amount > bal) {
        throw new Error(
          `Amount exceeds on-chain balance (${formatEther(bal)} RIT). Use Withdraw all.`
        );
      }

      setMsg(
        `Confirm withdraw ${formatEther(amount)} RIT from agent #${selectedId}…`
      );
      const hash = await radarWrite({
        functionName: "withdraw",
        args: [selectedId, amount],
        gasFloor: BigInt(120_000),
      });
      const receipt = await waitTx(hash);
      if (receipt.status !== "success") {
        throw new Error("Withdraw transaction reverted on-chain");
      }
      setMsg(`Withdrew ${formatEther(amount)} RIT to your wallet`);
      toast.success("Withdrawn", `${formatEther(amount)} RIT sent to your wallet`);
      setWithdrawAmt("");
      await refresh();
    } catch (e: unknown) {
      const m = errMsg(e, "withdraw");
      setErr(m);
      setMsg("");
      if (!/reject|denied/i.test(m)) toast.error("Withdraw failed", m);
      if (selectedId != null) {
        void readAgentOnChain(selectedId).then((a) => {
          if (!a) return;
          setAgent(a);
          setAgentMeta((prev) => ({
            ...prev,
            [selectedId.toString()]: {
              status: a.status,
              kind: a.kind,
              name: a.name,
              balance: a.balance.toString(),
            },
          }));
        });
      }
    }
  }

  async function killSelected() {
    if (selectedId == null || !agent) return;
    try {
      setErr("");
      await ensureWallet();
      if (!address) throw new Error("Wallet not ready");

      const live = await readAgentOnChain(selectedId);
      if (!live) {
        throw new Error(
          "Could not read agent on-chain. Check Ritual RPC and try Refresh."
        );
      }
      setAgent(live);

      if (live.owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error(
          "Connected wallet is not the owner of this agent. Switch account in MetaMask."
        );
      }
      if (live.status === 4 || isAgentClosed(selectedId.toString())) {
        throw new Error(
          live.balance > BigInt(0)
            ? `Agent is already closed. Use “Withdraw remaining” to pull ${formatEther(live.balance)} RIT.`
            : "Agent is already closed and balance is 0. Deploy a new agent to continue."
        );
      }

      const refundLabel = formatEther(live.balance);
      // Prefer known map / bytecode; never soft-close on kill-capable Radar
      const known = radarHasKnownKill();
      let hasKill =
        known === true
          ? true
          : known === false
            ? false
            : await supportsKillAgent();
      setCanKillOnChain(hasKill);

      // --- Prefer real on-chain kill whenever possible ---
      if (hasKill) {
        const ok = window.confirm(
          `Kill agent #${selectedId.toString()} (${live.name})?\n\n` +
            `Permanent on-chain DEAD. Full balance (${refundLabel} RIT) is refunded to your wallet.\n` +
            `Radar: ${RADAR_CONTRACT?.slice(0, 10)}…\n` +
            `Gas is paid from your wallet (not the agent).`
        );
        if (!ok) return;

        try {
          setMsg(`Confirm killAgent #${selectedId} (refund ${refundLabel} RIT)…`);
          const hash = await radarWrite({
            functionName: "killAgent",
            args: [selectedId],
            gasFloor: BigInt(150_000),
          });
          const receipt = await waitTx(hash);
          if (receipt.status !== "success") {
            throw new Error("Kill transaction reverted on-chain");
          }
          markAgentClosed(selectedId.toString());
          setAgent({ ...live, status: 4, balance: BigInt(0) });
          setAgentMeta((prev) => ({
            ...prev,
            [selectedId.toString()]: {
              status: 4,
              kind: live.kind,
              name: live.name,
              balance: "0",
            },
          }));
          setMsg(
            `Agent #${selectedId} killed on-chain · ${refundLabel} RIT refunded`
          );
          toast.success(
            `Agent #${selectedId} killed`,
            `${refundLabel} RIT refunded · status DEAD`
          );
          setSelectedId(null);
          setErr("");
          await refresh();
          return;
        } catch (killErr: unknown) {
          // Only fall through to soft-close if kill is literally missing
          if (!isMissingKillFunctionError(killErr)) {
            throw killErr;
          }
          setCanKillOnChain(false);
          hasKill = false;
        }
      }

      // --- Soft close: only when Radar has no killAgent (legacy 0x5ed8…) ---
      const ok = window.confirm(
        `Close agent #${selectedId.toString()} (${live.name})?\n\n` +
          `This Radar (${RADAR_CONTRACT?.slice(0, 10)}…) has no killAgent.\n` +
          `We will withdraw balance and pause (not on-chain DEAD).\n\n` +
          `To get real kill: set NEXT_PUBLIC_RADAR_CONTRACT to 0x50a3… and deploy new agents there.`
      );
      if (!ok) return;

      let withdrew = BigInt(0);
      if (live.balance > BigInt(0)) {
        setMsg(
          `Confirm withdraw ${refundLabel} RIT from agent #${selectedId}…`
        );
        const wHash = await radarWrite({
          functionName: "withdraw",
          args: [selectedId, live.balance],
          gasFloor: BigInt(120_000),
        });
        const wRec = await waitTx(wHash);
        if (wRec.status !== "success") {
          throw new Error("Withdraw during close failed");
        }
        withdrew = live.balance;
      }

      const after = await readAgentOnChain(selectedId);
      if (after && after.status === 1) {
        setMsg(`Confirm pause agent #${selectedId}…`);
        const pHash = await radarWrite({
          functionName: "setPaused",
          args: [selectedId],
        });
        const pRec = await waitTx(pHash);
        if (pRec.status !== "success") {
          throw new Error("Pause during close failed");
        }
      }

      markAgentClosed(selectedId.toString());
      setAgent({
        ...(after || live),
        status: 4,
        balance: BigInt(0),
      });
      setAgentMeta((prev) => ({
        ...prev,
        [selectedId.toString()]: {
          status: 4,
          kind: live.kind,
          name: live.name,
          balance: "0",
        },
      }));
      setMsg(
        `Agent #${selectedId} soft-closed` +
          (withdrew > BigInt(0)
            ? ` · withdrew ${formatEther(withdrew)} RIT`
            : "") +
          ` · paused (legacy Radar — not on-chain DEAD)`
      );
      toast.info(
        `Agent #${selectedId} soft-closed`,
        "Legacy Radar has no killAgent — use Radar 0x50a3… for real kill"
      );
      setSelectedId(null);
      setErr("");
      await refresh();
    } catch (e: unknown) {
      const msg = errMsg(e, "killAgent");
      setErr(msg);
      if (!/reject|denied/i.test(msg)) toast.error("Kill failed", msg);
      setMsg("");
      if (selectedId != null) {
        void readAgentOnChain(selectedId).then((a) => {
          if (!a) return;
          setAgent(a);
          setAgentMeta((prev) => ({
            ...prev,
            [selectedId.toString()]: {
              status:
                a.status === 4 || isAgentClosed(selectedId.toString())
                  ? 4
                  : a.status,
              kind: a.kind,
              name: a.name,
              balance: a.balance.toString(),
            },
          }));
        });
      }
    }
  }

  async function setStatus(active: boolean) {
    if (selectedId == null) return;
    try {
      setErr("");
      await ensureWallet();
      if (agent?.status === 4) throw new Error("Agent is dead");
      setMsg(active ? "Activating…" : "Pausing…");
      const hash = await radarWrite({
        functionName: active ? "setActive" : "setPaused",
        args: [selectedId],
      });
      await waitTx(hash);
      setMsg(active ? "Agent LIVE" : "Agent Paused");
      toast.success(active ? "Agent is LIVE" : "Agent paused");
      await refresh();
    } catch (e: unknown) {
      const m = errMsg(e);
      setErr(m);
      setMsg("");
      if (!/reject|denied/i.test(m)) toast.error("Status update failed", m);
    }
  }

  async function runDataTick() {
    if (selectedId == null || !agent) return;
    if (agent.status === 4) {
      setErr("Sovereign agent is dead (finished 3 ticks). Deploy a new one.");
      return;
    }
    const decoded = decodeAgentTrack(watchlist);
    if (!decoded) {
      setErr("Agent has no locked data kind.");
      return;
    }
    try {
      setErr("");
      setTicking(true);
      // Hide previous tick panel while this wake is pending confirm
      setLastSnapshot(null);
      await ensureWallet();

      setMsg(`Fetching ${decoded.kind} off-chain (not shown until tick is confirmed)…`);
      const res = await fetch("/api/agent/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: decoded.kind,
          target: decoded.target,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        snapshot?: SurfDataSnapshot;
      };
      if (!res.ok || !data.snapshot) {
        throw new Error(data.error || "Data API fetch failed");
      }

      // Hold snapshot in memory only — never render until runTick succeeds
      const snapshot = data.snapshot;

      const digestPayload = JSON.stringify({
        kind: snapshot.kind,
        target: snapshot.target,
        summary: snapshot.summary,
        highlights: snapshot.highlights,
        fetchedAt: snapshot.fetchedAt,
        agentId: selectedId.toString(),
      });
      const digest = keccak256(stringToBytes(digestPayload));

      setMsg(
        "Confirm runTick in wallet to charge fee and unlock data. Rejecting cancels this wake — no data shown."
      );
      const hash = await radarWrite({
        functionName: "runTick",
        args: [selectedId, digest],
        gasFloor: BigInt(200_000),
      });
      const receipt = await waitTx(hash);
      if (receipt.status !== "success") {
        throw new Error("runTick transaction reverted");
      }

      // ONLY after on-chain confirm: persist + show
      const newCount = agent.runCount + BigInt(1);
      const rec: TickRecord = {
        agentId: selectedId.toString(),
        runCount: newCount.toString(),
        at: Date.now(),
        txHash: hash,
        digest,
        snapshot,
      };
      saveTick(rec);
      setTicks(await loadMergedTicks(selectedId.toString(), {
        ...agent,
        runCount: newCount,
        lastRunAt: BigInt(Math.floor(Date.now() / 1000)),
        lastDigest: digest,
        lastTopic: `${snapshot.kind}|${snapshot.target}`,
      }));
      setLastSnapshot(snapshot);

      const died =
        agent.kind === AGENT_KIND.Sovereign &&
        agent.maxRuns > BigInt(0) &&
        newCount >= agent.maxRuns;
      setAgent({
        ...agent,
        runCount: newCount,
        lastRunAt: BigInt(Math.floor(Date.now() / 1000)),
        lastDigest: digest,
        balance: agent.balance >= fee ? agent.balance - fee : BigInt(0),
        status: died ? 4 : agent.status,
      });
      if (agent.maxRuns > BigInt(0)) {
        const left =
          newCount >= agent.maxRuns ? BigInt(0) : agent.maxRuns - newCount;
        setTicksLeft(left);
      }

      setErr("");
      setMsg(
        died
          ? `Tick #${newCount}/3 sealed · sovereign agent DIED (life complete)`
          : `Tick #${newCount} sealed · ${snapshot.summary.slice(0, 72)} · fee ${feeLabel} RIT`
      );
      if (died) {
        toast.success(
          `Tick #${newCount} sealed · agent DIED`,
          "Sovereign life complete"
        );
      } else {
        toast.success(
          `Tick #${newCount} sealed`,
          snapshot.summary.slice(0, 80)
        );
      }

      // Telegram DM after successful seal (no flow change if unlinked)
      if (address) {
        void fetch("/api/notify/telegram/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: address,
            agentId: selectedId.toString(),
            agentName: agent.name,
            runCount: newCount.toString(),
            summary: snapshot.summary,
            kindLabel: snapshot.kindLabel,
            target: snapshot.target,
            txHash: hash,
            died,
          }),
        }).catch(() => undefined);
      }

      void refresh({ soft: true });
    } catch (e: unknown) {
      // Drop any pending data — user cancelled or tx failed
      setLastSnapshot(null);
      const m = errMsg(e);
      setErr(
        m +
          " — Data is only shown after you confirm runTick. Try Wake again and approve the transaction."
      );
      setMsg("");
      if (!/reject|denied/i.test(m)) toast.error("Wake / tick failed", m);
    } finally {
      setTicking(false);
    }
  }

  if (!RADAR_CONTRACT) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-amber-200">
        Radar agent contract not configured. Set{" "}
        <code>NEXT_PUBLIC_RADAR_CONTRACT</code>.
      </div>
    );
  }

  const flowSteps = mode === "deploy" ? DEPLOY_FLOW : MANAGE_FLOW;
  const flowStep = mode === "deploy" ? deployFlowStep : manageFlowStep;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-[#c8ff4a]">
          {mode === "deploy" ? "Deploy agent" : "My agents"}
        </h2>
        <span className="rounded-full border border-[#c8ff4a]/30 bg-[#c8ff4a]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#c8ff4a]">
          Surf Data API
        </span>
      </div>
      <p className="mb-5 text-sm text-white/50">
        {mode === "deploy" ? (
          <>
            <b className="text-white/80">Persistent</b> —{" "}
            <b className="text-[#c8ff4a]">
              {formatEther(PERSISTENT_DEPLOY_FEE)} RIT
            </b>{" "}
            deploy · never dies by tick count.{" "}
            <b className="text-white/80">Sovereign</b> —{" "}
            <b className="text-[#c8ff4a]">
              {formatEther(SOVEREIGN_DEPLOY_FEE)} RIT
            </b>{" "}
            · dies after {SOVEREIGN_MAX_RUNS} ticks. Manage live agents in the{" "}
            <b className="text-white/80">My Agents</b> tab.
          </>
        ) : (
          <>
            Control <b className="text-white/80">live</b> agents only — activate,
            fund, schedule, and wake. Dead agents are listed once at the bottom
            (no actions).
          </>
        )}
      </p>

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Network agents"
          value={networkTotal ? String(networkTotal) : "—"}
        />
        <Stat
          label="Live (Active)"
          value={networkTotal ? String(networkLive) : "—"}
        />
        <Stat label="Your live" value={String(liveAgentIds.length)} />
        <Stat label="Your dead" value={String(deadAgentIds.length)} />
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {flowSteps.map((f) => (
          <div
            key={f.n}
            className={`min-w-[88px] flex-1 rounded-xl border p-3 text-center ${
              flowStep === f.n
                ? "border-[#c8ff4a] bg-[#c8ff4a]/15"
                : flowStep > f.n
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-white/10 bg-black/25"
            }`}
          >
            <div className="text-xs font-bold text-[#c8ff4a]">
              {f.n}. {f.t}
            </div>
            <div className="mt-1 text-[10px] text-white/45">{f.d}</div>
          </div>
        ))}
      </div>

      {!isConnected ? (
        <div className="glass rounded-2xl p-6 text-center">
          <p className="mb-4 text-sm text-white/60">
            {mode === "deploy"
              ? "Connect wallet to deploy agents"
              : "Connect wallet to manage your agents"}
          </p>
          <button
            type="button"
            disabled={connecting}
            onClick={() => {
              const c =
                connectors.find((x) => x.id === "injected") || connectors[0];
              if (c) connect({ connector: c, chainId: ritualChain.id });
            }}
            className="btn-primary rounded-xl px-6 py-3"
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : wrongChain ? (
        <button
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: ritualChain.id })}
          className="w-full rounded-xl bg-amber-400 py-3 font-semibold text-black"
        >
          Switch to Ritual (1979)
        </button>
      ) : (
        <div className="space-y-4">
          {mode === "deploy" && (
          <>
          {/* Agent class */}
          <div className="glass rounded-2xl p-5">
            <h3 className="mb-3 text-sm font-semibold text-[#c8ff4a]">
              1 · Agent class
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setAgentKind(AGENT_KIND.Persistent)}
                className={`rounded-xl border p-4 text-left transition ${
                  agentKind === AGENT_KIND.Persistent
                    ? "border-[#c8ff4a] bg-[#c8ff4a]/12"
                    : "border-white/10 bg-black/25 hover:border-white/25"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-white">
                    Persistent
                  </span>
                  <span className="rounded-full bg-[#c8ff4a]/20 px-2 py-0.5 text-[11px] font-bold text-[#c8ff4a]">
                    {formatEther(PERSISTENT_DEPLOY_FEE)} RIT
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-white/50">
                  Does not die. Unlimited ticks while funded. Higher deploy fee
                  for a lasting on-chain agent.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setAgentKind(AGENT_KIND.Sovereign)}
                className={`rounded-xl border p-4 text-left transition ${
                  agentKind === AGENT_KIND.Sovereign
                    ? "border-[#c8ff4a] bg-[#c8ff4a]/12"
                    : "border-white/10 bg-black/25 hover:border-white/25"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-white">
                    Sovereign
                  </span>
                  <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold text-amber-200">
                    {formatEther(SOVEREIGN_DEPLOY_FEE)} RIT
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-white/50">
                  Dies after exactly {SOVEREIGN_MAX_RUNS} ticks. Lower deploy
                  fee for short-lived missions.
                </p>
              </button>
            </div>
          </div>

          {/* Data + deploy */}
          <div className="glass rounded-2xl p-5">
            <h3 className="mb-1 text-sm font-semibold text-[#c8ff4a]">
              2 · Data stream (locked at deploy)
            </h3>
            <p className="mb-3 text-[11px] text-white/40">
              One Surf Data API kind only. Never uses Chat / Responses research.
            </p>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              {DATA_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setDataKind(k.id)}
                  className={`rounded-xl border p-3 text-left transition ${
                    dataKind === k.id
                      ? "border-[#c8ff4a] bg-[#c8ff4a]/12"
                      : "border-white/10 bg-black/25 hover:border-white/25"
                  }`}
                >
                  <div className="text-sm font-semibold text-white">{k.label}</div>
                  <div className="mt-1 text-[11px] leading-snug text-white/45">
                    {k.description}
                  </div>
                </button>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-[11px] text-white/40">Agent name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                />
              </div>
              {dataDef.targetLabel ? (
                <div>
                  <label className="text-[11px] text-white/40">
                    {dataDef.targetLabel}
                  </label>
                  <input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder={dataDef.targetPlaceholder}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-[11px] text-white/40">Target</label>
                  <div className="mt-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/40">
                    Global (no target)
                  </div>
                </div>
              )}
              <div>
                <label className="text-[11px] text-white/40">
                  Extra run fund (after deploy fee) — wallet{" "}
                  {walletBal
                    ? Number(formatEther(walletBal.value)).toFixed(4)
                    : "—"}
                </label>
                <input
                  value={extraFund}
                  onChange={(e) => setExtraFund(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[11px] text-white/40">
                  Auto-wake schedule (blocks or time)
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    value={schedValue}
                    onChange={(e) => setSchedValue(e.target.value)}
                    className="w-28 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                    inputMode="numeric"
                  />
                  <select
                    value={schedUnit}
                    onChange={(e) =>
                      setSchedUnit(e.target.value as ScheduleUnit)
                    }
                    className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="blocks">Blocks</option>
                  </select>
                </div>
                <p className="mt-1 text-[10px] text-white/35">
                  Stores as {wakeBlocksForCreate.toString()} blocks (~
                  {BLOCK_TIME_SEC}s/block) · {formatInterval(wakeBlocksForCreate)}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-[#c8ff4a]/20 bg-black/30 p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2 text-white/70">
                <span>Deploy fee ({AGENT_KIND_LABELS[agentKind]})</span>
                <span className="font-semibold text-[#c8ff4a]">
                  {formatEther(deployFee)} RIT
                </span>
              </div>
              <div className="mt-1 flex flex-wrap justify-between gap-2 text-white/70">
                <span>Run balance fund</span>
                <span>{formatEther(extraFundWei)} RIT</span>
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-white/10 pt-2 font-semibold text-white">
                <span>Total from wallet</span>
                <span className="text-[#c8ff4a]">
                  {formatEther(totalDeployValue)} RIT
                </span>
              </div>
              {agentKind === AGENT_KIND.Sovereign && (
                <p className="mt-2 text-[11px] text-amber-200/80">
                  Sovereign life: {SOVEREIGN_MAX_RUNS} ticks then status → DEAD
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={writing || ticking}
              onClick={createAgent}
              className="btn-primary mt-4 w-full rounded-xl py-3 text-sm"
            >
              {writing
                ? "Confirm in wallet…"
                : `Deploy ${AGENT_KIND_LABELS[agentKind]} · ${formatEther(totalDeployValue)} RIT`}
            </button>
          </div>
          <p className="text-center text-[12px] text-white/40">
            After deploy, open the <b className="text-white/60">My Agents</b>{" "}
            tab to activate and wake.
          </p>
          </>
          )}

          {mode === "manage" && (
          <>
          {address && <TelegramNotifyCard owner={address} />}

          {/* Live agents only */}
          {liveAgentIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/45">Live:</span>
              {liveAgentIds.map((id) => {
                const key = id.toString();
                const reg = getAppAgent(key);
                const meta = agentMeta[key];
                const selected = selectedId === id;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSelectedId(id);
                      setErr("");
                      setMsg("");
                    }}
                    className={`rounded-full px-3 py-1 text-xs ${
                      selected
                        ? "bg-[#c8ff4a] font-semibold text-black"
                        : "border border-white/15 bg-black/30 text-white/70"
                    }`}
                  >
                    #{key}
                    {reg
                      ? ` · ${AGENT_KIND_LABELS[reg.agentKind] || "?"} · ${
                          DATA_KINDS.find((k) => k.id === reg.dataKind)?.short ||
                          reg.dataKind
                        }`
                      : meta
                        ? ` · ${AGENT_KIND_LABELS[meta.kind as AgentKindId] || "?"}`
                        : ""}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => refresh()}
                className="text-xs text-white/40 underline"
              >
                {loading ? "…" : "Refresh"}
              </button>
            </div>
          ) : (
            <div className="glass rounded-2xl p-6 text-center text-sm text-white/50">
              No live agents. Deploy one in the{" "}
              <b className="text-white/70">Deploy</b> tab, then return here.
              <button
                type="button"
                onClick={() => refresh()}
                className="mt-3 block w-full text-xs text-[#c8ff4a] underline"
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          )}

          {/* Dead — minimal one-liner (no big cards, no spam) */}
          {deadAgentIds.length > 0 && (
            <p className="text-[11px] text-white/30">
              Dead: {deadAgentIds.map((id) => `#${id.toString()}`).join(", ")}
            </p>
          )}

          {/* LIVE / active agent — full controls */}
          {agent && selectedId != null && !agentFinished && (
            <div className="glass rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-white">
                    {agent.name}
                  </div>
                  <div className="text-xs text-white/40">
                    #{selectedId.toString()} ·{" "}
                    <span className="text-[#c8ff4a]/90">
                      {AGENT_KIND_LABELS[agent.kind] || "Agent"}
                    </span>
                    {track && (
                      <>
                        {" "}
                        ·{" "}
                        {DATA_KINDS.find((k) => k.id === track.kind)?.label ||
                          track.kind}
                        {track.target && track.target !== "_"
                          ? ` · ${track.target}`
                          : ""}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${statusColor(agent.status)}`}
                >
                  {statusText(agent.status)}
                </span>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat
                  label="Balance"
                  value={`${Number(formatEther(agent.balance)).toFixed(4)} RIT`}
                />
                <Stat
                  label="Ticks"
                  value={
                    agent.maxRuns > BigInt(0)
                      ? `${agent.runCount.toString()}/${agent.maxRuns.toString()}`
                      : agent.runCount.toString()
                  }
                />
                <Stat
                  label="Ticks left"
                  value={
                    ticksLeft != null
                      ? fmtMaxUint(ticksLeft)
                      : agent.maxRuns === BigInt(0)
                        ? "∞"
                        : "—"
                  }
                />
                <Stat
                  label="Schedule"
                  value={formatInterval(agent.wakeIntervalBlocks)}
                />
                <Stat
                  label="Next auto-wake"
                  value={
                    agent.status !== 1
                      ? "activate first"
                      : dueInfo
                        ? dueInfo.due
                          ? "DUE NOW"
                          : formatCountdown(dueInfo.secondsUntilDue)
                        : "—"
                  }
                />
                <Stat
                  label="Last wake"
                  value={formatChainTime(agent.lastRunAt)}
                />
              </div>

                  {agent.status === 3 && (
                    <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-950/40 p-3 text-[12px] text-amber-100">
                      Agent is <b>Out of funds</b> — ticks and auto-wake cannot
                      run. Deposit RIT below, then Activate → LIVE, then Wake.
                    </div>
                  )}

                  <div className="mb-4 rounded-xl border border-[#c8ff4a]/20 bg-black/25 p-3">
                    <div className="mb-2 text-xs font-semibold text-[#c8ff4a]">
                      Wake schedule
                    </div>
                    <p className="mb-2 text-[11px] text-white/40">
                      Saved on-chain as block interval. Example: 3 minutes ≈{" "}
                      {scheduleToBlocks({ value: 3, unit: "minutes" }).toString()}{" "}
                      blocks (~{BLOCK_TIME_SEC}s/block).{" "}
                      <b className="text-white/55">Manual Wake</b> always works
                      when LIVE + funded. Automatic wakes need a server keeper
                      (CRON_SECRET + KEEPER_PRIVATE_KEY) — not just saving a
                      schedule.
                    </p>
                    <p className="mb-2 text-[11px] text-white/50">
                      On-chain interval now:{" "}
                      <b className="text-[#c8ff4a]">
                        {formatInterval(agent.wakeIntervalBlocks)}
                      </b>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={editSchedValue}
                        onChange={(e) => setEditSchedValue(e.target.value)}
                        className="w-24 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        inputMode="numeric"
                      />
                      <select
                        value={editSchedUnit}
                        onChange={(e) =>
                          setEditSchedUnit(e.target.value as ScheduleUnit)
                        }
                        className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        <option value="minutes">Minutes</option>
                        <option value="hours">Hours</option>
                        <option value="blocks">Blocks</option>
                      </select>
                      <button
                        type="button"
                        disabled={writing || ticking}
                        onClick={() => void saveSchedule()}
                        className="btn-primary rounded-lg px-4 text-sm"
                      >
                        Save schedule
                      </button>
                    </div>
                    {dueInfo && agent.status === 1 && (
                      <p
                        className={`mt-2 text-[11px] ${
                          dueInfo.due
                            ? "font-semibold text-amber-200"
                            : "text-white/40"
                        }`}
                      >
                        {dueInfo.due
                          ? "Interval elapsed — click Wake now (or wait for keeper if configured)."
                          : `Next interval in ${formatCountdown(dueInfo.secondsUntilDue)} · ${new Date(dueInfo.nextRunAt * 1000).toLocaleString()}`}
                      </p>
                    )}
                    {agent.status !== 1 && (
                      <p className="mt-2 text-[11px] text-white/40">
                        Activate → LIVE (and fund if needed) before schedule /
                        wake matter.
                      </p>
                    )}
                  </div>

                  <div className="mb-4 rounded-xl border border-white/10 bg-black/25 p-3">
                    <div className="mb-2 text-xs font-semibold text-[#c8ff4a]">
                      Fund run balance
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={fundAmt}
                        onChange={(e) => setFundAmt(e.target.value)}
                        className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        placeholder="0.01"
                      />
                      <button
                        type="button"
                        disabled={writing || ticking}
                        onClick={() => void fundSelected()}
                        className="btn-primary rounded-lg px-4 text-sm"
                      >
                        Deposit
                      </button>
                    </div>
                  </div>

                  <div className="mb-4 rounded-xl border border-white/10 bg-black/25 p-3">
                    <div className="mb-2 text-xs font-semibold text-[#c8ff4a]">
                      Withdraw unused RITUAL
                    </div>
                    <p className="mb-2 text-[11px] text-white/40">
                      Pull extra balance to your wallet (does not kill the
                      agent). Available:{" "}
                      <b className="text-white/70">
                        {formatEther(agent.balance)} RIT
                      </b>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={withdrawAmt}
                        onChange={(e) => setWithdrawAmt(e.target.value)}
                        className="min-w-[8rem] flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        placeholder="Amount or max"
                      />
                      <button
                        type="button"
                        disabled={
                          writing || ticking || agent.balance <= BigInt(0)
                        }
                        onClick={() => void withdrawSelected()}
                        className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
                      >
                        Withdraw
                      </button>
                      <button
                        type="button"
                        disabled={
                          writing || ticking || agent.balance <= BigInt(0)
                        }
                        onClick={() => void withdrawSelected(agent.balance)}
                        className="rounded-lg border border-[#c8ff4a]/30 bg-[#c8ff4a]/10 px-3 py-2 text-sm text-[#c8ff4a]"
                      >
                        Withdraw all
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <button
                      type="button"
                      disabled={writing || ticking}
                      onClick={() => setStatus(true)}
                      className="rounded-xl bg-emerald-400/90 py-2.5 text-sm font-semibold text-black"
                    >
                      Activate → LIVE
                    </button>
                    <button
                      type="button"
                      disabled={writing || ticking}
                      onClick={() => setStatus(false)}
                      className="rounded-xl border border-white/15 bg-black/40 py-2.5 text-sm text-white"
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      disabled={
                        writing || ticking || agent.status !== 1 || !track
                      }
                      onClick={runDataTick}
                      className="btn-primary rounded-xl py-2.5 text-sm"
                    >
                      {ticking ? "Confirm tick in wallet…" : "Wake · pull Data API"}
                    </button>
                  </div>
                  {ticking && (
                    <p className="mt-3 text-center text-[11px] text-amber-200/80">
                      Data is prepared off-chain but <b>not shown</b> until you
                      approve <code className="text-[#c8ff4a]">runTick</code> in
                      your wallet. Reject = no new data, no fee.
                    </p>
                  )}

                  <div className="mt-4 rounded-xl border border-red-400/30 bg-red-950/30 p-3">
                    <div className="mb-1 text-xs font-semibold text-red-300">
                      {canKillOnChain === false
                        ? "Close agent"
                        : "Kill agent"}
                    </div>
                    <p className="mb-2 text-[11px] text-white/45">
                      {canKillOnChain === false
                        ? "This Radar contract has no killAgent function. Close withdraws all balance and pauses the agent (1–2 wallet confirms)."
                        : "Permanent on-chain stop. Remaining balance is refunded. Panel collapses to a small DEAD card after."}
                    </p>
                    <button
                      type="button"
                      disabled={writing || ticking}
                      onClick={() => void killSelected()}
                      className="w-full rounded-xl border border-red-400/50 bg-red-500/20 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/30"
                    >
                      {writing
                        ? "Confirm in wallet…"
                        : canKillOnChain === false
                          ? "Close agent · withdraw & pause"
                          : "Kill agent · refund balance"}
                    </button>
                  </div>
            </div>
          )}

          {/* Only show after runTick is confirmed — live agents only */}
          {ticking && agent && !agentFinished && (
            <div className="glass rounded-2xl p-6 text-center">
              <p className="text-sm font-semibold text-[#c8ff4a]">
                Waiting for runTick confirmation…
              </p>
              <p className="mt-2 text-xs text-white/50">
                Approve the transaction to unlock this wake&apos;s data. Closing
                or rejecting the wallet keeps previous results only.
              </p>
            </div>
          )}

          {!ticking &&
            agent &&
            !agentFinished &&
            (lastSnapshot ||
              (ticks[0]?.snapshot &&
                (ticks[0].snapshot.rows?.length > 0 ||
                  ticks[0].source === "local" ||
                  ticks[0].source === "keeper"))) && (
            <DataSnapshotCard
              snapshot={lastSnapshot || ticks[0].snapshot}
              title="Latest tick data"
            />
          )}

          {!ticking &&
            ticks.length === 0 &&
            agent &&
            !agentFinished &&
            agent.status === 1 && (
            <div className="glass rounded-2xl p-5 text-sm text-white/55">
              <h3 className="mb-2 text-sm font-semibold text-[#c8ff4a]">
                No ticks yet
              </h3>
              <p className="text-[12px] leading-relaxed">
                On-chain run count is <b className="text-white/80">{agent.runCount.toString()}</b>
                {agent.lastRunAt === BigInt(0) ? " · last wake: never" : ""}.
                Tick results appear here after a successful{" "}
                <code className="text-[#c8ff4a]">runTick</code> (manual Wake or
                server keeper). Auto-wake needs{" "}
                <code className="text-[#c8ff4a]">KEEPER_PRIVATE_KEY</code> +{" "}
                <code className="text-[#c8ff4a]">CRON_SECRET</code> on Vercel
                Production and no Deployment Protection blocking{" "}
                <code className="text-[#c8ff4a]">/api/agent/cron</code>.
              </p>
            </div>
          )}

          {ticks.length > 0 && agent && !agentFinished && (
            <div className="glass rounded-2xl p-5">
              <h3 className="mb-3 text-sm font-semibold text-[#c8ff4a]">
                Tick results
              </h3>
              <div className="space-y-3">
                {ticks.slice(0, 8).map((t) => (
                  <div
                    key={`${t.at}-${t.runCount}-${t.txHash || ""}`}
                    className="rounded-xl border border-white/10 bg-black/25 p-3"
                  >
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-white/80">
                        Tick #{t.runCount} · {t.snapshot.kindLabel}
                        {t.snapshot.target && t.snapshot.target !== "_"
                          ? ` · ${t.snapshot.target}`
                          : ""}
                        {t.source === "chain" || t.source === "keeper" ? (
                          <span className="ml-1 text-[10px] font-normal text-white/40">
                            ({t.source === "keeper" ? "auto-wake" : "on-chain"})
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[10px] text-white/40">
                        {new Date(t.at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-[12px] text-white/65">
                      {t.snapshot.summary}
                    </p>
                    {t.txHash &&
                      t.txHash !==
                        "0x0000000000000000000000000000000000000000000000000000000000000000" && (
                      <a
                        href={txUrl(t.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-[11px] text-[#c8ff4a] underline"
                      >
                        Seal tx ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          </>
          )}

          <p className="text-center text-[10px] text-white/30">
            Radar {RADAR_CONTRACT?.slice(0, 6)}…{RADAR_CONTRACT?.slice(-4)}
            {canKillOnChain === true
              ? " · killAgent available"
              : canKillOnChain === false
                ? " · legacy (soft-close only)"
                : ""}{" "}
            <a
              href={addressUrl(RADAR_CONTRACT)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              explorer ↗
            </a>
          </p>
        </div>
      )}

      {(msg || err) && (
        <p
          className={`mt-4 whitespace-pre-wrap text-center text-sm ${
            err ? "text-red-300" : "text-white/70"
          }`}
        >
          {err || msg}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
      <div className="text-[10px] uppercase text-white/40">{label}</div>
      <div className="truncate text-xs font-medium text-white/90">{value}</div>
    </div>
  );
}

function SnapshotCellView({ cell, col }: { cell: SnapshotCell; col: string }) {
  const text = snapshotCellText(cell);
  const href = sanitizeHttpUrl(snapshotCellHref(cell));
  const isHeadline = col === "Headline" || col === "Link" || col === "Title";

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-[min(420px,70vw)] items-start gap-1 font-medium text-[#b8f53a] underline decoration-[#b8f53a]/40 underline-offset-2 hover:text-[#d4ff6a]"
        title={text}
      >
        <span className="whitespace-normal break-words">{text}</span>
        <span className="shrink-0 text-[10px] opacity-70" aria-hidden>
          ↗
        </span>
      </a>
    );
  }

  // Autolink bare https URLs in plain cells
  const bare = sanitizeHttpUrl(text);
  if (bare) {
    return (
      <a
        href={bare}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-medium text-[#b8f53a] underline decoration-[#b8f53a]/40 hover:text-[#d4ff6a]"
      >
        {text}
        <span className="ml-0.5 text-[10px] opacity-70">↗</span>
      </a>
    );
  }

  return (
    <span
      className={
        isHeadline
          ? "whitespace-normal break-words text-[#d8e8d2]"
          : "text-[#d8e8d2]"
      }
      title={text}
    >
      {text || "—"}
    </span>
  );
}

function DataSnapshotCard({
  snapshot,
  title,
}: {
  snapshot: SurfDataSnapshot;
  title: string;
}) {
  const cols = snapshot.rows.length ? Object.keys(snapshot.rows[0]) : [];
  const linkedCount = snapshot.rows.filter((r) =>
    cols.some((c) => snapshotCellHref(r[c]))
  ).length;

  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#c8ff4a]">{title}</h3>
        <span className="text-[10px] text-white/40">
          {snapshot.kindLabel}
          {snapshot.target && snapshot.target !== "_"
            ? ` · ${snapshot.target}`
            : ""}{" "}
          · {new Date(snapshot.fetchedAt).toLocaleString()}
        </span>
      </div>
      <p className="mb-3 text-sm text-white/80">{snapshot.summary}</p>
      {linkedCount > 0 && (
        <p className="mb-2 text-[11px] text-[#c8ff4a]/70">
          Click a headline to open the full article ↗
        </p>
      )}
      {snapshot.highlights.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {snapshot.highlights.map((h) => (
            <Stat key={h.label} label={h.label} value={h.value} />
          ))}
        </div>
      )}
      {snapshot.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[#c8ff4a]/20 bg-black/30">
          <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
            <thead className="bg-[#0d2818] text-[#c8ff4a]">
              <tr>
                {cols.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-[10px] font-semibold uppercase tracking-wide"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {snapshot.rows.map((row, i) => (
                <tr key={i} className="even:bg-white/[0.02] hover:bg-[#c8ff4a]/[0.04]">
                  {cols.map((col) => (
                    <td
                      key={col}
                      className={`align-top px-3 py-2.5 ${
                        col === "Headline" || col === "Title"
                          ? "min-w-[220px] max-w-[420px]"
                          : "max-w-[160px]"
                      }`}
                    >
                      <SnapshotCellView cell={row[col]} col={col} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[10px] text-white/30">
        Endpoint {snapshot.endpoint} · Surf Data API
      </p>
    </div>
  );
}
