# Rite

**Pay-per-prompt crypto research** platform on **Ritual testnet**, **Surf Data Agents** on **Ritual testnet**, **Telegram tick alerts** and an **auto bounty pool** on **Ritual testnet** (chain id `1979`).

**Live app:** [https://rite-mehidy-s-projects.vercel.app](https://rite-mehidy-s-projects.vercel.app)

Built by [@its_perseus_1](https://x.com/its_perseus_1)

---

## What is Rite?

| Product | User pays | Off-chain | On-chain seal |
|---------|-----------|-----------|----------------|
| **Research** | 0.005 RITUAL per prompt | Surf **Responses** report | `payForResearch` → `settleResearch` |
| **Data agents** | Deploy fee + 0.005 RIT per tick | Surf **Data API** (one stream per agent) | `runTick` digests |
| **Bounty** | — (funded by fees) | — | 50% of fees → pool → pull claim |
| **Telegram** | Free | Bot DMs after a sealed tick | — |

Fees always split **50% treasury / 50% BountyPool**.

---

## App tabs

| Tab | Purpose |
|-----|---------|
| **Research** | Connect wallet → prompt → pay → **sign claim** → Surf runs → **seal** → **reveal** report |
| **Records** | On-chain research ledger for the connected wallet |
| **Deploy** | Create **Persistent** or **Sovereign** agents + lock one Data stream |
| **My Agents** | Activate, fund, schedule, manual **Wake**, kill/close, **Telegram**, auto-wake poll |
| **Bounty** | Live pool / last winner banner (weighted lottery after **20** fee interactions) |

### Research flow (security)

1. `payForResearch(promptHash)` on ResearchDesk  
2. Wallet **signs** a claim message (`researchId` + `promptHash` + nonce + expiry)  
3. `POST /api/research` → **`resultHash` + encrypted `sealedReport`** (no plaintext)  
4. `settleResearch(id, resultHash)` on-chain  
5. `POST /api/research/reveal` (signature + sealed blob) → plaintext markdown report  

### Agent types

| Class | Deploy fee | Life |
|-------|------------|------|
| **Persistent** | **0.1** RIT | Never dies from tick count — use for unattended schedules |
| **Sovereign** | **0.01** RIT | Dies after **3** ticks |

- Tick fee: **0.005** RIT from **agent balance** (not wallet)  
- Gas: from **wallet** (or keeper for auto-wake)  
- Streams (locked at deploy): token price, fear & greed, news, stablecoin peg, gas, whales, OI skew, narrative, Ritual network  


### Auto-wake (unattended)

| Path | Auth | Cadence |
|------|------|---------|
| **My Agents** open | Rate-limited `POST /api/agent/auto-wake` (owner-scoped) | ~every 20s while tab open |
| **Unattended** | `Authorization: Bearer <CRON_SECRET>` → `/api/agent/cron` | QStash / cron-job.org every **1m** (recommended) |
| Vercel Hobby cron | Bearer (platform injects if configured) | **Daily only** (`vercel.json`) |

Requirements:

- `KEEPER_PRIVATE_KEY` (gas) + `CRON_SECRET` + `SURF_API_KEY`  
- Agent **LIVE**, funded, schedule saved  
- Prefer **Persistent** for long unattended runs  
- Telegram multi-user store: **Upstash Redis** (`UPSTASH_REDIS_REST_*`) — users only **Connect Telegram** in the app  
- Guides: [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md) · [TELEGRAM.md](./TELEGRAM.md) · `scripts/setup-qstash-cron.mjs`

---

## Live deployment

| | |
|--|--|
| **Production** | [https://rite-mehidy-s-projects.vercel.app](https://rite-mehidy-s-projects.vercel.app) |
| **GitHub** | [Arafat128/rite-research](https://github.com/Arafat128/rite-research) |
| **Chain** | Ritual Testnet · id `1979` |

### Live contracts (Ritual testnet)

| Contract | Address | Notes |
|----------|---------|--------|
| **ResearchDesk** | [`0xd3469a23b2a08b237bc6c0522845eb1b508e5352`](https://explorer.ritualfoundation.org/address/0xd3469a23b2a08b237bc6c0522845eb1b508e5352) | Research pay + settle |
| **RadarAgent** | [`0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f`](https://explorer.ritualfoundation.org/address/0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f) | Preferred (`killAgent`) |
| **RadarAgent (legacy)** | `0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30` | No `killAgent` — UI soft-closes |
| **BountyPool** | [`0xbc4bc83298950cbda52837cd806d41ad7c3c36bf`](https://explorer.ritualfoundation.org/address/0xbc4bc83298950cbda52837cd806d41ad7c3c36bf) | 50% fees · auto-draw @ 20 · **pull** `claimPayout` |
| **Treasury** | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` | 50% of fees |

> Solidity upgrades live in `contracts/` and need a **fresh deploy** to change on-chain behavior. See [DEPLOY.md](./DEPLOY.md).

---

## Stack

| Layer | Choice |
|-------|--------|
| App | **Next.js 14** (App Router) · TypeScript · Tailwind |
| Wallet | **wagmi** + **viem** · injected MetaMask |
| AI research | Surf **`/responses`** (`surf-1.5-instant` recommended) |
| Agent data | Surf **Data API** |
| Telegram prefs | **Upstash Redis** (multi-user, multi-instance) |
| Unattended cron | GitHub Actions backup · **QStash** / cron-job.org for 1m |
| Contracts | **Foundry** · Solidity 0.8.24 |
| Hosting | **Vercel** (`iad1`) |

---

## Security (current)

| Control | Behavior |
|---------|----------|
| Research | Wallet claim signature · settle-before-reveal · sealed report blob |
| Cron | Bearer `CRON_SECRET` only · no public config leak on unauthenticated routes |
| Auto-wake | Owner-scoped · rate-limited · due-only ticks (no full-registry public scan) |
| Telegram webhook | `secret_token` required on Vercel · HMAC link tokens (start= safe alphabet) |
| Telegram prefs | No raw `chatId` on public GET · no chat hijack on register/push |
| Surf | Host allowlist (SSRF) · no raw upstream blob to browser |
| HTTP | CSP · `X-Frame-Options` · `nosniff` · API `no-store` |
| Errors | `publicErrorMessage` strips keys / long stacks |

**Never** put secrets in `NEXT_PUBLIC_*`.

---

## Local development

```bash
cd ritual-research
cp .env.example .env.local
# Set SURF_API_KEY=... (https://agents.asksurf.ai)
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

## Environment variables

### Server-only

| Variable | Required | Purpose |
|----------|----------|---------|
| `SURF_API_KEY` | **Yes** | Surf API |
| `SURF_API_BASE_URL` | No | Default `https://api.asksurf.ai/gateway/v1` |
| `SURF_MODEL` | No | Prefer `surf-1.5-instant` |
| `CRON_SECRET` | Auto-wake | Bearer auth for `/api/agent/cron` |
| `KEEPER_PRIVATE_KEY` | Auto-wake | Gas wallet for keeper `runTick` |
| `REPORT_SEAL_SECRET` | Recommended | Encrypt research until reveal |
| `TELEGRAM_BOT_TOKEN` | Optional | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Optional* | Webhook `secret_token` (*required on Vercel if bot enabled) |
| `UPSTASH_REDIS_REST_URL` | Multi-user TG | Shared link store |
| `UPSTASH_REDIS_REST_TOKEN` | Multi-user TG | Shared link store |

### Public

| Variable | Example |
|----------|---------|
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | `rite_research_bot` (no `@`) |
| `NEXT_PUBLIC_CHAIN_ID` | `1979` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.ritualfoundation.org` |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://explorer.ritualfoundation.org` |
| `NEXT_PUBLIC_RESEARCH_FEE` | `0.005` |
| `NEXT_PUBLIC_RESEARCH_CONTRACT` | ResearchDesk |
| `NEXT_PUBLIC_RADAR_CONTRACT` | RadarAgent (`0x50a3…` preferred) |
| `NEXT_PUBLIC_BOUNTY_CONTRACT` | BountyPool |
| `NEXT_PUBLIC_FEE_RECIPIENT` | Treasury |
| `NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC` | `2` |

Full template: [`.env.example`](./.env.example)

---

## Deploy on Vercel

1. Import [this repo](https://github.com/Arafat128/rite-research)  
2. Framework **Next.js** · root = repo root  
3. Set Production env (Surf, contracts, optional keeper + Telegram + Upstash)  
4. Deploy → open [https://rite-mehidy-s-projects.vercel.app](https://rite-mehidy-s-projects.vercel.app)  
5. Wallet on **Ritual Testnet (1979)**  

Optional unattended 1m: QStash (`node scripts/setup-qstash-cron.mjs`) or cron-job.org → `POST /api/agent/cron` with Bearer.

---

## API surface

| Route | Role | Auth |
|-------|------|------|
| `POST /api/research` | Paid research → sealed report | Wallet signature + payment |
| `POST /api/research/reveal` | After settle → plaintext | Wallet signature |
| `POST /api/agent/data` | Surf Data for wakes | Rate-limited |
| `GET/POST /api/agent/cron` | Keeper auto-wake | **Bearer CRON_SECRET** |
| `POST /api/agent/auto-wake` | In-app schedule poll | Owner-scoped · rate-limited |
| `GET /api/agent/ticks` | Tick history | Public read (no secrets) |
| `GET/POST /api/notify/telegram` | Link status / actions | Rate-limited |
| `POST /api/notify/telegram/webhook` | Telegram updates | `secret_token` header |
| `POST /api/notify/telegram/push` | Browser tick DM | Rate-limited · no chat hijack |

---

## Fee model

| Event | Fee | Split |
|-------|-----|--------|
| Research payment | 0.005 RIT | 50 / 50 |
| Persistent deploy | 0.1 RIT | 50 / 50 |
| Sovereign deploy | 0.01 RIT | 50 / 50 |
| Agent tick | 0.005 RIT from agent balance | 50 / 50 |

Bounty: after **20** fee interactions, one **weighted** winner; they call **`claimPayout()`**.

---

## Project layout

```
ritual-research/
├── src/
│   ├── app/                 # App Router + API routes
│   ├── components/          # Research, Agents, Records, Telegram, Bounty
│   └── lib/                 # Surf, security, seals, radar, telegram, keeper
├── contracts/               # Foundry
├── scripts/                 # setup-qstash-cron.mjs
├── .github/workflows/       # agent-keeper.yml (backup unattended)
├── vercel.json
├── TELEGRAM.md
├── UNATTENDED_KEEPER.md
├── DEPLOY.md
└── README.md
```

---

## License

MIT
