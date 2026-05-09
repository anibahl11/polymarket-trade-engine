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
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DbReader } from "../db/reader.ts";
import type { ProjectionInput } from "../db/reader.ts";

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000", 10);
const DB_PATH = "state/performance.db";
const ENV_PATH = ".env";

// All available strategy names (mirrors engine/strategy/index.ts registry).
const ALL_STRATEGIES = [
  "simulation",
  "late-entry",
  "momentum-imbalance",
  "btc-gap-fade",
  "passive-maker",
  "multi-level-ofi",
] as const;

// -----------------------------------------------------------------------------
// Engine process manager
// -----------------------------------------------------------------------------

type EngineStatus = {
  strategy: string;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
};

// One child process per strategy. Keyed by strategy name.
const engineProcs = new Map<string, {
  proc: ReturnType<typeof Bun.spawn>;
  startedAt: number;
}>();

function getEngineStatuses(): EngineStatus[] {
  return ALL_STRATEGIES.map((strategy) => {
    const entry = engineProcs.get(strategy);
    if (!entry) return { strategy, running: false, pid: null, startedAt: null, exitCode: null };
    // Bun subprocess: exitCode is null while running, a number once exited
    const exitCode = entry.proc.exitCode;
    const running = exitCode === null;
    if (!running) engineProcs.delete(strategy); // reap finished procs
    return {
      strategy,
      running,
      pid: running ? entry.proc.pid : null,
      startedAt: running ? entry.startedAt : null,
      exitCode: running ? null : exitCode,
    };
  });
}

function startEngine(strategy: string): { ok: boolean; error?: string } {
  if (!(ALL_STRATEGIES as readonly string[]).includes(strategy)) {
    return { ok: false, error: `Unknown strategy: ${strategy}` };
  }
  const existing = engineProcs.get(strategy);
  if (existing && existing.proc.exitCode === null) {
    return { ok: false, error: `${strategy} is already running` };
  }

  // Determine the project root (one level up from dashboard/).
  const root = join(import.meta.dir, "..");
  const entrypoint = join(root, "index.ts");

  // Per-strategy state file keeps sessions isolated.
  // PERF_DB=true so rounds are recorded; FORCE_PROD skips the readline prompt.
  const proc = Bun.spawn(
    ["bun", "run", entrypoint, "--strategy", strategy],
    {
      cwd: root,
      env: {
        ...process.env,
        PERF_DB: "true",
        SIMULATION_MODE: "true",
        FORCE_PROD: "false",
        // Unique lock name so each strategy gets its own PID file.
        LOCK_NAME: `early-bird-${strategy}`,
        // Per-strategy state file to avoid clobbering each other.
        STATE_FILE: `state/early-bird-${strategy}.json`,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  engineProcs.set(strategy, { proc, startedAt: Date.now() });
  console.log(`[engines] Started ${strategy} (PID ${proc.pid})`);
  return { ok: true };
}

function stopEngine(strategy: string): { ok: boolean; error?: string } {
  const entry = engineProcs.get(strategy);
  if (!entry || entry.proc.exitCode !== null) {
    engineProcs.delete(strategy);
    return { ok: false, error: `${strategy} is not running` };
  }
  entry.proc.kill("SIGTERM");
  console.log(`[engines] Sent SIGTERM to ${strategy} (PID ${entry.proc.pid})`);
  return { ok: true };
}

// Clean up all child processes when the dashboard exits.
process.on("exit", () => {
  for (const [strategy, entry] of engineProcs) {
    if (entry.proc.exitCode === null) {
      entry.proc.kill("SIGTERM");
      console.log(`[engines] Sent SIGTERM to ${strategy} on dashboard exit`);
    }
  }
});

// Safe-to-expose config keys (no credentials)
const CONFIG_WHITELIST = new Set([
  "MARKET_ASSET",
  "MARKET_WINDOW",
  "SIMULATION_MODE",
  "WALLET_BALANCE",
  "MAX_SESSION_LOSS",
  "MAX_POSITION_PCT",
  "MAX_DRAWDOWN_PCT",
  "DAILY_LOSS_LIMIT",
  "SIM_PARTIAL_FILL_PROB",
  "SIM_SLIPPAGE_BPS",
  "SIM_LATENCY_JITTER_MS",
  "SIM_NETWORK_FAIL_PROB",
]);

// -----------------------------------------------------------------------------
// DB helpers
// -----------------------------------------------------------------------------

function openReadonlyDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new Database(DB_PATH, { readonly: true });
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
  walletStart = 50,
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

  // Annualized return: CAGR based on median final PnL relative to starting balance.
  // Formula: (1 + totalReturn)^(365/days) - 1  where totalReturn = medianFinal / walletStart
  const medianFinal = steps[days]!.p50;
  let annualizedReturn: number | null = null;
  if (days >= 7 && walletStart > 0) {
    const totalReturn = medianFinal / walletStart;
    // Compound annual growth rate (handles both positive and negative returns)
    annualizedReturn = Math.pow(1 + totalReturn, 365 / days) - 1;
  }

  // Max drawdown on median path (as absolute dollar amount from peak).
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
  const session = withReader((r) => r.getLiveSession(), null);

  type PartialState = {
    sessionPnl?: number;
    balance?: number | null;
    activeMarkets?: unknown[];
    completedMarkets?: unknown[];
  };

  type StrategyState = {
    strategy: string;
    sessionPnl: number;
    balance: number | null;
  };

  const stateJson: {
    sessionPnl: number;
    balance: number | null;
    activeMarkets: unknown[];
    completedMarkets: unknown[];
    strategyStates: StrategyState[];
  } = { sessionPnl: 0, balance: null, activeMarkets: [], completedMarkets: [], strategyStates: [] };

  const seenPaths = new Set<string>();

  for (const strategy of ALL_STRATEGIES) {
    const candidates = [
      `state/early-bird-${strategy}.json`,
      "state/early-bird.json",
    ];
    for (const p of candidates) {
      if (seenPaths.has(p) || !existsSync(p)) continue;
      seenPaths.add(p);
      try {
        const s = JSON.parse(readFileSync(p, "utf-8")) as PartialState;
        const pnl = s.sessionPnl ?? 0;
        const bal = typeof s.balance === "number" ? s.balance : null;
        stateJson.sessionPnl += pnl;
        if (bal !== null) stateJson.balance = (stateJson.balance ?? 0) + bal;
        stateJson.activeMarkets.push(...(s.activeMarkets ?? []));
        stateJson.completedMarkets.push(...(s.completedMarkets ?? []));
        stateJson.strategyStates.push({ strategy, sessionPnl: pnl, balance: bal });
      } catch {}
      break;
    }
  }

  return json({ session, state: stateJson, engines: getEngineStatuses() });
}

function handleEnginesGet(): Response {
  return json(getEngineStatuses());
}

async function handleEnginesPost(req: Request): Promise<Response> {
  let body: { action: "start" | "stop"; strategy: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.action || !body.strategy) {
    return json({ error: "Required fields: action, strategy" }, 400);
  }
  if (body.action === "start") return json(startEngine(body.strategy));
  if (body.action === "stop")  return json(stopEngine(body.strategy));
  return json({ error: `Unknown action: ${body.action}` }, 400);
}

function handleCompare(url: URL): Response {
  const raw = url.searchParams.get("strategies") ?? "";
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const rows = withReader((r) => r.compareStrategies(ids), []);
  const allCurves = ids.length > 0
    ? Object.fromEntries(ids.map((id) => [
        id,
        withReader((r) => r.getEquityCurve({ strategy: id }), []),
      ]))
    : withReader((r) => {
        const all = r.listStrategies().map((s) => s.id);
        return Object.fromEntries(all.map((id) => [id, r.getEquityCurve({ strategy: id })]));
      }, {});
  return json({ rows, curves: allCurves });
}

function handleProjections(url: URL): Response {
  const strategyId = url.searchParams.get("strategy");
  if (!strategyId) return json({ error: "strategy param required" }, 400);

  const input = withReader((r) => r.getProjectionData(strategyId), {
    strategy_id: strategyId, n: 0, win_rate: 0, avg_win: 0, avg_loss: 0, outcomes: [],
  });

  // Use the wallet_start from the strategy's first session as the baseline.
  const walletStart = withReader((r) => r.getWalletStartForStrategy(strategyId), null)
    ?? parseFloat(process.env.WALLET_BALANCE ?? "50");

  const periodDays: Record<string, number> = {
    "1d": 1, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365, "3y": 1095,
  };

  const results: Record<string, MonteCarloResult> = {};
  for (const [key, days] of Object.entries(periodDays)) {
    results[key] = monteCarlo(input, days, 12, 1000, walletStart);
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

  return json({ input, projections: results, kelly, quarterKelly: kelly != null ? kelly / 4 : null, breakEven, walletStart });
}

// -----------------------------------------------------------------------------
// Config handlers
// -----------------------------------------------------------------------------

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip inline comment from value
    let val = trimmed.slice(eq + 1).trim();
    const commentIdx = val.indexOf(" #");
    if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    result[key] = val;
  }
  return result;
}

function handleGetConfig(): Response {
  const defaults: Record<string, string> = {
    MARKET_ASSET: "btc",
    MARKET_WINDOW: "5m",
    SIMULATION_MODE: "true",
    WALLET_BALANCE: "50",
    MAX_SESSION_LOSS: "3",
    MAX_POSITION_PCT: "0.05",
    MAX_DRAWDOWN_PCT: "0.20",
    DAILY_LOSS_LIMIT: "0",
    SIM_PARTIAL_FILL_PROB: "0",
    SIM_SLIPPAGE_BPS: "0",
    SIM_LATENCY_JITTER_MS: "0",
    SIM_NETWORK_FAIL_PROB: "0",
  };

  let fileValues: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    try {
      fileValues = parseEnvFile(readFileSync(ENV_PATH, "utf-8"));
    } catch {}
  }

  const config: Record<string, string> = {};
  for (const key of CONFIG_WHITELIST) {
    config[key] = fileValues[key] ?? process.env[key] ?? defaults[key] ?? "";
  }
  return json(config);
}

async function handlePostConfig(req: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    body = await req.json() as Record<string, string>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Reject any keys not in the whitelist
  for (const key of Object.keys(body)) {
    if (!CONFIG_WHITELIST.has(key)) {
      return json({ error: `Forbidden key: ${key}` }, 403);
    }
  }

  // Read current .env (or start with empty string)
  let content = "";
  if (existsSync(ENV_PATH)) {
    try { content = readFileSync(ENV_PATH, "utf-8"); } catch {}
  }

  const updated = new Set<string>();
  const lines = content.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in body && CONFIG_WHITELIST.has(key)) {
      updated.add(key);
      return `${key}=${body[key]}`;
    }
    return line;
  });

  // Append any keys that weren't already in the file
  for (const [key, val] of Object.entries(body)) {
    if (!updated.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }

  try {
    writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  } catch (e) {
    return json({ error: `Failed to write .env: ${e}` }, 500);
  }

  return json({ ok: true });
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
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
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
      if (pathname === "/api/engines" && req.method === "GET")  return handleEnginesGet();
      if (pathname === "/api/engines" && req.method === "POST") return await handleEnginesPost(req);
      if (pathname === "/api/config" && req.method === "GET")  return handleGetConfig();
      if (pathname === "/api/config" && req.method === "POST") return await handlePostConfig(req);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("[dashboard] Route error:", e);
      return json({ error: String(e) }, 500);
    }
  },
});

console.log(`[dashboard] Server running at http://localhost:${server.port}`);
console.log(`[dashboard] DB path: ${DB_PATH}`);
console.log(`[dashboard] Watching state: state/early-bird-<strategy>.json`);
