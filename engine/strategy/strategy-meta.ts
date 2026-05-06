// =============================================================================
// strategy-meta.ts
//
// Shared interface contract for all strategies in this engine.
//
// Every strategy file must export:
//   - VERSION: a semver string identifying the strategy release (e.g. "1.0.0")
//   - PARAMS_SCHEMA: a flat map of every env-var knob the strategy reads,
//     with its default value and a human-readable description.
//
// The VERSION + PARAMS_SCHEMA pair is used by the DB layer to:
//   1. Register the strategy in the `strategies` table on first run.
//   2. Snapshot the exact env-var values in effect for each session, so you
//      can compare runs across different param sets without code changes.
//   3. Build a stable strategy_id ("name@version") that links every round
//      in the `rounds` table back to the exact strategy release that traded it.
//
// Bumping VERSION creates a new strategy_id, giving you a clean split in the
// comparison dashboard between old and new logic. Changing env vars without
// bumping version records a different params snapshot under the same id — you
// can diff params in the dashboard to see what changed between sessions.
// =============================================================================

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * A single knob exposed by a strategy.
 *
 * `default` is the value used when the env var is absent. Type is inferred
 * from the default: string, number, or boolean. Arrays are not supported here
 * (use a comma-separated string default and parse inside the strategy).
 */
export type ParamDef =
  | { default: number; description: string }
  | { default: boolean; description: string }
  | { default: string; description: string };

/**
 * The full schema for a strategy's configurable parameters. Keys are the
 * exact env-var names the strategy reads (e.g. "BGF_GAP_THRESHOLD").
 */
export type ParamsSchema = Record<string, ParamDef>;

/**
 * Contract every strategy module must satisfy.
 * Import this type in your strategy file to get compile-time enforcement.
 *
 * @example
 * ```ts
 * import type { StrategyMeta } from "./strategy-meta.ts";
 *
 * export const VERSION: StrategyMeta["VERSION"] = "1.0.0";
 * export const PARAMS_SCHEMA: StrategyMeta["PARAMS_SCHEMA"] = { ... };
 * ```
 */
export interface StrategyMeta {
  /** Semver string — bump when logic changes. */
  VERSION: string;
  /**
   * All env-var knobs this strategy reads, with defaults and descriptions.
   * Used by snapshotParams() at session start to record what values were
   * actually in effect.
   */
  PARAMS_SCHEMA: ParamsSchema;
}

// -----------------------------------------------------------------------------
// snapshotParams
// -----------------------------------------------------------------------------

/**
 * Read every env var listed in `schema` from `process.env`, falling back to
 * its declared default. Returns a plain object suitable for JSON serialization
 * into the `strategies.params` DB column.
 *
 * Call this once at session start so the DB records the exact configuration
 * that was in effect — not just the schema defaults.
 *
 * @example
 * ```ts
 * const snapshot = snapshotParams(PARAMS_SCHEMA);
 * // { BGF_GAP_THRESHOLD: 30, BGF_FADE_RATIO: 0.85, ... }
 * writer.upsertStrategy(id, name, version, description, snapshot);
 * ```
 */
export function snapshotParams(schema: ParamsSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(schema)) {
    const raw = process.env[key];

    if (raw === undefined) {
      // No override: use the schema default as-is.
      result[key] = def.default;
      continue;
    }

    // Coerce the raw string to the same type as the default.
    if (typeof def.default === "number") {
      const n = parseFloat(raw);
      result[key] = isNaN(n) ? def.default : n;
    } else if (typeof def.default === "boolean") {
      result[key] = raw === "true";
    } else {
      result[key] = raw;
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// buildStrategyId
// -----------------------------------------------------------------------------

/**
 * Constructs the canonical strategy identifier used as a primary key in the
 * `strategies` DB table and as a foreign key in `rounds`.
 *
 * Format: "name@version"  (e.g. "btc-gap-fade@1.0.0")
 *
 * If `version` is missing or empty, falls back to "0.0.0" so a poorly
 * configured strategy never causes a DB constraint violation.
 */
export function buildStrategyId(name: string, version: string): string {
  return `${name}@${version || "0.0.0"}`;
}
