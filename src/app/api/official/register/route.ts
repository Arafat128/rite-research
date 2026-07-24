import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  listOfficialByOwner,
  publicOfficial,
  upsertOfficialAgent,
  type OfficialAgentServerRecord,
} from "@/lib/officialAgentRegistry";
import { clientIp, rateLimit } from "@/lib/security";
import { resolveTelegramPref } from "@/lib/telegramPrefs";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { EXPLORER_URL } from "@/lib/ritual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const owner = (req.nextUrl.searchParams.get("owner") || "").toLowerCase();
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }
  try {
    const rows = await listOfficialByOwner(owner);
    return NextResponse.json({
      agents: rows.map(publicOfficial),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "list failed" },
      { status: 500 }
    );
  }
}

/**
 * Register / sync official agents for server-side Telegram activity alerts.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = rateLimit(`official-reg:${ip}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req.json()) as {
      action?: string;
      owner?: string;
      agent?: Partial<OfficialAgentServerRecord>;
      agents?: Array<Partial<OfficialAgentServerRecord>>;
      notifyLaunch?: boolean;
    };

    const owner = (body.owner || "").toLowerCase();
    if (!owner || !isAddress(owner)) {
      return NextResponse.json({ error: "owner required" }, { status: 400 });
    }

    const list =
      body.action === "sync" && Array.isArray(body.agents)
        ? body.agents
        : body.agent
          ? [body.agent]
          : [];

    if (!list.length) {
      return NextResponse.json(
        { error: "agent or agents[] required" },
        { status: 400 }
      );
    }

    const saved = [];
    for (const raw of list.slice(0, 30)) {
      const child = (raw.childAddress || "").toLowerCase();
      if (!child || !isAddress(child)) continue;
      if (raw.owner && raw.owner.toLowerCase() !== owner) continue;
      const kind =
        raw.kind === "persistent" || raw.kind === "sovereign"
          ? raw.kind
          : null;
      if (!kind) continue;

      const rec = await upsertOfficialAgent({
        kind,
        name: String(raw.name || `${kind} agent`).slice(0, 80),
        owner,
        childAddress: child,
        userSalt: raw.userSalt,
        createTx: raw.createTx,
        createdAt: Number(raw.createdAt) || Date.now(),
        prompt: raw.prompt,
        model: raw.model,
        executor: raw.executor,
        status: raw.status,
        telegramEnabled: raw.telegramEnabled !== false,
      });
      saved.push(publicOfficial(rec));

      // Optional one-shot launch DM (only for single register with notifyLaunch)
      if (
        body.notifyLaunch &&
        list.length === 1 &&
        telegramConfigured()
      ) {
        try {
          const pref = await resolveTelegramPref(owner);
          if (pref?.chatId && pref.enabled !== false) {
            const kindLabel =
              kind === "persistent"
                ? "Persistent (0x0820)"
                : "Sovereign (0x080C)";
            const url = `${EXPLORER_URL.replace(/\/$/, "")}/address/${child}`;
            await sendTelegramMessage(
              pref.chatId,
              `<b>Rite · Official Ritual agent launched</b>\n` +
                `<b>${escapeHtml(rec.name)}</b> · ${kindLabel}\n` +
                `<code>${child}</code>\n` +
                `<a href="${url}">Open on Ritual ↗</a>\n` +
                `You will get DMs when explorer shows new activity / heartbeats.`
            );
            // Mark launch as alerted so tick won't re-send identical launch
            await upsertOfficialAgent({
              ...rec,
              lastAlertKey: `launch:${rec.createTx || rec.createdAt}`,
              lastAlertAt: Date.now(),
            });
          }
        } catch (e) {
          console.warn("[official/register] launch TG", e);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      count: saved.length,
      agents: saved,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "register failed" },
      { status: 400 }
    );
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
