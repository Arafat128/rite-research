# Deploy checklist (Vercel + Ritual)

## 1. Env for Vercel

Copy from `.env.example` into Vercel Project → Settings → Environment Variables:

| Name | Where | Notes |
|------|--------|--------|
| `SURF_API_KEY` | Server only | From https://agents.asksurf.ai |
| `SURF_API_BASE_URL` | Server | Default `https://api.asksurf.ai/gateway/v1` |
| `SURF_MODEL` | Server | `surf-1.5` (2.0 stack model family) |
| `NEXT_PUBLIC_CHAIN_ID` | Public | `1979` |
| `NEXT_PUBLIC_RPC_URL` | Public | `https://rpc.ritualfoundation.org` |
| `NEXT_PUBLIC_EXPLORER_URL` | Public | `https://explorer.ritualfoundation.org` |
| `NEXT_PUBLIC_RESEARCH_FEE` | Public | `0.005` |
| `NEXT_PUBLIC_RESEARCH_CONTRACT` | Public | Live: `0xd3469a23b2a08b237bc6c0522845eb1b508e5352` |
| `NEXT_PUBLIC_RADAR_CONTRACT` | Public | Live: `0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30` |
| `NEXT_PUBLIC_BOUNTY_CONTRACT` | Public | Live: `0xbc4bc83298950cbda52837cd806d41ad7c3c36bf` |
| `NEXT_PUBLIC_FEE_RECIPIENT` | Public | Your treasury wallet (50% of fees) |
| `FEE_RECIPIENT_ADDRESS` | Server/deploy | Same as treasury |

Do **not** set `PRIVATE_KEY` on Vercel.

## 2. Live contracts (testnet)

### ResearchDesk (pay-per-prompt)

| | |
|--|--|
| Address | `0xd3469a23b2a08b237bc6c0522845eb1b508e5352` |
| Fee | 0.005 RITUAL (**50% treasury / 50% bounty**) |
| Treasury | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` |
| Explorer | https://explorer.ritualfoundation.org/address/0xd3469a23b2a08b237bc6c0522845eb1b508e5352 |

### RadarAgent (persistent + sovereign data agents)

| | |
|--|--|
| Address | `0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30` |
| Persistent deploy fee | **0.1 RITUAL** (never dies) · 50/50 split |
| Sovereign deploy fee | **0.01 RITUAL** (dies after **3** ticks) · 50/50 split |
| Run fee | 0.005 RITUAL per tick · 50/50 split |
| Explorer | https://explorer.ritualfoundation.org/address/0x5ed8c4179f5cd798126ea3d0fa75b43c4a9beb30 |

### BountyPool (auto bounty — one winner)

| | |
|--|--|
| Address | `0xbc4bc83298950cbda52837cd806d41ad7c3c36bf` |
| Share | **50%** of all research + agent fees |
| Trigger | **Auto-finalize at 20 interactions** (research pay / agent deploy / tick) |
| Winner | **One** random weighted winner takes full pool (no manual finalize needed) |
| Explorer | https://explorer.ritualfoundation.org/address/0xbc4bc83298950cbda52837cd806d41ad7c3c36bf |

## 3. Local

```bash
npm run dev
# http://localhost:3010  (or 3000)
```

Put `SURF_API_KEY` in `.env.local` before researching.

## 4. Vercel

```bash
npx vercel
# or connect GitHub repo in dashboard
```

Framework preset: Next.js. Root: this folder.
