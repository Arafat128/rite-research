"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { formatEther, type Address, type Hex, parseAbiItem } from "viem";
import {
  BOUNTY_CONTRACT,
  bountyPoolAbi,
  getRitualReadClient,
  ritualChain,
  txUrl,
  addressUrl,
} from "@/lib/ritual";
import { OpenOnRadar } from "@/components/OpenOnRadar";
import { useToast } from "@/components/ToastProvider";

type WinnerInfo = {
  winner: Address;
  amount: bigint;
  finalizedAt: bigint;
  wonRoundId: bigint;
  currentPool: bigint;
  currentEntrants: bigint;
  currentRoundId: bigint;
  ready: boolean;
  interactions: bigint;
  threshold: bigint;
};

const zero = "0x0000000000000000000000000000000000000000";

const winnerPaidEvent = parseAbiItem(
  "event WinnerPaid(uint256 indexed roundId, address indexed winner, uint256 amount, uint256 entrants, uint256 totalPoints, uint256 interactions)"
);

export function BountyBanner() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const toast = useToast();

  const [info, setInfo] = useState<WinnerInfo | null>(null);
  const [myPoints, setMyPoints] = useState<bigint>(BigInt(0));
  /** Pull-payment credit awaiting claimPayout() */
  const [pendingClaim, setPendingClaim] = useState<bigint>(BigInt(0));
  const [claiming, setClaiming] = useState(false);
  const [payoutTx, setPayoutTx] = useState<Hex | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!BOUNTY_CONTRACT) return;
    setLoading(true);
    try {
      const client = getRitualReadClient();
      const raw = (await client.readContract({
        address: BOUNTY_CONTRACT,
        abi: bountyPoolAbi,
        functionName: "lastWinnerInfo",
      })) as readonly [
        Address,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        boolean,
        bigint,
        bigint,
      ];

      const next: WinnerInfo = {
        winner: raw[0],
        amount: raw[1],
        finalizedAt: raw[2],
        wonRoundId: raw[3],
        currentPool: raw[4],
        currentEntrants: raw[5],
        currentRoundId: raw[6],
        ready: raw[7],
        interactions: raw[8],
        threshold: raw[9],
      };
      setInfo(next);

      // Notify only if *you* won — once per round (session)
      if (
        address &&
        next.winner &&
        next.winner.toLowerCase() === address.toLowerCase() &&
        next.amount > BigInt(0) &&
        next.wonRoundId > BigInt(0)
      ) {
        const k = `rite_bounty_toast_${next.wonRoundId.toString()}`;
        try {
          if (!sessionStorage.getItem(k)) {
            sessionStorage.setItem(k, "1");
            toast.success(
              "You won the bounty!",
              `${Number(formatEther(next.amount)).toFixed(4)} RIT credited — use Claim bounty to withdraw`
            );
          }
        } catch {
          /* private mode */
        }
      }

      if (address) {
        try {
          const pts = (await client.readContract({
            address: BOUNTY_CONTRACT,
            abi: bountyPoolAbi,
            functionName: "points",
            args: [address],
          })) as bigint;
          setMyPoints(pts);
        } catch {
          setMyPoints(BigInt(0));
        }
        try {
          const pending = (await client.readContract({
            address: BOUNTY_CONTRACT,
            abi: bountyPoolAbi,
            functionName: "pendingPayouts",
            args: [address],
          })) as bigint;
          setPendingClaim(pending);
        } catch {
          setPendingClaim(BigInt(0));
        }
      } else {
        setMyPoints(BigInt(0));
        setPendingClaim(BigInt(0));
      }

      if (
        next.winner &&
        next.winner.toLowerCase() !== zero &&
        next.wonRoundId > BigInt(0)
      ) {
        try {
          const logs = await client.getLogs({
            address: BOUNTY_CONTRACT,
            event: winnerPaidEvent,
            args: {
              roundId: next.wonRoundId,
              winner: next.winner,
            },
            fromBlock: BigInt(0),
            toBlock: "latest",
          });
          if (logs.length) {
            setPayoutTx(logs[logs.length - 1].transactionHash);
          }
        } catch {
          /* non-fatal */
        }
      }
    } catch (e) {
      console.warn("[bounty] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [address, toast]);

  async function claimBounty() {
    if (!address || !walletClient || !BOUNTY_CONTRACT) return;
    if (pendingClaim <= BigInt(0)) return;
    setClaiming(true);
    try {
      const hash = await walletClient.writeContract({
        address: BOUNTY_CONTRACT,
        abi: bountyPoolAbi,
        functionName: "claimPayout",
        chain: ritualChain,
        account: address,
      });
      const client = getRitualReadClient();
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 90_000,
        pollingInterval: 400,
      });
      if (receipt.status !== "success") {
        throw new Error("Claim transaction reverted");
      }
      toast.success(
        "Bounty claimed",
        `${Number(formatEther(pendingClaim)).toFixed(4)} RIT sent to your wallet`
      );
      setPendingClaim(BigInt(0));
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Claim failed";
      if (!/reject|denied|user/i.test(msg)) {
        toast.error("Claim failed", msg);
      }
    } finally {
      setClaiming(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!BOUNTY_CONTRACT) return null;

  const hasWinner =
    info &&
    info.winner &&
    info.winner.toLowerCase() !== zero &&
    info.amount > BigInt(0);

  const threshold = info ? Number(info.threshold) : 20;
  const interactions = info ? Number(info.interactions) : 0;
  const remaining = Math.max(0, threshold - interactions);
  const progress = Math.min(100, Math.round((interactions / threshold) * 100));

  const poolLabel = info
    ? `${Number(formatEther(info.currentPool)).toFixed(4)} RIT`
    : "…";

  return (
    <div className="mb-6 space-y-3">
      {/* Winner crown */}
      {hasWinner && (
        <div className="relative overflow-hidden rounded-2xl border border-amber-300/40 bg-gradient-to-r from-amber-500/20 via-[#0d2818] to-amber-500/10 px-4 py-3 shadow-lg shadow-amber-900/20 sm:px-5">
          <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-amber-300/10 blur-2xl" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/90">
                ★ Auto bounty winner · Round #{info!.wonRoundId.toString()}
              </div>
              <div className="mt-1 text-lg font-semibold text-amber-50 sm:text-xl">
                {info!.winner.slice(0, 6)}…{info!.winner.slice(-4)}
                <span className="ml-2 text-base font-bold text-[#c8ff4a]">
                  won {Number(formatEther(info!.amount)).toFixed(4)} RIT
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-white/45">
                Auto-drawn after {threshold} interactions · Finalized{" "}
                {info!.finalizedAt > BigInt(0)
                  ? new Date(Number(info!.finalizedAt) * 1000).toLocaleString()
                  : "—"}
                {" · "}
                Payout is pull-based (winner must claim)
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={addressUrl(info!.winner)}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-amber-200/30 bg-black/30 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-black/50"
              >
                Winner ↗
              </a>
              <OpenOnRadar
                address={info!.winner}
                label="Radar · winner"
                title="Map bounty winner on Ritual Radar"
              />
              {payoutTx && (
                <a
                  href={txUrl(payoutTx)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-white/20 bg-black/30 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-black/50"
                >
                  Credit tx ↗
                </a>
              )}
              {isConnected && pendingClaim > BigInt(0) && (
                <button
                  type="button"
                  disabled={claiming || loading}
                  onClick={() => void claimBounty()}
                  className="rounded-full bg-[#c8ff4a] px-3 py-1.5 text-xs font-bold text-black hover:bg-[#d4ff6a] disabled:opacity-50"
                >
                  {claiming
                    ? "Claiming…"
                    : `Claim ${Number(formatEther(pendingClaim)).toFixed(4)} RIT`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Live pool + progress to auto-draw */}
      <div className="glass rounded-2xl px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Live bounty pool
              </div>
              <div className="font-semibold text-[#c8ff4a]">{poolLabel}</div>
            </div>
            <div className="hidden h-8 w-px bg-white/10 sm:block" />
            <div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Interactions
              </div>
              <div className="font-medium text-white/85">
                {interactions} / {threshold}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Until auto-draw
              </div>
              <div className="font-medium text-white/85">
                {remaining === 0 ? "Drawing…" : `${remaining} left`}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Entrants
              </div>
              <div className="font-medium text-white/85">
                {info ? info.currentEntrants.toString() : "…"}
              </div>
            </div>
            {isConnected && myPoints > BigInt(0) && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">
                  Your points
                </div>
                <div className="font-medium text-white/85">
                  {Number(formatEther(myPoints)).toFixed(4)}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => load()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-[11px] text-white/60 hover:text-white"
            >
              {loading ? "…" : "Refresh"}
            </button>
            <a
              href={addressUrl(BOUNTY_CONTRACT)}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-white/35 underline"
            >
              Pool ↗
            </a>
            <OpenOnRadar
              address={BOUNTY_CONTRACT}
              label="Radar · pool"
              title="Map BountyPool contract graph"
            />
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10px] text-white/40">
            <span>Auto-finalize progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#8fd914] to-[#c8ff4a] transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <p className="text-center text-[11px] text-white/35">
        <b className="text-white/55">50%</b> of research fees, agent deploys &amp;
        ticks enter the pool. Each paid action ={" "}
        <b className="text-white/55">1 interaction</b>
        {" · "}
        every <b className="text-white/55">0.005 RIT</b> consumed by{" "}
        <b className="text-white/55">Oracast Alert</b> ={" "}
        <b className="text-white/55">1 interaction</b>. At{" "}
        <b className="text-[#c8ff4a]">{threshold}</b> interactions the pool{" "}
        <b className="text-white/55">auto-draws one random winner</b> (weighted by
        fees paid) — no manual finalize.
      </p>
    </div>
  );
}
