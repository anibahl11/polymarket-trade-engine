// =============================================================================
// dashboard/server.ts
//
// Bun HTTP server for the performance dashboard.
//
// Usage:
//   bun dashboard/server.ts
//   DASHBOARD_PORT=3001 bun dashboard/server.ts
//
// The server opens state/performance.db in READONLY mode so it can never
// accidentally mutate engine state. If the DB does not yet exist (engine has
// never run), all API routes return empty arrays / null with a 200 status.
//
// Monte Carlo projections are computed server-side in /api/projections so the
// browser receives ready-to-chart percentile curves.
//
// CORS: Access-Control-Allow-Origin: * so the HTML file can be opened from
// file:// or a different port during development.
// =============================================================================

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DbReader } from "../db/reader.ts";
import { runMigrations } from "../db/schema.ts";
import type { ProjectionInput } from "../db/reader.ts";

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000", 10);
const DB_PATH = "state/performance.db";
const STATE_PATH = "state/early-bird.json";

// -----------------------------------------------------------------------------
// DB helpers
// -----------------------------------------------------------------------------

function openReadonlyDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    // Run migrations in readonly mode — this is a no-op if tables exist,
    // but errors if the file is a fresh DB that hasn't been initialized.
    // Swallow the error: we'll just return empty data.
    try { runMigrations(db); } catch {}
    return db;
  } catch {
    return null;
  }
}

function withReader<T>(fn: (reader: DbReader) => T, fallback: T): T {
  const db = openReadonlyDb();
  if (!db) return fallback;
  try {
    return fn(new DbReader(db));
  } catch (e) {
    console.warn("[dashboard] DB read error:", e);
    return fallback;
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------------
// Monte Carlo projection
// -----------------------------------------------------------------------------

type MonteCarloResult = {
  steps: Array<{ day: number; p10: number; p50: number; p90: number }>;
  annualizedReturn: number | null;
  maxDrawdownP50: number;
  confidence: "high" | "low";
  tradesPerDay: number;
};

function monteCarlo(
  input: ProjectionInput,
  days: number,
  tradesPerDay = 12,
  paths = 1000,
): MonteCarloResult {
  const { n, win_rate, avg_win, avg_loss, outcomes } = input;
  const useBootstrap = n >= 30;
  const confidence = useBootstrap ? "high" : "low";

  // Build one simulated path: `days` days, `tradesPerDay` trades each.
  const simulatePath = (): number[] => {
    const equity: number[] = [0];
    let cum = 0;
    for (let d = 0; d < days; d++) {
      for (let t = 0; t < tradesPerDay; t++) {
        let trade: number;
        if (useBootstrap) {
          trade = outcomes[Math.floor(Math.random() * outcomes.length)]!;
        } else {
          trade = Math.random() < win_rate ? avg_win : avg_loss;
        }
        cum += trade;
      }
      equity.push(cum);
    }
    return equity;
  };

  // Run all paths and collect per-step values.
  const pathResults: number[][] = Array.from({ length: paths }, simulatePath);

  const steps = Array.from({ length: days + 1 }, (_, i) => {
    const vals = pathResults.map((p) => p[i]!).sort((a, b) => a - b);
    return {
      day: i,
      p10: vals[Math.floor(paths * 0.1)]!,
      p50: vals[Math.floor(paths * 0.5)]!,
      p90: vals[Math.floor(paths * 0.9)]!,
    };
  });

  // Annualized return: median final value / 365 days annualized.
  const medianFinal = steps[days]!.p50;
  // Treat starting balance as the WALLET_START from the latest session.
  const annualizedReturn = days >= 7 ? (medianFinal / days) * 365 : null;

  // Max drawdown on median path.
  const medianPath = pathResults[Math.floor(paths * 0.5)] ?? pathResults[0]!;
  let peak = 0;
  let maxDd = 0;
  for (const v of medianPath) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }

  return { steps, annualizedReturn, maxDrawdownP50: maxDd, confidence, tradesPerDay };
}

// -----------------------------------------------------------------------------
// JSON response helpers
// -----------------------------------------------------------------------------

const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// -----------------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------------

function handleStrategies(): Response {
  return json(withReader((r) => r.listStrategies(), []));
}

function handleRounds(url: URL): Response {
  const strategy = url.searchParams.get("strategy") ?? undefined;
  const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : undefined;
  const to   = url.searchParams.has("to")   ? Number(url.searchParams.get("to"))   : undefined;
  const outcome = url.searchParams.get("outcome") ?? undefined;
  const limit  = url.searchParams.has("limit")  ? Number(url.searchParams.get("limit"))  : 50;
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  return json(withReader((r) => r.listRounds({ strategy, from, to, outcome, limit, offset }), []));
}

function handlePerformance(url: URL): Response {
  const period = (url.searchParams.get("period") ?? "daily") as any;
  const strategy = url.searchParams.get("strategy") ?? undefined;
  return json(withReader((r) => r.getPerformance(period, strategy), []));
}

function handleEquityCurve(url: URL): Response {
  const strategy = url.searchParams.get("strategy") ?? undefined;
  const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : undefined;
  const to   = url.searchParams.has("to")   ? Number(url.searchParams.get("to"))   : undefined;
  return json(withReader((r) => r.getEquityCurve({ strategy, from, to }), []));
}

function handleLive(): Response {
  // DB session + state file JSON for real-time display.
  const session = withReader((r) => r.getLiveSession(), null);
  let stateJson: unknown = null;
  if (existsSync(STATE_PATH)) {
    try { stateJson = JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch {}
  }
  return json({ session, state: stateJson });
}

function handleCompare(url: URL): Response {
  const raw = url.searchParams.get("strategies") ?? "";
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const rows    = withReader((r) => r.compareStrategies(ids), []);
  const curves  = withReader((r) => r.getEquityCurve({ strategy: ids[0] }), []);
  // Per-strategy equity curves for the overlay chart.
  const allCurves = ids.length > 0
    ? Object.fromEntries(ids.map((id) => [
        id,
        withReader((r) => r.getEquityCurve({ strategy: id }), []),
      ]))
    : withReader((r) => {
        const all = r.listStrategies().map((s) => s.id);
        return Object.fromEntries(all.map((id) => [id, r.getEquityCurve({ strategy: id })]));
      }, {});
  void curves;
  return json({ rows, curves: allCurves });
}

function handleProjections(url: URL): Response {
  const strategyId = url.searchParams.get("strategy");
  if (!strategyId) return json({ error: "strategy param required" }, 400);

  const input = withReader((r) => r.getProjectionData(strategyId), {
    strategy_id: strategyId, n: 0, win_rate: 0, avg_win: 0, avg_loss: 0, outcomes: [],
  });

  const periodDays: Record<string, number> = {
    "1d": 1, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365, "3y": 1095,
  };

  const results: Record<string, MonteCarloResult> = {};
  for (const [key, days] of Object.entries(periodDays)) {
    results[key] = monteCarlo(input, days);
  }

  // Kelly fraction for UI display.
  let kelly: number | null = null;
  if (input.avg_win > 0 && input.avg_loss < 0 && input.win_rate > 0) {
    const b = input.avg_win / Math.abs(input.avg_loss);
    const k = input.win_rate - (1 - input.win_rate) / b;
    kelly = Math.max(0, k);
  }

  // Break-even win rate.
  const breakEven = input.avg_win > 0 && input.avg_loss < 0
    ? Math.abs(input.avg_loss) / (input.avg_win + Math.abs(input.avg_loss))
    : null;

  return json({ input, projections: results, kelly, quarterKelly: kelly != null ? kelly / 4 : null, breakEven });
}

// Serve the dashboard HTML file.
function handleRoot(): Response {
  const path = join(import.meta.dir, "index.html");
  if (!existsSync(path)) {
    return new Response("dashboard/index.html not found", { status: 404 });
  }
  return new Response(Bun.file(path), { headers: { "Content-Type": "text/html" } });
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
    }

    try {
      if (pathname === "/" || pathname === "/index.html")   return handleRoot();
      if (pathname === "/api/strategies")                  return handleStrategies();
      if (pathname === "/api/rounds")                      return handleRounds(url);
      if (pathname === "/api/performance")                 return handlePerformance(url);
      if (pathname === "/api/equity-curve")                return handleEquityCurve(url);
      if (pathname === "/api/live")                        return handleLive();
      if (pathname === "/api/compare")                     return handleCompare(url);
      if (pathname === "/api/projections")                 return handleProjections(url);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error("[dashboard] Route error:", e);
      return json({ error: String(e) }, 500);
    }
  },
});

console.log(`[dashboard] Server running at http://localhost:${server.port}`);
console.log(`[dashboard] DB path: ${DB_PATH}`);
console.log(`[dashboard] Watching state: ${STATE_PATH}`);
