"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useWriteContract,
  useReadContract,
  usePublicClient,
  useBalance,
  useConnect,
  useSwitchChain,
  useSignMessage,
} from "wagmi";
import {
  keccak256,
  stringToBytes,
  formatEther,
  decodeEventLog,
  type Hex,
  type Address,
} from "viem";
import {
  RESEARCH_CONTRACT,
  RESEARCH_FEE,
  researchDeskAbi,
  FEE_RECIPIENT,
  txUrl,
  addressUrl,
  ritualChain,
} from "@/lib/ritual";
import { buildClaimMessage } from "@/lib/researchClaim";
import { ResearchReport } from "@/components/ResearchReport";
import { ResearchLoading } from "@/components/ResearchLoading";

type Phase = "idle" | "paying" | "researching" | "settling" | "done" | "error";

type PaidCredit = {
  researchId: string;
  prompt: string;
  promptHash: string;
  paymentTx?: string;
  settled: boolean;
  feePaid?: string;
};

const STEPS = [
  { id: 1, label: "Connect" },
  { id: 2, label: "Prompt" },
  { id: 3, label: "Pay" },
  { id: 4, label: "Research" },
  { id: 5, label: "Seal · reveal" },
] as const;

const LS_KEY = "rite_paid_credits_v1";

function loadLocalCredits(wallet: string): PaidCredit[] {
  try {
    const raw = localStorage.getItem(`${LS_KEY}:${wallet.toLowerCase()}`);
    if (!raw) return [];
    return JSON.parse(raw) as PaidCredit[];
  } catch {
    return [];
  }
}

function saveLocalCredit(wallet: string, credit: PaidCredit) {
  const key = `${LS_KEY}:${wallet.toLowerCase()}`;
  const prev = loadLocalCredits(wallet).filter((c) => c.researchId !== credit.researchId);
  prev.unshift(credit);
  localStorage.setItem(key, JSON.stringify(prev.slice(0, 30)));
}

function errText(e: unknown) {
  if (e && typeof e === "object" && "shortMessage" in e) {
    return String((e as { shortMessage?: string }).shortMessage);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function ResearchTab() {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: bal } = useBalance({ address });
  const { signMessageAsync } = useSignMessage();

  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [report, setReport] = useState("");
  const [credits, setCredits] = useState<PaidCredit[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    researchId?: string;
    paymentTx?: string;
    settleTx?: string;
    model?: string;
    resultHash?: string;
    sealedReport?: string;
    claimed?: boolean;
  }>({});

  const { data: onChainFee } = useReadContract({
    address: RESEARCH_CONTRACT || undefined,
    abi: researchDeskAbi,
    functionName: "researchFee",
    query: { enabled: Boolean(RESEARCH_CONTRACT) },
  });

  const fee = onChainFee ?? RESEARCH_FEE;
  const feeLabel = useMemo(() => formatEther(fee), [fee]);
  const wrongChain = isConnected && chainId !== ritualChain.id;
  const hasEnough = bal != null && bal.value >= fee;

  const { writeContractAsync, isPending: writing } = useWriteContract();

  const busy =
    phase === "paying" ||
    phase === "researching" ||
    phase === "settling" ||
    writing ||
    claimingId !== null;

  const activeStep = !isConnected
    ? 1
    : wrongChain
      ? 1
      : prompt.trim().length < 3
        ? 2
        : phase === "done"
          ? 5
          : phase === "settling"
            ? 5
            : phase === "researching"
              ? 4
              : phase === "paying"
                ? 3
                : busy
                  ? 3
                  : 3;

  const refreshCredits = useCallback(async () => {
    if (!address || !publicClient || !RESEARCH_CONTRACT) {
      setCredits([]);
      return;
    }
    const local = loadLocalCredits(address);
    try {
      const count = (await publicClient.readContract({
        address: RESEARCH_CONTRACT,
        abi: researchDeskAbi,
        functionName: "researcherCount",
        args: [address as Address],
      })) as bigint;

      const merged: PaidCredit[] = [];
      if (count > BigInt(0)) {
        const ids = (await publicClient.readContract({
          address: RESEARCH_CONTRACT,
          abi: researchDeskAbi,
          functionName: "researcherIds",
          args: [address as Address],
        })) as bigint[];

        for (const id of [...ids].reverse()) {
          const r = (await publicClient.readContract({
            address: RESEARCH_CONTRACT,
            abi: researchDeskAbi,
            functionName: "getRecord",
            args: [id],
          })) as {
            promptHash: Hex;
            settled: boolean;
            feePaid: bigint;
          };
          const matchLocal = local.find((c) => c.researchId === id.toString());
          // skip bogus "pending" local-only placeholders that never resolved
          if (id.toString() === "pending") continue;
          merged.push({
            researchId: id.toString(),
            prompt: matchLocal?.prompt || "",
            promptHash: r.promptHash,
            paymentTx: matchLocal?.paymentTx,
            settled: r.settled,
            feePaid: formatEther(r.feePaid),
          });
        }
      }

      for (const loc of local) {
        if (loc.researchId === "pending") continue;
        if (!merged.some((m) => m.researchId === loc.researchId)) {
          merged.push(loc);
        }
      }
      setCredits(merged);
    } catch (e) {
      console.error("refreshCredits", e);
      setCredits(local.filter((c) => c.researchId !== "pending"));
    }
  }, [address, publicClient]);

  useEffect(() => {
    if (isConnected && address) void refreshCredits();
  }, [isConnected, address, refreshCredits]);

  const unpaid = useMemo(() => credits.filter((c) => !c.settled), [credits]);

  const promptHashNow = useMemo(() => {
    const t = prompt.trim();
    if (t.length < 3) return null;
    return keccak256(stringToBytes(t));
  }, [prompt]);

  const unpaidMatching = useMemo(() => {
    if (!promptHashNow) return unpaid;
    return unpaid.filter(
      (c) =>
        c.promptHash.toLowerCase() === promptHashNow.toLowerCase() ||
        (c.prompt && c.prompt.trim() === prompt.trim())
    );
  }, [unpaid, prompt, promptHashNow]);

  const blockReasonPay = useMemo(() => {
    if (!RESEARCH_CONTRACT) return "Research contract not configured";
    if (!isConnected) return "Connect your wallet first";
    if (wrongChain) return "Switch network to Ritual (1979)";
    if (prompt.trim().length < 3) return "Type a research question (min 3 chars)";
    if (!hasEnough) return `Need at least ${feeLabel} RITUAL for a new payment`;
    if (busy) return "Working…";
    return null;
  }, [isConnected, wrongChain, prompt, hasEnough, feeLabel, busy]);

  const canPay = blockReasonPay === null;

  async function onConnect() {
    try {
      setStatus("Opening wallet…");
      setPhase("idle");
      const injected = connectors.find((c) => c.id === "injected") || connectors[0];
      if (!injected) {
        setStatus("No browser wallet found. Install MetaMask (recommended on localhost).");
        setPhase("error");
        return;
      }
      // Request accounts first so OKX/MetaMask authorizes this origin
      if (typeof window !== "undefined") {
        const eth = (
          window as unknown as {
            ethereum?: { request: (args: { method: string }) => Promise<string[]> };
          }
        ).ethereum;
        if (eth?.request) {
          try {
            await eth.request({ method: "eth_requestAccounts" });
          } catch (e) {
            console.warn("eth_requestAccounts", e);
          }
        }
      }
      connect({ connector: injected, chainId: ritualChain.id });
      setStatus("Wallet connected — type a prompt or claim a paid credit.");
    } catch (e) {
      setPhase("error");
      setStatus(errText(e));
    }
  }

  async function signClaim(researchId: string, promptHash: string) {
    const nonce =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expiry = Math.floor(Date.now() / 1000) + 10 * 60;
    const message = buildClaimMessage({
      researchId,
      promptHash,
      nonce,
      expiry,
    });
    const signature = (await signMessageAsync({ message })) as Hex;
    return { signature, nonce, expiry };
  }

  async function callSurf(opts: {
    prompt: string;
    researcher: Address;
    txHash?: Hex;
    researchId?: string;
  }) {
    setPhase("researching");
    setStatus(
      opts.researchId
        ? `Claiming paid #${opts.researchId} — sign then Surf…`
        : "Fee paid. Sign claim, then Surf /responses…"
    );

    // Need researchId for signature — for tx path we resolve after server event;
    // first request without sig fails; for claim path we have researchId.
    // Flow: if researchId known, sign first. If only txHash, two-step:
    //   1) server would need id — we always have researchId for claim;
    //   for pay path we decode id from receipt before callSurf (see runResearchPay).
    if (!opts.researchId) {
      throw new Error("researchId required for signed research claim");
    }
    const promptHash = keccak256(stringToBytes(opts.prompt));
    const sig = await signClaim(opts.researchId, promptHash);

    const res = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...opts, ...sig, researchId: opts.researchId }),
    });
    let data: {
      error?: string;
      report?: string;
      sealedReport?: string;
      researchId?: string;
      paymentTx?: string | null;
      model?: string;
      resultHash?: string;
      claimed?: boolean;
    };
    try {
      data = await res.json();
    } catch {
      if (res.status === 504 || res.status === 502 || res.status === 524) {
        throw new Error(
          `Research timed out (HTTP ${res.status}). Your fee is already on-chain — open Paid credits and use “Claim free report” with the same prompt.`
        );
      }
      throw new Error(`Research API HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(
        data.error ||
          (res.status === 504
            ? "Research timed out. Use Claim free report — you already paid."
            : `Research API failed (${res.status})`)
      );
    }
    return data;
  }

  async function revealReport(opts: {
    researchId: string;
    researcher: Address;
    resultHash: Hex;
    sealedReport?: string;
    prompt: string;
  }) {
    setStatus("Sealed on-chain — revealing report…");
    const promptHash = keccak256(stringToBytes(opts.prompt));
    const sig = await signClaim(opts.researchId, promptHash);
    const res = await fetch("/api/research/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        researchId: opts.researchId,
        researcher: opts.researcher,
        resultHash: opts.resultHash,
        sealedReport: opts.sealedReport,
        ...sig,
      }),
    });
    const data = (await res.json()) as { error?: string; report?: string };
    if (!res.ok || !data.report) {
      throw new Error(data.error || "Could not reveal report after settle");
    }
    return data.report;
  }

  /**
   * REQUIRED seal step — report is only unlocked after this succeeds.
   * Throws if user rejects / tx fails so the caller never shows the report.
   */
  async function settleRequired(
    researchId: string,
    resultHash: Hex,
    paidPrompt: string,
    paymentTx?: string
  ): Promise<Hex> {
    if (!address || !publicClient || !RESEARCH_CONTRACT) {
      throw new Error("Wallet not ready to seal research");
    }
    setPhase("settling");
    setStatus(
      "Confirm in wallet to unlock your report (seal result on-chain). Rejecting cancels the report."
    );

    const settleHash = await writeContractAsync({
      address: RESEARCH_CONTRACT,
      abi: researchDeskAbi,
      functionName: "settleResearch",
      args: [BigInt(researchId), resultHash],
      chainId: ritualChain.id,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: settleHash });
    if (receipt.status !== "success") {
      throw new Error("Seal transaction reverted");
    }

    setMeta((m) => ({ ...m, settleTx: settleHash, resultHash }));
    saveLocalCredit(address, {
      researchId,
      prompt: paidPrompt,
      promptHash: keccak256(stringToBytes(paidPrompt)),
      paymentTx,
      settled: true,
    });
    return settleHash;
  }

  /** Claim already-paid research without new payment */
  async function claimPaid(credit: PaidCredit) {
    setClaimingId(credit.researchId);
    setErrSafe("");
    setPhase("idle");
    setStatus(`Starting claim for #${credit.researchId}…`);

    try {
      if (!address) {
        throw new Error("Connect the wallet that paid (see researcher address on Records).");
      }
      if (!publicClient) throw new Error("RPC not ready — refresh the page.");
      if (wrongChain) throw new Error("Switch to Ritual (1979) first.");

      // Prompt must match paid hash
      if (credit.prompt) setPrompt(credit.prompt);
      const clean = (credit.prompt || prompt).trim();

      if (clean.length < 3) {
        throw new Error(
          `Type the EXACT prompt you paid for in the box, then click Claim again for #${credit.researchId}. (On-chain only stores the hash.)`
        );
      }

      const h = keccak256(stringToBytes(clean));
      if (credit.promptHash && credit.promptHash.toLowerCase() !== h.toLowerCase()) {
        throw new Error(
          `Prompt does not match paid hash for #${credit.researchId}. Re-type the exact original prompt.`
        );
      }

      if (credit.researchId === "pending") {
        throw new Error(
          "This local payment never got a research id. Use the on-chain id from the list (not pending)."
        );
      }

      setReport("");
      setMeta({
        researchId: credit.researchId,
        paymentTx: credit.paymentTx,
        claimed: true,
      });

      const data = await callSurf({
        prompt: clean,
        researcher: address,
        researchId: credit.researchId,
      });

      if (!data.researchId || !data.resultHash || !data.sealedReport) {
        throw new Error(
          "Research incomplete — no sealed report or seal hash from server"
        );
      }

      // Hold sealed blob until settle + reveal — never show plaintext early
      setMeta({
        researchId: data.researchId,
        paymentTx: data.paymentTx || credit.paymentTx,
        model: data.model,
        resultHash: data.resultHash,
        sealedReport: data.sealedReport,
        claimed: true,
      });
      saveLocalCredit(address, {
        researchId: data.researchId,
        prompt: clean,
        promptHash: h,
        paymentTx: data.paymentTx || credit.paymentTx,
        settled: false,
      });

      await settleRequired(
        data.researchId,
        data.resultHash as Hex,
        clean,
        data.paymentTx || credit.paymentTx
      );

      const plaintext = await revealReport({
        researchId: data.researchId,
        researcher: address,
        resultHash: data.resultHash as Hex,
        sealedReport: data.sealedReport,
        prompt: clean,
      });
      setReport(plaintext);
      setStatus("Complete: report unlocked · sealed on-chain.");
      setPhase("done");
      await refreshCredits();
    } catch (e: unknown) {
      console.error("claimPaid", e);
      setPhase("error");
      setReport("");
      setStatus(
        errText(e) +
          " — Report is locked until you confirm the seal transaction. You already paid; try Claim again and approve seal."
      );
    } finally {
      setClaimingId(null);
    }
  }

  function setErrSafe(s: string) {
    if (s) setStatus(s);
  }

  async function runResearchPay() {
    if (!address || !publicClient || !canPay) {
      setStatus(blockReasonPay || "Cannot pay yet");
      setPhase("error");
      return;
    }

    const clean = prompt.trim();
    const promptHash = keccak256(stringToBytes(clean));

    try {
      setPhase("paying");
      setStatus(`Confirm in wallet: pay ${feeLabel} RITUAL research fee…`);
      setReport("");
      setMeta({});

      const hash = await writeContractAsync({
        address: RESEARCH_CONTRACT,
        abi: researchDeskAbi,
        functionName: "payForResearch",
        args: [promptHash],
        value: fee,
        chainId: ritualChain.id,
      });
      setStatus(`Payment sent ${hash.slice(0, 14)}… waiting for confirmation`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Payment tx reverted");

      // Keep prompt + tx so claim works even if Surf fails mid-flight
      saveLocalCredit(address, {
        researchId: "pending",
        prompt: clean,
        promptHash,
        paymentTx: hash,
        settled: false,
      });

      // Resolve researchId from payment receipt so we can sign the claim
      let researchIdFromTx: string | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: researchDeskAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "ResearchPaid") {
            const args = decoded.args as { id: bigint };
            researchIdFromTx = args.id.toString();
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!researchIdFromTx) {
        throw new Error(
          "Could not read research id from payment tx. Use Claim free report with the on-chain id."
        );
      }
      saveLocalCredit(address, {
        researchId: researchIdFromTx,
        prompt: clean,
        promptHash,
        paymentTx: hash,
        settled: false,
      });

      const data = await callSurf({
        prompt: clean,
        researcher: address,
        researchId: researchIdFromTx,
        txHash: hash,
      });

      if (!data.researchId || !data.resultHash || !data.sealedReport) {
        throw new Error(
          "Research incomplete — payment recorded but no sealed report. Use Claim free report with the same prompt."
        );
      }

      setMeta({
        researchId: data.researchId,
        paymentTx: data.paymentTx || hash,
        model: data.model,
        resultHash: data.resultHash,
        sealedReport: data.sealedReport,
      });
      saveLocalCredit(address, {
        researchId: data.researchId,
        prompt: clean,
        promptHash,
        paymentTx: hash,
        settled: false,
      });

      await settleRequired(
        data.researchId,
        data.resultHash as Hex,
        clean,
        hash
      );

      const plaintext = await revealReport({
        researchId: data.researchId,
        researcher: address,
        resultHash: data.resultHash as Hex,
        sealedReport: data.sealedReport,
        prompt: clean,
      });
      setReport(plaintext);
      setStatus("Complete: report unlocked · sealed on-chain.");
      setPhase("done");
      await refreshCredits();
    } catch (e: unknown) {
      console.error(e);
      setPhase("error");
      setReport("");
      const msg = errText(e);
      setStatus(
        msg +
          " — If fee was paid but seal was rejected, use Claim free report and confirm the seal tx to unlock the report."
      );
      await refreshCredits();
    }
  }

  return (
    <section className="ritual-tab-bg relative">
      {/* Ritual knot — soft shadow watermark (not a floating logo) */}
      <div className="ritual-watermark" aria-hidden />

      <div className="relative z-[1] flex flex-col items-center">
      <h1 className="hero-title mb-4 text-center text-6xl font-semibold sm:text-8xl md:text-9xl">
        Rite
      </h1>
      <p className="mb-6 max-w-xl text-center text-sm text-white/55">
        Pay-per-prompt crypto research on Ritual · Surf AI
      </p>

      <div className="mb-8 flex w-full max-w-2xl flex-wrap items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={`flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold ${
                activeStep >= s.id
                  ? "bg-[#c8ff4a] text-black"
                  : "border border-white/15 bg-black/30 text-white/45"
              }`}
            >
              <span>{s.id}</span>
              <span>{s.label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <span className="hidden text-white/25 sm:inline">→</span>
            )}
          </div>
        ))}
      </div>

      <div className="glass mb-6 w-full max-w-2xl rounded-2xl p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="text-[10px] uppercase tracking-wide text-white/40">
              Research fee
            </div>
            <div className="mt-1 text-lg font-semibold text-[#c8ff4a]">
              {feeLabel} RITUAL
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="text-[10px] uppercase tracking-wide text-white/40">
              Your balance
            </div>
            <div className="mt-1 text-lg font-semibold text-white">
              {isConnected && bal
                ? `${Number(formatEther(bal.value)).toFixed(4)} RIT`
                : "—"}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
            <div className="text-[10px] uppercase tracking-wide text-white/40">
              Connected
            </div>
            <div className="mt-1 truncate text-sm text-white/80">
              {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "not connected"}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-white/45">
          Fees go to{" "}
          <a className="text-[#c8ff4a] underline" href={addressUrl(FEE_RECIPIENT)} target="_blank" rel="noreferrer">
            treasury
          </a>
          . Paid-but-failed Surf runs can be claimed free (same wallet + exact prompt).
        </p>
      </div>

      {/* Paid credits */}
      {isConnected && (
        <div className="glass mb-4 w-full max-w-2xl rounded-2xl border border-amber-400/30 p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-amber-200">
              Paid credits ({unpaid.length} unpaid)
            </div>
            <button
              type="button"
              onClick={() => void refreshCredits()}
              className="text-[11px] text-white/40 underline"
            >
              Refresh
            </button>
          </div>
          <p className="mb-3 text-[11px] text-white/45">
            Must connect the <b className="text-white/70">same wallet that paid</b>. If prompt text
            is missing, type the exact original question in the box, then Claim.
          </p>

          {unpaid.length === 0 ? (
            <p className="text-xs text-white/40">
              No unpaid credits for this wallet. If you paid from another wallet, switch to it.
            </p>
          ) : (
            <div className="space-y-2">
              {unpaid.map((c) => {
                const hashOk =
                  !prompt.trim() ||
                  !promptHashNow ||
                  c.promptHash.toLowerCase() === promptHashNow.toLowerCase() ||
                  (c.prompt && c.prompt.trim() === prompt.trim());
                return (
                  <div
                    key={c.researchId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[#c8ff4a]">
                        Research #{c.researchId}
                        {c.feePaid ? ` · ${c.feePaid} RIT` : ""}
                      </div>
                      <div className="truncate text-white/55">
                        {c.prompt
                          ? c.prompt
                          : `hash ${c.promptHash.slice(0, 18)}… (re-type exact prompt)`}
                      </div>
                      {c.paymentTx && (
                        <a
                          href={txUrl(c.paymentTx)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-white/35 underline"
                        >
                          payment tx
                        </a>
                      )}
                      {!hashOk && prompt.trim().length >= 3 && (
                        <div className="mt-1 text-amber-300">
                          Prompt in box does not match this payment hash
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        // Use stored prompt if present
                        if (c.prompt) setPrompt(c.prompt);
                        void claimPaid(c);
                      }}
                      className="shrink-0 rounded-lg bg-amber-300 px-3 py-2 font-semibold text-black disabled:opacity-50"
                    >
                      {claimingId === c.researchId
                        ? "Unlocking…"
                        : c.prompt
                          ? "Unlock report (seal tx)"
                          : "Unlock (enter prompt first)"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="prompt-box w-full max-w-2xl rounded-2xl p-3 sm:p-4">
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-[#c8ff4a]/70">
          Research prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Type the project question (must match paid prompt to claim)"
          className="mb-3 w-full resize-y bg-transparent px-1 text-[15px] text-white placeholder:text-white/35 outline-none"
        />

        {!isConnected ? (
          <button
            type="button"
            disabled={connecting}
            onClick={() => void onConnect()}
            className="btn-primary w-full rounded-xl py-3.5 text-sm sm:text-base"
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : wrongChain ? (
          <button
            type="button"
            disabled={switching}
            onClick={() => switchChain({ chainId: ritualChain.id })}
            className="w-full rounded-xl bg-amber-400 py-3.5 text-sm font-semibold text-black sm:text-base"
          >
            {switching ? "Switching…" : "Switch to Ritual (1979)"}
          </button>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy || unpaid.length === 0}
              onClick={() => {
                const c =
                  unpaidMatching[0] ||
                  unpaid.find((x) => x.prompt && x.prompt.trim() === prompt.trim()) ||
                  unpaid[0];
                if (!c) {
                  setPhase("error");
                  setStatus("No unpaid credit for this wallet.");
                  return;
                }
                void claimPaid(c);
              }}
              className="rounded-xl border border-amber-300/50 bg-amber-300/15 py-3.5 text-sm font-semibold text-amber-100 disabled:opacity-40"
            >
              {claimingId
                ? "Claiming…"
                : unpaid.length
                  ? `Claim free (${unpaid.length} unpaid)`
                  : "No unpaid credits"}
            </button>
            <button
              type="button"
              disabled={!canPay}
              onClick={() => void runResearchPay()}
              className="btn-primary rounded-xl py-3.5 text-sm sm:text-base"
            >
              {busy && !claimingId
                ? phase === "paying"
                  ? "Confirm payment…"
                  : phase === "researching"
                    ? "Surf researching…"
                    : "Sealing…"
                : `Pay ${feeLabel} RITUAL & Research`}
            </button>
          </div>
        )}

        {connectError && (
          <p className="mt-2 text-center text-xs text-red-300">{connectError.message}</p>
        )}
        {blockReasonPay && isConnected && !wrongChain && !busy && (
          <p className="mt-2 text-center text-xs text-white/40">{blockReasonPay}</p>
        )}
      </div>

      {/* Branded wait UI while pay → Surf → seal */}
      {(phase === "paying" || phase === "researching" || phase === "settling") && (
        <ResearchLoading phase={phase} status={status} />
      )}

      {status && phase !== "paying" && phase !== "researching" && phase !== "settling" && (
        <p
          className={`mt-5 max-w-2xl whitespace-pre-wrap text-center text-sm ${
            phase === "error" ? "text-red-300" : "text-white/75"
          }`}
        >
          {status}
        </p>
      )}

      {meta.paymentTx && phase !== "paying" && phase !== "researching" && (
        <div className="mt-3 flex flex-wrap justify-center gap-3 text-xs text-[#c8ff4a]/90">
          <a href={txUrl(meta.paymentTx)} target="_blank" rel="noreferrer" className="underline">
            Payment tx ↗
          </a>
          {meta.settleTx && (
            <a href={txUrl(meta.settleTx)} target="_blank" rel="noreferrer" className="underline">
              Seal tx ↗
            </a>
          )}
          {meta.researchId && <span>#{meta.researchId}</span>}
          {meta.claimed && <span className="text-amber-200">claimed</span>}
          {meta.model && <span>{meta.model}</span>}
        </div>
      )}

      {report && phase !== "researching" && phase !== "settling" ? (
        <ResearchReport content={report} />
      ) : null}
      </div>
    </section>
  );
}
