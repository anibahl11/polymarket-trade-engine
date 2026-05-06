# polymarket-trade-engine

Automated trading engine for Polymarket binary prediction markets (e.g. BTC Up/Down 5-minute), with a strategy test harness, performance database, and live dashboard.

- [**GUIDE.md**](docs/GUIDE.md) — Strategy development guide covering CLI, configuration, architecture, strategy API, dashboard, and risk gates.
- [**LEARNING.md**](docs/LEARNING.md) — Introduction to prediction markets, order books, bids, asks, and how Polymarket works.
- [**INDICATORS.md**](docs/INDICATORS.md) — Technical indicator reference (RSI, ATR, RTV, PGR, OFI, PriceWindow).

If you are unfamiliar with terms like order books, bids, asks, or prediction markets, start with [LEARNING.md](docs/LEARNING.md). Then follow [GUIDE.md](docs/GUIDE.md) for a complete walkthrough on developing and testing your own strategy.

---

## Supported Markets

- **BTC, ETH, XRP, SOL, DOGE** — 5-minute and 15-minute prediction windows

## Strategies

Six strategies ship with the engine. All run in simulation by default. Strategies marked **Sim only** include a production guard that blocks execution with real funds.

| Strategy | Flag | Version | Description |
|----------|------|---------|-------------|
| Simulation | `simulation` | 1.0.0 | Minimal reference. Buys at 0.49, sells at 0.70, emergency exits before close. Sim only. |
| Late Entry | `late-entry` | 1.0.0 | Indicator-driven entry (ATR, gap safety, divergence, PGR). Waits for confirmation before committing. |
| Momentum Imbalance | `momentum-imbalance` | 1.0.0 | Combines spot momentum, order-book imbalance, and liquidity checks with a mean-reversion fallback. |
| BTC Gap Fade | `btc-gap-fade` | 1.1.0 | Gap mean-reversion. Buys the losing token when a hard open move fades toward the reference price. Sim only. |
| Passive Maker | `passive-maker` | — | Passive market-making with configurable resting-order parameters. |
| Multi-Level OFI | `multi-level-ofi` | 1.1.0 | Multi-level order flow imbalance + BTC dislocation gate. Fee-safe zone enforcement. Sim only. |

```bash
# Run a strategy for 10 rounds in simulation
bun run index.ts --strategy btc-gap-fade --rounds 10

# Start the performance dashboard
bun dashboard/server.ts
```

## Quick Start

```bash
# Clone and install
git clone <repo>
cd polymarket-trade-engine
bun install

# Run the simulation strategy (default)
bun run index.ts --rounds 10

# Run a specific strategy
bun run index.ts --strategy btc-gap-fade --rounds 5

# Run the live dashboard (http://localhost:3000)
bun dashboard/server.ts

# Type-check the entire project
bun run check
```

## Dashboard

The dashboard (`bun dashboard/server.ts`) opens at `http://localhost:3000` and provides:

- **Live tab** — real-time session PnL, active markets, engine statuses, completed round feed
- **Projections tab** — Monte Carlo fan chart (p10/p50/p90) over 1d → 3y, Kelly fraction, break-even win rate
- **Rounds tab** — paginated trade history with filtering by strategy and outcome, detail modal with entry reason
- **Config tab** — live `.env` editor (whitelisted keys only, saved to disk)

The dashboard can start and stop per-strategy engine processes and reads a shared SQLite performance database (`state/performance.db`).

## Architecture

```
index.ts          CLI entry point. Parses flags, resolves safety mode, starts EarlyBird.
engine/
  early-bird.ts   Top-level bot. Manages market lifecycles, session PnL, safety gates.
  market-lifecycle.ts  Single market round: INIT → RUNNING → STOPPING → DONE.
  client.ts       CLOB client abstraction (live + sim with realistic fills/slippage).
  state.ts        Atomic JSON state persistence and recovery types.
  safety.ts       Safety mode resolution, startup banners, defense-in-depth assertions.
  db-hooks.ts     Performance DB recording hooks (opt-in via PERF_DB=true).
  strategy/       Strategy registry and all strategy implementations.
tracker/
  ticker.ts       BTC/crypto price ticker (Binance, Coinbase, Polymarket).
  orderbook.ts    WebSocket order book subscription.
  api-queue.ts    Polymarket REST API queue with caching.
db/
  schema.ts       SQLite schema and migrations.
  reader.ts       Read-only query helpers for the dashboard.
  writer.ts       Write operations called by db-hooks.ts.
dashboard/
  server.ts       Bun HTTP server, engine process manager, Monte Carlo simulator.
  index.html      Alpine.js dashboard UI with Chart.js charts.
utils/            Config, slot timing, reconnecting WebSocket, process locks, etc.
scripts/          Maintenance scripts: redeem, chart visualizer, order book monitor, pUSD wrap.
```

## Risk Gates

| Gate | Env Var | Default | Behaviour |
|------|---------|---------|-----------|
| Session loss limit | `MAX_SESSION_LOSS` | `$3` | Shuts down when cumulative losses reach this threshold |
| Max drawdown | `MAX_DRAWDOWN_PCT` | `20%` | Shuts down when bankroll drops by this percentage from start |
| Daily loss limit | `DAILY_LOSS_LIMIT` | `$0` (off) | Shuts down when daily losses reach this amount (resets at UTC midnight) |
| Max position size | `MAX_POSITION_PCT` | `5%` | Blocks any single order that would exceed this fraction of the wallet |

## Performance Database

Set `PERF_DB=true` to enable recording. The dashboard reads `state/performance.db` (SQLite, WAL mode) in readonly mode. Tables:

| Table | Contents |
|-------|----------|
| `strategies` | Version registry keyed by `name@version` |
| `sessions` | One row per engine run with PnL and wallet snapshots |
| `rounds` | One row per 5-minute market with full trade metadata |
| `ticks` | Optional per-second tick snapshots (opt-in via `PERF_RECORD_TICKS=true`) |

## Simulation Realism

Paper trading can be configured to mirror live conditions:

| Var | Default | Description |
|-----|---------|-------------|
| `SIM_PARTIAL_FILL_PROB` | `0` | Probability (0–1) of a partial fill |
| `SIM_SLIPPAGE_BPS` | `0` | Slippage in basis points (0–500) |
| `SIM_LATENCY_JITTER_MS` | `0` | Random order latency in ms (0–2000) |
| `SIM_NETWORK_FAIL_PROB` | `0` | Probability (0–0.5) of an order rejection |

## Production

Production places real orders with real funds. See [GUIDE.md → Production Setup](docs/GUIDE.md#production-setup) for the full checklist including wallet setup, Builder API credentials, pUSD wrapping, and the `PRIVATE_KEY` / `POLY_FUNDER_ADDRESS` configuration.

```bash
PRIVATE_KEY=0x... bun run index.ts --strategy <your-strategy> --prod
```

## Why TypeScript?

5-minute markets have thin liquidity (≤150k USDC per side) and all interactions go through standard REST/WebSocket APIs over a CLOB — not FIX or low-latency protocols. TypeScript and Python are valid choices at this scale, and TypeScript is what this project is written in. The engine is not slow because of the language.

## License

MIT
