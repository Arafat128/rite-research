"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { formatEther, type Address } from "viem";
import {
  RESEARCH_CONTRACT,
  researchDeskAbi,
  addressUrl,
  EXPLORER_URL,
  ritualChain,
} from "@/lib/ritual";
import { ErrorFeedback } from "@/components/ErrorFeedback";
import {
  buildErrorReport,
  rememberErrorReport,
  type ErrorReport,
} from "@/lib/errorReport";

type Row = {
  id: string;
  feePaid: string;
  paidAt: string;
  settled: boolean;
  promptHash: string;
  resultHash: string;
};

export function RecordsTab() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errorReport, setErrorReport] = useState<ErrorReport | null>(null);

  useEffect(() => {
    if (!isConnected || !address || !publicClient || !RESEARCH_CONTRACT) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr("");
      setErrorReport(null);
      try {
        const count = (await publicClient.readContract({
          address: RESEARCH_CONTRACT,
          abi: researchDeskAbi,
          functionName: "researcherCount",
          args: [address as Address],
        })) as bigint;

        const ids =
          count > BigInt(0)
            ? ((await publicClient.readContract({
                address: RESEARCH_CONTRACT,
                abi: researchDeskAbi,
                functionName: "researcherIds",
                args: [address as Address],
              })) as bigint[])
            : [];

        const out: Row[] = [];
        for (const id of [...ids].reverse()) {
          const r = (await publicClient.readContract({
            address: RESEARCH_CONTRACT,
            abi: researchDeskAbi,
            functionName: "getRecord",
            args: [id],
          })) as {
            feePaid: bigint;
            paidAt: bigint;
            settled: boolean;
            promptHash: `0x${string}`;
            resultHash: `0x${string}`;
          };
          const ts = Number(r.paidAt);
          const ms = ts > 1e12 ? ts : ts * 1000;
          out.push({
            id: id.toString(),
            feePaid: formatEther(r.feePaid),
            paidAt: new Date(ms).toLocaleString(),
            settled: r.settled,
            promptHash: r.promptHash,
            resultHash: r.resultHash,
          });
        }
        if (!cancelled) setRows(out);
      } catch (e: unknown) {
        if (!cancelled) {
          const report = buildErrorReport(e, {
            where: "records.load",
            chainId: ritualChain.id,
            wallet: address,
            userMessage: "Could not load your research records. Try again.",
          });
          rememberErrorReport(report);
          setErrorReport(report);
          setErr(report.userMessage);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, isConnected, publicClient]);

  if (!isConnected) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-white/60">
        Connect wallet to load your on-chain research records.
      </div>
    );
  }

  if (!RESEARCH_CONTRACT) {
    return (
      <div className="glass mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-amber-200/90">
        Research records are temporarily unavailable. Please try again later.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="mb-2 font-[family-name:var(--font-display)] text-3xl text-[#c8ff4a]">
        On-chain records
      </h2>
      <p className="mb-6 text-sm text-white/50">
        Every paid research is a Ritual event + storage slot.{" "}
        <a
          className="underline decoration-white/20"
          href={addressUrl(RESEARCH_CONTRACT)}
          target="_blank"
          rel="noreferrer"
        >
          View contract
        </a>
      </p>

      {loading && <p className="text-sm text-white/50">Loading…</p>}
      {errorReport ? (
        <div className="mb-4">
          <ErrorFeedback
            report={errorReport}
            onDismiss={() => {
              setErrorReport(null);
              setErr("");
            }}
          />
        </div>
      ) : err ? (
        <p className="text-sm text-red-300">{err}</p>
      ) : null}
      {!loading && !err && !errorReport && rows.length === 0 && (
        <p className="text-sm text-white/50">No research payments from this wallet yet.</p>
      )}

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.id} className="glass rounded-xl p-4 text-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[#c8ff4a]">#{r.id}</span>
              <span className="text-xs text-white/45">{r.paidAt}</span>
            </div>
            <div className="grid gap-1 text-xs text-white/65">
              <div>
                Fee: <b className="text-white/90">{r.feePaid} RITUAL</b>
              </div>
              <div>
                Settled:{" "}
                <b className={r.settled ? "text-emerald-300" : "text-amber-200"}>
                  {r.settled ? "yes" : "payment only"}
                </b>
              </div>
              <div className="break-all">promptHash: {r.promptHash}</div>
              {r.settled && r.resultHash !==
                "0x0000000000000000000000000000000000000000000000000000000000000000" && (
                <div className="break-all">resultHash: {r.resultHash}</div>
              )}
              <a
                className="mt-1 text-[#c8ff4a]/80 underline"
                href={`${EXPLORER_URL}/address/${RESEARCH_CONTRACT}`}
                target="_blank"
                rel="noreferrer"
              >
                Open explorer
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
