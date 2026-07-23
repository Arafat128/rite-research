"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { parseEther, type Hex } from "viem";
import { ritualChain } from "@/lib/ritual";
import {
  FREQ_OPTIONS_MIN,
  ORACAST_MIN_DEPOSIT_RIT,
  ORACAST_RATE_RIT_PER_HOUR,
} from "@/lib/oracastConstants";
import { ORACAST_TOKEN_LIST } from "@/lib/oracastPrice";
import { TelegramNotifyCard } from "@/components/TelegramNotifyCard";
import { useToast } from "@/components/ToastProvider";
import {
  buildErrorReport,
  isUserRejection,
  rememberErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";
import { ErrorFeedback } from "@/components/ErrorFeedback";

type PublicWatch = {
  id: string;
  symbol: string;
  name: string;
  coinId?: string;
  contractAddress?: string;
  frequencyMin: number;
  depositRit: string;
  hoursRemaining: number;
  active: boolean;
  lastPrice?: number;
  lastSource?: string;
  notifyCount: number;
};

const FREQ_LABELS: Record<number, string> = {
  5: "Every 5 min",
  15: "Every 15 min",
  30: "Every 30 min",
  60: "Every 1 hour",
  120: "Every 2 hours",
  240: "Every 4 hours",
  360: "Every 6 hours",
  720: "Every 12 hours",
  1440: "Every 24 hours",
};

export function OracastMarketTab() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: ritualChain.id });
  const toast = useToast();

  const [depositTo, setDepositTo] = useState("");
  const [rate, setRate] = useState(ORACAST_RATE_RIT_PER_HOUR);
  const [watches, setWatches] = useState<PublicWatch[]>([]);
  const [mode, setMode] = useState<"pick" | "contract">("pick");
  const [coinId, setCoinId] = useState("bitcoin");
  const [contract, setContract] = useState("");
  const [preview, setPreview] = useState<{
    price: number;
    symbol: string;
    name: string;
    source: string;
    priceLabel?: string;
  } | null>(null);
  const [frequencyMin, setFrequencyMin] = useState(60);
  const [depositRit, setDepositRit] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const wrongChain = isConnected && chainId !== ritualChain.id;

  const hoursPreview = useMemo(() => {
    const n = Number(depositRit);
    if (!Number.isFinite(n) || n <= 0 || rate <= 0) return 0;
    return Math.floor((n / rate) * 10) / 10;
  }, [depositRit, rate]);

  const refresh = useCallback(async () => {
    if (!address) {
      setWatches([]);
      return;
    }
    setLoadingList(true);
    try {
      const res = await fetch(
        `/api/oracast/watch?owner=${encodeURIComponent(address)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "load failed");
      setWatches(data.watches || []);
      if (data.depositTo) setDepositTo(data.depositTo);
      if (data.rateRitPerHour != null) setRate(Number(data.rateRitPerHour));
    } catch (e) {
      console.warn(e);
    } finally {
      setLoadingList(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // In-app poke so notifications fire while Markets tab is open
  useEffect(() => {
    if (!address || !isConnected) return;
    let cancelled = false;
    const poke = async () => {
      try {
        await fetch("/api/oracast/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner: address, max: 12 }),
          cache: "no-store",
        });
        if (!cancelled) void refresh();
      } catch {
        /* ignore */
      }
    };
    void poke();
    const t = setInterval(() => void poke(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [address, isConnected, refresh]);

  async function loadPreview() {
    setErr("");
    setPreview(null);
    try {
      const q =
        mode === "pick"
          ? `coinId=${encodeURIComponent(coinId)}`
          : `contract=${encodeURIComponent(contract.trim())}`;
      const res = await fetch(`/api/oracast/price?${q}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "price failed");
      setPreview({
        price: data.price,
        symbol: data.symbol,
        name: data.name,
        source: data.source,
        priceLabel: data.priceLabel,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load price");
    }
  }

  async function ensureWallet() {
    if (!isConnected) {
      const c = connectors.find((x) => x.id === "injected") || connectors[0];
      if (!c) throw new Error("Install MetaMask");
      connect({ connector: c, chainId: ritualChain.id });
      throw new Error("Connect wallet and try again");
    }
    if (wrongChain) {
      switchChain({ chainId: ritualChain.id });
      throw new Error("Switch to Ritual Chain and try again");
    }
    if (!walletClient || !address) throw new Error("Wallet not ready");
  }

  async function startWatch() {
    setBusy(true);
    setErr("");
    setMsg("");
    setErrorReport(null);
    try {
      await ensureWallet();
      if (!walletClient || !address || !publicClient) {
        throw new Error("Wallet not ready");
      }
      if (!depositTo || depositTo.startsWith("0x0000")) {
        throw new Error(
          "Fee recipient not configured (NEXT_PUBLIC_FEE_RECIPIENT)"
        );
      }
      if (mode === "contract" && !contract.trim()) {
        throw new Error("Paste a token contract address");
      }

      const value = parseEther(depositRit || "0");
      if (value < parseEther(String(ORACAST_MIN_DEPOSIT_RIT))) {
        throw new Error(
          `Deposit must be at least ${ORACAST_MIN_DEPOSIT_RIT} RIT (any amount above that is fine)`
        );
      }

      setMsg("Confirm deposit in wallet…");
      const hash = await walletClient.sendTransaction({
        chain: ritualChain,
        account: address,
        to: depositTo as `0x${string}`,
        value,
      });
      setMsg(`Deposit sent ${hash.slice(0, 12)}… waiting for confirmation`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });
      if (receipt.status !== "success") {
        throw new Error("Deposit transaction failed");
      }

      setMsg("Registering Oracast watch…");
      const res = await fetch("/api/oracast/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          owner: address,
          coinId: mode === "pick" ? coinId : undefined,
          contractAddress: mode === "contract" ? contract.trim() : undefined,
          frequencyMin,
          depositRit,
          txHash: hash as Hex,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "create failed");

      setMsg(
        `Watching ${data.watch.symbol} · ~${data.watch.hoursRemaining}h · TG every ${frequencyMin}m`
      );
      toast.success(
        `Watching ${data.watch.symbol}`,
        `${data.watch.hoursRemaining}h prepaid · Telegram`
      );
      await refresh();
    } catch (e: unknown) {
      if (isUserRejection(String((e as Error)?.message || e))) {
        setMsg("Cancelled in wallet");
        return;
      }
      const report = buildErrorReport(e, {
        where: "oracast.watch.create",
        chainId,
        wallet: address,
      });
      rememberErrorReport(report);
      setErrorReport(report);
      setErr(report.userMessage);
      toast.error("Oracast watch failed", report.userMessage);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string, active: boolean) {
    if (!address) return;
    setBusy(true);
    try {
      const res = await fetch("/api/oracast/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          owner: address,
          watchId: id,
          active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "update failed");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  async function changeFreq(id: string, frequencyMin: number) {
    if (!address) return;
    try {
      const res = await fetch("/api/oracast/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          owner: address,
          watchId: id,
          frequencyMin,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "update failed");
      await refresh();
      toast.success("Frequency updated", FREQ_LABELS[frequencyMin] || `${frequencyMin}m`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    }
  }

  async function topUp(id: string) {
    if (!address || !walletClient || !publicClient || !depositTo) return;
    setBusy(true);
    setErr("");
    try {
      await ensureWallet();
      const value = parseEther(depositRit || String(ORACAST_MIN_DEPOSIT_RIT));
      const hash = await walletClient.sendTransaction({
        chain: ritualChain,
        account: address,
        to: depositTo as `0x${string}`,
        value,
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      const res = await fetch("/api/oracast/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fund",
          owner: address,
          watchId: id,
          depositRit,
          txHash: hash,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "fund failed");
      toast.success("Topped up", `+${depositRit} RIT`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "top up failed");
    } finally {
      setBusy(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center">
        <p className="mb-4 text-sm text-white/60">
          Connect wallet to start Oracast price watches on Ritual
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
        <p className="mb-4 text-sm text-amber-100">Switch to Ritual Chain</p>
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
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h2 className="font-[family-name:var(--font-display)] text-3xl text-[#c8ff4a]">
          Oracast Markets
        </h2>
        <p className="mt-1 text-sm text-white/50">
          Token price alerts via Telegram ·{" "}
          <b className="text-white/70">{rate} RIT / hour</b> prepaid · Ritual
          deposit. Powered by{" "}
          <a
            href="https://github.com/RitualChain/oracast-markets"
            target="_blank"
            rel="noreferrer"
            className="text-[#c8ff4a]/80 underline-offset-2 hover:underline"
          >
            Oracast
          </a>
          .
        </p>
      </div>

      {address && <TelegramNotifyCard owner={address} />}

      <div className="glass space-y-4 rounded-2xl p-5">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode("pick")}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              mode === "pick"
                ? "bg-[#c8ff4a] text-black"
                : "border border-white/15 text-white/65"
            }`}
          >
            Select token
          </button>
          <button
            type="button"
            onClick={() => setMode("contract")}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
              mode === "contract"
                ? "bg-[#c8ff4a] text-black"
                : "border border-white/15 text-white/65"
            }`}
          >
            Paste contract
          </button>
        </div>

        {mode === "pick" ? (
          <div>
            <label className="text-[11px] text-white/40">Token</label>
            <select
              value={coinId}
              onChange={(e) => setCoinId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            >
              {ORACAST_TOKEN_LIST.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.symbol} · {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="text-[11px] text-white/40">
              Token contract address
            </label>
            <input
              value={contract}
              onChange={(e) => setContract(e.target.value)}
              placeholder="0x… or chain token address"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none"
            />
            <p className="mt-1 text-[10px] text-white/35">
              Resolved via DexScreener / CoinGecko when not on Oracast list
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void loadPreview()}
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white/70 hover:bg-black/45"
          >
            Preview price
          </button>
          {preview && (
            <span className="rounded-lg border border-[#c8ff4a]/25 bg-[#c8ff4a]/10 px-3 py-1.5 text-xs text-[#c8ff4a]">
              {preview.symbol} · ${preview.priceLabel || preview.price} ·{" "}
              {preview.source}
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-[11px] text-white/40">
              Telegram frequency
            </label>
            <select
              value={frequencyMin}
              onChange={(e) => setFrequencyMin(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            >
              {FREQ_OPTIONS_MIN.map((m) => (
                <option key={m} value={m}>
                  {FREQ_LABELS[m] || `Every ${m} min`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-white/40">
              Deposit RIT (prepaid time)
            </label>
            <input
              value={depositRit}
              onChange={(e) => setDepositRit(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            />
            <p className="mt-1 text-[10px] text-white/35">
              ≈ {hoursPreview}h at {rate} RIT/h · deposit any amount ≥{" "}
              {ORACAST_MIN_DEPOSIT_RIT} RIT
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] text-white/45">
          Deposit goes to{" "}
          <code className="text-white/60">
            {depositTo
              ? `${depositTo.slice(0, 8)}…${depositTo.slice(-6)}`
              : "FEE_RECIPIENT (set env)"}
          </code>
          . Balance burns while the watch is active. Link Telegram above first.
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void startWatch()}
          className="btn-primary w-full rounded-xl py-3 text-sm"
        >
          {busy
            ? "Working…"
            : `Start watch · ${depositRit || "0"} RIT (~${hoursPreview}h)`}
        </button>

        {msg && <p className="text-xs text-[#c8ff4a]">{msg}</p>}
        {err && <p className="text-xs text-red-300">{err}</p>}
        {errorReport && (
          <ErrorFeedback
            report={errorReport}
            onDismiss={() => setErrorReport(null)}
          />
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white/80">Your watches</h3>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-[11px] text-white/40 underline"
          >
            {loadingList ? "…" : "Refresh"}
          </button>
        </div>
        {watches.length === 0 ? (
          <div className="glass rounded-2xl p-5 text-center text-sm text-white/45">
            No active watches yet. Deposit RIT to start Telegram price updates.
          </div>
        ) : (
          watches.map((w) => (
            <div
              key={w.id}
              className="glass rounded-2xl border border-white/10 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-semibold text-white">
                    {w.symbol}{" "}
                    <span className="text-sm font-normal text-white/45">
                      {w.name}
                    </span>
                  </div>
                  <div className="text-xs text-white/40">
                    {w.lastPrice != null
                      ? `$${w.lastPrice} · ${w.lastSource || "—"}`
                      : "Awaiting first tick"}{" "}
                    · {w.notifyCount} alerts
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                    w.active
                      ? "border border-[#c8ff4a]/40 bg-[#c8ff4a]/15 text-[#c8ff4a]"
                      : "border border-white/15 bg-white/5 text-white/45"
                  }`}
                >
                  {w.active ? "Active" : "Paused"}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-white/50 sm:grid-cols-4">
                <div>
                  Left · <b className="text-white/80">{w.hoursRemaining}h</b>
                </div>
                <div>
                  Balance ·{" "}
                  <b className="text-white/80">{w.depositRit} RIT</b>
                </div>
                <div className="col-span-2 sm:col-span-2">
                  <label className="mr-2">Freq</label>
                  <select
                    value={w.frequencyMin}
                    onChange={(e) =>
                      void changeFreq(w.id, Number(e.target.value))
                    }
                    className="rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px]"
                  >
                    {FREQ_OPTIONS_MIN.map((m) => (
                      <option key={m} value={m}>
                        {FREQ_LABELS[m] || `${m}m`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setActive(w.id, !w.active)}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/5"
                >
                  {w.active ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void topUp(w.id)}
                  className="rounded-lg border border-[#c8ff4a]/30 bg-[#c8ff4a]/10 px-3 py-1.5 text-[11px] text-[#c8ff4a]"
                >
                  Top up {depositRit} RIT
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
