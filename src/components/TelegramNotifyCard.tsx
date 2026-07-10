"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useToast } from "@/components/ToastProvider";

type Status = {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  enabled: boolean;
  username: string | null;
  agentIds: string[];
};

export function TelegramNotifyCard({ owner }: { owner: Address }) {
  const toast = useToast();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/notify/telegram?owner=${encodeURIComponent(owner)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as Status & { error?: string };
      if (!res.ok) throw new Error(data.error || "status failed");
      setSt(data);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load Telegram status");
    }
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(action: string, extra?: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/notify/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, owner, ...extra }),
      });
      const data = (await res.json()) as {
        error?: string;
        deepLink?: string;
        enabled?: boolean;
        sent?: boolean;
      };
      if (!res.ok) throw new Error(data.error || "Request failed");

      if (action === "link" && data.deepLink) {
        window.open(data.deepLink, "_blank", "noopener,noreferrer");
        toast.info(
          "Finish in Telegram",
          "Press Start in the bot to complete linking"
        );
        // poll a few times for link complete
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await load();
          const s = await fetch(
            `/api/notify/telegram?owner=${encodeURIComponent(owner)}`
          ).then((r) => r.json());
          if (s.linked) {
            toast.success("Telegram linked", "You will get DMs on agent ticks");
            break;
          }
        }
      } else if (action === "test" && data.sent) {
        toast.success("Test sent", "Check your Telegram DMs");
      } else if (action === "unlink") {
        toast.info("Telegram unlinked");
      } else if (action === "toggle") {
        toast.success(
          data.enabled ? "Alerts on" : "Alerts paused",
          data.enabled ? "Tick DMs enabled" : "No more DMs until re-enabled"
        );
      }
      await load();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Failed";
      setErr(m);
      toast.error("Telegram", m);
    } finally {
      setBusy(false);
    }
  }

  if (!st) {
    return (
      <div className="glass rounded-2xl border border-white/10 p-4 text-[12px] text-white/45">
        Loading Telegram…
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl border border-[#c8ff4a]/20 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#c8ff4a]">Telegram alerts</h3>
        {st.linked ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              st.enabled
                ? "bg-emerald-400/20 text-emerald-200"
                : "bg-zinc-500/30 text-zinc-300"
            }`}
          >
            {st.enabled ? "ON" : "PAUSED"}
          </span>
        ) : (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/50">
            Not linked
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-white/45">
        Get a DM when your agents seal a tick (after Wake or keeper). Use{" "}
        <b className="text-white/70">Connect Telegram</b> (not a bare{" "}
        <code className="text-white/50">/start</code> only) so the bot receives
        your link token. See <code className="text-[#c8ff4a]">TELEGRAM.md</code>.
      </p>

      {!st.configured && (
        <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-100">
          Server missing <code className="text-[#c8ff4a]">TELEGRAM_BOT_TOKEN</code>
          . Add it on Vercel and redeploy.
        </p>
      )}

      {st.configured && !st.linked && (
        <p className="mb-2 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-white/45">
          If the bot stays silent after Start: Vercel{" "}
          <b className="text-white/60">Deployment Protection</b> is likely
          blocking Telegram (401). Disable protection on Production or add
          Protection Bypass and set the webhook URL with{" "}
          <code className="text-[#c8ff4a]">x-vercel-protection-bypass</code>.
        </p>
      )}

      {st.linked && st.username && (
        <p className="mb-2 text-[11px] text-white/50">
          Linked as @{st.username}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!st.linked ? (
          <button
            type="button"
            disabled={busy || !st.configured}
            onClick={() => void post("link")}
            className="btn-primary rounded-lg px-3 py-2 text-sm"
          >
            {busy ? "…" : "Connect Telegram"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void post("toggle", { enabled: !st.enabled })}
              className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
            >
              {st.enabled ? "Pause alerts" : "Enable alerts"}
            </button>
            <button
              type="button"
              disabled={busy || !st.enabled}
              onClick={() => void post("test")}
              className="rounded-lg border border-[#c8ff4a]/30 bg-[#c8ff4a]/10 px-3 py-2 text-sm text-[#c8ff4a]"
            >
              Send test
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void post("unlink")}
              className="rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-200"
            >
              Unlink
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="text-xs text-white/40 underline"
        >
          Refresh status
        </button>
      </div>

      {err && (
        <p className="mt-2 text-[11px] text-red-300">{err}</p>
      )}
    </div>
  );
}
