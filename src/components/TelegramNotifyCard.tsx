"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useToast } from "@/components/ToastProvider";

const LS_KEY = "rite_telegram_link_v2";
const LS_KEY_LEGACY = "rite_telegram_chat_v1";

type Status = {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  enabled: boolean;
  username: string | null;
  agentIds: string[];
  /** Server no longer returns raw chatId — browser localStorage only */
  hasChatId?: boolean;
  storeBackend?: "upstash" | "memory";
  multiUserReady?: boolean;
};

/** Full link snapshot kept in this browser (survives server cold starts). */
type LocalLink = {
  chatId: string;
  username?: string;
  enabled?: boolean;
};

function lsGet(owner: string): LocalLink | null {
  try {
    const raw = localStorage.getItem(`${LS_KEY}:${owner.toLowerCase()}`);
    if (raw) {
      const p = JSON.parse(raw) as LocalLink;
      if (p?.chatId && /^\d+$/.test(p.chatId)) return p;
    }
    // migrate chat-id-only v1
    const legacy = localStorage.getItem(
      `${LS_KEY_LEGACY}:${owner.toLowerCase()}`
    );
    if (legacy && /^\d+$/.test(legacy)) {
      const migrated: LocalLink = { chatId: legacy, enabled: true };
      lsSet(owner, migrated);
      return migrated;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function lsSet(owner: string, link: LocalLink) {
  try {
    localStorage.setItem(
      `${LS_KEY}:${owner.toLowerCase()}`,
      JSON.stringify(link)
    );
    // keep legacy key so older code paths still rehydrate
    localStorage.setItem(
      `${LS_KEY_LEGACY}:${owner.toLowerCase()}`,
      link.chatId
    );
  } catch {
    /* ignore */
  }
}

function lsClear(owner: string) {
  try {
    localStorage.removeItem(`${LS_KEY}:${owner.toLowerCase()}`);
    localStorage.removeItem(`${LS_KEY_LEGACY}:${owner.toLowerCase()}`);
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
  const [localLink, setLocalLink] = useState<LocalLink | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/notify/telegram?owner=${encodeURIComponent(owner)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as Status & { error?: string };
      if (!res.ok) throw new Error(data.error || "status failed");
      setErr("");
      const ls = lsGet(owner);
      setLocalLink(ls);

      // Re-hydrate server after cold start (silent — no spam DM)
      if (ls?.chatId && (!data.linked || !data.username)) {
        const reg = await fetch("/api/notify/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "register_chat",
            owner,
            chatId: ls.chatId,
            username: ls.username,
            enabled: ls.enabled ?? true,
            silent: true,
          }),
        }).catch(() => null);
        if (reg?.ok) {
          const res2 = await fetch(
            `/api/notify/telegram?owner=${encodeURIComponent(owner)}`,
            { cache: "no-store" }
          );
          if (res2.ok) {
            const data2 = (await res2.json()) as Status;
            setSt(data2);
            if (data2.linked) {
              lsSet(owner, {
                chatId: ls.chatId,
                username: data2.username || ls.username,
                enabled: data2.enabled,
              });
              setLocalLink(lsGet(owner));
            }
            return;
          }
        }
      }

      // Server is source of truth when linked — sync into localStorage
      if (data.linked) {
        // Prefer existing local chat id if GET doesn't return it (API never returns chatId)
        const chatId = ls?.chatId;
        if (chatId) {
          lsSet(owner, {
            chatId,
            username: data.username || ls?.username,
            enabled: data.enabled,
          });
          setLocalLink(lsGet(owner));
        }
      }

      setSt(data);
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
        const data = (await res.json()) as {
          error?: string;
          chatId?: string;
          username?: string;
        };
        if (!res.ok) throw new Error(data.error || "confirm failed");
        if (data.chatId) {
          lsSet(owner, {
            chatId: data.chatId,
            username: data.username,
            enabled: true,
          });
          setLocalLink(lsGet(owner));
        }
        toast.success("Telegram linked", "Alerts are on");
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
        username?: string | null;
      };
      if (!res.ok) throw new Error(data.error || "Request failed");

      if (action === "link" && data.deepLink) {
        setDeepLink(data.deepLink);
        const opened = window.open(
          data.deepLink,
          "_blank",
          "noopener,noreferrer"
        );
        if (!opened) {
          toast.info(
            "Open the Telegram link below",
            "Popup blocked — use Open bot or Copy link"
          );
        } else {
          toast.info(
            "Press Start in Telegram",
            "Then return here and click Refresh status"
          );
        }
      } else if (action === "test" && data.sent) {
        toast.success("Test sent", "Check your Telegram DMs");
      } else if (action === "unlink") {
        lsClear(owner);
        setLocalLink(null);
        setDeepLink(null);
        toast.info("Telegram unlinked");
      } else if (action === "toggle") {
        const ls = lsGet(owner);
        if (ls) {
          lsSet(owner, { ...ls, enabled: data.enabled ?? !ls.enabled });
          setLocalLink(lsGet(owner));
        }
        toast.success(
          data.enabled ? "Alerts on" : "Alerts paused",
          data.enabled ? "Tick DMs enabled" : "No more DMs until re-enabled"
        );
      } else if (action === "register_chat" && data.chatId) {
        lsSet(owner, {
          chatId: data.chatId,
          username: data.username || undefined,
          enabled: true,
        });
        setLocalLink(lsGet(owner));
        toast.success("Telegram registered", `Chat ${data.chatId}`);
      } else if (action === "confirm" && data.chatId) {
        lsSet(owner, {
          chatId: data.chatId,
          username: data.username || undefined,
          enabled: true,
        });
        setLocalLink(lsGet(owner));
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

  const showLinked = st.linked || Boolean(localLink?.chatId);
  const displayUser =
    st.username || localLink?.username || null;
  const displayEnabled = st.linked
    ? st.enabled
    : (localLink?.enabled ?? Boolean(localLink?.chatId));

  return (
    <div className="glass rounded-2xl border border-[#c8ff4a]/20 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#c8ff4a]">Telegram alerts</h3>
        {showLinked ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              displayEnabled
                ? "bg-emerald-400/20 text-emerald-200"
                : "bg-zinc-500/30 text-zinc-300"
            }`}
          >
            {displayEnabled ? "ON" : "PAUSED"}
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
        Link is per environment — re-connect once on Vercel if you linked only on localhost.
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
              Production webhook must point at this site (not a local tunnel)
            </li>
            <li>
              <code className="text-[#c8ff4a]">secret_token</code> ={" "}
              <code className="text-[#c8ff4a]">TELEGRAM_WEBHOOK_SECRET</code>
            </li>
            <li>
              Or: <code className="text-[#c8ff4a]">/link {owner}</code> then paste
              chat id below
            </li>
          </ol>
        </div>
      )}

      {showLinked && (
        <div className="mb-2 space-y-0.5 text-[11px] text-white/55">
          <p>
            {displayUser ? (
              <>
                Linked as <span className="text-white/80">@{displayUser}</span>
              </>
            ) : (
              <>Linked to Telegram</>
            )}
            {localLink?.chatId && (
              <span className="text-white/35">
                {" "}
                · chat{" "}
                <code className="text-white/50">{localLink.chatId}</code>
              </span>
            )}
          </p>
          {st.linked && !st.username && localLink?.username && (
            <p className="text-[10px] text-white/35">
              Showing username from this browser (server had chat id only).
            </p>
          )}
          {!st.linked && localLink?.chatId && (
            <p className="text-[10px] text-amber-200/80">
              Browser has chat id — rehydrating server… click Refresh if status
              stays incomplete.
            </p>
          )}
          <div
            className={`mt-2 rounded-lg border px-2 py-2 text-[10px] leading-relaxed ${
              st.multiUserReady
                ? "border-emerald-400/25 bg-emerald-950/30 text-emerald-50/90"
                : "border-amber-400/25 bg-amber-950/30 text-amber-50/90"
            }`}
          >
            <p className="font-semibold">
              {st.multiUserReady
                ? "Multi-user unattended DMs: ON"
                : "Multi-user unattended DMs: needs Redis (once)"}
            </p>
            {st.multiUserReady ? (
              <p className="mt-1 text-white/60">
                Each user only clicks <b>Connect Telegram</b> — no per-user env.
                Keeper can DM them with the site closed.
              </p>
            ) : (
              <p className="mt-1 text-white/60">
                Without shared storage, Vercel forgets links between instances.
                Admin (once): free{" "}
                <a
                  className="text-[#c8ff4a] underline"
                  href="https://console.upstash.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Upstash Redis
                </a>{" "}
                → add{" "}
                <code className="text-white/70">UPSTASH_REDIS_REST_URL</code> +{" "}
                <code className="text-white/70">UPSTASH_REDIS_REST_TOKEN</code>{" "}
                on Vercel → redeploy. Then every new user just links in the app.
              </p>
            )}
          </div>
        </div>
      )}

      {deepLink && !showLinked && (
        <div className="mb-3 space-y-2 rounded-lg border border-[#c8ff4a]/25 bg-black/40 px-2.5 py-2">
          <p className="text-[11px] font-semibold text-[#c8ff4a]">
            Your link (opens bot with wallet token)
          </p>
          <p className="break-all font-mono text-[10px] text-white/70">{deepLink}</p>
          <div className="flex flex-wrap gap-2">
            <a
              href={deepLink}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary rounded-lg px-3 py-1.5 text-xs"
            >
              Open bot
            </a>
            <button
              type="button"
              className="rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-xs text-white"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(deepLink);
                  toast.success("Copied", "Paste in browser or Telegram");
                } catch {
                  toast.info("Copy manually", deepLink.slice(0, 48) + "…");
                }
              }}
            >
              Copy link
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!showLinked ? (
          <button
            type="button"
            disabled={busy || !st.configured}
            onClick={() => void post("link")}
            className="btn-primary rounded-lg px-3 py-2 text-sm"
          >
            {busy ? "…" : deepLink ? "New link" : "Connect Telegram"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || !st.configured}
              onClick={() =>
                void post("toggle", { enabled: !displayEnabled })
              }
              className="rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
            >
              {displayEnabled ? "Pause alerts" : "Enable alerts"}
            </button>
            <button
              type="button"
              disabled={busy || !displayEnabled || !st.configured}
              onClick={() =>
                void post("test", {
                  chatId: localLink?.chatId,
                  username: localLink?.username || displayUser,
                })
              }
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
            In the bot send <code className="text-white/50">/link {owner}</code>
          </p>
        </div>
      )}

      {err && <p className="mt-2 text-[11px] text-red-300">{err}</p>}
    </div>
  );
}
