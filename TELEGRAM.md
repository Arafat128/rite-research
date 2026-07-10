# Telegram agent alerts — setup guide

When an agent seals a tick (manual **Wake** or server **keeper**), Rite can **DM** you a short summary on Telegram.

Flows (pay / settle / runTick) are unchanged. Messaging is **after** a successful seal only.

---

## 1. Create a bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g. `Rite Agent Alerts`)
4. Choose a username ending in `bot` (e.g. `RiteRadarBot`)
5. Copy the **HTTP API token** → this is `TELEGRAM_BOT_TOKEN`
6. Note the **username** (without `@`) → `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`

Optional: `/setdescription` and `/setabouttext` for a short bio.

---

## 2. Env vars

### Local — `.env.local`

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=RiteRadarBot

# Recommended for webhook auth (or reuse CRON_SECRET)
TELEGRAM_WEBHOOK_SECRET=long-random-string
CRON_SECRET=long-random-string
```

### Vercel → Project → Settings → Environment Variables

| Name | Scope | Notes |
|------|--------|--------|
| `TELEGRAM_BOT_TOKEN` | Server | From BotFather |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Public | Bot username **without** `@` |
| `TELEGRAM_WEBHOOK_SECRET` | Server | Random string; must match webhook `secret_token` |

Redeploy after saving env.

---

## 3. Point Telegram at your app (webhook)

### ⚠️ Critical: Vercel Deployment Protection

If the project has **Deployment Protection** (SSO / “Vercel Authentication”), Telegram gets **401 Protected deployment** and the bot **never answers** `/start`.

**Fix one of these:**

**A. Recommended for a public app**  
Vercel → Project → **Settings → Deployment Protection** → for **Production** set to **None** (or disable Vercel Authentication).

**B. Keep protection, allow automation**  
1. Settings → Deployment Protection → **Protection Bypass for Automation** → enable, copy the secret.  
2. Put it in env as `VERCEL_AUTOMATION_BYPASS_SECRET` (optional; only for your notes).  
3. Set webhook URL **with** the bypass query param:

```text
https://YOUR_APP.vercel.app/api/notify/telegram/webhook?x-vercel-protection-bypass=YOUR_BYPASS_SECRET
```

(Your app secret `TELEGRAM_WEBHOOK_SECRET` is still separate — that is `secret_token` for Telegram.)

### setWebhook (after protection is fixed)

```bash
# Production example (PowerShell-friendly)
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" `
  -d "url=https://YOUR_APP.vercel.app/api/notify/telegram/webhook" `
  -d "secret_token=rite_tg_wh_k7m9p2xQ4vL8nR3wY6zA1bC5dE0fG" `
  -d "drop_pending_updates=true"
```

If using bypass (option B), put the **full** URL including `?x-vercel-protection-bypass=...` in `url=`.

Check:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

You should see your `url`. If `last_error_message` mentions 401 / Unauthorized, protection is still blocking.

**Local dev:** use [ngrok](https://ngrok.com/) or similar:

```bash
ngrok http 3000
# setWebhook url=https://xxxx.ngrok.io/api/notify/telegram/webhook
```

---

## 4. Link in the app

1. Open **Rite → My Agents** (wallet connected)
2. Open section **Telegram alerts**
3. Click **Connect Telegram** → opens the bot with a one-time token
4. Press **Start** in Telegram → bot replies **Linked to Rite**
5. Optional: **Send test message**

You are linked. Ticks will DM when:

- You click **Wake** and the seal succeeds, or  
- The **keeper** runs a successful `runTick` for your agent

---

## 5. How it works (architecture)

```
User links wallet ↔ Telegram chat_id
        │
        ▼
Successful runTick (UI or keeper)
        │
        ▼
notifyAgentTick({ owner, agentId, summary, txHash, … })
        │
        ▼
Telegram Bot API sendMessage → user DM
```

| Piece | Path |
|-------|------|
| Bot send helper | `src/lib/telegram.ts` |
| Link store | `src/lib/telegramPrefs.ts` |
| User API | `GET/POST /api/notify/telegram` |
| Telegram webhook | `POST /api/notify/telegram/webhook` |
| After manual wake | `AgentTab` → `notifyAgentTick` |
| After keeper wake | `agentKeeper` → `notifyAgentTick` |

---

## 6. API quick reference

### Status

```http
GET /api/notify/telegram?owner=0xYourWallet
```

### Start link (returns deep link)

```http
POST /api/notify/telegram
Content-Type: application/json

{ "action": "link", "owner": "0xYourWallet" }
```

Response: `{ "deepLink": "https://t.me/YourBot?start=TOKEN", ... }`

### Test / unlink / pause

```json
{ "action": "test", "owner": "0x..." }
{ "action": "unlink", "owner": "0x..." }
{ "action": "toggle", "owner": "0x...", "enabled": false }
```

### Filter agents (empty = all)

```json
{ "action": "agents", "owner": "0x...", "agentIds": ["2", "5"] }
```

---

## 7. Bot commands (user)

| Command | Effect |
|---------|--------|
| `/start` | Help / complete link from Rite |
| `/status` | Linked wallet + on/off |
| `/stop` | Pause notifications |

---

## 8. Production notes

### In-memory prefs

Link state is stored **in the serverless process memory** (fine for demos).  
On cold starts / many instances, links can be lost → user clicks **Connect** again.

For durable production, replace `telegramPrefs.ts` with:

- **Upstash Redis**, or  
- **Vercel Postgres / Supabase**

### Security

- Never put `TELEGRAM_BOT_TOKEN` in `NEXT_PUBLIC_*`
- Set `TELEGRAM_WEBHOOK_SECRET` and pass it as Telegram `secret_token`
- Link tokens expire in **15 minutes**
- Only send DMs **after** a successful on-chain tick

### Hobby / Protection

If Deployment Protection blocks Telegram’s webhook, add a **Protection Bypass** or disable protection for the webhook path / production.

---

## 9. Checklist

- [ ] Bot created in BotFather  
- [ ] `TELEGRAM_BOT_TOKEN` + `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` on Vercel  
- [ ] Webhook set to `https://YOUR_APP/api/notify/telegram/webhook`  
- [ ] `secret_token` matches `TELEGRAM_WEBHOOK_SECRET`  
- [ ] Redeploy  
- [ ] My Agents → Connect Telegram → Start in app  
- [ ] Test message arrives  
- [ ] Wake an agent → DM with tick summary  

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| “Telegram not configured” | Env missing or not redeployed |
| Connect opens wrong bot | Fix `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` |
| **Start does nothing / bot silent** | **1)** Webhook not set · **2)** **Vercel Deployment Protection 401** (most common) · **3)** Typed bare `/start` without opening **Connect Telegram** deep link · **4)** `secret_token` ≠ `TELEGRAM_WEBHOOK_SECRET` on Vercel |
| Linked but no tick DMs | Wake must succeed on-chain; check agent LIVE + funded; `/status` → ON |
| Lost link after idle | Cold start cleared memory — reconnect (or add Redis) |

### Verify protection is the issue

```bash
# Should return JSON, NOT HTML login / 401 Protected deployment
curl -i -X POST "https://YOUR_APP.vercel.app/api/notify/telegram/webhook" `
  -H "Content-Type: application/json" `
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_WEBHOOK_SECRET" `
  -d "{\"message\":{\"text\":\"/start\",\"chat\":{\"id\":1}}}"
```

If you see `Protected deployment` or HTML, fix Deployment Protection first.

---

## Message example

```
Rite agent tick

Agent #2 · Price Radar
Stream: Token price · BTC
Tick #4

BTC last ≈ $97,200 · …

Seal tx ↗
```
