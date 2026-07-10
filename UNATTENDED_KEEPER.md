# Unattended auto-wake (1 minute agents)

Fully automatic ticks **without** leaving **My Agents** open.

## Architecture

```
GitHub Actions (every 1 min)  ──Bearer CRON_SECRET──►  Vercel /api/agent/cron
                                                         │
                                                         ├─ KEEPER_PRIVATE_KEY (gas)
                                                         ├─ Surf data fetch
                                                         └─ runTick on LIVE + due agents
```

Vercel **Hobby** native cron is only **daily** — use GitHub Actions (or cron-job.org) for 1m.

---

## Checklist — what you must do

### 1. Vercel Production env (Project → Settings → Environment Variables)

| Variable | Required | Notes |
|----------|----------|--------|
| `KEEPER_PRIVATE_KEY` | Yes | Wallet with a little RIT for **gas only** |
| `CRON_SECRET` | Yes | Long random string; same value in GitHub secret |
| `SURF_API_KEY` | Yes | Data API |
| `NEXT_PUBLIC_RADAR_CONTRACT` | Yes | Prefer `0x50a3…` (kill-capable) |
| `TELEGRAM_BOT_TOKEN` | Optional | For DMs |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Optional | Without `@` |
| `TELEGRAM_WEBHOOK_SECRET` | Optional | Match setWebhook |

**Redeploy** after changing env.

### 2. Deployment Protection

Vercel → Project → **Settings → Deployment Protection**:

- Production: **disable** Vercel Authentication, **or**
- Enable **Protection Bypass for Automation** and put that secret in GitHub as `VERCEL_AUTOMATION_BYPASS_SECRET`

If protection blocks cron, you get HTML login / 401 and **zero ticks**.

### 3. GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Example |
|--------|---------|
| `APP_URL` | `https://rite-mehidy-s-projects.vercel.app` (no trailing `/`) |
| `CRON_SECRET` | **Exact same** as Vercel `CRON_SECRET` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Only if protection bypass is on |

### 4. Enable the workflow

1. Push / merge `main` so `.github/workflows/agent-keeper.yml` is on GitHub  
2. **Actions** tab → **Agent keeper (unattended)** → **Enable** if prompted  
3. **Run workflow** once (workflow_dispatch) to verify  
4. Confirm green run + JSON with `"ok": true`

### 5. Agent on-chain readiness

For each agent you want unattended:

1. **Deploy** on the Radar in `NEXT_PUBLIC_RADAR_CONTRACT`  
2. **Activate → LIVE**  
3. **Fund** so balance ≥ run fee (~0.005 RIT)  
4. **Save schedule** to **1 minute** (or your interval)  
5. Keep agent **LIVE** (not Paused / Dead / OutOfFunds)

Sovereign agents die after **3 ticks** — use Persistent for long unattended runs.

### 6. Keeper allowlist (if ticks fail with NotAuthorized)

Radar admin must:

```bash
cast send 0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f \
  "setKeeper(address,bool)" YOUR_KEEPER_ADDRESS true \
  --rpc-url https://rpc.ritualfoundation.org \
  --private-key ADMIN_PRIVATE_KEY
```

Keeper address = public address of `KEEPER_PRIVATE_KEY`.

### 7. Telegram (optional)

1. Webhook → production:  
   `https://YOUR_APP.vercel.app/api/notify/telegram/webhook`  
2. Open the **production** site → Connect Telegram once  
3. After cold starts, browser rehydrate helps; server may need re-link if prefs were only in memory

---

## Verify manually

```bash
# Health
curl -sS "https://YOUR_APP.vercel.app/api/agent/cron?health=1" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"

# Force tick pass (only due agents actually seal)
curl -sS -X POST "https://YOUR_APP.vercel.app/api/agent/cron?max=25" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Expect:

```json
{ "ok": true, "autoWake": true, "ticked": 0 or more, "results": [...] }
```

- `ticked: 0` + `not_due_…` → schedule not elapsed yet (normal)  
- `not_active` → Activate → LIVE  
- `insufficient_balance` → Fund agent  
- `NotAuthorized` → setKeeper  

---

## Optional: tighter 1m than GitHub

GitHub schedules can lag. For stricter 1m:

1. [cron-job.org](https://cron-job.org) → every **1 minute**  
2. URL: `https://YOUR_APP.vercel.app/api/agent/cron?max=25`  
3. Method: POST  
4. Header: `Authorization: Bearer YOUR_CRON_SECRET`  

You can run **both** GitHub + cron-job (idempotent: early calls skip with `not_due`).

---

## What you do **not** need

- My Agents tab open  
- Manual Wake every minute  
- Your laptop on  

You **do** need: secrets set, protection not blocking, agent LIVE + funded + schedule, keeper wallet with gas.
