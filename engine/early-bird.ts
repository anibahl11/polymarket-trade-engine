import { APIQueue } from "../tracker/api-queue.ts";
import type { EarlyBirdClient } from "./client.ts";
import { EarlyBirdSimClient, PolymarketEarlyBirdClient } from "./client.ts";
import { MarketLifecycle } from "./market-lifecycle.ts";
import {
  loadState,
  saveState,
  type CompletedMarketState,
  type DailyLossState,
} from "./state.ts";
import { getSlug } from "../utils/slot.ts";
import { log } from "./log.ts";
import { recover } from "./recovery.ts";
import {
  strategies,
  strategyVersions,
  strategyParamsSchemas,
  DEFAULT_STRATEGY,
  type Strategy,
} from "./strategy/index.ts";
import { WalletTracker } from "./wallet-tracker.ts";
import { TickerTracker } from "../tracker/ticker";
import { Env } from "../utils/config.ts";
import { modeTag, safetyLog, utcDate } from "./safety.ts";
import { DbHooks } from "./db-hooks.ts";

const SAVE_INTERVAL_MS = 5000;
// Set PERF_DB=true to enable performance database recording.
const PERF_DB_ENABLED = process.env.PERF_DB === "true";

export class EarlyBird {
  private _lifecycles = new Map<string, MarketLifecycle>();
  private _completedSlugs = new Set<string>();
  private _completedMarkets: CompletedMarketState[] = [];
  private _client: EarlyBirdClient;
  private _apiQueue = new APIQueue();
  private _sessionPnl = 0;
  private _sessionLoss = 0;
  private _shuttingDown = false;
  private _lastSaveMs = 0;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _slotOffset: number;

  private readonly _statePath: string;
  private readonly _rounds: number | null; // null = unlimited
  private readonly _prod: boolean;
  private readonly _minSessionPnl: number;
  private readonly _alwaysLog: boolean;
  private _roundsCreated = 0;
  private _tracker!: WalletTracker;
  private _ticker = new TickerTracker();
  private _initialBalance = 0;
  private _daily: DailyLossState = { date: utcDate(), lossToday: 0 };
  private _dbHooks: DbHooks | null = null;

  constructor(
    strategyName?: string,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
    alwaysLog = false,
  ) {
    this._prod = prod;
    // STATE_FILE env lets the dashboard spawn multiple per-strategy instances
    // with isolated state, without conflicts.
    this._statePath = process.env.STATE_FILE
      ?? (prod ? "state/early-bird-prod.json" : "state/early-bird.json");
    this._rounds = rounds;
    this._strategyName = strategyName ?? DEFAULT_STRATEGY;
    this._strategy = strategies[this._strategyName]!;
    this._slotOffset = slotOffset;
    this._alwaysLog = alwaysLog;
    this._minSessionPnl = parseFloat(process.env.MAX_SESSION_LOSS ?? "3");
    if (prod) {
      this._client = new PolymarketEarlyBirdClient();
    } else {
      this._client = new EarlyBirdSimClient((tokenId) => {
        for (const lifecycle of this._lifecycles.values()) {
          const snap = lifecycle.getBookSnapshot(tokenId);
          if (snap) return snap;
        }
        return {
          bestAsk: null,
          bestAskLiquidity: null,
          bestBid: null,
          bestBidLiquidity: null,
        };
      });
    }
  }

  async start(): Promise<void> {
    log.write("[startup] Starting");
    this._ticker.schedule();
    await this._ticker.waitForReady();
    log.write(`[startup] ${Env.getAssetConfig().apiSymbol} ticker ready`);

    await this._client.init();

    // Seed wallet tracker
    let initialBalance: number;
    if (this._prod) {
      await this._client.updateUSDCBalance();
      initialBalance = await this._client.getUSDCBalance();
      log.write(`[startup] On-chain balance: $${initialBalance.toFixed(2)}`);
      if (initialBalance === 0) {
        console.error(
          "Wallet balance is $0.00. Fund your funder wallet with pUSD before starting the engine.\n" +
          "Run `bun scripts/pusd.ts wrap` to convert USDC.e → pUSD, or see docs/MIGRATE_V2.md.",
        );
        process.exit(1);
      }
    } else {
      initialBalance = parseFloat(process.env.WALLET_BALANCE ?? "50");
      log.write(`[startup] PAPER TRADING — simulated balance: $${initialBalance.toFixed(2)} (not real money)`, "yellow");
    }
    this._initialBalance = initialBalance;
    this._tracker = new WalletTracker(initialBalance, (msg) =>
      log.write(msg, "dim"),
    );

    // Initialise performance DB hooks if opted in via PERF_DB=true.
    if (PERF_DB_ENABLED) {
      const schema = strategyParamsSchemas[this._strategyName] ?? null;
      this._dbHooks = new DbHooks(this._ticker, null, schema);
      const version = strategyVersions[this._strategyName] ?? "0.0.0";
      this._dbHooks.onSessionStart(this._strategyName, version, initialBalance);
      log.write(`[startup] Performance DB recording (strategy: ${this._strategyName}@${version}, mode: ${this._prod ? "LIVE" : "SIM"})`, "dim");
    }

    log.write(
      `[startup] Min session PnL exit: $${this._minSessionPnl.toFixed(2)}`,
    );
    log.write(
      `[startup] Risk gates: MAX_POSITION_PCT=${(Env.get("MAX_POSITION_PCT") * 100).toFixed(2)}% ` +
        `MAX_DRAWDOWN_PCT=${(Env.get("MAX_DRAWDOWN_PCT") * 100).toFixed(2)}% ` +
        `DAILY_LOSS_LIMIT=$${Env.get("DAILY_LOSS_LIMIT").toFixed(2)}`,
    );

    const state = loadState(this._statePath);
    if (state) {
      log.write(`[startup] Loading state from ${this._statePath}`);
      this._sessionPnl = state.sessionPnl;
      this._sessionLoss = state.sessionLoss ?? 0;

      // Hydrate daily-loss bucket; reset if persisted date is not today.
      const today = utcDate();
      if (state.daily && state.daily.date === today) {
        this._daily = { date: today, lossToday: state.daily.lossToday };
      } else {
        this._daily = { date: today, lossToday: 0 };
      }

      const dailyLimit = Env.get("DAILY_LOSS_LIMIT");
      if (
        dailyLimit > 0 &&
        Math.abs(this._daily.lossToday) >= dailyLimit
      ) {
        log.write(
          `[startup] Daily loss for ${this._daily.date} ($${this._daily.lossToday.toFixed(2)}) already meets or exceeds DAILY_LOSS_LIMIT ($${dailyLimit.toFixed(2)}). ` +
            `Wait until UTC midnight, raise DAILY_LOSS_LIMIT, or reset "daily" in ${this._statePath}.`,
          "red",
        );
        safetyLog("shutdown", "DAILY_LOSS_LIMIT_AT_STARTUP", {
          date: this._daily.date,
          lossToday: this._daily.lossToday,
          limit: dailyLimit,
        });
        process.exit(1);
      }

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        log.write(
          `[startup] Session loss from previous session ($${this._sessionLoss.toFixed(2)}) already meets or exceeds the MAX_SESSION_LOSS threshold (-$${this._minSessionPnl.toFixed(2)}). ` +
            `The engine would shut down immediately. ` +
            `To start fresh, reset "sessionLoss" to 0 in ${this._statePath}, or increase MAX_SESSION_LOSS in your .env.`,
          "red",
        );
        process.exit(1);
      }

      // Sim recovery: replay order history to reconstruct balance
      if (!this._prod) {
        for (const market of state.activeMarkets) {
          for (const order of market.orderHistory) {
            if (order.action === "buy")
              this._tracker.debit(order.price * order.shares);
            else this._tracker.credit(order.price * order.shares);
          }
        }
      }

      const recovered = await recover(
        state,
        this._client,
        this._apiQueue,
        (msg, color) => log.write(msg, color),
        this._tracker,
        this._ticker,
      );
      for (const [slug, lifecycle] of recovered) {
        this._lifecycles.set(slug, lifecycle);
      }
    } else {
      log.write("[startup] No saved state found. Starting fresh.");
    }

    process.on("exit", () => {
      log.flush();
      this._saveState();
    });

    const onSignal = (sig: string) => {
      log.write(
        `[shutdown] ${sig} received. Initiating graceful shutdown...`,
        "yellow",
      );
      log.flush();
      this._saveState();
      this._startShutdown(`${sig} received.`);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    setInterval(() => this._tick(), 100);
  }

  private _tick(): void {
    // Create a new lifecycle for next market if not shutting down and rounds allow
    const roundsExhausted =
      this._rounds !== null && this._roundsCreated >= this._rounds;
    if (!this._shuttingDown && !roundsExhausted) {
      const slug = getSlug(this._slotOffset);
      if (!this._lifecycles.has(slug) && !this._completedSlugs.has(slug)) {
        const newLifecycle = new MarketLifecycle({
          slug,
          apiQueue: this._apiQueue,
          client: this._client,
          log: (msg, color) => log.write(msg, color),
          strategyName: this._strategyName,
          strategy: this._strategy,
          tracker: this._tracker,
          ticker: this._ticker,
          alwaysLog: this._alwaysLog,
        });
        this._lifecycles.set(slug, newLifecycle);
        const slotEndMs = newLifecycle.slotEndMs;
        const slotStartMs = newLifecycle.slotStartMs;
        this._dbHooks?.onRoundStart(slug, slotStartMs, slotEndMs);
        this._roundsCreated++;
      }
    }

    // Tick all lifecycles (fire-and-forget; _ticking guard prevents re-entry)
    const done: string[] = [];
    for (const [slug, lifecycle] of this._lifecycles) {
      lifecycle
        .tick()
        .catch((e) => log.write(`[${slug}] tick error: ${e}`, "red"));
      if (lifecycle.state === "DONE") done.push(slug);
    }

    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug)!;
      this._sessionPnl = parseFloat(
        (this._sessionPnl + lifecycle.pnl).toFixed(4),
      );
      if (lifecycle.pnl < 0) {
        this._sessionLoss = parseFloat(
          (this._sessionLoss + lifecycle.pnl).toFixed(4),
        );
        // Roll into the daily bucket; reset if UTC date rolled over mid-run.
        const today = utcDate();
        if (this._daily.date !== today) {
          this._daily = { date: today, lossToday: 0 };
        }
        this._daily.lossToday = parseFloat(
          (this._daily.lossToday + lifecycle.pnl).toFixed(4),
        );
      }
      log.write(
        `[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`,
        this._sessionPnl >= 0 ? "green" : "red",
      );
      safetyLog(modeTag(), "marketResolved", {
        slug,
        pnl: lifecycle.pnl,
        sessionPnl: this._sessionPnl,
        sessionLoss: this._sessionLoss,
        balance: this._tracker.balance,
        dailyLoss: this._daily.lossToday,
      });
      this._completedMarkets.push({
        slug,
        strategyName: lifecycle.strategyName,
        pnl: lifecycle.pnl,
        orderHistory: lifecycle.orderHistory,
      });

      if (this._dbHooks) {
        const slotEnd = lifecycle.slotEndMs;
        const slotStart = lifecycle.slotStartMs;
        const marketResult = this._apiQueue.marketResult.get(slotStart);
        this._dbHooks.onRoundEnd({
          slug,
          strategyName: lifecycle.strategyName,
          pnl: lifecycle.pnl,
          orderHistory: lifecycle.orderHistory,
          openPrice:  marketResult?.openPrice  ?? null,
          closePrice: marketResult?.closePrice ?? null,
          direction:  marketResult?.closePrice != null && marketResult?.openPrice != null
            ? (marketResult.closePrice > marketResult.openPrice ? "UP" : "DOWN")
            : null,
          slotStartMs: slotStart,
          slotEndMs:   slotEnd,
        });
      }

      lifecycle.destroy();
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);

      if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
        safetyLog("shutdown", "MAX_SESSION_LOSS", {
          sessionLoss: this._sessionLoss,
          threshold: this._minSessionPnl,
        });
        this._startShutdown(
          `Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`,
        );
        continue;
      }

      // Drawdown check: % of initial bankroll lost.
      const ddPct = Env.get("MAX_DRAWDOWN_PCT");
      if (ddPct > 0 && this._initialBalance > 0) {
        const dd =
          (this._initialBalance - this._tracker.balance) /
          this._initialBalance;
        if (dd >= ddPct) {
          safetyLog("shutdown", "MAX_DRAWDOWN_PCT", {
            initial: this._initialBalance,
            current: this._tracker.balance,
            drawdownPct: dd,
            threshold: ddPct,
          });
          this._startShutdown(
            `Max drawdown reached: ${(dd * 100).toFixed(2)}% >= ${(ddPct * 100).toFixed(2)}%.`,
          );
          continue;
        }
      }

      // Daily loss check: |lossToday| against DAILY_LOSS_LIMIT.
      const dailyLimit = Env.get("DAILY_LOSS_LIMIT");
      if (
        dailyLimit > 0 &&
        Math.abs(this._daily.lossToday) >= dailyLimit
      ) {
        safetyLog("shutdown", "DAILY_LOSS_LIMIT", {
          date: this._daily.date,
          lossToday: this._daily.lossToday,
          limit: dailyLimit,
        });
        this._startShutdown(
          `Daily loss limit reached for ${this._daily.date}: $${this._daily.lossToday.toFixed(2)} (limit $${dailyLimit.toFixed(2)}).`,
        );
      }
    }

    // Throttled state persistence (every 5s)
    if (Date.now() - this._lastSaveMs >= SAVE_INTERVAL_MS) {
      this._saveState();
    }

    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._startShutdown(`All ${this._rounds} round(s) complete.`);
    }

    // Exit once all lifecycles are settled during shutdown
    if (this._shuttingDown && this._lifecycles.size === 0) {
      log.write("[shutdown] All settled. Exiting.", "dim");
      this._saveState();
      this._ticker.destroy();
      process.exit(0);
    }
  }

  private _startShutdown(reason: string): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write(`[shutdown] ${reason}`, "yellow");
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    // Record session end to the performance DB.
    this._dbHooks?.onSessionEnd(
      this._sessionPnl,
      this._sessionLoss,
      this._roundsCreated,
      this._tracker.balance,
    );

    for (const [, lifecycle] of this._lifecycles) {
      lifecycle.shutdown();
    }

    const stoppingCount = [...this._lifecycles.values()].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private _saveState(): void {
    this._lastSaveMs = Date.now();
    const activeMarkets = [...this._lifecycles.entries()]
      .filter(([, l]) => l.state === "RUNNING" || l.state === "STOPPING")
      .map(([slug, l]) => ({
        slug,
        state: l.state as "RUNNING" | "STOPPING",
        strategyName: l.strategyName,
        clobTokenIds: l.clobTokenIds!,
        pendingOrders: l.pendingOrders,
        orderHistory: l.orderHistory,
      }));

    saveState(this._statePath, {
      sessionPnl: this._sessionPnl,
      sessionLoss: this._sessionLoss,
      balance: this._tracker.balance,
      daily: this._daily,
      activeMarkets,
      completedMarkets: this._completedMarkets,
    });
  }
}
