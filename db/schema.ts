// =============================================================================
// db/schema.ts
//
// SQLite schema definition and migration runner for the performance database.
//
// DATABASE FILE: state/performance.db
//
// This module is deliberately free of any engine imports — it only depends on
// bun:sqlite (a Bun built-in, no npm package needed). This means it can be
// imported by both the trading engine and the dashboard server without pulling
// in engine dependencies on the dashboard side.
//
// TABLES
// ──────
//   strategies  — version registry: one row per (name, version) pair.
//                 Stores the params snapshot so you can diff configs across
//                 sessions even when the version string hasn't changed.
//
//   sessions    — one row per engine run (start → shutdown).
//                 Tracks wallet balance, session PnL, and session loss so
//                 the dashboard can show overall account growth over time.
//
//   rounds      — one row per 5-minute market slot.
//                 The core performance record: entry/exit prices, PnL, fees,
//                 outcome. FK → sessions and strategies.
//
//   ticks       — optional per-second price/book snapshots inside a round.
//                 Opt-in via PERF_RECORD_TICKS=true. Grows at ~300 rows/round;
//                 prune with scripts/prune-ticks.ts to keep the DB lean.
//
// CONCURRENCY
// ───────────
// The engine process writes; the dashboard server reads. WAL journal mode
// (set via PRAGMA after opening) allows simultaneous reads and one writer
// without blocking. This is set once and persists in the DB file.
//
// MIGRATIONS
// ──────────
// runMigrations() uses CREATE TABLE IF NOT EXISTS throughout, so it is safe
// to call on every startup — it is idempotent. New columns should be added
// via ALTER TABLE in future migration steps appended below.
// =============================================================================

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

// Path to the SQLite file. Created automatically on first open.
export const DB_PATH = "state/performance.db";

// -----------------------------------------------------------------------------
// openDatabase
// -----------------------------------------------------------------------------

/**
 * Open (or create) the performance database.
 *
 * - Creates the `state/` directory if it doesn't exist.
 * - Enables WAL journal mode for concurrent read/write access.
 * - Runs all schema migrations so the schema is always up to date.
 *
 * Pass `{ readonly: true }` when opening from the dashboard server so it
 * never accidentally mutates engine state.
 *
 * @example
 * ```ts
 * // Engine (read-write)
 * const db = openDatabase();
 *
 * // Dashboard server (read-only)
 * const db = openDatabase({ readonly: true });
 * ```
 */
export function openDatabase(opts: { readonly?: boolean } = {}): Database {
  // Ensure the state/ directory exists before SQLite tries to create the file.
  mkdirSync("state", { recursive: true });

  const db = opts.readonly
    ? new Database(DB_PATH, { readonly: true })
    : new Database(DB_PATH);

  // WAL mode: allows the dashboard to read while the engine writes.
  // This pragma is persistent — it only needs to be set once per DB file, but
  // it's harmless to set it on every open (it's a no-op if already set).
  if (!opts.readonly) {
    db.exec("PRAGMA journal_mode=WAL;");
    // Slightly relax durability for better write throughput. The engine can
    // tolerate losing the last ~1s of ticks on an OS crash (PnL is recovered
    // from the NDJSON logs). Rounds are written at market close, not on every
    // tick, so this is safe.
    db.exec("PRAGMA synchronous=NORMAL;");
    // Allow up to 5 seconds of retrying when another writer holds the lock.
    // Critical when 5 strategies write simultaneously at slot boundaries.
    db.exec("PRAGMA busy_timeout=5000;");
  }

  runMigrations(db);
  return db;
}

// -----------------------------------------------------------------------------
// runMigrations
// -----------------------------------------------------------------------------

/**
 * Apply all schema migrations in order. Safe to call on every startup —
 * every statement uses CREATE TABLE IF NOT EXISTS or CREATE INDEX IF NOT EXISTS.
 *
 * To add a column in a future version, append an ALTER TABLE step at the end
 * of this function, guarded by a try/catch (ALTER TABLE fails if the column
 * already exists in SQLite).
 */
export function runMigrations(db: Database): void {
  db.exec(`
    -- -------------------------------------------------------------------------
    -- strategies
    --
    -- One row per (name, version) pair. The primary key is the strategy_id
    -- string ("name@version"), which is also the FK used in rounds and sessions.
    --
    -- params: JSON snapshot of env vars at the time this strategy version was
    --         first registered. If params change without a version bump, the
    --         sessions table captures the per-session snapshot instead.
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS strategies (
      id          TEXT    PRIMARY KEY,  -- "btc-gap-fade@1.0.0"
      name        TEXT    NOT NULL,     -- "btc-gap-fade"
      version     TEXT    NOT NULL,     -- "1.0.0"
      description TEXT,
      params      TEXT,                 -- JSON: env-var snapshot at registration
      created_at  INTEGER NOT NULL      -- Unix ms
    );

    -- -------------------------------------------------------------------------
    -- sessions
    --
    -- One row per engine process run (from start() to shutdown).
    -- ended_at is NULL while the session is running and filled in at shutdown.
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id   TEXT    NOT NULL,   -- FK → strategies.id
      params        TEXT,               -- JSON: actual env vars for this session
                                        --   (may differ from strategies.params if
                                        --    you tuned without bumping version)
      mode          TEXT    NOT NULL DEFAULT 'sim',  -- "sim" | "prod"
      started_at    INTEGER NOT NULL,   -- Unix ms
      ended_at      INTEGER,            -- NULL while running
      total_rounds  INTEGER DEFAULT 0,
      session_pnl   REAL    DEFAULT 0,
      session_loss  REAL    DEFAULT 0,
      wallet_start  REAL,               -- bankroll at session start
      wallet_end    REAL                -- bankroll at shutdown (NULL while running)
    );

    -- -------------------------------------------------------------------------
    -- rounds
    --
    -- One row per 5-minute market slot that the engine processed.
    --
    -- outcome values:
    --   "win"      — the position closed profitably
    --   "loss"     — the position closed at a loss
    --   "no-trade" — strategy ran but did not enter a position
    --   "no-data"  — slot ended without resolution data (crash/restart)
    --
    -- entry_reason: JSON object recording which entry conditions passed/failed,
    --   useful for debugging why the strategy entered or skipped.
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS rounds (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL,   -- FK → sessions.id
      strategy_id   TEXT    NOT NULL,   -- FK → strategies.id
      slug          TEXT    NOT NULL,   -- e.g. "btc-updown-5m-1775241600"
      asset         TEXT    NOT NULL DEFAULT 'btc',
      window        TEXT    NOT NULL DEFAULT '5m',
      slot_start_ms INTEGER,            -- Unix ms — market open
      slot_end_ms   INTEGER,            -- Unix ms — market close
      open_price    REAL,               -- BTC price at market open (price-to-beat)
      close_price   REAL,               -- BTC price at market close
      direction     TEXT,               -- "UP" | "DOWN" — which side won
      entry_side    TEXT,               -- "UP" | "DOWN" — which side we bought
      entry_price   REAL,               -- price paid per share on entry
      exit_price    REAL,               -- price received per share on exit (or null if held to resolution)
      shares_bought REAL    DEFAULT 0,
      shares_sold   REAL    DEFAULT 0,
      taker_fees    REAL    DEFAULT 0,  -- total FOK taker fees paid (USDC)
      pnl           REAL,               -- gross PnL before fees
      net_pnl       REAL,               -- pnl - taker_fees
      outcome       TEXT,               -- "win" | "loss" | "no-trade" | "no-data"
      entry_reason  TEXT,               -- JSON: condition results at entry
      created_at    INTEGER NOT NULL    -- Unix ms — when this row was inserted
    );

    -- -------------------------------------------------------------------------
    -- ticks
    --
    -- Optional per-second snapshots of market state during a round. Only
    -- written when PERF_RECORD_TICKS=true. Used by the dashboard for chart
    -- replay of individual rounds.
    --
    -- At 1 row/second × 300s/round × N rounds/day, this table grows quickly.
    -- Prune with: bun scripts/prune-ticks.ts --older-than-days 30
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS ticks (
      round_id  INTEGER NOT NULL,       -- FK → rounds.id
      ts        INTEGER NOT NULL,       -- Unix ms
      btc_price REAL,
      gap       REAL,                   -- btc_price - open_price
      up_ask    REAL,                   -- best ask on UP side
      up_bid    REAL,                   -- best bid on UP side
      down_ask  REAL,                   -- best ask on DOWN side
      down_bid  REAL                    -- best bid on DOWN side
    );

    -- -------------------------------------------------------------------------
    -- Indexes
    -- -------------------------------------------------------------------------

    -- Dashboard queries filter rounds by strategy and time range constantly.
    CREATE INDEX IF NOT EXISTS idx_rounds_strategy_id
      ON rounds (strategy_id);

    CREATE INDEX IF NOT EXISTS idx_rounds_created_at
      ON rounds (created_at);

    CREATE INDEX IF NOT EXISTS idx_rounds_slug
      ON rounds (slug);

    CREATE INDEX IF NOT EXISTS idx_rounds_session_id
      ON rounds (session_id);

    -- Tick chart replay queries by (round_id, ts).
    CREATE INDEX IF NOT EXISTS idx_ticks_round_ts
      ON ticks (round_id, ts);
  `);
}
