// =============================================================================
// db/writer.ts
//
// Insert and update helpers for the performance database.
//
// All writes go through this class so the engine never builds raw SQL strings
// at runtime. Prepared statements are compiled once in the constructor and
// reused across calls — this is critical for hot paths like insertTick() which
// is called every second during a round.
//
// USAGE (from engine/db-hooks.ts):
// ```ts
// const db = openDatabase();
// const writer = new DbWriter(db);
//
// const sessionId = writer.insertSession({ strategy_id, params, ... });
// const roundId   = writer.insertRound({ session_id, strategy_id, slug, ... });
// writer.insertTick(roundId, { ts, btc_price, gap, ... });
// writer.updateRound(roundId, { pnl, net_pnl, outcome, close_price, ... });
// writer.updateSession(sessionId, { ended_at, session_pnl, wallet_end, ... });
// ```
//
// ERROR HANDLING
// All public methods are intentionally non-throwing — the caller (db-hooks.ts)
// wraps them in try/catch so a DB error never propagates to the trading engine.
// =============================================================================

import { type Database, type Statement } from "bun:sqlite";

// -----------------------------------------------------------------------------
// Input types
// -----------------------------------------------------------------------------

export type StrategyInsert = {
  id: string;           // "btc-gap-fade@1.0.0"
  name: string;
  version: string;
  description?: string;
  params?: object;      // env-var snapshot from snapshotParams()
};

export type SessionInsert = {
  strategy_id: string;
  params?: object;      // per-session env-var snapshot (may differ from strategy registration)
  mode: "sim" | "prod";
  started_at: number;   // Unix ms
  wallet_start: number;
};

export type SessionUpdate = {
  ended_at?: number;
  total_rounds?: number;
  session_pnl?: number;
  session_loss?: number;
  wallet_end?: number;
};

export type RoundInsert = {
  session_id: number;
  strategy_id: string;
  slug: string;
  asset?: string;
  window?: string;
  slot_start_ms?: number;
  slot_end_ms?: number;
  created_at: number;   // Unix ms
};

export type RoundUpdate = {
  open_price?: number | null;
  close_price?: number | null;
  direction?: string | null;
  entry_side?: string | null;
  entry_price?: number | null;
  exit_price?: number | null;
  shares_bought?: number;
  shares_sold?: number;
  taker_fees?: number;
  pnl?: number | null;
  net_pnl?: number | null;
  outcome?: "win" | "loss" | "no-trade" | "no-data";
  entry_reason?: object | null;
};

export type TickInsert = {
  ts: number;           // Unix ms
  btc_price?: number | null;
  gap?: number | null;
  up_ask?: number | null;
  up_bid?: number | null;
  down_ask?: number | null;
  down_bid?: number | null;
};

// -----------------------------------------------------------------------------
// DbWriter
// -----------------------------------------------------------------------------

export class DbWriter {
  readonly db: Database;

  // Prepared statements for hot-path calls. Compiled once, reused on every call.
  private readonly _insertTickStmt: Statement;
  private readonly _updateRoundStmt: Statement;
  private readonly _incrementRoundsStmt: Statement;

  constructor(db: Database) {
    this.db = db;

    // Tick inserts happen every second per active round — prepare once.
    this._insertTickStmt = db.prepare(`
      INSERT INTO ticks (round_id, ts, btc_price, gap, up_ask, up_bid, down_ask, down_bid)
      VALUES ($round_id, $ts, $btc_price, $gap, $up_ask, $up_bid, $down_ask, $down_bid)
    `);

    // Round updates happen at fill time and at resolution — prepare once.
    // We update every nullable column in one shot so we never need a dynamic
    // column list.
    this._updateRoundStmt = db.prepare(`
      UPDATE rounds SET
        open_price    = COALESCE($open_price,    open_price),
        close_price   = COALESCE($close_price,   close_price),
        direction     = COALESCE($direction,     direction),
        entry_side    = COALESCE($entry_side,    entry_side),
        entry_price   = COALESCE($entry_price,   entry_price),
        exit_price    = COALESCE($exit_price,    exit_price),
        shares_bought = COALESCE($shares_bought, shares_bought),
        shares_sold   = COALESCE($shares_sold,   shares_sold),
        taker_fees    = COALESCE($taker_fees,    taker_fees),
        pnl           = COALESCE($pnl,           pnl),
        net_pnl       = COALESCE($net_pnl,       net_pnl),
        outcome       = COALESCE($outcome,       outcome),
        entry_reason  = COALESCE($entry_reason,  entry_reason)
      WHERE id = $id
    `);

    this._incrementRoundsStmt = db.prepare(`
      UPDATE sessions SET total_rounds = total_rounds + 1 WHERE id = $id
    `);
  }

  /**
   * Increment the session's round count by 1. Called after each round completes
   * so the dashboard can show live progress without waiting for session end.
   */
  incrementSessionRounds(sessionId: number): void {
    this._incrementRoundsStmt.run({ $id: sessionId });
  }

  // ---------------------------------------------------------------------------
  // strategies
  // ---------------------------------------------------------------------------

  /**
   * Register a strategy version in the DB. Uses INSERT OR REPLACE so calling
   * this on every session start is safe — it only overwrites if the params
   * snapshot has changed (same id = same name@version).
   */
  upsertStrategy(data: StrategyInsert): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO strategies (id, name, version, description, params, created_at)
      VALUES ($id, $name, $version, $description, $params, $created_at)
    `).run({
      $id: data.id,
      $name: data.name,
      $version: data.version,
      $description: data.description ?? null,
      $params: data.params ? JSON.stringify(data.params) : null,
      $created_at: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // sessions
  // ---------------------------------------------------------------------------

  /**
   * Insert a new session row at engine startup. Returns the auto-generated
   * session id, which is passed to every subsequent insertRound() call.
   */
  insertSession(data: SessionInsert): number {
    const result = this.db.prepare(`
      INSERT INTO sessions (strategy_id, params, mode, started_at, wallet_start)
      VALUES ($strategy_id, $params, $mode, $started_at, $wallet_start)
    `).run({
      $strategy_id: data.strategy_id,
      $params: data.params ? JSON.stringify(data.params) : null,
      $mode: data.mode,
      $started_at: data.started_at,
      $wallet_start: data.wallet_start,
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Update a session row on shutdown with final PnL, wallet balance, and
   * round count. Only provided fields are written; missing fields keep their
   * current DB value via COALESCE.
   */
  updateSession(id: number, data: SessionUpdate): void {
    this.db.prepare(`
      UPDATE sessions SET
        ended_at     = COALESCE($ended_at,     ended_at),
        total_rounds = COALESCE($total_rounds, total_rounds),
        session_pnl  = COALESCE($session_pnl,  session_pnl),
        session_loss = COALESCE($session_loss, session_loss),
        wallet_end   = COALESCE($wallet_end,   wallet_end)
      WHERE id = $id
    `).run({
      $id: id,
      $ended_at: data.ended_at ?? null,
      $total_rounds: data.total_rounds ?? null,
      $session_pnl: data.session_pnl ?? null,
      $session_loss: data.session_loss ?? null,
      $wallet_end: data.wallet_end ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // rounds
  // ---------------------------------------------------------------------------

  /**
   * Insert a partial round row at market open (INIT phase). The slug, session,
   * and strategy are known immediately; resolution fields (open_price,
   * close_price, pnl, outcome, etc.) are filled in later via updateRound().
   *
   * Returns the auto-generated round id, needed as the FK for ticks.
   */
  insertRound(data: RoundInsert): number {
    const result = this.db.prepare(`
      INSERT INTO rounds
        (session_id, strategy_id, slug, asset, window, slot_start_ms, slot_end_ms, created_at)
      VALUES
        ($session_id, $strategy_id, $slug, $asset, $window, $slot_start_ms, $slot_end_ms, $created_at)
    `).run({
      $session_id: data.session_id,
      $strategy_id: data.strategy_id,
      $slug: data.slug,
      $asset: data.asset ?? "btc",
      $window: data.window ?? "5m",
      $slot_start_ms: data.slot_start_ms ?? null,
      $slot_end_ms: data.slot_end_ms ?? null,
      $created_at: data.created_at,
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * Update a round with trade and resolution data. Safe to call multiple times
   * (e.g. once at fill, once at resolution) — only non-null provided fields
   * overwrite existing DB values.
   *
   * Passing null for a field explicitly preserves the existing DB value, which
   * allows partial updates without clobbering previously written data.
   */
  updateRound(id: number, data: RoundUpdate): void {
    this._updateRoundStmt.run({
      $id: id,
      $open_price: data.open_price ?? null,
      $close_price: data.close_price ?? null,
      $direction: data.direction ?? null,
      $entry_side: data.entry_side ?? null,
      $entry_price: data.entry_price ?? null,
      $exit_price: data.exit_price ?? null,
      $shares_bought: data.shares_bought ?? null,
      $shares_sold: data.shares_sold ?? null,
      $taker_fees: data.taker_fees ?? null,
      $pnl: data.pnl ?? null,
      $net_pnl: data.net_pnl ?? null,
      $outcome: data.outcome ?? null,
      $entry_reason: data.entry_reason ? JSON.stringify(data.entry_reason) : null,
    });
  }

  // ---------------------------------------------------------------------------
  // ticks
  // ---------------------------------------------------------------------------

  /**
   * Insert one per-second tick snapshot for a round. Called from a 1-second
   * interval inside DbHooks when PERF_RECORD_TICKS=true.
   *
   * Uses a pre-compiled prepared statement for minimal overhead — this is the
   * hottest write path in the DB layer.
   */
  insertTick(roundId: number, data: TickInsert): void {
    this._insertTickStmt.run({
      $round_id: roundId,
      $ts: data.ts,
      $btc_price: data.btc_price ?? null,
      $gap: data.gap ?? null,
      $up_ask: data.up_ask ?? null,
      $up_bid: data.up_bid ?? null,
      $down_ask: data.down_ask ?? null,
      $down_bid: data.down_bid ?? null,
    });
  }
}
