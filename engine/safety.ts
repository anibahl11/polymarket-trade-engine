import { Env } from "../utils/config.ts";
import { log } from "./log.ts";

export type SafetyMode = { live: boolean; reason: string };

export type SafetyTag = "SIM" | "LIVE" | "blocked" | "shutdown";

export function resolveSafetyMode(input: {
  prodFlag: boolean;
  dryRun: boolean;
  envSimulationMode: boolean;
}): SafetyMode {
  if (input.dryRun) {
    return { live: false, reason: "--dry-run forces simulation" };
  }
  if (input.envSimulationMode) {
    return { live: false, reason: "SIMULATION_MODE=true (default)" };
  }
  if (!input.prodFlag) {
    return { live: false, reason: "--prod not passed" };
  }
  return {
    live: true,
    reason: "live trading: --prod && SIMULATION_MODE=false",
  };
}

export function printStartupBanner(mode: SafetyMode): void {
  const bar = "=".repeat(72);
  if (mode.live) {
    const red = "\x1b[41m\x1b[97m";
    const reset = "\x1b[0m";
    console.log(
      `${red}${bar}\n` +
      `  ⚠️  LIVE TRADING — REAL MONEY AT RISK\n` +
      `  ${mode.reason}\n` +
      `  All orders go to the real Polymarket CLOB. Losses are permanent.\n` +
      `${bar}${reset}`,
    );
  } else {
    const green = "\x1b[42m\x1b[30m";
    const reset = "\x1b[0m";
    console.log(
      `${green}${bar}\n` +
      `  📋 PAPER TRADING — simulated balance, no real orders sent\n` +
      `  ${mode.reason}\n` +
      `  Wallet balance is virtual. Connect a real wallet to go live.\n` +
      `${bar}${reset}`,
    );
  }
}

/**
 * Defense-in-depth gate. Re-reads SIMULATION_MODE on every call so a
 * misconfigured run cannot smuggle live orders out, even if the prod client
 * was somehow instantiated. Throws if SIMULATION_MODE is not exactly "false".
 */
export function assertLiveOrdersAllowed(callsite: string): void {
  if (process.env.SIMULATION_MODE !== "false") {
    throw new Error(
      `[SAFETY] ${callsite} attempted while SIMULATION_MODE!=false. ` +
        `Refusing to send live orders. Set SIMULATION_MODE=false AND pass ` +
        `--prod to enable live trading.`,
    );
  }
}

export function modeTag(): "SIM" | "LIVE" {
  return process.env.SIMULATION_MODE === "false" ? "LIVE" : "SIM";
}

/**
 * Returns true if the proposed buy cost exceeds MAX_POSITION_PCT of bankroll.
 * Returns false (allowed) when MAX_POSITION_PCT <= 0 or balance is not finite.
 */
export function exceedsMaxPosition(cost: number, balance: number): boolean {
  const pct = Env.get("MAX_POSITION_PCT");
  if (pct <= 0) return false;
  if (!isFinite(balance) || balance <= 0) return false;
  return cost / balance > pct;
}

export function safetyLog(
  tag: SafetyTag,
  action: string,
  details: Record<string, unknown> = {},
): void {
  const rec = { ts: new Date().toISOString(), tag, action, ...details };
  log.write(`[safety] ${JSON.stringify(rec)}`, "cyan");
}

/** Returns the current UTC date as YYYY-MM-DD. Used for daily loss bucketing. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
