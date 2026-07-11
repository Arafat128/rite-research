# Rite

**Pay-per-prompt crypto research**, **Surf data agents**, **Telegram alerts**, and an **auto bounty pool** on **Ritual Testnet** (chain id `1979`).

**Live app:** [https://rite-mehidy-s-projects.vercel.app](https://rite-mehidy-s-projects.vercel.app)  
**GitHub:** [Arafat128/rite-research](https://github.com/Arafat128/rite-research)  
Built by [@its_perseus_1](https://x.com/its_perseus_1)

---

## What is Rite? (short)

| Product | User pays | Off-chain | On-chain seal |
|---------|-----------|-----------|----------------|
| **Research** | **0.005** RITUAL per prompt | Surf **Responses** → markdown report | `payForResearch` → `settleResearch` → reveal |
| **Data agents** | Deploy fee + **0.005** RIT per tick | Surf **Data API** (one stream locked per agent) | `runTick(digest)` |
| **Bounty** | — (funded by fees) | — | 50% of fees → pool → pull `claimPayout` |
| **Telegram** | Free | DMs after unlock/seal | Link wallet ↔ chat (no secrets in chat) |

Fees always split **50% treasury / 50% BountyPool**.

| Tab | Purpose |
|-----|---------|
| **Research** | Prompt → pay → Surf → seal → unlock report |
| **Records** | On-chain research ledger for the connected wallet |
| **Deploy** | Create **Persistent** or **Sovereign** agent + lock one data stream |
| **My Agents** | Activate, fund, schedule, **Wake**, kill/close, Telegram, auto-wake |
| **Bounty** | Pool size / last winner (draw after **20** fee interactions) |

| Agent class | Deploy fee | Life |
|-------------|------------|------|
| **Persistent** | **0.1** RIT | Never dies from tick count (best for schedules) |
| **Sovereign** | **0.01** RIT | Dies after **3** ticks |

**Streams (locked at deploy):** token price · fear & greed · news · stablecoin peg · gas · whales · OI skew · narrative · Ritual network  

**Stack:** Next.js 14 · wagmi/viem · Surf API · Foundry · Vercel · Upstash (Telegram multi-user) · GitHub Actions / QStash (unattended ticks)

**Live contracts**

| Contract | Address |
|----------|---------|
| ResearchDesk | [`0xd346…5352`](https://explorer.ritualfoundation.org/address/0xd3469a23b2a08b237bc6c0522845eb1b508e5352) |
| RadarAgent | [`0x50a3…5f6f`](https://explorer.ritualfoundation.org/address/0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f) (preferred · has `killAgent`) |
| BountyPool | [`0xbc4b…36bf`](https://explorer.ritualfoundation.org/address/0xbc4bc83298950cbda52837cd806d41ad7c3c36bf) |
| Treasury | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` |

More: [DEPLOY.md](./DEPLOY.md) · [TELEGRAM.md](./TELEGRAM.md) · [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md)

---

# Detailed application breakdown

This section documents **every major flow** end-to-end: wallet, contracts, APIs, and UI.

---

## 1. Architecture overview

```
Browser (AppShell tabs)
  │  wagmi / MetaMask · Ritual 1979
  ├─ ResearchTab ──► ResearchDesk (pay / settle) + /api/research + /api/research/reveal
  ├─ RecordsTab  ──► ResearchDesk reads (on-chain history)
  ├─ AgentTab    ──► RadarAgent (create / fund / wake / kill) + /api/agent/*
  ├─ BountyBanner──► BountyPool reads + claimPayout
  └─ Telegram    ──► /api/notify/telegram* + Upstash (optional)

Server (Vercel Node)
  │  SURF_API_KEY · CRON_SECRET · KEEPER_PRIVATE_KEY · seal secret · bot token
  ├─ Surf /responses     → research reports
  ├─ Surf Data API       → agent tick snapshots
  ├─ Keeper (cron/auto)  → gas + runTick + Telegram DM
  └─ Report seal (AES)   → no plaintext until settle+reveal
```

**Design rules**

- **User wallet** pays research fees, deploy fees, and gas for manual txs.  
- **Agent balance** pays tick fees (`0.005` RIT each `runTick`).  
- **Keeper wallet** pays gas only for unattended / auto-wake `runTick`.  
- **Surf** never returns raw research plaintext until the user has **settled on-chain** and **revealed**.  
- **Telegram** never receives secrets; DMs are after seal/unlock only.

---

## 2. Research flow (detailed)

### 2.1 Happy path (first-time pay)

| Step | Where | What happens |
|------|--------|----------------|
| 1 | UI | User connects MetaMask on **Ritual Testnet (1979)** and enters a prompt |
| 2 | Wallet | `payForResearch(promptHash)` with value = on-chain `researchFee` (0.005 RIT) |
| 3 | Chain | ResearchDesk stores record: researcher, fee, `promptHash`, `settled=false` · fee split 50/50 |
| 4 | UI | Reads `ResearchPaid` event → `researchId` · saves **paid credit** locally (wallet + prompt) |
| 5 | Wallet | Signs claim message: researchId + promptHash + nonce + expiry |
| 6 | Server | `POST /api/research` verifies payment + signature · calls Surf `/responses` (default **instant**, ~270s timeout) |
| 7 | Server | Computes `resultHash = keccak256(report)` · **encrypts** report → `sealedReport` · caches report |
| 8 | Response | Returns **only** `sealedReport` + `resultHash` (no plaintext) |
| 9 | Wallet | `settleResearch(researchId, resultHash)` — seal hash on-chain |
| 10 | Server | `POST /api/research/reveal` after settle · verifies signature + on-chain hash · returns markdown |
| 11 | UI | Renders report (GFM) · optional toast if Telegram DM sent |
| 12 | Telegram | If wallet is linked: **Rite · Research report** DM (full report, may split into parts) |

### 2.2 Claim free report (paid, Surf failed / timeout)

When Surf times out or the tab dies **after payment** but **before** a successful seal:

1. Fee is already on-chain (`settled = false`, `resultHash = 0`).  
2. UI lists **Paid credits** for the paying wallet.  
3. User pastes the **exact same prompt** (must match `promptHash`).  
4. `POST /api/research` with `researchId` (claim path) + signature — **no new payment**.  
5. Surf runs again → seal → reveal as above.

**Important:** There is nothing to seal until Surf returns a report. Timeout UI must not imply “rejecting seal lost the fee” for pure Surf timeouts — fee is already paid; use Claim.

### 2.3 Report shape

- Adaptive markdown: headings fit the **question** (not a forced Overview / Tokenomics / … template).  
- Tables / bold / lists when useful; Sources when claims are cited.

### 2.4 Timeouts & limits

| Limit | Value | Notes |
|-------|--------|--------|
| Surf client abort | **~270s** (env `SURF_FETCH_TIMEOUT_MS`) | Under Vercel function max **300s** |
| Default model | `surf-1.5-instant` | Override `SURF_MODEL` |
| Prompt size | Clamped server-side | Hash must match payment |

---

## 3. Data agent flow (detailed)

### 3.1 Deploy

| Step | What |
|------|------|
| 1 | Choose **Persistent** (0.1 RIT) or **Sovereign** (0.01 RIT) |
| 2 | Choose **one** data stream + optional target (symbol / pair / sector) |
| 3 | Wallet: `createAgent(name, wakeIntervalBlocks, kind)` + deploy fee (+ optional fund) |
| 4 | Wallet: `setWatchlist(agentId, ["kind\|target"])` — **max 48 bytes per cell** on-chain |
| 5 | Agent starts **Paused** · appears under **My Agents** |

### 3.2 Activate · fund · schedule

| Action | Contract / UI |
|--------|----------------|
| **Activate → LIVE** | `setActive` — status must be **Active (1)** to tick |
| **Fund** | `fundAgent` — balance must cover tick fee (0.005) |
| **Schedule** | `setWakeInterval(blocks)` — UI converts minutes/hours ≈ block time |
| **Pause** | `setPaused` — stops auto/manual wakes until activated again |

### 3.3 Manual Wake

| Step | What |
|------|------|
| 1 | UI checks LIVE + decoded watchlist (`kind|target`) |
| 2 | `POST /api/agent/data` → Surf Data snapshot (table rows + highlights) |
| 3 | Digest = `keccak256(JSON snapshot fields)` |
| 4 | Wallet `runTick(agentId, digest)` — fee from **agent balance**; gas from **user wallet** |
| 5 | UI shows snapshot only after successful receipt · local tick history · optional Telegram |

If watchlist is empty (e.g. `setWatchlist` failed), **Wake stays disabled** (`!track`).

### 3.4 Tick economics & life

| Item | Rule |
|------|------|
| Tick fee | **0.005** RIT from **agent balance** → 50/50 treasury/bounty |
| Gas | User wallet (manual) or **keeper** (auto) |
| Sovereign | After **3** successful ticks → status **Dead** |
| Persistent | Unlimited ticks by count · still needs balance + LIVE |
| Out of funds | Status **OutOfFunds** if balance &lt; run fee |

### 3.5 Kill / close

| Radar | Behavior |
|-------|----------|
| **0x50a3…** (preferred) | `killAgent` — dead + refund remaining balance |
| Legacy (e.g. 0x5ed8…) | Soft-close: withdraw + pause (no `killAgent` in bytecode) |

### 3.6 Data streams

| Stream id | Label | Target |
|-----------|--------|--------|
| `market_price` | Token price | Symbol (BTC, …) |
| `fear_greed` | Fear & Greed | — |
| `news_feed` | Crypto news | — |
| `stablecoin_peg` | Stablecoin peg stress | Optional extra symbol |
| `gas_fees` | Gas / fee pulse | — |
| `whale_transfers` | Whale / large moves | Symbol |
| `open_interest_skew` | OI + long/short skew | Pair |
| `narrative_sector` | Narrative / sector | Query |
| `ritual_network` | Ritual network pulse | — |

Legacy watchlist aliases still decode: `perp_funding` → OI skew, `social_mindshare` → narrative.

---

## 4. Auto-wake & unattended ticks (detailed)

Agents do **not** tick by themselves. Something must call the keeper path.

### 4.1 Tab open (My Agents)

| Item | Detail |
|------|--------|
| Trigger | Client polls `POST /api/agent/auto-wake` ~ every **20s** |
| Auth | Rate-limited · **owner address required** · only that owner’s agents |
| Server | `runDueAgentTicks` — status LIVE, funded, **due** (block or time fallback), has stream |
| Tick | Keeper signs `runTick` with **EIP-1559** cheap gas (Ritual rejects legacy type-0) |
| UI | Merges snapshot into tick history · Telegram if linked |

### 4.2 Tab closed (unattended)

| Path | Cadence | Auth |
|------|---------|------|
| **GitHub Actions** `agent-keeper.yml` | ~50× 1m loop, restarts ~:00/:15/:30/:45 | Bearer `CRON_SECRET` → `/api/agent/cron` |
| **QStash / cron-job.org** | True 1m recommended | Same Bearer |
| **Vercel Hobby cron** | **Daily only** | Platform + secret |

Requirements: `KEEPER_PRIVATE_KEY` (funded for gas), `CRON_SECRET`, `SURF_API_KEY`, agent **LIVE** + funded + schedule, prefer **Persistent**.

Health: `GET /api/agent/cron?health=1` with Bearer.

See [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md).

### 4.3 Due logic

1. Prefer on-chain `lastTickBlock + wakeIntervalBlocks`.  
2. If that view fails, fall back to time math from `lastRunAt` and approx block time (`NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC`, default **2**).  
3. Not due → skip (`not_due_…`); TooEarly on-chain is reported clearly.

---

## 5. Telegram (detailed)

### 5.1 Linking (multi-user)

1. User clicks **Connect Telegram** in the app.  
2. Opens bot with signed/HMAC start payload (wallet-bound).  
3. Webhook `POST /api/notify/telegram/webhook` (requires `TELEGRAM_WEBHOOK_SECRET` on Vercel).  
4. Pref stored: wallet → `chatId` in **Upstash Redis** when configured (works across Vercel instances).  
5. Users never set env vars; admins set bot + Upstash once.

### 5.2 Message types (clear labels)

| Type | When | Header in DM |
|------|------|----------------|
| **Agent tick** | After successful `runTick` (manual / auto / cron) | `Rite · Agent tick` — stream snapshot, not research |
| **Research report** | After settle + reveal unlock | `Rite · Research report` — full report (may continue in parts) |

### 5.3 Security

- Webhook `secret_token` required in production.  
- No public GET of raw `chatId`.  
- Register/push cannot hijack another wallet’s chat.  
- Agent filter: optional per-agent allowlist; empty = all of owner’s agents.

Full setup: [TELEGRAM.md](./TELEGRAM.md).

---

## 6. Bounty pool (detailed)

| Item | Detail |
|------|--------|
| Funding | **50%** of every research fee, deploy fee, and tick fee |
| Eligibility | Weighted by fee interactions credited to the user |
| Draw | After **20** fee interactions (pool threshold) — one weighted winner |
| Claim | Winner calls **`claimPayout()`** (pull) — not auto-sent |
| UI | Banner shows pool / last winner when available |

---

## 7. Security model (detailed)

| Area | Control |
|------|---------|
| Research | Claim signature · settle-before-reveal · AES sealed blob · `REPORT_SEAL_SECRET` |
| Research API | Rate limit · payment tx / researchId check · promptHash match |
| Cron | **Bearer CRON_SECRET only** · health does not leak secrets unauthenticated |
| Auto-wake | Owner-scoped · rate-limited · due-only (no open full-registry gas grief) |
| Telegram | Webhook secret · HMAC links · no chat hijack · no secrets in DMs |
| Surf | Host allowlist (SSRF) · no raw upstream dump to browser |
| HTTP | CSP · frame deny · nosniff · API `no-store` |
| Errors | `publicErrorMessage` redacts keys / long stacks |

**Never** put private keys or bot tokens in `NEXT_PUBLIC_*`.

---

## 8. API surface (detailed)

| Route | Method | Role | Auth |
|-------|--------|------|------|
| `/api/research` | POST | Pay-verify + Surf → sealed report | Wallet claim sig + payment / researchId |
| `/api/research/reveal` | POST | After settle → plaintext + optional TG research DM | Wallet claim sig |
| `/api/agent/data` | GET/POST | Surf Data snapshot for a kind/target | Rate-limited |
| `/api/agent/cron` | GET/POST | Keeper scan due agents + runTick | **Bearer CRON_SECRET** |
| `/api/agent/auto-wake` | GET/POST | Owner-scoped due ticks | Rate-limited + `owner` |
| `/api/agent/ticks` | GET | Tick history / cache read | Public (no secrets) |
| `/api/notify/telegram` | GET/POST | Link status / enable / actions | Rate-limited |
| `/api/notify/telegram/webhook` | POST | Bot updates (`/start`, …) | Telegram `secret_token` |
| `/api/notify/telegram/push` | POST | Browser-side tick DM helper | Rate-limited · no hijack |

Function durations (Vercel): research **300s**, cron **300s**, auto-wake **120s**, agent data **60s**.

---

## 9. Fee model (summary table)

| Event | Amount | Paid from | Split |
|-------|--------|-----------|--------|
| Research | **0.005** RIT | User wallet | 50 / 50 |
| Persistent deploy | **0.1** RIT | User wallet | 50 / 50 |
| Sovereign deploy | **0.01** RIT | User wallet | 50 / 50 |
| Agent tick | **0.005** RIT | **Agent balance** | 50 / 50 |
| Gas | variable | User wallet or **keeper** | — |

---

## 10. Local development

```bash
cd ritual-research
cp .env.example .env.local
# SURF_API_KEY=...  from https://agents.asksurf.ai
npm install
npm run dev
# → http://localhost:3000
```

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |
| `cd contracts && forge test` | Solidity tests |

---

## 11. Environment variables

### Server-only

| Variable | Required | Purpose |
|----------|----------|---------|
| `SURF_API_KEY` | **Yes** | Surf API |
| `SURF_API_BASE_URL` | No | Default gateway `https://api.asksurf.ai/gateway/v1` |
| `SURF_MODEL` | No | Prefer `surf-1.5-instant` |
| `SURF_FETCH_TIMEOUT_MS` | No | Default **270000** |
| `CRON_SECRET` | Unattended | Bearer for `/api/agent/cron` |
| `KEEPER_PRIVATE_KEY` | Unattended | Gas for keeper `runTick` (fund with RIT) |
| `REPORT_SEAL_SECRET` | Recommended | Encrypt research until reveal |
| `TELEGRAM_BOT_TOKEN` | Optional | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Optional* | Webhook secret (*required on Vercel if bot on) |
| `UPSTASH_REDIS_REST_URL` | Multi-user TG | Shared wallet→chat store |
| `UPSTASH_REDIS_REST_TOKEN` | Multi-user TG | Shared store |

### Public (`NEXT_PUBLIC_*`)

| Variable | Example |
|----------|---------|
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | `rite_research_bot` (no `@`) |
| `NEXT_PUBLIC_CHAIN_ID` | `1979` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.ritualfoundation.org` |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://explorer.ritualfoundation.org` |
| `NEXT_PUBLIC_RESEARCH_FEE` | `0.005` |
| `NEXT_PUBLIC_RESEARCH_CONTRACT` | ResearchDesk |
| `NEXT_PUBLIC_RADAR_CONTRACT` | RadarAgent `0x50a3…` preferred |
| `NEXT_PUBLIC_BOUNTY_CONTRACT` | BountyPool |
| `NEXT_PUBLIC_FEE_RECIPIENT` | Treasury |
| `NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC` | `2` |

Full template: [`.env.example`](./.env.example)

---

## 12. Deploy on Vercel

1. Import [Arafat128/rite-research](https://github.com/Arafat128/rite-research)  
2. Framework **Next.js** · root = repo root  
3. Set Production env (Surf, contracts, optional keeper + Telegram + Upstash)  
4. Deploy → [live app](https://rite-mehidy-s-projects.vercel.app)  
5. Wallet on **Ritual Testnet (1979)** · faucet if needed  

Unattended 1m: [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md) · `scripts/setup-qstash-cron.mjs` or cron-job.org → `POST /api/agent/cron` + Bearer.

Contract upgrades live in `contracts/` and need a **fresh deploy** for on-chain changes — [DEPLOY.md](./DEPLOY.md).

---

## 13. Project layout

```
ritual-research/
├── src/
│   ├── app/                 # App Router + API routes
│   ├── components/          # Research, Agents, Records, Telegram, Bounty
│   └── lib/                 # Surf, security, seals, radar, telegram, keeper
├── contracts/               # Foundry (ResearchDesk, RadarAgent, BountyPool)
├── scripts/                 # setup-qstash-cron.mjs
├── .github/workflows/       # agent-keeper.yml (unattended backup)
├── vercel.json              # region, function maxDuration, daily cron
├── TELEGRAM.md
├── UNATTENDED_KEEPER.md
├── DEPLOY.md
└── README.md
```

---

## License

MIT
