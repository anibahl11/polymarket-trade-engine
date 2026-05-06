# Polymarket Trade Engine — Strategy Development Guide

This document is the primary reference for developing strategies on the Polymarket binary prediction market trading engine. It covers the CLI interface, configuration, engine architecture, the strategy API, the performance dashboard, and best practices.

> **Upgrading from an engine that uses clob-client v1?** See the [v2 Migration Guide](MIGRATE_V2.md) for the one-time USDC.e → pUSD wrap step required before running the engine.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [CLI Reference](#cli-reference)
4. [Configuration](#configuration)
5. [Engine Architecture](#engine-architecture)
6. [Market Structure](#market-structure)
7. [Included Strategies](#included-strategies)
8. [Strategy Interface](#strategy-interface)
9. [StrategyContext API](#strategycontext-api)
10. [Order Lifecycle](#order-lifecycle)
11. [Utility Functions](#utility-functions)
12. [PnL Computation](#pnl-computation)
13. [State Persistence and Recovery](#state-persistence-and-recovery)
14. [Performance Dashboard](#performance-dashboard)
15. [Risk Gates](#risk-gates)
16. [Best Practices](#best-practices)
17. [Production Setup](#production-setup)
18. [Redemption](#redemption)
19. [Debugging and Visualization](#debugging-and-visualization)

---

## Overview

The engine trades binary prediction markets on Polymarket. Each market asks whether a crypto asset (BTC, ETH, XRP, SOL, or DOGE) will finish above or below a reference price (the "price to beat") at the end of a 5-minute or 15-minute window. The engine manages market discovery, order book subscriptions, order placement, fill tracking, and PnL accounting. Your job as a strategy author is to implement a single async function that decides what to buy, when to sell, and how to react to fills and expirations.

---

## Quick Start

```bash
# Simulation mode — 10 rounds with default strategy
bun run index.ts --rounds 10

# Simulation mode — specific strategy, enter 2 slots ahead
bun run index.ts --strategy btc-gap-fade --slot-offset 2 --rounds 10

# Start the performance dashboard
bun dashboard/server.ts

# Production mode — see the "Production Setup" section below
# PRIVATE_KEY=0x... bun run index.ts --strategy <your-strategy> --prod
```

---

## CLI Reference

```
bun run index.ts [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-s, --strategy <name>` | string | `simulation` | Strategy to run. See [Included Strategies](#included-strategies) for all options. |
| `--slot-offset <n>` | positive integer | `1` | Which future market slot to pre-enter. `1` = next slot, `2` = slot after that. |
| `--prod` | boolean flag | `false` | Run against the real Polymarket CLOB. Requires `PRIVATE_KEY`. Prompts for confirmation unless `FORCE_PROD=true`. |
| `--dry-run` | boolean flag | `false` | Force simulation mode regardless of `--prod` and `SIMULATION_MODE`. |
| `--rounds <n>` | integer | unlimited | Number of market rounds to trade then exit. `0` = recover existing positions only, no new entries. Omit for unlimited. |
| `--always-log` | boolean flag | `false` | Always write the per-market NDJSON log file even when no orders were placed. Useful for debugging entry conditions in rounds where the strategy chose not to enter. |

When `--prod` is confirmed, `process.env.PROD` is set to `"true"` so strategies can check `Env.get("PROD")` at runtime.

---

## Configuration

### Environment Variables

**Market Selection**

| Variable | Default | Description |
|----------|---------|-------------|
| `MARKET_ASSET` | `"btc"` | Asset to trade: `btc`, `eth`, `xrp`, `sol`, `doge`. |
| `MARKET_WINDOW` | `"5m"` | Market window: `"5m"` (5-minute) or `"15m"` (15-minute). |
| `TICKER` | `"polymarket,coinbase"` | Comma-separated price sources. Valid values: `polymarket`, `binance`, `coinbase`. |

**Trading**

| Variable | Default | Description |
|----------|---------|-------------|
| `PROD` | `"false"` | Set automatically by `--prod`. Do not set manually. |
| `PRIVATE_KEY` | — | Polygon wallet private key (with `0x` prefix). Required for production. |
| `POLY_FUNDER_ADDRESS` | — | Polymarket proxy/funder address. Required for production. |
| `WALLET_BALANCE` | `"50"` | Simulated wallet balance in USD for paper trading. |
| `SIMULATION_MODE` | `"true"` | Master safety switch. Set to `"false"` only via `--prod`. |
| `FORCE_PROD` | `"false"` | Skip the interactive production confirmation prompt. |

**Risk Gates**

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SESSION_LOSS` | `"3"` | Maximum cumulative session loss in USD before auto-shutdown. |
| `MAX_POSITION_PCT` | `"0.05"` | Maximum fraction of wallet per single trade (5%). |
| `MAX_DRAWDOWN_PCT` | `"0.20"` | Maximum drawdown from starting balance before shutdown (20%). |
| `DAILY_LOSS_LIMIT` | `"0"` | Daily loss cap in USD. `0` = disabled. Resets at UTC midnight. |

**Simulation Realism**

| Variable | Default | Description |
|----------|---------|-------------|
| `SIM_PARTIAL_FILL_PROB` | `"0"` | Probability (0–1) of a partial fill. |
| `SIM_SLIPPAGE_BPS` | `"0"` | Slippage in basis points (0–500). |
| `SIM_LATENCY_JITTER_MS` | `"0"` | Random order latency in ms (0–2000). |
| `SIM_NETWORK_FAIL_PROB` | `"0"` | Probability (0–0.5) of an order rejection. |

**Performance Database**

| Variable | Default | Description |
|----------|---------|-------------|
| `PERF_DB` | `"false"` | Enable performance database recording (`state/performance.db`). |
| `PERF_RECORD_TICKS` | `"false"` | Record per-second tick snapshots to the `ticks` table (verbose). |

---

## Engine Architecture

The engine is composed of two core classes: **EarlyBird** and **MarketLifecycle**.

### EarlyBird (engine/early-bird.ts)

EarlyBird is the top-level engine loop. It:

- Creates a new `MarketLifecycle` for each upcoming market slot, determined by `--slot-offset`.
- Runs an internal engine tick every 100ms to drive lifecycle state transitions, order status polling, and state persistence. This is **not** a market tick. Market-level ticks (reacting to price changes, checking indicators, evaluating entry/exit conditions) are the responsibility of each strategy. See the `late-entry` and `btc-gap-fade` strategies for examples of strategy-driven market ticks using `setInterval`.
- Tracks cumulative session PnL across all rounds.
- Persists engine state to disk every 5 seconds.
- Evaluates all risk gates after each completed round and auto-shuts down when a gate trips.
- Handles `SIGINT` and `SIGTERM` for graceful shutdown.

**State file paths** (per-strategy when launched from the dashboard):

| Mode | Default path |
|------|-------------|
| Simulation | `state/early-bird.json` |
| Production | `state/early-bird-prod.json` |
| Dashboard-managed | `state/early-bird-<strategy>.json` |

### MarketLifecycle (engine/market-lifecycle.ts)

Each market round is managed by a `MarketLifecycle` instance, which progresses through four states:

```
INIT --> RUNNING --> STOPPING --> DONE
```

**INIT**

1. Fetches event details from the Polymarket API.
2. Resolves CLOB token IDs for the UP and DOWN sides.
3. Subscribes to the order book WebSocket.
4. Waits for the order book to become ready.
5. Calls the strategy function.
6. Transitions to RUNNING after the strategy function returns.

**RUNNING**

- Every tick (~100ms), processes all pending orders:
  - Checks if orders have been filled (via the CLOB API).
  - Checks if orders have expired (based on `expireAtMs`).
  - Fires the appropriate callback (`onFilled`, `onExpired`, `onFailed`).
- Transitions to STOPPING when:
  - The slot time ends (`Date.now() >= slotEndMs`), OR
  - No pending orders remain AND no in-flight placements AND no active strategy holds (`ctx.hold()`).

**STOPPING**

1. Cancels any remaining buy orders.
2. Continues processing pending sell orders each tick — fill and expiry callbacks still fire normally.
3. If the slot expires with unfilled sells, cancels them.
4. Computes PnL based on order history and market resolution.
5. Transitions to DONE.

**DONE**

The lifecycle is complete. PnL is recorded to the session total and the lifecycle instance is destroyed.

### Timing Model

Markets are 5-minute (300-second) slots. Each slot is identified by its end timestamp (`slotEndMs`). The market window opens at `slotEndMs - 300,000 ms` (`slotStartMs`).

Because the engine runs with `--slot-offset >= 1`, the strategy function is invoked **before** the market opens. This gives the strategy time to analyze the order book and prepare orders before the market window begins.

---

## Market Structure

Each market is a binary prediction market with two sides:

| Side | Token Index | Resolves to 1.00 when |
|------|-------------|----------------------|
| UP | `clobTokenIds[0]` | Asset finishes above the price to beat |
| DOWN | `clobTokenIds[1]` | Asset finishes below the price to beat |

Prices range from `0.00` to `1.00`, representing the implied probability of that outcome.

**Example:** You buy 100 shares of UP at `0.49` each (cost: $49.00). If the asset finishes above the price to beat, each share resolves to `1.00` and you receive $100.00 (profit: $51.00). If it finishes below, the shares resolve to `0.00` (loss: $49.00).

The market `slug` encodes the asset, market type, and slot end time. For example, `btc-updown-5m-1775241600` indicates a BTC up/down 5-minute market ending at Unix timestamp 1775241600.

---

## Included Strategies

Six strategies ship with the engine. All are designed for simulation first. Three include a hard production guard (`process.exit(1)` if `PROD=true`). Remove that guard only when you have validated the strategy and are prepared to risk real funds.

### How to add a strategy

1. Create `engine/strategy/your-strategy.ts`. Export:
   - `yourStrategy: Strategy` — the main function
   - `VERSION: string` — semver (e.g. `"1.0.0"`)
   - `PARAMS_SCHEMA: ParamsSchema` — all env-var knobs with defaults (or `null`)
2. Import and add entries to all three maps in `engine/strategy/index.ts`:
   - `strategies["your-strategy"] = yourStrategy`
   - `strategyVersions["your-strategy"] = VERSION`
   - `strategyParamsSchemas["your-strategy"] = PARAMS_SCHEMA`
3. Run `bun run check` to confirm no type errors.

### Versioning

Bump `VERSION` whenever the trading logic changes in a way that would produce different results on the same market data. The DB records `"name@version"` as the `strategy_id`, so version bumps create a clean split in the dashboard comparison panel. Changing only env-var defaults does not require a version bump.

### simulation (1.0.0)

**File:** `engine/strategy/simulation.ts` | **Sim only**

Minimal reference implementation. Places a GTC buy at 0.49 immediately, places a GTC sell at 0.70 on fill, and emergency sells if the sell hasn't filled 30 seconds before market close. Read this strategy first — every API feature is demonstrated here.

```bash
bun run index.ts --strategy simulation --rounds 10
```

### late-entry (1.0.0)

**File:** `engine/strategy/late-entry.ts`

Indicator-driven strategy. Waits for multiple confirmation signals before entering late in the market window (ATR volatility gate, gap safety ratio, PGR momentum check, cross-source price divergence). Demonstrates `ctx.hold()`, timer-based indicator polling, and stop-loss logic.

```bash
bun run index.ts --strategy late-entry --rounds 5
```

### momentum-imbalance (1.0.0)

**File:** `engine/strategy/momentum-imbalance.ts`

Combines spot price momentum with order-book imbalance and liquidity checks. Includes a mean-reversion fallback when momentum is ambiguous. Demonstrates multi-signal entry filtering and position management.

```bash
bun run index.ts --strategy momentum-imbalance --rounds 5
```

### btc-gap-fade (1.1.0)

**File:** `engine/strategy/btc-gap-fade.ts` | **Sim only**

Gap mean-reversion strategy. Hypothesis: BTC gaps hard at slot open but tends to revert toward the open price. Buys the losing token while the gap is fading.

**Entry:** 100–160s before close. Gap must exceed `BGF_GAP_THRESHOLD`, have faded ≥ `(1 - BGF_FADE_RATIO)` from its peak (PGR check), and ATR must exceed `BGF_MIN_ATR`.

**Exit:** GTC take-profit at `BGF_TAKE_PROFIT_PRICE`, expiring 40s before close. Review timer checks for gap re-expansion at `BGF_REVIEW_AT_SECS`. Hard stop at `BGF_STOP_AT_SECS`.

**Configurable params** (all via env vars):

| Var | Default | Description |
|-----|---------|-------------|
| `BGF_GAP_THRESHOLD` | `20` | Min absolute BTC gap ($) to trigger entry |
| `BGF_FADE_RATIO` | `0.70` | PGR ceiling — enter when gap has faded below this fraction of peak |
| `BGF_MIN_ATR` | `3` | Min ATR required for entry |
| `BGF_TAKE_PROFIT_PRICE` | `0.55` | GTC take-profit sell price |
| `BGF_STOP_AT_SECS` | `30` | Hard stop: emergency exit this many seconds before close |
| `BGF_REVIEW_AT_SECS` | `45` | Review: check gap re-expansion this many seconds before close |
| `BGF_ENTRY_MIN_SECS` | `100` | Entry window open (seconds before close) |
| `BGF_ENTRY_MAX_SECS` | `160` | Entry window close (seconds before close) |
| `BGF_POSITION_SHARES` | `5` | USDC budget (shares = floor(budget / askPrice)) |

```bash
bun run index.ts --strategy btc-gap-fade --rounds 10
```

### passive-maker

**File:** `engine/strategy/passive-maker.ts`

Passive market-making strategy. Places resting limit orders on both sides and collects the spread. Fully configurable via `PM_*` environment variables. Suitable for low-volatility markets where spread is predictable.

```bash
bun run index.ts --strategy passive-maker --rounds 5
```

### multi-level-ofi (1.1.0)

**File:** `engine/strategy/multi-level-ofi.ts` | **Sim only**

Multi-level Order Flow Imbalance strategy. Computes weighted OFI across the top 3 order book levels (weights: 1.0, 0.7, 0.4). Entry also requires a BTC dislocation gate: BTC must have moved meaningfully in the last 30 seconds, in the same direction as the OFI signal, AND the token price must not yet reflect that move.

**Entry:** FOK (immediate fill or reject). Only enters in fee-safe zones (price < `MLOFI_FEE_SAFE_MAX` or > `MLOFI_FEE_SAFE_MIN`) to keep taker fees manageable.

**Exit:** GTC take-profit at `MLOFI_TAKE_PROFIT_PCT` above entry. Stop-loss triggered when best bid drops below `MLOFI_STOP_LOSS_PCT`. Emergency exit 20s before close.

**Configurable params** (all via env vars):

| Var | Default | Description |
|-----|---------|-------------|
| `MLOFI_OFI_THRESHOLD` | `20` | Min weighted OFI magnitude to consider signal |
| `MLOFI_DISLOC_BTC_PCT` | `0.0002` | Min BTC % move in 30s to count as dislocation |
| `MLOFI_DISLOC_TOKEN_GAP` | `0.02` | Min token mispricing vs fair value |
| `MLOFI_FEE_SAFE_MAX` | `0.40` | Upper bound of lower fee-safe zone |
| `MLOFI_FEE_SAFE_MIN` | `0.60` | Lower bound of upper fee-safe zone |
| `MLOFI_TAKE_PROFIT_PCT` | `0.20` | Take-profit % above entry price |
| `MLOFI_STOP_LOSS_PCT` | `0.30` | Stop-loss % below entry price |
| `MLOFI_MIN_REMAINING_S` | `30` | Don't enter with fewer seconds remaining |
| `MLOFI_MAX_REMAINING_S` | `240` | Don't enter with more seconds remaining |
| `MLOFI_POSITION_SHARES` | `5` | USDC budget for the position |

```bash
bun run index.ts --strategy multi-level-ofi --rounds 10
```

---

## Strategy Interface

A strategy is a single async function with the following signature:

```ts
type Strategy = (ctx: StrategyContext) => Promise<(() => void) | void>;
```

The function is called **once** per market round, after the INIT phase completes (order book is ready, token IDs are resolved). All subsequent logic is driven by callbacks on orders. This is an **event-driven model** — the strategy function sets up initial orders and callback chains, then returns.

### Cleanup Function

The strategy may optionally return a cleanup function. The engine calls it when the lifecycle is destroyed — whether the trade completed early or the slot ended. Use it to clear any `setTimeout` or `setInterval` handles the strategy created.

```ts
export const myStrategy: Strategy = async (ctx) => {
  const intervals: NodeJS.Timeout[] = [];
  const timeouts: NodeJS.Timeout[] = [];

  timeouts.push(setTimeout(() => { /* ... */ }, delay));
  intervals.push(setInterval(() => { /* ... */ }, 500));

  return () => {
    timeouts.forEach(clearTimeout);
    intervals.forEach(clearInterval);
  };
};
```

This pattern is intentionally similar to the cleanup return in React's `useEffect`. Strategies that create no timers can omit the return value entirely.

---

## StrategyContext API

The `StrategyContext` object is the sole interface between your strategy and the engine.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `slug` | `string` | Market identifier (e.g. `"btc-updown-5m-1775241600"`). |
| `slotStartMs` | `number` | Unix ms when the market opens. |
| `slotEndMs` | `number` | Unix ms when the market closes. |
| `clobTokenIds` | `[string, string]` | Token IDs: index 0 is UP, index 1 is DOWN. |
| `orderBook` | `OrderBook` | Live order book instance (see below). |
| `log` | `(msg: string, color?: LogColor) => void` | Log messages to engine output. |
| `pendingOrders` | `PendingOrder[]` | Live reference to currently pending orders. |
| `orderHistory` | `Array<{ action: "buy" \| "sell"; price: number; shares: number }>` | Completed (filled) orders. |
| `ticker` | `TickerTracker` | Live asset price tracker (see below). |

### Methods

#### ctx.postOrders(orders: OrderRequest[])

Fire-and-forget order placement. Returns immediately. The engine handles placement asynchronously with automatic retries on balance errors (up to 30 retries for buys, unlimited retries for sells until slot end). React to outcomes via callbacks on each `OrderRequest`.

| Callback | When it fires |
|----------|---------------|
| `onFilled(filledShares)` | Order fully matched, or expired with a partial match. Always use `filledShares` — never the originally requested count. |
| `onExpired()` | `expireAtMs` was reached with no shares matched. |
| `onFailed(reason)` | Order was not placed or was cancelled by the exchange. FOK rejections fire immediately with no retry. |

#### ctx.cancelOrders(orderIds: string[]): Promise\<CancelOrderResponse\>

Cancels orders in batch. Returns `{ canceled, not_canceled }`.

#### ctx.emergencySells(orderIds: string[]): Promise\<void\>

Last-resort exit. Cancels the specified pending sell orders and re-places them as FOK orders at the current best bid price. Bypasses any active sell-block. Automatically retries (with a fresh bid read) if the FOK is rejected.

#### ctx.getOrderById(orderId: string): Promise\<Order | null\>

Fetches the full order object from the CLOB by ID.

#### ctx.hold(): () => void

Returns a `release` function. While any hold is active, the lifecycle will not transition out of RUNNING, even if there are no pending orders. Essential for strategies that watch for conditions before entering. Call `release()` exactly once when done. Forgetting to release causes the engine to hang indefinitely.

#### ctx.blockBuys()

Permanently prevents further buy orders for this round. In-progress buy retries are also stopped.

#### ctx.blockSells()

Permanently prevents further sell orders for this round. `emergencySells` bypasses this block.

#### ctx.getMarketResult(): MarketData | undefined

Returns `{ openPrice, closePrice }` when available. `openPrice` is the asset price at market open (the "price to beat"). Returns `undefined` before market data is available.

### OrderRequest

```ts
type OrderRequest = {
  req: {
    tokenId: string;
    action: "buy" | "sell";
    price: number;          // 0.00 – 1.00
    shares: number;
    orderType?: "GTC" | "FOK";  // default: "GTC"
  };
  expireAtMs: number;       // Unix ms — engine auto-cancels after this time
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void;
  onFailed?: (reason: string) => void;
};
```

#### Order Types

| Type | Behaviour | Fees |
|------|-----------|------|
| `"GTC"` | Rests on the book until filled, expired, or cancelled. You are the maker. | No taker fee |
| `"FOK"` | Must fill immediately and in full, or be rejected instantly. You are the taker. | Taker fee applies |

**FOK fees:** `fee = shares × feeRate × price × (1 - price)`. The engine adjusts `filledShares` in `onFilled` to reflect net shares after fees, so strategies can use the value directly.

### OrderBook

| Method | Signature | Description |
|--------|-----------|-------------|
| `bestAskInfo` | `(side) => { price, liquidity } \| null` | Best ask price and available liquidity. |
| `bestBidPrice` | `(side) => number \| null` | Best bid price. |
| `bestBidInfo` | `(side) => { price, liquidity } \| null` | Best bid price and available liquidity. |
| `getSnapshotData` | `() => { up: BookSnapshot; down: BookSnapshot } \| null` | Full top-3 levels for OFI computation. |

### TickerTracker

| Property | Type | Description |
|----------|------|-------------|
| `price` | `number \| undefined` | Current asset price aggregated across all configured sources. |
| `binancePrice` | `number \| undefined` | Raw price from Binance. |
| `coinbasePrice` | `number \| undefined` | Raw price from Coinbase. |
| `divergence` | `number \| null` | Price divergence across configured sources. |

### PendingOrder

| Field | Type | Description |
|-------|------|-------------|
| `orderId` | `string` | Unique order identifier. |
| `tokenId` | `string` | CLOB token ID. |
| `action` | `"buy" \| "sell"` | Order side. |
| `orderType` | `"GTC" \| "FOK" \| undefined` | Order type. |
| `price` | `number` | Limit price. |
| `shares` | `number` | Number of shares. |
| `expireAtMs` | `number` | Expiration timestamp in Unix ms. |

---

## Order Lifecycle

```
postOrders([order])
    |
    v
[Engine queues order for async placement]
    |
    +---> Placement fails (exchange error)       ---> onFailed(reason)
    |         |
    |         +--- "not enough balance"           ---> retried (buys: ≤30x, sells: until slot end)
    |         +--- FOK rejection (no liquidity)   ---> onFailed immediately, no retry
    |
    +---> Placement succeeds (orderId assigned)
              |
              +---> GTC: order rests on book
              |         |
              |         +---> Fills on CLOB       ---> onFilled(filledShares)
              |         +---> expireAtMs reached  ---> engine cancels
              |         |         |
              |         |         +---> Partially filled   ---> onFilled(matchedShares)
              |         |         +---> Not filled at all  ---> onExpired()
              |         +---> Exchange cancels    ---> onFailed(reason)
              |         +---> STOPPING cancels it ---> (no callback, cleanup only)
              |
              +---> FOK: resolves on next tick
                        |
                        +---> Filled instantly    ---> onFilled(filledShares)
                        (rejection returns no orderId — handled above)
```

---

## Utility Functions

Available from `engine/strategy/utils.ts`.

### waitForAsk(ctx, side, targetPrice, onReached, pollMs?)

Polls the order book every `pollMs` milliseconds (default: 100) until the best ask on `side` reaches or exceeds `targetPrice`. Calls `onReached(price)` when the condition is met. Returns a `PriceSignal` with a `cancel()` method.

**Why this exists:** On a CLOB, placing a limit buy above the current ask fills immediately at the ask — you pay your limit price but could have paid the ask. `waitForAsk` watches passively until the ask naturally rises to your target price, ensuring you don't overpay.

### waitForBid(ctx, side, targetPrice, onReached, pollMs?)

Polls until the best bid on `side` drops to or below `targetPrice`. Returns a `PriceSignal` with `cancel()`.

**Why this exists:** For stop-loss logic — rather than a standing limit sell that might fill prematurely during normal fluctuation, watch passively until the bid actually reaches your stop level before committing the exit.

---

## PnL Computation

1. **Order-based PnL**: Sum sell proceeds (credits) minus buy costs (debits). Taker fees (FOK orders) are subtracted for both buy and sell fills.
2. **Resolution-based PnL**: Shares held at market close resolve at `1.00` (winning side) or `0.00` (losing side).
3. **Session PnL**: Accumulated across all rounds in the session.
4. **Session Loss**: Tracked separately. Only losing rounds contribute — winning rounds do not offset it. A session that wins $5 then loses $3 has session PnL of +$2 but session loss of -$3.

---

## State Persistence and Recovery

### State Snapshots

The engine persists its state to disk every 5 seconds. State includes session PnL, session loss, daily loss bucket, wallet balance, all active market lifecycles (with pending orders and order history), and completed market results.

### Graceful Shutdown

When shutdown is triggered — by `SIGINT`, `SIGTERM`, a risk gate, or round exhaustion — the engine does not exit immediately. It signals all active lifecycles to wind down. Lifecycles in INIT are discarded; lifecycles in RUNNING transition to STOPPING, where buy orders are cancelled and sell orders are polled until filled or the slot ends. The engine exits only once every lifecycle has settled.

If the slot ends with a sell still unfilled, the engine cancels it and lets the position resolve at market close.

### Crash Recovery

If the engine crashes or is forcefully killed, state recovery handles the gap on the next startup. The engine loads the most recent state snapshot and resumes tracking any pending orders that were active at the time of the crash. Orders remain live on the Polymarket CLOB regardless of whether the engine is running — recovery reconnects to them by ID.

Callbacks are not persisted. Any logic waiting inside an `onFilled` or `onExpired` handler will not fire for recovered orders. Design strategies with this in mind.

---

## Performance Dashboard

```bash
bun dashboard/server.ts
# or
DASHBOARD_PORT=3001 bun dashboard/server.ts
```

Opens at `http://localhost:3000`. The dashboard reads `state/performance.db` in readonly mode (it can never mutate engine state). Enable DB recording with `PERF_DB=true` (set automatically when launching engines from the dashboard).

### Tabs

**Live**
- Real-time session PnL and wallet balance (polled every 3s from state files)
- Active markets and completed round feed
- Engine start/stop controls for each strategy (spawns child processes)
- Current session from the performance DB

**Projections**
- Monte Carlo simulation (1000 paths, 12 trades/day)
- Fan chart showing p10/p50/p90 cumulative PnL over 1d, 1w, 1m, 3m, 6m, 1y, 3y
- Kelly fraction and quarter-Kelly position sizing
- Break-even win rate
- Confidence level (high: ≥30 rounds bootstrap, low: <30 rounds Bernoulli)

**Rounds**
- Paginated round history with strategy and outcome filtering
- Detail modal showing entry reason JSON, fill prices, fees, PnL

**Config**
- Live `.env` editor (whitelisted keys only)
- Changes are written to disk and take effect on the next engine start

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/strategies` | All registered strategies with stats |
| GET | `/api/rounds` | Paginated round history (filters: strategy, from, to, outcome, limit, offset) |
| GET | `/api/performance` | Stats grouped by period (daily/weekly/monthly/3m/6m/1y/3y) |
| GET | `/api/equity-curve` | Cumulative PnL series for charting |
| GET | `/api/live` | Current session + state file data + engine statuses |
| GET | `/api/compare` | Side-by-side strategy comparison with Sharpe approximation |
| GET | `/api/projections` | Monte Carlo input + results + Kelly + break-even |
| GET/POST | `/api/engines` | List, start, or stop per-strategy engine processes |
| GET/POST | `/api/config` | Read or write whitelisted `.env` keys |

---

## Risk Gates

All gates are evaluated after each completed round. Tripping any gate triggers a graceful shutdown.

| Gate | Env Var | Default | When it trips |
|------|---------|---------|---------------|
| Session loss | `MAX_SESSION_LOSS` | `$3` | Cumulative negative PnL ≥ threshold |
| Max drawdown | `MAX_DRAWDOWN_PCT` | `20%` | `(initialBalance - currentBalance) / initialBalance ≥ threshold` |
| Daily loss | `DAILY_LOSS_LIMIT` | `$0` (off) | Cumulative daily negative PnL ≥ limit. Persists across restarts. Resets at UTC midnight. |
| Max position | `MAX_POSITION_PCT` | `5%` | Single order cost / wallet balance > threshold (blocks order, not shutdown) |

**Startup checks:** If the previous session already tripped `MAX_SESSION_LOSS` or `DAILY_LOSS_LIMIT` when the engine starts, it exits immediately with an explanation and instructions for resetting.

To reset between sessions, set `sessionLoss` to `0` in the state file, or increase `MAX_SESSION_LOSS` in `.env`.

---

## Best Practices

### General

- **Always test in simulation first.** Run at least 10 rounds (`--rounds 10`) before enabling production mode. The simulation environment uses real order book data and mirrors Polymarket behavior including spread, partial fills, and fill timing.
- **The strategy function is called once per market.** All subsequent logic must be driven by callbacks. Do not use long-running loops inside the strategy function — use `ctx.hold()` combined with timer-based or event-based patterns.
- **Return a cleanup function if your strategy creates timers.** Clear all `setTimeout` and `setInterval` handles in the returned function. The engine calls it when the lifecycle is destroyed.

### Order Management

- **Always use `filledShares` from `onFilled`, never the original requested shares.** Partial fills are possible, and FOK fills are reduced by taker fees.
- **Set `expireAtMs` strategically.** For sell orders, expire them 20–40 seconds before `slotEndMs` so `onExpired` has time to trigger emergency sells before close.
- **Use `ctx.hold()` for event-driven strategies.** Without it, the lifecycle transitions to STOPPING as soon as the strategy function returns and no orders are pending.

### Callback Chaining

```ts
ctx.postOrders([{
  req: { tokenId: ctx.clobTokenIds[0], action: "buy", price: 0.49, shares: 100 },
  expireAtMs: ctx.slotEndMs - 60_000,
  onFilled: (filledShares) => {
    ctx.postOrders([{
      req: { tokenId: ctx.clobTokenIds[0], action: "sell", price: 0.55, shares: filledShares },
      expireAtMs: ctx.slotEndMs - 30_000,
      onExpired: () => {
        const sellIds = ctx.pendingOrders
          .filter(o => o.action === "sell")
          .map(o => o.orderId);
        ctx.emergencySells(sellIds);
      },
    }]);
  },
}]);
```

### Risk Management

- Use `ctx.blockBuys()` to prevent new entries after a stop-loss condition.
- Use `ctx.emergencySells()` as a last resort when limit sells have not filled and the slot is about to end.
- Monitor `ctx.pendingOrders` to track open orders by ID for cancellation or emergency selling.
- Set `MAX_SESSION_LOSS` to an amount you are comfortable losing in a single session.

### Resilience

- **Design for restarts.** Callbacks are not persisted across crashes. Orders will be tracked but callback chains will not resume. Avoid designs where the only exit path is a callback chain started before a potential crash.
- **Reset session state before starting a new session** if the prior session ended with losses that already meet the `MAX_SESSION_LOSS` threshold.

---

## Production Setup

Production mode places real orders with real funds. Complete all steps before enabling.

### 1. Create a Polymarket Wallet

You need a Polygon-compatible wallet with a private key. Fund the wallet with USDC on the Polygon network.

### 2. Wrap USDC to pUSD

Polymarket v2 uses pUSD (wrapped USDC.e). Run the wrap script before your first production run:

```bash
bun scripts/pusd.ts wrap
```

See [MIGRATE_V2.md](MIGRATE_V2.md) for details.

### 3. Obtain Builder API Credentials

The engine uses Polymarket's gasless relayer to redeem resolved positions on-chain without paying gas.

1. Log in to [polymarket.com](https://polymarket.com) and complete profile creation.
2. Go to **Settings → Builder Codes**.
3. Click **Create New** to generate a key/secret/passphrase triplet.
4. Save all three values — the secret and passphrase are only shown once.

### 4. Configure the .env File

```env
# Wallet private key (with 0x prefix). Signs all orders.
PRIVATE_KEY=0x...

# Polymarket proxy/funder address.
POLY_FUNDER_ADDRESS=0x...

# Builder API credentials for the gasless relayer.
BUILDER_KEY=...
BUILDER_SECRET=...
BUILDER_PASSPHRASE=...

# Asset to trade.
MARKET_ASSET=btc

# Price sources.
TICKER=polymarket,coinbase

# Risk gates.
MAX_SESSION_LOSS=3
MAX_DRAWDOWN_PCT=0.20
DAILY_LOSS_LIMIT=0

# Skip the interactive confirmation prompt (for automated runs).
FORCE_PROD=false
```

### 5. Run in Production

```bash
bun run index.ts --strategy <your-strategy> --prod
```

Type `Y` at the confirmation prompt. Set `FORCE_PROD=true` to skip it for automated runs.

### 6. Strategy Production Guard

Strategies can check whether they are running in production via `Env.get("PROD")`. The three sim-only strategies (`simulation`, `btc-gap-fade`, `multi-level-ofi`) block execution in production by design:

```ts
if (Env.get("PROD")) {
  ctx.log("This strategy is for simulation only.", "red");
  process.exit(1);
}
```

When writing a production strategy, remove this guard and ensure your logic accounts for real funds, slippage, and exchange latency.

### Production Checklist

- Wallet has sufficient pUSD balance on Polygon (run `bun scripts/pusd.ts wrap` if needed).
- Strategy validated in simulation for at least 10 rounds.
- `MAX_SESSION_LOSS`, `MAX_DRAWDOWN_PCT`, and `DAILY_LOSS_LIMIT` set appropriately.
- `PRIVATE_KEY` and `POLY_FUNDER_ADDRESS` are correct and correspond to the same Polymarket account.
- `BUILDER_KEY`, `BUILDER_SECRET`, and `BUILDER_PASSPHRASE` are set.
- `.env` is not committed to version control (already excluded by `.gitignore`).

---

## Redemption

When a market resolves, winning token holders must redeem positions on-chain to convert them back to USDC. The engine handles this automatically in production mode.

### Auto-Redeem (Engine)

When a lifecycle completes in production and the strategy held a position to market close, the engine automatically calls `redeemPositions` on-chain via Polymarket's gasless relayer. No MATIC is required. Redemption failures are logged but do not block shutdown.

### Batch Redeem Script

```bash
# Check what positions are redeemable (no transactions sent)
bun scripts/redeem.ts --dry-run

# Redeem all resolved positions on-chain
bun scripts/redeem.ts
```

Run this script periodically after each session to ensure resolved positions are converted back to USDC.

---

## Debugging and Visualization

### Log Files

**Console log** (`logs/early-bird-YYYY-MM-DD-HH-mm-ss.log`)

Timestamped, human-readable log of engine events: startup, lifecycle transitions, order placements, fills, cancellations, PnL summaries, and shutdown messages.

**Market log** (`logs/early-bird-{slug}.log`)

Structured NDJSON log generated per market round. Written only when orders were placed by default; pass `--always-log` to write for every round. Contains:

| Entry type | Description |
|------------|-------------|
| `slot` | Start and end markers |
| `orderbook_snapshot` | Full top-of-book state, written every second |
| `remaining` | Seconds remaining in the market window |
| `ticker` | Asset price from all sources, divergence |
| `market_price` | Open price and current gap |
| `order` | Order events: placed, filled, expired, failed, canceled |
| `resolution` | Final outcome: direction, open/close prices, payout, PnL |

### Chart Visualization

```bash
bun run scripts/chart.ts logs/early-bird-btc-updown-5m-1775241600.log [--open]
```

Generates an interactive HTML chart from a market log file. Renders the full order book timeline (UP/DOWN ask and bid lines), order event markers, and the BTC price curve. The `--open` flag opens the chart in your default browser automatically.

**Debugging workflow:**

1. Run a simulation session: `bun run index.ts --rounds 5`
2. Identify the market round from the console log.
3. Find the market log in `logs/` (named by slug).
4. Generate the chart: `bun run scripts/chart.ts logs/early-bird-{slug}.log`
5. Open the HTML file and inspect the timeline.

For rapid iteration: `bun run index.ts --rounds 1`, then immediately chart it.

### Live Order Book Monitor

```bash
# Monitor the current BTC market slot
bun run scripts/orderbook.ts

# Monitor ETH
bun run scripts/orderbook.ts --asset eth

# Monitor next slot
bun run scripts/orderbook.ts --market 1

# Follow new slots continuously
bun run scripts/orderbook.ts --continuous
```

| Flag | Description |
|------|-------------|
| `--asset <a>` | Asset to monitor: `btc`, `eth`, `xrp`, `sol`, `doge`. Defaults to `btc`. |
| `--market <n>` | Slot offset or timestamp. `0` = current, `1` = next, `-1` = previous. |
| `--window <w>` | Window duration: `5m` (default) or `15m`. |
| `--continuous` | Follow new slots as they open. |

The monitor connects directly to the same WebSocket the engine uses, giving you the exact same view of the book that your strategy sees in real time.
