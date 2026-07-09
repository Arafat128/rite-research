# Rite — Ritual Research Desk

Pay-per-prompt **crypto research** + **Surf Data API agents** + **auto bounty** on **Ritual Chain** (1979).

Made with ♥ by [mehidy](https://x.com/its_perseus_1) · [@its_perseus_1](https://x.com/its_perseus_1)

## Features

| Tab | What it does |
|-----|----------------|
| **Research** | Pay **0.005 RIT** → Surf **Responses** research report (markdown tables) → seal hash on-chain |
| **Records** | On-chain research ledger |
| **Agent** | **Persistent** (0.1 deploy) / **Sovereign** (0.01 deploy, dies after 3 ticks) — Surf **Data API** only |
| **Bounty** | **50%** of all fees → pool · auto-draw **1 winner** at **20 interactions** · banner + payout tx |

## Live contracts (Ritual testnet 1979)

| Contract | Address |
|----------|---------|
| ResearchDesk | `0xd3469a23b2a08b237bc6c0522845eb1b508e5352` |
| RadarAgent | `0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f` |
| BountyPool | `0xbc4bc83298950cbda52837cd806d41ad7c3c36bf` |
| Fee treasury (50%) | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` |

See [DEPLOY.md](./DEPLOY.md) for full deploy notes.

## Stack

- Next.js 14 (App Router) · TypeScript · Tailwind · wagmi/viem
- Surf: Research = `/responses` · Agents = **Data API**
- Foundry contracts in `contracts/`

## Local setup

```bash
cp .env.example .env.local
# Required: SURF_API_KEY  (https://agents.asksurf.ai)
# Public contract addresses are pre-filled in .env.example

npm install
npm run dev
# http://localhost:3000 (or 3010)
```

### Server env (never `NEXT_PUBLIC_`)

| Variable | Notes |
|----------|--------|
| `SURF_API_KEY` | **Required** on Vercel |
| `SURF_API_BASE_URL` | Default `https://api.asksurf.ai/gateway/v1` |
| `SURF_MODEL` | `surf-1.5` (research) |

### Public env

| Variable | Notes |
|----------|--------|
| `NEXT_PUBLIC_CHAIN_ID` | `1979` |
| `NEXT_PUBLIC_RPC_URL` | Ritual RPC |
| `NEXT_PUBLIC_EXPLORER_URL` | Explorer |
| `NEXT_PUBLIC_RESEARCH_FEE` | `0.005` |
| `NEXT_PUBLIC_RESEARCH_CONTRACT` | ResearchDesk |
| `NEXT_PUBLIC_RADAR_CONTRACT` | RadarAgent |
| `NEXT_PUBLIC_BOUNTY_CONTRACT` | BountyPool |
| `NEXT_PUBLIC_FEE_RECIPIENT` | Treasury wallet |

## Deploy on Vercel

1. Push this repo to GitHub
2. [vercel.com](https://vercel.com) → **Add New Project** → import the repo
3. Framework: **Next.js** · Root: repo root
4. **Environment variables** (Production + Preview):

```
SURF_API_KEY=sk-surf-...
SURF_API_BASE_URL=https://api.asksurf.ai/gateway/v1
SURF_MODEL=surf-1.5
NEXT_PUBLIC_CHAIN_ID=1979
NEXT_PUBLIC_RPC_URL=https://rpc.ritualfoundation.org
NEXT_PUBLIC_EXPLORER_URL=https://explorer.ritualfoundation.org
NEXT_PUBLIC_RESEARCH_FEE=0.005
NEXT_PUBLIC_RESEARCH_CONTRACT=0xd3469a23b2a08b237bc6c0522845eb1b508e5352
NEXT_PUBLIC_RADAR_CONTRACT=0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30
NEXT_PUBLIC_BOUNTY_CONTRACT=0xbc4bc83298950cbda52837cd806d41ad7c3c36bf
NEXT_PUBLIC_FEE_RECIPIENT=0xd3309Bf2E2D1F451132dbC34Dc5908C442903458
```

5. Deploy → open the URL → connect **Ritual (1979)** wallet

**Never** put `SURF_API_KEY` or `PRIVATE_KEY` in `NEXT_PUBLIC_*`.

## Fee split

Every research payment, agent deploy fee, and agent tick fee:

- **50%** → treasury  
- **50%** → BountyPool (auto winner at 20 interactions)

## License

MIT
