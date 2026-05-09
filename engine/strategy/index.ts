// =============================================================================
// engine/strategy/index.ts
//
// Strategy registry — the single place that maps strategy names to their
// implementation functions, version strings, and parameter schemas.
//
// HOW TO ADD A NEW STRATEGY
// ─────────────────────────
// 1. Create engine/strategy/your-strategy.ts following the pattern in
//    momentum-imbalance.ts. Export:
//      - `yourStrategy: Strategy`       — the main function
//      - `VERSION: string`              — semver (e.g. "1.0.0")
//      - `PARAMS_SCHEMA: ParamsSchema`  — all env-var knobs with defaults
//
// 2. Import the three exports below and add entries to all three maps:
//      - strategies["your-strategy"]         = yourStrategy
//      - strategyVersions["your-strategy"]   = VERSION
//      - strategyParamsSchemas["your-strategy"] = PARAMS_SCHEMA
//
// 3. Run `bun run check` to confirm no type errors.
//
// VERSIONING
// ──────────
// Bump VERSION in the strategy file whenever the trading logic changes in a
// way that would produce different results on the same market data. The DB
// records "name@version" as the strategy_id, so version bumps create a clean
// split in the dashboard comparison panel between old and new logic.
//
// Changing only env-var defaults (PARAMS_SCHEMA defaults) does NOT require a
// version bump — the per-session params snapshot handles that distinction.
// =============================================================================

import type { Strategy } from "./types.ts";
import type { ParamsSchema } from "./strategy-meta.ts";

import { simulationStrategy } from "./simulation.ts";
import { lateEntry,      VERSION as LE_VERSION,   PARAMS_SCHEMA as LE_PARAMS    } from "./late-entry.ts";
import { momentumImbalance } from "./momentum-imbalance.ts";
import { btcGapFade,    VERSION as BGF_VERSION,   PARAMS_SCHEMA as BGF_PARAMS   } from "./btc-gap-fade.ts";
import { passiveMaker,  VERSION as PM_VERSION,    PARAMS_SCHEMA as PM_PARAMS    } from "./passive-maker.ts";
import { multiLevelOfi, VERSION as MLOFI_VERSION, PARAMS_SCHEMA as MLOFI_PARAMS } from "./multi-level-ofi.ts";

// -----------------------------------------------------------------------------
// strategies
//
// Maps CLI --strategy flag values to their implementation functions.
// -----------------------------------------------------------------------------
export const strategies: Record<string, Strategy> = {
  "simulation":         simulationStrategy,
  "late-entry":         lateEntry,
  "momentum-imbalance": momentumImbalance,
  "btc-gap-fade":       btcGapFade,
  "passive-maker":      passiveMaker,
  "multi-level-ofi":    multiLevelOfi,
};

// -----------------------------------------------------------------------------
// strategyVersions
//
// Maps strategy name → current semver string.
// Used by EarlyBird to build the strategy_id for DB records ("name@version").
// Strategies without an explicit VERSION default to "1.0.0".
// -----------------------------------------------------------------------------
export const strategyVersions: Record<string, string> = {
  "simulation":         "1.0.0",
  "late-entry":         LE_VERSION,
  "momentum-imbalance": "1.0.0",
  "btc-gap-fade":       BGF_VERSION,
  "passive-maker":      PM_VERSION,
  "multi-level-ofi":    MLOFI_VERSION,
};

// -----------------------------------------------------------------------------
// strategyParamsSchemas
//
// Maps strategy name → its PARAMS_SCHEMA export (or null for strategies that
// predate the schema system). Used by DbHooks to snapshot env-var values at
// session start so the DB records exactly what configuration was in effect.
// -----------------------------------------------------------------------------
export const strategyParamsSchemas: Record<string, ParamsSchema | null> = {
  "simulation":         null,
  "late-entry":         LE_PARAMS,
  "momentum-imbalance": null,
  "btc-gap-fade":       BGF_PARAMS,
  "passive-maker":      PM_PARAMS,
  "multi-level-ofi":    MLOFI_PARAMS,
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export const DEFAULT_STRATEGY = "simulation";

export type { Strategy, StrategyContext } from "./types.ts";
