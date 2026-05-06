// =============================================================================
// db/reader.ts
//
// Read-only query helpers for the performance dashboard.
//
// All methods return plain objects or arrays — no SQLite row proxies leak out.
// The dashboard server imports this module and opens the DB in readonly mode,
// so these queries can never accidentally mutate engine state.
//
// QUERY DESIGN NOTES
// ──────────────────
// - Equity curve uses a SQLite window function (SUM OVER ORDER BY) to compute
//   running cumulative PnL in a single pass — no application-level folding.
// - Period grouping uses strftime() on the stored Unix-ms timestamp divided by
//   1000 to convert to Unix seconds (what SQLite's date functions expect).
// - Projection data returns raw win/loss stats; the Monte Carlo computation
//   itself lives in the dashboard server to keep this module pure SQL.
// - All queries accept optional filters (strategy, from/to timestamps, etc.)
//   and fall back to "all strategies / all time" when filters are absent.
// =============================================================================

import type { Database } from "bun:sqlite";

// -----------------------------------------------------------------------------
// Return types (plain objects — safe to JSON.stringify)
// -----------------------------------------------------------------------------

export type StrategyRow = {
  id: string;
  name: string;
  version: string;
  description: string | null;
  params: Record<string, unknown> | null;
  created_at: number;
  // Aggregated stats joined from rounds
  total_rounds: number;
  traded_rounds: number;  // rounds where outcome != "no-trade"
  win_count: number;
  loss_count: number;
  win_rate: number | null;  // null when traded_rounds = 0
  total_net_pnl: number;
  avg_net_pnl: number | null;
  total_fees: number;
};

export type RoundRow = {
  id: number;
  session_id: number;
  strategy_id: string;
  slug: string;
  asset: string;
  window: string;
  slot_start_ms: number | null;
  slot_end_ms: number | null;
  open_price: number | null;
  close_price: number | null;
  direction: string | null;
  entry_side: string | null;
  entry_price: number | null;
  exit_price: number | null;
  shares_bought: number;
  shares_sold: number;
  taker_fees: number;
  pnl: number | null;
  net_pnl: number | null;
  outcome: string | null;
  entry_reason: Record<string, unknown> | null;
  created_at: number;
};

export type EquityPoint = {
  created_at: number;   // Unix ms — x-axis
  net_pnl: number;      // this round's net PnL
  cumulative: number;   // running sum — y-axis
  strategy_id: string;
  outcome: string | null;
};

export type PerformancePeriod = {
  period: string;       // e.g. "2026-05-01" for daily, "2026-W18" for weekly
  total_rounds: number;
  traded_rounds: number;
  win_count: number;
  loss_count: number;
  win_rate: number | null;
  total_net_pnl: number;
  avg_net_pnl: number | null;
  total_fees: number;
};

export type ComparisonRow = {
  strategy_id: string;
  name: string;
  version: string;
  total_rounds: number;
  traded_rounds: number;
  win_count: number;
  loss_count: number;
  win_rate: number | null;
  total_net_pnl: number;
  avg_net_pnl: number | null;
  best_round: number | null;
  worst_round: number | null;
  total_fees: number;
  // Sharpe-like: avg_net_pnl / stddev(net_pnl)
  sharpe_approx: number | null;
};

export type ProjectionInput = {
  strategy_id: string;
  n: number;            // total rounds with a trade
  win_rate: number;
  avg_win: number;      // mean net_pnl of winning rounds
  avg_loss: number;     // mean net_pnl of losing rounds (negative number)
  // Raw outcomes for bootstrap sampling when n >= 30
  outcomes: number[];
};

export type SessionRow = {
  id: number;
  strategy_id: string;
  mode: string;
  params: Record<string, unknown> | null;
  started_at: number;
  ended_at: number | null;
  total_rounds: number;
  session_pnl: number;
  session_loss: number;
  wallet_start: number | null;
  wallet_end: number | null;
};

export type TickRow = {
  ts: number;
  btc_price: number | null;
  gap: number | null;
  up_ask: number | null;
  up_bid: number | null;
  down_ask: number | null;
  down_bid: number | null;
};

// Period identifiers accepted by getPerformance()
export type Period = "daily" | "weekly" | "monthly" | "3m" | "6m" | "1y" | "3y";

// -----------------------------------------------------------------------------
// DbReader
// -----------------------------------------------------------------------------

export class DbReader {
  private readonly _db: Database;

  constructor(db: Database) {
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // strategies
  // ---------------------------------------------------------------------------

  /**
   * List all registered strategy versions with their aggregated performance
   * stats. Used by the dashboard's Strategy Comparison and header panels.
   *
   * Strategies with no rounds still appear (total_rounds = 0, win_rate = null).
   */
  listStrategies(): StrategyRow[] {
    const rows = this._db.query<any, []>(`
      SELECT
        s.id, s.name, s.version, s.description, s.params, s.created_at,
        COUNT(r.id)                                               AS total_rounds,
        COUNT(CASE WHEN r.outcome != 'no-trade' THEN 1 END)      AS traded_rounds,
        COUNT(CASE WHEN r.outcome = 'win'  THEN 1 END)           AS win_count,
        COUNT(CASE WHEN r.outcome = 'loss' THEN 1 END)           AS loss_count,
        COALESCE(SUM(r.net_pnl), 0)                              AS total_net_pnl,
        COALESCE(SUM(r.taker_fees), 0)                           AS total_fees
      FROM strategies s
      LEFT JOIN rounds r ON r.strategy_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `).all();

    return rows.map((r: any) => ({
      ...r,
      params: r.params ? JSON.parse(r.params) : null,
      win_rate: r.traded_rounds > 0 ? r.win_count / r.traded_rounds : null,
      avg_net_pnl: r.traded_rounds > 0 ? r.total_net_pnl / r.traded_rounds : null,
    }));
  }

  // ---------------------------------------------------------------------------
  // rounds
  // ---------------------------------------------------------------------------

  /**
   * Paginated round history. All filters are optional; omit to get all rounds
   * across all strategies and time periods.
   *
   * @param strategy - Filter by exact strategy_id (e.g. "btc-gap-fade@1.0.0")
   * @param from     - Start of time range (Unix ms, inclusive)
   * @param to       - End of time range (Unix ms, inclusive)
   * @param outcome  - Filter by outcome: "win" | "loss" | "no-trade" | "no-data"
   * @param limit    - Page size (default 50)
   * @param offset   - Page offset (default 0)
   */
  listRounds(filters: {
    strategy?: string;
    from?: number;
    to?: number;
    outcome?: string;
    limit?: number;
    offset?: number;
  } = {}): RoundRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.strategy) {
      conditions.push("r.strategy_id = $strategy");
      params.$strategy = filters.strategy;
    }
    if (filters.from != null) {
      conditions.push("r.created_at >= $from");
      params.$from = filters.from;
    }
    if (filters.to != null) {
      conditions.push("r.created_at <= $to");
      params.$to = filters.to;
    }
    if (filters.outcome) {
      conditions.push("r.outcome = $outcome");
      params.$outcome = filters.outcome;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.$limit = filters.limit ?? 50;
    params.$offset = filters.offset ?? 0;

    const rows = this._db.query<any, any>(`
      SELECT r.*
      FROM rounds r
      ${where}
      ORDER BY r.created_at DESC
      LIMIT $limit OFFSET $offset
    `).all(params);

    return rows.map((r: any) => ({
      ...r,
      entry_reason: r.entry_reason ? JSON.parse(r.entry_reason) : null,
    }));
  }

  // ---------------------------------------------------------------------------
  // equity curve
  // ---------------------------------------------------------------------------

  /**
   * Returns an ordered series of (created_at, net_pnl, cumulative) points for
   * plotting an equity curve. The cumulative column is computed with a SQLite
   * window function so no application-level folding is needed.
   *
   * Pass `strategy` to get a single-strategy curve; omit to get all strategies
   * interleaved (useful for a multi-series chart).
   */
  getEquityCurve(opts: {
    strategy?: string;
    from?: number;
    to?: number;
  } = {}): EquityPoint[] {
    const conditions: string[] = ["r.outcome IS NOT NULL", "r.net_pnl IS NOT NULL"];
    const params: Record<string, unknown> = {};

    if (opts.strategy) {
      conditions.push("r.strategy_id = $strategy");
      params.$strategy = opts.strategy;
    }
    if (opts.from != null) {
      conditions.push("r.created_at >= $from");
      params.$from = opts.from;
    }
    if (opts.to != null) {
      conditions.push("r.created_at <= $to");
      params.$to = opts.to;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    return this._db.query<any, any>(`
      SELECT
        r.created_at,
        r.net_pnl,
        r.strategy_id,
        r.outcome,
        SUM(r.net_pnl) OVER (
          PARTITION BY r.strategy_id
          ORDER BY r.created_at
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative
      FROM rounds r
      ${where}
      ORDER BY r.created_at ASC
    `).all(params);
  }

  // ---------------------------------------------------------------------------
  // performance by period
  // ---------------------------------------------------------------------------

  /**
   * Aggregate performance stats grouped by the requested time period.
   * Used by the Performance panel's period selector (1D / 1W / 1M / 3M / 6M / 1Y / 3Y).
   *
   * Period   SQLite strftime format string
   * ───────  ──────────────────────────────
   * daily    %Y-%m-%d          → "2026-05-06"
   * weekly   %Y-W%W            → "2026-W18"
   * monthly  %Y-%m             → "2026-05"
   * 3m/6m/1y/3y → still grouped monthly; caller filters by `from` range
   */
  getPerformance(period: Period, strategy?: string): PerformancePeriod[] {
    // Map period to a strftime format and a lookback range in days.
    const formatMap: Record<Period, string> = {
      daily:   "%Y-%m-%d",
      weekly:  "%Y-W%W",
      monthly: "%Y-%m",
      "3m":    "%Y-%m",
      "6m":    "%Y-%m",
      "1y":    "%Y-%m",
      "3y":    "%Y-%m",
    };
    const lookbackDays: Record<Period, number | null> = {
      daily:   1,
      weekly:  7,
      monthly: 30,
      "3m":    90,
      "6m":    180,
      "1y":    365,
      "3y":    1095,
    };

    const fmt = formatMap[period];
    const days = lookbackDays[period];
    const conditions: string[] = ["r.net_pnl IS NOT NULL"];
    const params: Record<string, unknown> = { $fmt: fmt };

    if (strategy) {
      conditions.push("r.strategy_id = $strategy");
      params.$strategy = strategy;
    }
    if (days != null) {
      // Convert lookback days → Unix ms cutoff
      params.$from = Date.now() - days * 86_400_000;
      conditions.push("r.created_at >= $from");
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const rows = this._db.query<any, any>(`
      SELECT
        strftime($fmt, r.created_at / 1000, 'unixepoch') AS period,
        COUNT(r.id)                                              AS total_rounds,
        COUNT(CASE WHEN r.outcome != 'no-trade' THEN 1 END)     AS traded_rounds,
        COUNT(CASE WHEN r.outcome = 'win'  THEN 1 END)          AS win_count,
        COUNT(CASE WHEN r.outcome = 'loss' THEN 1 END)          AS loss_count,
        COALESCE(SUM(r.net_pnl),    0)                          AS total_net_pnl,
        COALESCE(SUM(r.taker_fees), 0)                          AS total_fees
      FROM rounds r
      ${where}
      GROUP BY period
      ORDER BY period ASC
    `).all(params);

    return rows.map((r: any) => ({
      ...r,
      win_rate:    r.traded_rounds > 0 ? r.win_count / r.traded_rounds : null,
      avg_net_pnl: r.traded_rounds > 0 ? r.total_net_pnl / r.traded_rounds : null,
    }));
  }

  // ---------------------------------------------------------------------------
  // strategy comparison
  // ---------------------------------------------------------------------------

  /**
   * Side-by-side stats for a list of strategy ids. Returns one row per
   * strategy with win rate, avg PnL, best/worst round, and a Sharpe
   * approximation (avg / stddev).
   *
   * Pass an empty array to compare all registered strategies.
   */
  compareStrategies(strategyIds: string[]): ComparisonRow[] {
    const condition = strategyIds.length > 0
      ? `WHERE r.strategy_id IN (${strategyIds.map(() => "?").join(",")})`
      : "";

    const rows = this._db.query<any, any>(`
      SELECT
        s.id                AS strategy_id,
        s.name,
        s.version,
        COUNT(r.id)                                               AS total_rounds,
        COUNT(CASE WHEN r.outcome != 'no-trade' THEN 1 END)      AS traded_rounds,
        COUNT(CASE WHEN r.outcome = 'win'  THEN 1 END)           AS win_count,
        COUNT(CASE WHEN r.outcome = 'loss' THEN 1 END)           AS loss_count,
        COALESCE(SUM(r.net_pnl),    0)                           AS total_net_pnl,
        MAX(r.net_pnl)                                            AS best_round,
        MIN(r.net_pnl)                                            AS worst_round,
        COALESCE(SUM(r.taker_fees), 0)                           AS total_fees,
        -- Approximate standard deviation via variance formula:
        -- stddev = sqrt(avg(x^2) - avg(x)^2)
        CASE
          WHEN COUNT(CASE WHEN r.outcome != 'no-trade' THEN 1 END) > 1
          THEN SQRT(
            AVG(r.net_pnl * r.net_pnl) -
            (AVG(r.net_pnl) * AVG(r.net_pnl))
          )
          ELSE NULL
        END AS stddev_net_pnl
      FROM strategies s
      LEFT JOIN rounds r ON r.strategy_id = s.id
      ${condition}
      GROUP BY s.id
      ORDER BY total_net_pnl DESC
    `).all(strategyIds.length > 0 ? strategyIds : []);

    return rows.map((r: any) => {
      const avg = r.traded_rounds > 0 ? r.total_net_pnl / r.traded_rounds : null;
      const sharpe = avg != null && r.stddev_net_pnl > 0
        ? avg / r.stddev_net_pnl
        : null;
      return {
        strategy_id:  r.strategy_id,
        name:         r.name,
        version:      r.version,
        total_rounds: r.total_rounds,
        traded_rounds: r.traded_rounds,
        win_count:    r.win_count,
        loss_count:   r.loss_count,
        win_rate:     r.traded_rounds > 0 ? r.win_count / r.traded_rounds : null,
        total_net_pnl: r.total_net_pnl,
        avg_net_pnl:  avg,
        best_round:   r.best_round,
        worst_round:  r.worst_round,
        total_fees:   r.total_fees,
        sharpe_approx: sharpe,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // projection input
  // ---------------------------------------------------------------------------

  /**
   * Returns the raw statistics the Monte Carlo projection needs. The actual
   * simulation runs in the dashboard server so the DB layer stays pure SQL.
   *
   * When n >= 30, `outcomes` contains all individual round net_pnl values for
   * bootstrap sampling (more accurate than Bernoulli). When n < 30, the server
   * falls back to Bernoulli with win_rate / avg_win / avg_loss.
   */
  getProjectionData(strategyId: string): ProjectionInput {
    const stats = this._db.query<any, [string]>(`
      SELECT
        COUNT(*)                                          AS n,
        COUNT(CASE WHEN outcome = 'win'  THEN 1 END)     AS win_count,
        AVG(CASE WHEN outcome = 'win'  THEN net_pnl END) AS avg_win,
        AVG(CASE WHEN outcome = 'loss' THEN net_pnl END) AS avg_loss
      FROM rounds
      WHERE strategy_id = ? AND outcome IN ('win', 'loss')
    `).get(strategyId);

    const outcomes = this._db.query<{ net_pnl: number }, [string]>(`
      SELECT net_pnl FROM rounds
      WHERE strategy_id = ? AND outcome IN ('win', 'loss')
      ORDER BY created_at ASC
    `).all(strategyId).map((r) => r.net_pnl);

    const n = stats?.n ?? 0;
    const win_count = stats?.win_count ?? 0;

    return {
      strategy_id: strategyId,
      n,
      win_rate:  n > 0 ? win_count / n : 0,
      avg_win:   stats?.avg_win  ?? 0,
      avg_loss:  stats?.avg_loss ?? 0,
      outcomes,
    };
  }

  // ---------------------------------------------------------------------------
  // live session
  // ---------------------------------------------------------------------------

  /**
   * Returns the most recently started session that has not yet ended.
   * Used by the Live panel to show current session state alongside the
   * real-time data from state/early-bird.json.
   *
   * Returns null if no session is currently running.
   */
  getLiveSession(): SessionRow | null {
    const row = this._db.query<any, []>(`
      SELECT * FROM sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `).get();

    if (!row) return null;
    return {
      ...row,
      params: row.params ? JSON.parse(row.params) : null,
    };
  }

  /**
   * Returns the N most recently completed sessions.
   * Used by the Performance panel's session history view.
   */
  listSessions(limit = 20): SessionRow[] {
    const rows = this._db.query<any, [number]>(`
      SELECT * FROM sessions
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);

    return rows.map((r: any) => ({
      ...r,
      params: r.params ? JSON.parse(r.params) : null,
    }));
  }

  // ---------------------------------------------------------------------------
  // ticks (chart replay)
  // ---------------------------------------------------------------------------

  /**
   * Fetch all tick snapshots for a given round. Used by the Round Browser
   * detail view to replay the order book and BTC price during the round.
   */
  getTicksForRound(roundId: number): TickRow[] {
    return this._db.query<TickRow, [number]>(`
      SELECT ts, btc_price, gap, up_ask, up_bid, down_ask, down_bid
      FROM ticks
      WHERE round_id = ?
      ORDER BY ts ASC
    `).all(roundId);
  }
}
