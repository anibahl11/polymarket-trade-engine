// =============================================================================
// engine/db-hooks.ts
//
// Bridge between the trading engine lifecycle events and the performance DB.
//
// DESIGN PHILOSOPHY
// ─────────────────
// This module is the only place the engine touches the DB. It is entirely
// opt-in: EarlyBird only instantiates DbHooks when PERF_DB=true. When that
// env var is absent, the engine behaves exactly as before — no DB dependency,
// no performance overhead.
//
// Integration points (all in engine/early-bird.ts):
//   1. onSessionStart()  — called once in EarlyBird.start(), after wallet init
//   2. onRoundStart()    — called in EarlyBird._tick() when a new lifecycle is created
//   3. onRoundEnd()      — called in EarlyBird._tick() when lifecycle.state === "DONE"
//   4. onSessionEnd()    — called in EarlyBird._startShutdown()
//
// We deliberately do NOT hook into MarketLifecycle's constructor — that would
// require touching the lifecycle class signature and break test fixtures.
// Instead, all round data is reconstructed from `lifecycle.orderHistory` and
// `lifecycle.pnl`, which are already available when state === "DONE".
//
// TICK RECORDING (optional)
// ─────────────────────────
// When PERF_RECORD_TICKS=true, onRoundStart() launches a 1-second interval
// that writes BTC price, gap, and top-of-book prices to the `ticks` table.
// This enables chart replay of individual rounds in the dashboard. The interval
// is canceled in onRoundEnd() — no cleanup is needed from the caller.
//
// ERROR SAFETY
// ────────────
// Every public method is wrapped in try/catch. A SQLite error (disk full,
// corruption, etc.) is logged as a dim warning but never propagates to the
// trading engine. The engine is the priority — the DB is best-effort.
// =============================================================================

import { openDatabase } from "../db/schema.ts";
import { DbWriter } from "../db/writer.ts";
import { buildStrategyId, snapshotParams } from "./strategy/strategy-meta.ts";
import type { ParamsSchema } from "./strategy/strategy-meta.ts";
import type { TickerTracker } from "../tracker/ticker.ts";
import type { OrderBook } from "../tracker/orderbook.ts";
import type { CompletedMarketState } from "./state.ts";

// Read from env once at module load (not inside each method call).
const RECORD_TICKS = process.env.PERF_RECORD_TICKS === "true";
const IS_PROD = process.env.PROD === "true";

// How often (ms) to sample ticks when PERF_RECORD_TICKS=true.
const TICK_INTERVAL_MS = 1000;

// -----------------------------------------------------------------------------
// RoundResolution — passed from EarlyBird to onRoundEnd()
// -----------------------------------------------------------------------------

/**
 * Everything EarlyBird knows about a completed round. Pulled from the
 * MarketLifecycle once its state transitions to "DONE".
 */
export type RoundResolution = {
  slug: string;
  strategyName: string;
  pnl: number;
  /** orderHistory from lifecycle — filled buy/sell records */
  orderHistory: CompletedMarketState["orderHistory"];
  /** openPrice from the API queue (null if unavailable) */
  openPrice: number | null;
  /** closePrice from the API queue (null before resolution) */
  closePrice: number | null;
  /** Which side won ("UP" | "DOWN" | null) */
  direction: string | null;
  slotStartMs: number;
  slotEndMs: number;
};

// -----------------------------------------------------------------------------
// DbHooks
// -----------------------------------------------------------------------------

export class DbHooks {
  private readonly _writer: DbWriter;
  private readonly _ticker: TickerTracker;
  private readonly _orderBook: OrderBook | null;
  private readonly _strategyParamsSchema: ParamsSchema | null;

  // slug → rounds.id for the current session
  private readonly _roundIds = new Map<string, number>();

  // slug → NodeJS timer for tick recording
  private readonly _tickTimers = new Map<string, ReturnType<typeof setInterval>>();

  private _sessionId: number | null = null;
  private _strategyId: string = "unknown@0.0.0";

  /**
   * @param ticker           TickerTracker instance — used to sample BTC price for ticks
   * @param orderBook        OrderBook instance — used to sample top-of-book for ticks (optional)
   * @param paramsSchema     The PARAMS_SCHEMA export from the active strategy (for snapshotParams)
   */
  constructor(
    ticker: TickerTracker,
    orderBook: OrderBook | null = null,
    paramsSchema: ParamsSchema | null = null,
  ) {
    const db = openDatabase();
    this._writer = new DbWriter(db);
    this._ticker = ticker;
    this._orderBook = orderBook;
    this._strategyParamsSchema = paramsSchema;
  }

  // ---------------------------------------------------------------------------
  // onSessionStart
  // ---------------------------------------------------------------------------

  /**
   * Called once in EarlyBird.start() after the wallet tracker is initialised.
   * Registers the strategy version in the DB and opens a new session row.
   *
   * @param strategyName  The strategy name key (e.g. "btc-gap-fade")
   * @param version       The VERSION export from the strategy module
   * @param walletStart   Starting sim/prod balance in USDC
   */
  onSessionStart(
    strategyName: string,
    version: string,
    walletStart: number,
  ): void {
    try {
      this._strategyId = buildStrategyId(strategyName, version);

      // Snapshot the current env vars for this session.
      const params = this._strategyParamsSchema
        ? snapshotParams(this._strategyParamsSchema)
        : null;

      // Register the strategy version (idempotent — safe to call every session).
      this._writer.upsertStrategy({
        id: this._strategyId,
        name: strategyName,
        version,
        params: params ?? undefined,
      });

      // Open a new session row.
      this._sessionId = this._writer.insertSession({
        strategy_id: this._strategyId,
        params: params ?? undefined,
        mode: IS_PROD ? "prod" : "sim",
        started_at: Date.now(),
        wallet_start: walletStart,
      });
    } catch (e) {
      console.warn(`[db-hooks] onSessionStart error: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // onRoundStart
  // ---------------------------------------------------------------------------

  /**
   * Called in EarlyBird._tick() immediately after a new MarketLifecycle is
   * created. Inserts a partial round row with what we know at open time —
   * resolution fields are filled in by onRoundEnd().
   *
   * If PERF_RECORD_TICKS=true, also starts a 1-second tick recorder.
   *
   * @param slug         Market slug (e.g. "btc-updown-5m-1775241600")
   * @param slotStartMs  Unix ms — market open timestamp
   * @param slotEndMs    Unix ms — market close timestamp
   */
  onRoundStart(
    slug: string,
    slotStartMs: number,
    slotEndMs: number,
  ): void {
    try {
      if (this._sessionId === null) return;

      const roundId = this._writer.insertRound({
        session_id: this._sessionId,
        strategy_id: this._strategyId,
        slug,
        asset: process.env.MARKET_ASSET ?? "btc",
        window: process.env.MARKET_WINDOW ?? "5m",
        slot_start_ms: slotStartMs,
        slot_end_ms: slotEndMs,
        created_at: Date.now(),
      });

      this._roundIds.set(slug, roundId);

      // Optionally start tick recording.
      if (RECORD_TICKS) {
        this._startTickRecorder(slug, roundId, slotEndMs);
      }
    } catch (e) {
      console.warn(`[db-hooks] onRoundStart(${slug}) error: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // onRoundEnd
  // ---------------------------------------------------------------------------

  /**
   * Called in EarlyBird._tick() when a lifecycle reaches state "DONE".
   * Updates the round row with all trade and resolution data.
   *
   * Reconstructs entry/exit details from `resolution.orderHistory` — we don't
   * need to instrument the lifecycle internals to get this data.
   */
  onRoundEnd(resolution: RoundResolution): void {
    try {
      const roundId = this._roundIds.get(resolution.slug);
      if (roundId == null) return;

      // Stop tick recording for this round.
      this._stopTickRecorder(resolution.slug);
      this._roundIds.delete(resolution.slug);

      // ── Reconstruct trade details from orderHistory ──────────────────────
      const buys  = resolution.orderHistory.filter(o => o.action === "buy");
      const sells = resolution.orderHistory.filter(o => o.action === "sell");

      const sharesBought = buys.reduce((s, o) => s + o.shares, 0);
      const sharesSold   = sells.reduce((s, o) => s + o.shares, 0);
      const takerFees    = resolution.orderHistory.reduce((s, o) => s + o.fee, 0);

      // Best estimate of entry price: weighted average of buy fills.
      const entryCost    = buys.reduce((s, o) => s + o.price * o.shares, 0);
      const entryPrice   = sharesBought > 0 ? entryCost / sharesBought : null;

      // Best estimate of exit price: weighted average of sell fills.
      const exitProceeds = sells.reduce((s, o) => s + o.price * o.shares, 0);
      const exitPrice    = sharesSold > 0 ? exitProceeds / sharesSold : null;

      // Which side did we trade? First buy determines the side.
      // The tokenId tells us: clobTokenIds[0] = UP, [1] = DOWN.
      // We don't have that mapping here, but entry_side is stored in the round
      // only when the strategy explicitly provides it in entry_reason. For now
      // we derive it from the direction/pnl relationship as a best-effort guess.
      // Strategies can pass entry_side via updateRound() if needed later.

      // ── Determine outcome ─────────────────────────────────────────────────
      let outcome: "win" | "loss" | "no-trade" | "no-data";
      if (sharesBought === 0) {
        outcome = "no-trade";
      } else if (resolution.closePrice == null || resolution.direction == null) {
        outcome = "no-data";
      } else if (resolution.pnl > 0) {
        outcome = "win";
      } else {
        outcome = "loss";
      }

      const netPnl = resolution.pnl - takerFees;

      this._writer.updateRound(roundId, {
        open_price:    resolution.openPrice,
        close_price:   resolution.closePrice,
        direction:     resolution.direction,
        entry_price:   entryPrice,
        exit_price:    exitPrice,
        shares_bought: sharesBought,
        shares_sold:   sharesSold,
        taker_fees:    takerFees,
        pnl:           resolution.pnl,
        net_pnl:       netPnl,
        outcome,
      });

      // Increment the session round counter so the dashboard shows live progress.
      if (this._sessionId !== null) {
        this._writer.incrementSessionRounds(this._sessionId);
      }
    } catch (e) {
      console.warn(`[db-hooks] onRoundEnd(${resolution.slug}) error: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // onSessionEnd
  // ---------------------------------------------------------------------------

  /**
   * Called in EarlyBird._startShutdown() with final session metrics.
   * Marks the session as ended and records the final PnL and wallet balance.
   */
  onSessionEnd(
    sessionPnl: number,
    sessionLoss: number,
    totalRounds: number,
    walletEnd: number,
  ): void {
    try {
      if (this._sessionId === null) return;

      // Stop any lingering tick recorders (shouldn't happen, but be safe).
      for (const [slug] of this._tickTimers) {
        this._stopTickRecorder(slug);
      }

      this._writer.updateSession(this._sessionId, {
        ended_at:     Date.now(),
        total_rounds: totalRounds,
        session_pnl:  sessionPnl,
        session_loss: sessionLoss,
        wallet_end:   walletEnd,
      });

      this._sessionId = null;
    } catch (e) {
      console.warn(`[db-hooks] onSessionEnd error: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Tick recorder (private)
  // ---------------------------------------------------------------------------

  private _startTickRecorder(slug: string, roundId: number, slotEndMs: number): void {
    const timer = setInterval(() => {
      // Stop if the slot has ended (belt-and-suspenders alongside onRoundEnd).
      if (Date.now() >= slotEndMs) {
        this._stopTickRecorder(slug);
        return;
      }

      try {
        const btcPrice = this._ticker.price ?? null;
        const snapshot = this._orderBook?.getSnapshotData() as any ?? null;

        const upAsk   = snapshot?.up?.asks?.[0]?.[0]   ?? null;
        const upBid   = snapshot?.up?.bids?.[0]?.[0]   ?? null;
        const downAsk = snapshot?.down?.asks?.[0]?.[0] ?? null;
        const downBid = snapshot?.down?.bids?.[0]?.[0] ?? null;

        // gap requires openPrice, which we don't have here — compute from
        // upAsk and downAsk as a proxy: gap direction ≈ upAsk > 0.5 → UP.
        // Actual gap (btcPrice - openPrice) is written to the round row.
        const gap = (upAsk != null && downAsk != null)
          ? upAsk - downAsk  // positive when UP is favoured
          : null;

        this._writer.insertTick(roundId, {
          ts: Date.now(),
          btc_price: btcPrice,
          gap,
          up_ask: upAsk,
          up_bid: upBid,
          down_ask: downAsk,
          down_bid: downBid,
        });
      } catch (e) {
        // Silent — a single missed tick is not worth crashing the recorder.
      }
    }, TICK_INTERVAL_MS);

    this._tickTimers.set(slug, timer);
  }

  private _stopTickRecorder(slug: string): void {
    const timer = this._tickTimers.get(slug);
    if (timer != null) {
      clearInterval(timer);
      this._tickTimers.delete(slug);
    }
  }
}
