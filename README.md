# Rite — Ritual Research Desk

**Pay-per-prompt crypto research**, **Surf data agents**, **Telegram alerts**, and an **auto bounty pool** on **Ritual Testnet** (chain id `1979`).

| | |
|--|--|
| **Live app** | [https://rite-woad.vercel.app](https://rite-woad.vercel.app) |
| **GitHub** | [Arafat128/rite-research](https://github.com/Arafat128/rite-research) |
| **Author** | [@its_perseus_1](https://x.com/its_perseus_1) |

---

## What you can do

| Product | What it does | Cost (testnet RITUAL) |
|---------|----------------|------------------------|
| **Research** | Prompt → Surf AI report → seal on-chain → unlock | **0.005** per prompt |
| **Data agents** | Deploy a Radar agent, lock one Surf data stream, wake on a schedule | Deploy **0.1** Persistent / **0.01** Sovereign + **0.005**/tick |
| **Records** | On-chain research history for your wallet | Free to browse |
| **Bounty** | Half of fees fund a pool; claim after draws | Funded by fees |
| **Telegram** | Optional DMs for research unlocks & agent ticks | Free |

Fees always split **50% treasury / 50% BountyPool**.

### Agent classes (Rite Radar — data agents)

| Class | Deploy fee | Life |
|-------|------------|------|
| **Persistent** | **0.1** RIT | Does not die from tick count (best for schedules) |
| **Sovereign** | **0.01** RIT | Dies after **3** sealed ticks |

> These are **Rite Radar data agents** (Surf streams + `runTick`). They are **not** Ritual chain TEE agents (`0x0820` / `0x080C`). Official TEE “Ritual AI agents” are **coming soon** and locked in the app for this release.

### Data streams

Token price · Fear & Greed · Crypto news · Stablecoin peg · Gas (ETH / POL / Ritual / L2s) · Whale / market stress · Ritual network pulse  

---

## Quick start (users)

1. Open the [live app](https://rite-woad.vercel.app).  
2. Install **MetaMask** (or another injected wallet) and switch to **Ritual Testnet (1979)**.  
3. Get testnet **RITUAL** for fees + gas.  
4. **Research** — write a prompt, pay, confirm seal, read the report.  
5. **Deploy** — create a data agent, then **My Agents** → Activate → Fund → Wake.  
6. Optional: **Connect Telegram** for DMs after unlocks/ticks.  
7. If something fails, use **Copy error report** and DM [@its_perseus_1](https://x.com/its_perseus_1).

---

## App tabs

| Tab | Purpose |
|-----|---------|
| **Research** | Pay-per-prompt Surf research + on-chain seal |
| **Records** | Your on-chain research ledger |
| **Deploy** | Create **data agents** (Persistent / Sovereign) + lock one stream |
| **My Agents** | Activate, fund, schedule, Wake, kill/close, Telegram, auto-wake |
| **Bounty** | Pool size / last winner (draw after fee volume) |

---

## Live contracts (Ritual Testnet)

| Contract | Address |
|----------|---------|
| ResearchDesk | [`0xd3469a23b2a08b237bc6c0522845eb1b508e5352`](https://explorer.ritualfoundation.org/address/0xd3469a23b2a08b237bc6c0522845eb1b508e5352) |
| RadarAgent | [`0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f`](https://explorer.ritualfoundation.org/address/0x50a3fb54aa1289546a0be2d6b29d689bb2dd5f6f) (`killAgent` capable) |
| BountyPool | [`0xbc4bc83298950cbda52837cd806d41ad7c3c36bf`](https://explorer.ritualfoundation.org/address/0xbc4bc83298950cbda52837cd806d41ad7c3c36bf) |
| Treasury | `0xd3309Bf2E2D1F451132dbC34Dc5908C442903458` |

Explorer: [explorer.ritualfoundation.org](https://explorer.ritualfoundation.org)

---

## Stack

Next.js 14 · wagmi / viem · Surf API · Foundry · Vercel · Upstash (optional Telegram multi-user) · GitHub Actions / QStash (optional unattended ticks)

---

## Operator docs

| Doc | For |
|-----|-----|
| [DEPLOY.md](./DEPLOY.md) | Contracts + Vercel env |
| [TELEGRAM.md](./TELEGRAM.md) | Bot + webhook + Upstash |
| [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md) | Keeper key + cron for auto ticks |

**Required for research + agents:** `SURF_API_KEY`, `NEXT_PUBLIC_RADAR_CONTRACT`, `NEXT_PUBLIC_RESEARCH_CONTRACT`, `NEXT_PUBLIC_BOUNTY_CONTRACT`, RPC/chain public vars.  
**For auto-wake / cron:** `KEEPER_PRIVATE_KEY`, `CRON_SECRET`.  
**For Telegram:** bot token + webhook secret (+ Upstash for multi-instance).

---

# Detailed application breakdown

## 1. Architecture

```
Browser (AppShell)
  │  wagmi / MetaMask · Ritual 1979
  ├─ Research ──► ResearchDesk + /api/research + /api/research/reveal
  ├─ Records  ──► ResearchDesk reads
  ├─ Deploy / My Agents ──► RadarAgent + /api/agent/*  (data agents only)
  ├─ Bounty ──► BountyPool
  └─ Telegram ──► /api/notify/telegram* (+ Upstash)

Server (Vercel)
  ├─ Surf Responses / Data API
  ├─ Keeper (auto-wake + cron) → runTick + optional Telegram
  └─ Report seal (AES) until settle + reveal
```

**Rules**

- User wallet pays research fees, deploy fees, and gas for manual txs.  
- Agent balance pays tick fees (**0.005** RIT per `runTick`).  
- Keeper pays gas only for auto-wake / cron ticks.  
- Research plaintext is never shown until on-chain settle + reveal.  
- Telegram never receives secrets.

---

## 2. Research flow

### Happy path

1. Connect wallet on Ritual **1979**.  
2. `payForResearch(promptHash)` with **0.005** RIT.  
3. Server runs Surf (default instant, ~270s timeout).  
4. Report encrypted → user `settleResearch(researchId, resultHash)`.  
5. Reveal markdown after settle.  
6. Optional Telegram research DM.

### Claim free report

If payment succeeded but Surf timed out: use **Paid credits** + same prompt — no second fee.

### Limits

| Limit | Value |
|-------|--------|
| Surf abort | ~270s (`SURF_FETCH_TIMEOUT_MS`) |
| Vercel function max | 300s |
| Default model | `surf-1.5-instant` (`SURF_MODEL`) |

---

## 3. Data agent flow

### Deploy

1. Choose **Persistent** or **Sovereign**.  
2. Choose **one** stream + target if needed.  
3. `createAgent` + deploy fee (+ optional fund).  
4. `setWatchlist` — **max 48 bytes** per cell (`kind|target`).  
5. Agent starts **Paused** → manage in **My Agents**.

### Activate · fund · schedule · wake

| Action | Meaning |
|--------|---------|
| **Activate** | Status → LIVE |
| **Fund** | Agent balance for tick fees |
| **Schedule** | On-chain wake interval (blocks) |
| **Wake** | Surf Data API → `runTick(digest)` → table + history |

### Life

| | |
|--|--|
| Tick fee | 0.005 RIT from agent balance |
| Sovereign | Dead after **3** ticks |
| Persistent | Unlimited by tick count |
| Kill | `killAgent` on Radar `0x50a3…` |

### Streams

| Id | Label |
|----|--------|
| `market_price` | Token price |
| `fear_greed` | Fear & Greed |
| `news_feed` | Crypto news |
| `stablecoin_peg` | Stablecoin peg (multi-source) |
| `gas_fees` | Gas / fees (ETH, POL, Ritual, Base, Arb, …) |
| `whale_transfers` | Whale / perp market stress |
| `ritual_network` | Ritual network pulse (heartbeat TEE agents) |

---

## 4. Auto-wake

Agents do **not** tick alone.

| Mode | How |
|------|-----|
| **My Agents open** | Client polls `/api/agent/auto-wake` ~20s |
| **Unattended** | GitHub Actions / QStash → `/api/agent/cron` with `CRON_SECRET` |

Prefer **Persistent** for long unattended runs. See [UNATTENDED_KEEPER.md](./UNATTENDED_KEEPER.md).

---

## 5. Telegram

1. **Connect Telegram** in the app (wallet-bound link).  
2. DMs: **Agent tick** after seals · **Research report** after unlock.  
3. Production needs webhook secret + bot token; Upstash recommended on Vercel.

See [TELEGRAM.md](./TELEGRAM.md).

---

## 6. Bounty pool

- **50%** of research, deploy, and tick fees → BountyPool.  
- Draw cadence: after fee-volume threshold (see app banner).  
- Users claim via wallet when eligible.

---

## 7. Roadmap (not in this release)

| Item | Status |
|------|--------|
| **Ritual AI agents** (official TEE Persistent `0x0820` / Sovereign `0x080C`) | **Coming soon** — UI locked |
| Rite Radar data agents | **Live** |

---

## Support

- In-app **Copy error report** (code + safe detail).  
- Contact: [@its_perseus_1](https://x.com/its_perseus_1) on X.

---

## License / disclaimer

Ritual **testnet** software. Fees and contracts may change. Use at your own risk. Not financial advice.
