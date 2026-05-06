import { Command } from "commander";
import * as readline from "readline";
import { EarlyBird } from "./engine/early-bird.ts";
import { strategies, DEFAULT_STRATEGY } from "./engine/strategy/index.ts";
import { acquireProcessLock } from "./utils/process-lock.ts";
import { Env } from "./utils/config.ts";
import {
  resolveSafetyMode,
  printStartupBanner,
} from "./engine/safety.ts";

const program = new Command()
  .description(
    "Automated trading engine for Polymarket binary prediction markets (e.g. BTC Up/Down 5-minute)",
  )
  .option(
    "-s, --strategy <name>",
    `Strategy to run (${Object.keys(strategies).join(", ")})`,
    DEFAULT_STRATEGY,
  )
  .option(
    "--slot-offset <n>",
    "Which future market slot to pre-enter or trade in current market (1 = next slot, 2 = slot after next, …)",
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1)
        throw new Error("--slot-offset must be a positive integer");
      return n;
    },
    1,
  )
  .option(
    "--prod",
    "Run against the real Polymarket CLOB (also requires SIMULATION_MODE=false)",
  )
  .option(
    "--dry-run",
    "Force simulation mode regardless of --prod and SIMULATION_MODE env",
  )
  .option(
    "--rounds <n>",
    "Number of market rounds to trade then exit (0 = recover existing only, omit for unlimited)",
    (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0)
        throw new Error("--rounds must be a non-negative integer");
      return n;
    },
  )
  .option(
    "--always-log",
    "Always write the slot log file even if no market was entered (useful for debugging)",
  )
  .parse();

const opts = program.opts<{
  strategy: string;
  slotOffset: number;
  prod?: boolean;
  dryRun?: boolean;
  rounds?: number;
  alwaysLog?: boolean;
}>();

// LOCK_NAME can be overridden via env so the dashboard can run multiple
// per-strategy instances without lock conflicts.
acquireProcessLock(process.env.LOCK_NAME ?? "early-bird");

if (!strategies[opts.strategy]) {
  console.error(`Unknown strategy: "${opts.strategy}"`);
  console.error(`Available: ${Object.keys(strategies).join(", ")}`);
  process.exit(1);
}

const mode = resolveSafetyMode({
  prodFlag: opts.prod ?? false,
  dryRun: opts.dryRun ?? false,
  envSimulationMode: Env.get("SIMULATION_MODE"),
});

printStartupBanner(mode);

if (opts.prod && opts.dryRun) {
  console.log(
    "\x1b[33mNote: --prod is ignored because --dry-run was passed.\x1b[0m",
  );
}

if (mode.live && process.env.FORCE_PROD !== "true") {
  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      "Run in PRODUCTION mode with real funds? Enter Y to confirm: ",
      (ans) => {
        rl.close();
        resolve(ans);
      },
    );
  });

  if (answer !== "Y") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// Keep PROD env aligned with the resolved mode so downstream consumers
// (per-strategy guards, recovery, logs) see a consistent signal.
process.env.PROD = mode.live ? "true" : "false";
// Re-affirm SIMULATION_MODE to whatever resolution decided so the
// defense-in-depth gate in client.ts agrees with the banner.
process.env.SIMULATION_MODE = mode.live ? "false" : "true";

const rounds = opts.rounds !== undefined ? opts.rounds : null;
const bot = new EarlyBird(
  opts.strategy,
  opts.slotOffset,
  mode.live,
  rounds,
  opts.alwaysLog ?? false,
);
await bot.start();
