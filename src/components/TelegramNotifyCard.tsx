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
        Get a Telegram DM when an agent seals a tick. Tap{" "}
        <b className="text-white/70">Connect Telegram</b> to link your wallet.
      </p>

      {!st.configured && (
        <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-100">
          Telegram alerts are temporarily unavailable. Try again later.
        </p>
      )}

      {showLinked && (
        <div className="mb-2 text-[11px] text-white/55">
          <p>
            {displayUser ? (
              <>
                Linked as <span className="text-white/80">@{displayUser}</span>
              </>
            ) : (
              <>Linked to Telegram</>
            )}
          </p>
        </div>
      )}

      {deepLink && !showLinked && (
        <div className="mb-3 flex flex-wrap gap-2 rounded-lg border border-[#c8ff4a]/25 bg-black/40 px-2.5 py-2">
          <a
            href={deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary rounded-lg px-3 py-1.5 text-xs"
          >
            Open Telegram bot
          </a>
          <button
            type="button"
            className="rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-xs text-white"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(deepLink);
                toast.success("Copied", "Open the link in Telegram");
              } catch {
                toast.info("Copy manually", deepLink.slice(0, 48) + "…");
              }
            }}
          >
            Copy link
          </button>
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

      {err && <p className="mt-2 text-[11px] text-red-300">{err}</p>}
    </div>
  );
}
