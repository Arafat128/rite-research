/**
 * Telegram notification prefs (owner wallet → chat id).
 * In-memory on Vercel (warm instances). For multi-instance durability, add Redis later.
 */

export type TelegramPref = {
  owner: string;
  chatId: string;
  /** empty = all agents owned by this wallet */
  agentIds: string[];
  enabled: boolean;
  linkedAt: number;
  username?: string;
};

export type PendingLink = {
  owner: string;
  token: string;
  expiresAt: number;
};

const g = globalThis as typeof globalThis & {
  __riteTgPrefs?: Map<string, TelegramPref>;
  __riteTgPending?: Map<string, PendingLink>;
};

function prefs(): Map<string, TelegramPref> {
  if (!g.__riteTgPrefs) g.__riteTgPrefs = new Map();
  return g.__riteTgPrefs;
}

function pending(): Map<string, PendingLink> {
  if (!g.__riteTgPending) g.__riteTgPending = new Map();
  return g.__riteTgPending;
}

export function getTelegramPref(owner: string): TelegramPref | null {
  return prefs().get(owner.toLowerCase()) || null;
}

export function setTelegramPref(pref: TelegramPref) {
  prefs().set(pref.owner.toLowerCase(), {
    ...pref,
    owner: pref.owner.toLowerCase(),
  });
}

export function unlinkTelegram(owner: string) {
  prefs().delete(owner.toLowerCase());
}

/** Create a short-lived link token for /start deep-link */
export function createLinkToken(owner: string): string {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  pending().set(token, {
    owner: owner.toLowerCase(),
    token,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  // prune old
  Array.from(pending().entries()).forEach(([k, v]) => {
    if (v.expiresAt < Date.now()) pending().delete(k);
  });
  return token;
}

export function findPrefByChatId(chatId: string): TelegramPref | null {
  const list = Array.from(prefs().values());
  for (let i = 0; i < list.length; i++) {
    if (list[i].chatId === chatId) return list[i];
  }
  return null;
}

export function consumeLinkToken(
  token: string
): PendingLink | null {
  const p = pending().get(token);
  if (!p) return null;
  pending().delete(token);
  if (p.expiresAt < Date.now()) return null;
  return p;
}

export function shouldNotifyAgent(
  pref: TelegramPref,
  agentId: string
): boolean {
  if (!pref.enabled || !pref.chatId) return false;
  if (!pref.agentIds.length) return true;
  return pref.agentIds.includes(agentId);
}
