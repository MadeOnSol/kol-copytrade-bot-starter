# KOL Copy-Trade Bot Starter (Solana, paper trading)

Watch **live smart-money (KOL) trades on Solana** and paper-trade them in real time: open a virtual position when a tracked KOL buys, close when they sell, track PnL from the market-cap multiple. ~300 lines, one dependency, runs in 5 minutes on a **free API key**.

Powered by the [MadeOnSol](https://madeonsol.com) KOL intelligence API — 1,000+ tracked KOL wallets, trades indexed with market cap at the exact moment of the swap.

> **Paper trading only.** MadeOnSol is a data API — it never executes trades, holds no funds, and neither does this starter. Fork it into whatever you want.

## Quickstart (5 minutes)

```bash
git clone https://github.com/madeonsol/kol-copytrade-bot-starter
cd kol-copytrade-bot-starter
npm install

# Free key (200 req/day, no payment): https://madeonsol.com/pricing
export MADEONSOL_API_KEY=msk_your_key_here

node index.mjs
```

You'll see something like:

```
MadeOnSol KOL paper-trader · key tier: BASIC · paper size 0.5 SOL · min KOL buy 1 SOL
Mode: REST polling every 480s (tier BASIC).
🟢 OPEN  $WIF   0.500 SOL @ MC $2.31M  (copying Ansem)
🟣 CLOSE $WIF   1.84x → +0.420 SOL  (Ansem exited)
   📊 realized +0.420 SOL · 1 closed · 3 open
```

## How it works

| Your key | Mode | Latency |
|---|---|---|
| **Free (BASIC)** | Polls `GET /kol/feed` at a rate-limit-safe interval | ~8 min |
| **PRO / ULTRA** | Real-time WebSocket (`kol:trades` channel) | **< 3 s from on-chain** |

The bot detects your tier automatically (`GET /me`) and picks the mode. Same engine, same logic — upgrading just makes it real-time and unlocks mark-to-market on open positions. Plans: [madeonsol.com/pricing](https://madeonsol.com/pricing).

## Configuration (env vars)

| Var | Default | What it does |
|---|---|---|
| `MADEONSOL_API_KEY` | — (required) | Your `msk_` API key |
| `PAPER_SOL` | `0.5` | Virtual SOL per position |
| `MIN_KOL_SOL` | `1` | Ignore KOL buys smaller than this |
| `FOLLOW_WALLETS` | *(all KOLs)* | Comma-separated wallet list to copy exclusively |
| `MAX_POSITIONS` | `10` | Max simultaneous open positions |
| `POLL_SECONDS` | `480` free / `60` PRO | Poll interval (polling mode) |
| `FORCE_POLL` | — | `1` = force REST mode even on PRO |
| `STATE_FILE` | `positions.json` | Where positions persist across restarts |

Pick KOLs to follow from the live leaderboard: [madeonsol.com/kol-tracker](https://madeonsol.com/kol-tracker) — or via `GET /kol/leaderboard`.

## Ideas to build on top

- Filter buys by KOL win rate (`kol_winrate_7d` is on every feed row) or by `deployer_tier`
- Gate entries on token risk: `GET /tokens/{mint}/risk` (PRO) — 0–100 rug score with auditable factors
- Multi-KOL confirmation: only enter when 2+ KOLs buy the same token (`GET /kol/coordination`)
- Wire the close events into a Telegram/Discord notifier

## Tests

```bash
MADEONSOL_API_KEY=msk_... node test.mjs
```

Unit tests for the engine (entry/exit/PnL math, filters) + live shape tests against the production API. WS test runs on PRO+ keys.

## API docs

Full REST + WebSocket reference: [madeonsol.com/api-docs](https://madeonsol.com/api-docs)

## License

MIT
