"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useToast } from "@/components/ToastProvider";

const LS_KEY = "rite_telegram_chat_v1";

type Status = {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  enabled: boolean;
  username: string | null;
  agentIds: string[];
};

function lsGet(owner: string): string | null {
  try {
    return localStorage.getItem(`${LS_KEY}:${owner.toLowerCase()}`);
  } catch {
    return null;
  }
}

function lsSet(owner: string, chatId: string) {
  try {
    localStorage.setItem(`${LS_KEY}:${owner.toLowerCase()}`, chatId);
  } catch {
    /* ignore */
  }
}

function lsClear(owner: string) {
  try {
    localStorage.removeItem(`${LS_KEY}:${owner.toLowerCase()}`);
  } catch {
    /* ignore */
  }
}

export function TelegramNotifyCard({ owner }: { owner: Address }) {
  const toast = useToast();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [manualChat, setManualChat] = useState("");
  const [localChat, setLocalChat] = useState<string | null>(null);

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
      const ls = lsGet(owner);
      setLocalChat(ls);
      // If server forgot (cold start) but we have local chat id, re-register
      if (!data.linked && ls) {
        await fetch("/api/notify/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "register_chat",
            owner,
            chatId: ls,
          }),
        }).catch(() => undefined);
        const res2 = await fetch(
          `/api/notify/telegram?owner=${encodeURIComponent(owner)}`,
          { cache: "no-store" }
        );
        if (res2.ok) setSt(await res2.json());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load Telegram status");
    }
  }, [owner]);

  // Complete link from Telegram deep-link: ?tg_owner=&tg_chat=&tg_code=
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const tgOwner = q.get("tg_owner");
    const tgChat = q.get("tg_chat");
    const tgCode = q.get("tg_code");
    if (!tgOwner || !tgChat || !tgCode) return;
    if (tgOwner.toLowerCase() !== owner.toLowerCase()) return;

    void (async () => {
      try {
        const res = await fetch("/api/notify/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "confirm",
            owner: tgOwner,
            chatId: tgChat,
            code: tgCode,
          }),
        });
        const data = (await res.json()) as { error?: string; chatId?: string };
        if (!res.ok) throw new Error(data.error || "confirm failed");
        if (data.chatId) lsSet(owner, data.chatId);
        toast.success("Telegram linked", "Alerts are on");
        // clean URL
        const url = new URL(window.location.href);
        url.searchParams.delete("tg_owner");
        url.searchParams.delete("tg_chat");
        url.searchParams.delete("tg_code");
        window.history.replaceState({}, "", url.pathname + url.search);
        await load();
      } catch (e) {
        toast.error(
          "Telegram confirm failed",
          e instanceof Error ? e.message : "try Connect again"
        );
      }
    })();
  }, [owner, load, toast]);

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
        chatId?: string;
      };
      if (!res.ok) throw new Error(data.error || "Request failed");

      if (action === "link" && data.deepLink) {
        window.open(data.deepLink, "_blank", "noopener,noreferrer");
        toast.info(
          "Press Start in Telegram",
          "Then return here and click Refresh status (or open the confirm link the bot sends)"
        );
      } else if (action === "test" && data.sent) {
        toast.success("Test sent", "Check your Telegram DMs");
      } else if (action === "unlink") {
        lsClear(owner);
        setLocalChat(null);
        toast.info("Telegram unlinked");
      } else if (action === "toggle") {
        toast.success(
          data.enabled ? "Alerts on" : "Alerts paused",
          data.enabled ? "Tick DMs enabled" : "No more DMs until re-enabled"
        );
      } else if (action === "register_chat" && data.chatId) {
        lsSet(owner, data.chatId);
        setLocalChat(data.chatId);
        toast.success("Telegram registered", `Chat ${data.chatId}`);
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

  const showLinked = st.linked || Boolean(localChat);

  return (
    <div className="glass rounded-2xl border border-[#c8ff4a]/20 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#c8ff4a]">Telegram alerts</h3>
        {showLinked ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              st.enabled || localChat
                ? "bg-emerald-400/20 text-emerald-200"
                : "bg-zinc-500/30 text-zinc-300"
            }`}
          >
            {st.enabled || localChat ? "ON" : "PAUSED"}
          </span>
        ) : (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/50">
            Not linked
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-white/45">
        DMs after a sealed tick. Use <b className="text-white/70">Connect Telegram</b>{" "}
        from this app (not a bare <code className="text-white/50">/start</code>).
      </p>

      {!st.configured && (
        <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-100">
          Missing <code className="text-[#c8ff4a]">TELEGRAM_BOT_TOKEN</code> on
          the server. Add env vars and redeploy.
        </p>
      )}

      {st.configured && !showLinked && (
        <div className="mb-3 space-y-2 rounded-lg border border-amber-400/25 bg-amber-950/30 px-2.5 py-2 text-[11px] text-amber-50/90">
          <p className="font-semibold text-amber-100">If the bot stays silent:</p>
          <ol className="list-decimal space-y-1 pl-4 text-white/70">
            <li>
              Re-run <code className="text-[#c8ff4a]">setWebhook</code> with{" "}
              <code className="text-[#c8ff4a]">secret_token</code> ={" "}
              <b>exactly</b> the same as Vercel{" "}
              <code className="text-[#c8ff4a]">TELEGRAM_WEBHOOK_SECRET</code>
            </li>
            <li>
              Turn off Vercel <b>Deployment Protection</b> on Production (or use
              bypass query on webhook URL)
            </li>
            <li>
              Or type in Telegram:{" "}
              <code className="text-[#c8ff4a]">/link {owner}</code> then paste
              chat id below
            </li>
          </ol>
        </div>
      )}

      {st.linked && st.username && (
        <p className="mb-2 text-[11px] text-white/50">
          Linked as @{st.username}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!showLinked ? (
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

      {/* Backup: manual chat id */}
      {!showLinked && st.configured && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-white/35">
            Backup: paste chat id from bot
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={manualChat}
              onChange={(e) => setManualChat(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 123456789"
              className="min-w-[10rem] flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            />
            <button
              type="button"
              disabled={busy || manualChat.length < 5}
              onClick={() =>
                void post("register_chat", { chatId: manualChat })
              }
              className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
            >
              Save chat id
            </button>
          </div>
          <p className="mt-1 text-[10px] text-white/35">
            In the bot send <code className="text-white/50">/link {owner}</code>{" "}
            — it will show your chat id if webhook works.
          </p>
        </div>
      )}

      {err && <p className="mt-2 text-[11px] text-red-300">{err}</p>}
    </div>
  );
}
