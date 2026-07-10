# Rite

**Pay-per-prompt crypto research**, **Surf Data agents**, and an **auto bounty pool** on **Ritual testnet** (chain id `1979`).

Built by [mehidy](https://x.com/its_perseus_1) · [@its_perseus_1](https://x.com/its_perseus_1)

---

## What is Rite?

| Product | User pays | Off-chain | On-chain seal |
|---------|-----------|-----------|----------------|
| **Research** | 0.005 RITUAL per prompt | Surf **Responses** report | `payForResearch` → `settleResearch` |
| **Data agents** | Deploy fee + 0.005 RIT per tick | Surf **Data API** (one stream per agent) | `runTick` digests |
| **Bounty** | — (funded by fees) | — | 50% of fees → pool → pull claim |

Fees always split **50% treasury / 50% BountyPool**.

---

## App tabs

| Tab | Purpose |
|-----|---------|
| **Research** | Connect wallet → prompt → pay → **sign claim** → Surf runs → **seal** → **reveal** report |
| **Records** | On-chain research ledger for the connected wallet |
| **Agents** | Deploy **Persistent** or **Sovereign** agents, schedule wakes, fund/withdraw, kill/close |
| **Bounty** | Live pool / last winner banner (weighted lottery after **20** fee interactions) |

### Research flow (security)

1. `payForResearch(promptHash)` on ResearchDesk  
2. Wallet **signs** a claim message (`researchId` + `promptHash` + nonce + expiry)  
3. `POST /api/research` → returns **`resultHash` + encrypted `sealedReport`** (no plaintext)  
4. `settleResearch(id, resultHash)` on-chain  
5. `POST /api/research/reveal` (signature + sealed blob) → plaintext markdown report  

### Agent types

| Class | Deploy fee | Life |
|-------|------------|------|
| **Persistent** | **0.1** RIT | Never dies from tick count |
| **Sovereign** | **0.01** RIT | Dies after **3** ticks |

- Tick fee: **0.005** RIT from **agent balance** (not wallet)  
- Gas for txs: from **wallet**  
- Streams (locked at deploy): price, fear & greed, news, perp funding, social mindshare  
- **DEAD / CLOSED** agents show a compact card (residual withdraw only)  

### Auto-wake (optional)

- Vercel Cron hits `GET/POST /api/agent/cron` with  
  **`Authorization: Bearer <CRON_SECRET>`** only  
- Hobby plan: native cron is **daily** (`0 0 * * *` in `vercel.json`)  
- For frequent wakes: external cron (e.g. cron-job.org) with the same Bearer header  
- Keeper wallet needs gas (`KEEPER_PRIVATE_KEY`); tick fee still comes from agent balance  
- On **new** Radar builds: call `setKeeper(keeper, true)` so the bot can tick  
- Older Radar without `killAgent`: UI **soft-closes** (withdraw all + pause)  

---

## Live contracts (Ritual testnet · 1979)

| Contract | Address | Notes |
|----------|---------|--------|
| **ResearchDesk** | [`0xd3469a23b2a08b237bc6c0522845eb1b508e5352`](https://explorer.ritualfoundation.org/address/0xd3469a23b2a08b237bc6c0522845eb1b508e5352) | Research pay + settle |
| **RadarAgent** | [`0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f`](https://explorer.ritualfoundation.org/address/0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f) | Preferred (includes `killAgent`) |
| **RadarAgent (legacy)** | `0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30` | No `killAgent` — app soft-closes |
| **BountyPool** | [`0xbc4bc83298950cbda52837cd806d41ad7c3c36bf`](https://explorer.ritualfoundation.org/address/0xbc4bc83298950cbda52837cd806d41ad7c3c36bf) | 50% fees · auto-draw @ 20 · **pull** `claimPayout` |
| **Treasury** | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` | 50% of fees |

> **Security contract upgrades** (locked `runTick`, bounty pull payments, etc.) live in `contracts/` and need a **fresh deploy** to take effect on-chain. The addresses above are the currently wired testnet deployments; redeploy if you ship new bytecode.

More deploy notes: [DEPLOY.md](./DEPLOY.md)

---

## Stack

| Layer | Choice |
|-------|--------|
| App | **Next.js 14** (App Router) · TypeScript · Tailwind |
| Wallet | **wagmi** + **viem** · injected MetaMask |
| AI research | Surf **`/responses`** (`surf-1.5-instant` recommended) |
| Agent data | Surf **Data API** (not Chat) |
| Contracts | **Foundry** (`contracts/`) · Solidity 0.8.24 |
| Hosting | **Vercel** (`vercel.json` · region `iad1`) |

---

## Latest build highlights

| Area | Behavior |
|------|----------|
| Research | Settle-before-reveal · wallet signature · sealed report blob · idempotent Surf per `researchId` |
| Agents | Owner/keeper-only `runTick` (source) · wake interval · explicit gas for Ritual MetaMask · compact DEAD/CLOSED UI |
| Cron | Bearer secret only · no public health config leak |
| Bounty | Pull-payment `claimPayout` · improved lottery entropy (still not VRF) |
| UX | Ritual timestamps treated as **ms** for schedules · soft-close on legacy Radar |

**Recent app commit:** `891fe06` — security: lock runTick, settle-before-reveal, harden cron, bounty pull payout  

---

## Local development

```bash
# 1. Clone & install
cd ritual-research
cp .env.example .env.local
npm install

# 2. Set at least:
#    SURF_API_KEY=...          (https://agents.asksurf.ai)
#    Contract addresses are prefilled for Ritual testnet

# 3. Run
npm run dev
# → http://localhost:3000
```

### Useful scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run start` | Serve production build |
| `npm run lint` | ESLint |
| `cd contracts && forge test` | Solidity tests |

---

## Environment variables

### Server-only (never `NEXT_PUBLIC_`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SURF_API_KEY` | **Yes** | Surf API |
| `SURF_API_BASE_URL` | No | Default `https://api.asksurf.ai/gateway/v1` |
| `SURF_MODEL` | No | Prefer `surf-1.5-instant` on Vercel |
| `CRON_SECRET` | For auto-wake | Cron auth: `Authorization: Bearer …` only |
| `KEEPER_PRIVATE_KEY` | For auto-wake | Gas wallet for keeper ticks |
| `REPORT_SEAL_SECRET` | Recommended | Encrypts research until reveal (falls back to cron/Surf secrets) |

### Public (browser)

| Variable | Example / default |
|----------|-------------------|
| `NEXT_PUBLIC_CHAIN_ID` | `1979` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.ritualfoundation.org` |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://explorer.ritualfoundation.org` |
| `NEXT_PUBLIC_RESEARCH_FEE` | `0.005` |
| `NEXT_PUBLIC_RESEARCH_CONTRACT` | ResearchDesk address |
| `NEXT_PUBLIC_RADAR_CONTRACT` | RadarAgent address |
| `NEXT_PUBLIC_BOUNTY_CONTRACT` | BountyPool address |
| `NEXT_PUBLIC_FEE_RECIPIENT` | Treasury address |
| `NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC` | `2` (schedule UI estimate) |

Full template: [`.env.example`](./.env.example)

---

## Deploy on Vercel

1. Push this repo to GitHub  
2. [vercel.com](https://vercel.com) → **Add New Project** → import  
3. Framework: **Next.js** · Root: repository root  
4. Set **Production** (and Preview if needed) env vars:

```env
SURF_API_KEY=sk-surf-...
SURF_API_BASE_URL=https://api.asksurf.ai/gateway/v1
SURF_MODEL=surf-1.5-instant

CRON_SECRET=long-random-string
# KEEPER_PRIVATE_KEY=0x...          # optional auto-wake
# REPORT_SEAL_SECRET=long-random    # recommended

NEXT_PUBLIC_CHAIN_ID=1979
NEXT_PUBLIC_RPC_URL=https://rpc.ritualfoundation.org
NEXT_PUBLIC_EXPLORER_URL=https://explorer.ritualfoundation.org
NEXT_PUBLIC_RESEARCH_FEE=0.005
NEXT_PUBLIC_RESEARCH_CONTRACT=0xd3469a23b2a08b237bc6c0522845eb1b508e5352
NEXT_PUBLIC_RADAR_CONTRACT=0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f
NEXT_PUBLIC_BOUNTY_CONTRACT=0xbc4bc83298950cbda52837cd806d41ad7c3c36bf
NEXT_PUBLIC_FEE_RECIPIENT=0xd3309Bf2E2D1F451132dbC34Dc5908C442903458
```

5. Deploy → connect wallet on **Ritual Testnet (1979)**  

**Never** put `SURF_API_KEY`, `KEEPER_PRIVATE_KEY`, `CRON_SECRET`, or `PRIVATE_KEY` in `NEXT_PUBLIC_*`.

### Cron (optional)

- Path: `/api/agent/cron`  
- Schedule in repo: **daily** (`0 0 * * *`) for Hobby compatibility  
- Auth: header only — `Authorization: Bearer <CRON_SECRET>`  
- If Deployment Protection is on, allow automation bypass or disable for Production  

---

## Contracts (Foundry)

```bash
cd contracts
forge test
# Deploy (needs PRIVATE_KEY + FEE_RECIPIENT_ADDRESS + bounty address in env)
# forge script script/DeployAll.s.sol --rpc-url $RITUAL_RPC_URL --broadcast
```

Sources:

- `contracts/src/ResearchDesk.sol` — pay + settle ledger  
- `contracts/src/RadarAgent.sol` — agents, ticks, kill, keepers  
- `contracts/src/BountyPool.sol` — fee credits, lottery, `claimPayout`  

---

## API surface (server)

| Route | Role |
|-------|------|
| `POST /api/research` | Paid research → sealed report + `resultHash` |
| `POST /api/research/reveal` | After settle → plaintext report |
| `POST /api/agent/data` | Surf Data API for agent wakes |
| `GET/POST /api/agent/cron` | Keeper auto-wake (Bearer auth) |
| `GET /api/agent/ticks` | On-chain + cache tick history |

---

## Fee model

| Event | Fee | Split |
|-------|-----|--------|
| Research payment | 0.005 RIT | 50 / 50 |
| Persistent deploy | 0.1 RIT | 50 / 50 |
| Sovereign deploy | 0.01 RIT | 50 / 50 |
| Agent tick | 0.005 RIT from agent balance | 50 / 50 |

Bounty: after **20** fee interactions in a round, one **weighted** winner is selected; they call **`claimPayout()`** to withdraw.

---

## Project layout

```
ritual-research/
├── src/
│   ├── app/                 # Next.js App Router + API routes
│   ├── components/          # Research, Agents, Records, Bounty UI
│   └── lib/                 # Surf, security, seals, radar, wagmi
├── contracts/               # Foundry sources + tests
├── public/
├── vercel.json
├── .env.example
├── DEPLOY.md
└── README.md
```

---

## License

MIT
