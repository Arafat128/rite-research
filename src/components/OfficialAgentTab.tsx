"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import {
  encodeFunctionData,
  formatEther,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import {
  addressUrl,
  ritualChain,
  txUrl,
} from "@/lib/ritual";
import {
  buildPersistentCompressedLaunch,
  buildSovereignRollingCompressedLaunch,
  buildSovereignTwoStepLaunch,
  explainSovereignRevert,
  PERSISTENT_FACTORY,
  ritualEip1559Fees,
  SOVEREIGN_FACTORY,
  sovereignFactoryAbi,
  sovereignHarnessAbi,
  type OfficialKind,
} from "@/lib/officialAgents";
import {
  listOfficialAgents,
  registerOfficialAgent,
  type OfficialAgentRecord,
} from "@/lib/officialAgentStore";
import { useToast } from "@/components/ToastProvider";
import { ErrorFeedback } from "@/components/ErrorFeedback";
import {
  buildErrorReport,
  isUserRejection,
  rememberErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";

type Props = {
  mode: "deploy" | "manage";
};

export function OfficialAgentTab({ mode }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: ritualChain.id });
  const toast = useToast();

  const [kind, setKind] = useState<OfficialKind>("sovereign");
  const [name, setName] = useState("Rite Agent");
  const [prompt, setPrompt] = useState(
    "You are a helpful Ritual AI agent for crypto research. Introduce yourself briefly."
  );
  const [model, setModel] = useState("");
  const [useRitualLlm, setUseRitualLlm] = useState(true);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [hfRepoId, setHfRepoId] = useState("");
  const [schedulerFunding, setSchedulerFunding] = useState("2");
  const [dkmsFunding, setDkmsFunding] = useState("0");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);
  const [rows, setRows] = useState<OfficialAgentRecord[]>([]);

  const wrongChain = isConnected && chainId !== ritualChain.id;

  const refreshList = useCallback(() => {
    if (!address) {
      setRows([]);
      return;
    }
    setRows(listOfficialAgents(address));
  }, [address]);

  useEffect(() => {
    refreshList();
  }, [refreshList, mode]);

  useEffect(() => {
    if (kind === "persistent") {
      setDkmsFunding((v) => (v === "0" ? "50" : v));
      setUseRitualLlm(false);
    } else {
      setDkmsFunding("0");
      setUseRitualLlm(true);
    }
  }, [kind]);

  const totalFundingLabel = useMemo(() => {
    try {
      const a = parseEther(schedulerFunding || "0");
      const b = parseEther(dkmsFunding || "0");
      return formatEther(a + b);
    } catch {
      return "?";
    }
  }, [schedulerFunding, dkmsFunding]);

  async function ensureWallet() {
    if (!isConnected) {
      const c = connectors.find((x) => x.id === "injected") || connectors[0];
      if (!c) throw new Error("Install MetaMask or another web3 wallet");
      connect({ connector: c, chainId: ritualChain.id });
      throw new Error("Connect wallet and try again");
    }
    if (wrongChain) {
      switchChain({ chainId: ritualChain.id });
      throw new Error("Switch to Ritual Chain and try again");
    }
    if (!walletClient || !address) throw new Error("Wallet not ready");
  }

  async function launchOfficial() {
    setBusy(true);
    setMsg("");
    setErrorReport(null);
    try {
      await ensureWallet();
      if (!walletClient || !address) throw new Error("Wallet not ready");
      if (!name.trim()) throw new Error("Enter an agent name");

      setMsg(
        kind === "sovereign"
          ? "Building official Sovereign launch (TEE executor + factory)…"
          : "Building official Persistent launch (TEE + DA + factory)…"
      );

      // Cheap Ritual EIP-1559 fees (avoids MetaMask "higher fee than necessary")
      const fees = await ritualEip1559Fees(
        publicClient ?? undefined
      );

      if (kind === "sovereign") {
        /**
         * Path A (preferred): two-step deployHarness + configureFundAndStart
         * Path B (fallback): launchSovereignCompressedRolling (live factory has this;
         *   NOT launchSovereignCompressed which is missing on-chain → always reverts)
         */
        const useOneShot = false; // set true to try rolling one-shot

        if (useOneShot) {
          const built = await buildSovereignRollingCompressedLaunch({
            owner: address,
            name: name.trim(),
            prompt: prompt.trim(),
            model: model.trim() || undefined,
            useRitualLlm: useRitualLlm && !anthropicKey.trim(),
            anthropicKey: anthropicKey.trim() || undefined,
            schedulerFundingRit: schedulerFunding,
            dkmsFundingRit: dkmsFunding,
          });
          setMsg(
            `Confirm one-shot rolling launch · ${formatEther(built.value)} RIT`
          );
          const data = encodeFunctionData({
            abi: sovereignFactoryAbi,
            functionName: "launchSovereignCompressedRolling",
            args: built.args as never,
          });
          const hash = await walletClient.sendTransaction({
            chain: ritualChain,
            account: address,
            to: SOVEREIGN_FACTORY,
            data,
            value: built.value,
            gas: built.gasLimit,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            type: "eip1559",
          });
          if (publicClient) {
            const r = await publicClient.waitForTransactionReceipt({
              hash,
              timeout: 180_000,
            });
            if (r.status !== "success") {
              throw new Error(
                `One-shot rolling launch failed (gas ${r.gasUsed}/${built.gasLimit}). Try two-step or a new name.`
              );
            }
          }
          registerOfficialAgent({
            kind: "sovereign",
            name: name.trim(),
            owner: address,
            childAddress: built.harness,
            userSalt: built.userSalt,
            createTx: hash,
            createdAt: Date.now(),
            prompt: prompt.trim(),
            model: built.model,
            executor: built.executor.teeAddress,
            status: "armed via compressed rolling",
          });
          toast.success("Official Sovereign launched", built.harness.slice(0, 12));
          setMsg(`Sovereign ready · ${built.harness}\nTx ${hash}`);
        } else {
          // Two-step: deployHarness → configureFundAndStart
          const built = await buildSovereignTwoStepLaunch({
            owner: address,
            name: name.trim(),
            prompt: prompt.trim(),
            model: model.trim() || undefined,
            useRitualLlm: useRitualLlm && !anthropicKey.trim(),
            anthropicKey: anthropicKey.trim() || undefined,
            schedulerFundingRit: schedulerFunding,
            dkmsFundingRit: dkmsFunding,
          });

          if (publicClient) {
            const bal = await publicClient.getBalance({ address });
            const need = built.configureValue + parseEther("0.02");
            if (bal < need) {
              throw new Error(
                `Need ~${formatEther(need)} RIT (funding ${formatEther(built.configureValue)} + gas). Wallet has ${formatEther(bal)} RIT.`
              );
            }
          }

          setMsg(
            `Step 1/2 · Deploy harness ${built.harness.slice(0, 10)}… (v3 two-step)`
          );

          if (publicClient) {
            try {
              await publicClient.simulateContract({
                address: SOVEREIGN_FACTORY,
                abi: sovereignFactoryAbi,
                functionName: "deployHarness",
                args: [built.userSalt],
                account: address,
              });
            } catch (simErr: unknown) {
              const raw =
                simErr instanceof Error ? simErr.message : String(simErr);
              throw new Error(explainSovereignRevert(raw));
            }
          }

          const deployData = encodeFunctionData({
            abi: sovereignFactoryAbi,
            functionName: "deployHarness",
            args: [built.userSalt],
          });
          const deployHash = await walletClient.sendTransaction({
            chain: ritualChain,
            account: address,
            to: SOVEREIGN_FACTORY,
            data: deployData,
            gas: built.gasDeploy,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            type: "eip1559",
          });

          setMsg(`Step 1/2 sent ${deployHash.slice(0, 12)}… waiting…`);
          if (publicClient) {
            const r1 = await publicClient.waitForTransactionReceipt({
              hash: deployHash,
              timeout: 180_000,
            });
            if (r1.status !== "success") {
              throw new Error(
                `Step 1 deployHarness failed (gas ${r1.gasUsed}/${built.gasDeploy}). Use a new agent name.`
              );
            }
            const code = await publicClient.getBytecode({
              address: built.harness,
            });
            if (!code || code === "0x") {
              throw new Error(
                "Harness address has no code after deploy — salt mismatch. Hard-refresh and retry with a new name."
              );
            }
          }

          setMsg(
            `Step 2/2 · Fund + arm ${formatEther(built.configureValue)} RIT (cheap Ritual fee)`
          );

          if (publicClient) {
            try {
              await publicClient.simulateContract({
                address: built.harness,
                abi: sovereignHarnessAbi,
                functionName: "configureFundAndStart",
                args: [
                  built.params as never,
                  built.schedule as never,
                  built.rolling as never,
                  built.schedulerLockDuration,
                ],
                account: address,
                value: built.configureValue,
              });
            } catch (simErr: unknown) {
              const raw =
                simErr instanceof Error ? simErr.message : String(simErr);
              throw new Error(
                explainSovereignRevert(raw) +
                  " (step 1 ok — use a new agent name to restart)"
              );
            }
          }

          const cfgData = encodeFunctionData({
            abi: sovereignHarnessAbi,
            functionName: "configureFundAndStart",
            args: [
              built.params as never,
              built.schedule as never,
              built.rolling as never,
              built.schedulerLockDuration,
            ],
          });
          const cfgHash = await walletClient.sendTransaction({
            chain: ritualChain,
            account: address,
            to: built.harness,
            data: cfgData,
            value: built.configureValue,
            gas: built.gasConfigure,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            type: "eip1559",
          });

          setMsg(`Step 2/2 sent ${cfgHash.slice(0, 12)}… waiting…`);
          if (publicClient) {
            const r2 = await publicClient.waitForTransactionReceipt({
              hash: cfgHash,
              timeout: 180_000,
            });
            if (r2.status !== "success") {
              throw new Error(
                `Step 2 configureFundAndStart failed (gas ${r2.gasUsed}/${built.gasConfigure}). Funding or schedule rejected — try new name + ≥2 RIT.`
              );
            }
          }

          registerOfficialAgent({
            kind: "sovereign",
            name: name.trim(),
            owner: address,
            childAddress: built.harness,
            userSalt: built.userSalt,
            createTx: cfgHash,
            createdAt: Date.now(),
            prompt: prompt.trim(),
            model: built.model,
            executor: built.executor.teeAddress,
            status: "armed · scheduler will call 0x080C",
          });
          toast.success(
            "Official Sovereign launched",
            `Harness ${built.harness.slice(0, 10)}…`
          );
          setMsg(
            `Sovereign ready · harness ${built.harness}\nDeploy tx ${deployHash}\nConfigure tx ${cfgHash}\nOpen My Agents → Ritual AI.`
          );
        }
      } else {
        const built = await buildPersistentCompressedLaunch({
          owner: address,
          name: name.trim(),
          model: model.trim() || undefined,
          llmApiKey: llmKey,
          hfToken,
          hfRepoId,
          schedulerFundingRit: schedulerFunding,
          dkmsFundingRit: dkmsFunding,
        });

        setMsg(
          `Confirm launch in wallet · launcher ${built.launcher.slice(0, 10)}… · total ${formatEther(built.value)} RIT`
        );

        const hash = await walletClient.writeContract({
          chain: ritualChain,
          account: address,
          address: PERSISTENT_FACTORY,
          abi: (
            await import("@/lib/officialAgents")
          ).persistentFactoryAbi,
          functionName: "launchPersistentCompressed",
          args: built.args as never,
          value: built.value,
          gas: built.gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          type: "eip1559",
        });

        setMsg(`Launch sent ${hash.slice(0, 12)}… waiting for confirmation`);
        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: 180_000,
          });
          if (receipt.status !== "success") {
            throw new Error(
              "Persistent launch reverted on-chain. Check LLM key, HF repo, and DKMS funding."
            );
          }
        }

        registerOfficialAgent({
          kind: "persistent",
          name: name.trim(),
          owner: address,
          childAddress: built.launcher,
          userSalt: built.userSalt,
          createTx: hash,
          createdAt: Date.now(),
          model: model.trim() || "provider default",
          executor: built.executor.teeAddress,
          status: "launched · monitor heartbeat after Phase 2",
        });
        toast.success(
          "Official Persistent launched",
          `Launcher ${built.launcher.slice(0, 10)}…`
        );
        setMsg(
          `Persistent launcher deployed · ${built.launcher}\nTx ${hash}\nSpawn runs via 0x0820 after schedule. Fund DKMS was ${dkmsFunding} RIT.`
        );
      }

      refreshList();
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const friendly = explainSovereignRevert(raw);
      const report = buildErrorReport(e, {
        where:
          kind === "sovereign"
            ? "official.sovereign.launch"
            : "official.persistent.launch",
        chainId,
        wallet: address,
        userMessage: friendly,
      });
      // Prefer explained detail for support
      report.detail = (report.detail + " | " + raw).slice(0, 600);
      rememberErrorReport(report);
      if (
        isUserRejection(report.detail) ||
        isUserRejection(report.userMessage)
      ) {
        setMsg("Cancelled in wallet");
        setErrorReport(null);
      } else {
        setErrorReport(report);
        setMsg("");
        toast.error(
          "Official launch failed",
          `Code ${report.code} — copy report for support`,
          report
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center">
        <p className="mb-4 text-sm text-white/60">
          Connect wallet to{" "}
          {mode === "deploy"
            ? "launch official Ritual agents"
            : "view official Ritual agents"}
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
    );
  }

  if (wrongChain) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center">
        <p className="mb-4 text-sm text-amber-100">
          Switch your wallet to Ritual Chain to continue.
        </p>
        <button
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: ritualChain.id })}
          className="btn-primary rounded-xl px-6 py-3"
        >
          {switching ? "Switching…" : "Switch to Ritual"}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-[#c8ff4a]">
          {mode === "deploy"
            ? "Deploy Ritual AI agent"
            : "My Ritual AI agents"}
        </h2>
        <span className="rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-violet-200">
          Official TEE · v3 two-step
        </span>
      </div>
      <p className="mb-5 text-sm text-white/50">
        {mode === "deploy" ? (
          <>
            Launch real Ritual chain agents via factories —{" "}
            <b className="text-white/75">Sovereign</b> (job ·{" "}
            <code className="text-white/45">0x080C</code>) or{" "}
            <b className="text-white/75">Persistent</b> (long-lived ·{" "}
            <code className="text-white/45">0x0820</code>). Separate from Surf
            data agents.
          </>
        ) : (
          <>
            Official agents launched from this browser. Child contract =
            harness (Sovereign) or launcher (Persistent).
          </>
        )}
      </p>

      {mode === "deploy" && (
        <div className="glass space-y-4 rounded-2xl p-5">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["sovereign", "Sovereign · 0x080C"],
                ["persistent", "Persistent · 0x0820"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setKind(id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  kind === id
                    ? "bg-violet-400 text-black"
                    : "border border-white/15 bg-black/30 text-white/65"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="text-[11px] text-white/40">Agent name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            />
          </div>

          {kind === "sovereign" && (
            <>
              <div>
                <label className="text-[11px] text-white/40">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-[12px] text-white/60">
                <input
                  type="checkbox"
                  checked={useRitualLlm && !anthropicKey}
                  onChange={(e) => setUseRitualLlm(e.target.checked)}
                />
                Use Ritual LLM (no API key · ZeroClaw · recommended)
              </label>
              {!useRitualLlm && (
                <div>
                  <label className="text-[11px] text-white/40">
                    Anthropic API key (encrypted to TEE)
                  </label>
                  <input
                    type="password"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    placeholder="sk-ant-…"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                    autoComplete="off"
                  />
                </div>
              )}
            </>
          )}

          {kind === "persistent" && (
            <>
              <p className="rounded-lg border border-amber-400/30 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-100">
                Persistent needs a real LLM key + HuggingFace DA. DKMS funding
                pays heartbeats — too low and the agent may not stay alive.
              </p>
              <div>
                <label className="text-[11px] text-white/40">
                  LLM API key (encrypted to TEE)
                </label>
                <input
                  type="password"
                  value={llmKey}
                  onChange={(e) => setLlmKey(e.target.value)}
                  placeholder="sk-ant-… or OpenAI / Gemini key"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-[11px] text-white/40">
                    HuggingFace token
                  </label>
                  <input
                    type="password"
                    value={hfToken}
                    onChange={(e) => setHfToken(e.target.value)}
                    placeholder="hf_…"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-white/40">
                    HF repo (user/repo)
                  </label>
                  <input
                    value={hfRepoId}
                    onChange={(e) => setHfRepoId(e.target.value)}
                    placeholder="alice/my-agent-workspace"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="text-[11px] text-white/40">
              Model (optional override)
            </label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                kind === "sovereign"
                  ? "default: zai-org/GLM-4.7-FP8"
                  : "default: claude-sonnet-4-5-20250929"
              }
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] text-white/40">
                Scheduler funding (RIT)
              </label>
              <input
                value={schedulerFunding}
                onChange={(e) => setSchedulerFunding(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] text-white/40">
                DKMS funding (RIT)
              </label>
              <input
                value={dkmsFunding}
                onChange={(e) => setDkmsFunding(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
              />
            </div>
          </div>

          <div className="rounded-xl border border-violet-400/25 bg-black/30 p-3 text-sm">
            <div className="flex justify-between text-white/70">
              <span>
                {kind === "sovereign"
                  ? "Configure funding (step 2)"
                  : "Total factory value"}
              </span>
              <span className="font-semibold text-violet-200">
                {totalFundingLabel} RIT
              </span>
            </div>
            <p className="mt-1 text-[10px] text-white/35">
              {kind === "sovereign"
                ? "Sovereign uses 2 wallet confirms: deploy harness, then fund+arm. Plus gas."
                : "Plus gas. Factory: " + PERSISTENT_FACTORY.slice(0, 10) + "…"}
            </p>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void launchOfficial()}
            className="btn-primary w-full rounded-xl py-3 text-sm"
          >
            {busy
              ? "Launching…"
              : `Launch official ${kind === "sovereign" ? "Sovereign (2 steps)" : "Persistent"} · ${totalFundingLabel} RIT + gas`}
          </button>
        </div>
      )}

      {mode === "manage" && (
        <div className="space-y-3">
          {rows.length === 0 ? (
            <div className="glass rounded-2xl p-6 text-center text-sm text-white/50">
              No official Ritual agents in this browser yet. Deploy one from
              the Deploy tab → Ritual AI agent.
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={`${r.childAddress}-${r.createdAt}`}
                className="glass rounded-2xl border border-violet-400/20 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-lg font-semibold text-white">
                      {r.name}
                    </div>
                    <div className="text-xs text-white/45">
                      {r.kind === "sovereign" ? "Sovereign" : "Persistent"} ·{" "}
                      {r.model || "—"}
                    </div>
                  </div>
                  <span className="rounded-full border border-violet-400/40 bg-violet-500/15 px-2.5 py-0.5 text-[11px] text-violet-100">
                    {r.kind}
                  </span>
                </div>
                <p className="mt-2 break-all font-mono text-[11px] text-white/55">
                  {r.childAddress}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                  <a
                    href={addressUrl(r.childAddress as Address)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-violet-200 underline"
                  >
                    Explorer ↗
                  </a>
                  {r.createTx && (
                    <a
                      href={txUrl(r.createTx as Hex)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#c8ff4a]/80 underline"
                    >
                      Launch tx ↗
                    </a>
                  )}
                </div>
                {r.status && (
                  <p className="mt-2 text-[11px] text-white/40">{r.status}</p>
                )}
                {r.prompt && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-white/35">
                    {r.prompt}
                  </p>
                )}
              </div>
            ))
          )}
          <button
            type="button"
            onClick={refreshList}
            className="text-xs text-white/40 underline"
          >
            Refresh list
          </button>
        </div>
      )}

      {errorReport && (
        <div className="mt-4">
          <ErrorFeedback
            report={errorReport}
            onDismiss={() => setErrorReport(null)}
          />
        </div>
      )}
      {msg && !errorReport && (
        <p className="mt-4 whitespace-pre-wrap text-center text-sm text-white/70">
          {msg}
        </p>
      )}
    </div>
  );
}
