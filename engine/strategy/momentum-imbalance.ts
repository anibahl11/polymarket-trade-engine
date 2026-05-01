// =============================================================================
// momentum-imbalance.ts
//
// Short-term BTC Up/Down strategy that combines three independent edges:
//   1. Spot momentum  — meaningful BTC move on Binance/Coinbase over a short
//      look-back window, in a direction that agrees with which side of the
//      market is currently "winning" relative to the slot's open price.
//   2. Order-book imbalance — top-of-book bid liquidity dominates the ask
//      side on the entry leg (buyers backstop the position).
//   3. Liquidity floor — counterparty (ask) side has enough USDC at the top
//      of book that a market-taking buy will fill cleanly without walking
//      the book.
//
// As a fallback, the strategy switches to a mean-reversion mode in the final
// minutes of the slot: if the market price is at an extreme (e.g. UP > 0.85)
// but BTC spot has reversed in the last 30s, fade the move with a small buy
// on the OPPOSITE side.
//
// Position sizing: fixed-fractional by default (default 2% of starting sim
// bankroll), with an optional "fractional Kelly" mode that scales with the
// estimated edge. The hard upper bound is enforced by the engine's safety
// overlay via MAX_POSITION_PCT (default 5%) — the strategy never gets to
// exceed that even if its own knobs are mis-set.
//
// Exit rules:
//   - Take-profit: a resting GTC sell is placed immediately after the entry
//     fills, at entry_price * (1 + TAKE_PROFIT_PCT).
//   - Stop-loss: every tick, if best_bid drops below entry * (1 - STOP_LOSS_PCT)
//     AND there is still time, cancel the take-profit and emergency-sell at
//     the best bid.
//   - Otherwise: hold to resolution and let the engine auto-redeem.
//
// Safety:
//   - Hardcoded prod guard (process.exit(1) if PROD=true). Live trading is
//     intentionally not supported by this strategy. Use simulation only.
//   - All buys flow through the engine's MAX_POSITION_PCT, MAX_DRAWDOWN_PCT,
//     MAX_SESSION_LOSS, and DAILY_LOSS_LIMIT gates added to the safety
//     overlay — this strategy does not bypass any of them.
// =============================================================================

import type { Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";

// -----------------------------------------------------------------------------
// Configuration. Read once at strategy start. Every knob has a sensible
// default; override via env at runtime.
// -----------------------------------------------------------------------------

type Config = {
  /** Fraction of starting bankroll to risk per trade (e.g. 0.02 = 2%). */
  positionPct: number;
  /** If true, scale position by quarter-Kelly within positionPct as the cap. */
  useKelly: boolean;
  /** Look-back window (seconds) for spot-momentum delta. */
  momentumWindowS: number;
  /** Min absolute BTC move (USD) over the window to count as momentum. */
  momentumThresholdUsd: number;
  /** Top-of-book bid / (bid + ask) liquidity ratio to count as imbalanced. */
  imbalanceThreshold: number;
  /** Min USDC at the top of the counterparty (ask) book to enter. */
  minLiquidityUsd: number;
  /** Don't enter when fewer seconds remain (avoids late, illiquid fills). */
  minRemainingS: number;
  /** Don't enter when more seconds remain (let signals develop). */
  maxRemainingS: number;
  /** Don't pay more than this for an entry leg. */
  maxEntryPrice: number;
  /** Take-profit as fraction of entry price (e.g. 0.20 → +20%). */
  takeProfitPct: number;
  /** Stop-loss as fraction of entry price (e.g. 0.30 → -30%). */
  stopLossPct: number;
  /** Switch to mean-reversion mode when this many seconds remain. */
  reversionRemainingS: number;
  /** Only fade if market price for the dominant side is >= this. */
  reversionExtremePrice: number;
  /** Only fade if BTC has reversed by at least this many USD in 30s. */
  reversionBtcDeltaUsd: number;
};

function readConfig(): Config {
  const f = (key: string, def: number) => {
    const raw = process.env[key];
    if (raw === undefined) return def;
    const n = parseFloat(raw);
    return isNaN(n) ? def : n;
  };
  const b = (key: string, def: boolean) => {
    const raw = process.env[key];
    if (raw === undefined) return def;
    return raw === "true";
  };
  return {
    positionPct: f("MI_POSITION_PCT", 0.02),
    useKelly: b("MI_USE_KELLY", false),
    momentumWindowS: f("MI_MOMENTUM_WINDOW_S", 60),
    momentumThresholdUsd: f("MI_MOMENTUM_THRESHOLD_USD", 30),
    imbalanceThreshold: f("MI_IMBALANCE_THRESHOLD", 0.6),
    minLiquidityUsd: f("MI_MIN_LIQUIDITY_USD", 50),
    minRemainingS: f("MI_MIN_REMAINING_S", 30),
    maxRemainingS: f("MI_MAX_REMAINING_S", 240),
    maxEntryPrice: f("MI_MAX_ENTRY_PRICE", 0.85),
    takeProfitPct: f("MI_TAKE_PROFIT_PCT", 0.2),
    stopLossPct: f("MI_STOP_LOSS_PCT", 0.3),
    reversionRemainingS: f("MI_REVERSION_REMAINING_S", 90),
    reversionExtremePrice: f("MI_REVERSION_EXTREME_PRICE", 0.85),
    reversionBtcDeltaUsd: f("MI_REVERSION_BTC_DELTA_USD", 20),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Fixed-window sliding buffer of (timestamp, price) samples. Used for spot
 * momentum: "what was BTC `windowS` seconds ago, vs now?"
 */
class PriceWindow {
  private _samples: Array<{ ts: number; price: number }> = [];

  constructor(private readonly _windowMs: number) {}

  push(ts: number, price: number) {
    this._samples.push({ ts, price });
    const cutoff = ts - this._windowMs;
    while (this._samples.length > 0 && this._samples[0]!.ts < cutoff) {
      this._samples.shift();
    }
  }

  /** Price `windowMs` ago, or the oldest sample we have. Null if empty. */
  oldest(): number | null {
    return this._samples[0]?.price ?? null;
  }

  /** Most-recent sample. Null if empty. */
  latest(): number | null {
    return this._samples[this._samples.length - 1]?.price ?? null;
  }

  /** Signed delta: latest - oldest. Null if too few samples. */
  delta(): number | null {
    if (this._samples.length < 2) return null;
    return this.latest()! - this.oldest()!;
  }

  /** Min and max prices over the window. */
  range(): { min: number; max: number } | null {
    if (this._samples.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this._samples) {
      if (s.price < min) min = s.price;
      if (s.price > max) max = s.price;
    }
    return { min, max };
  }

  size(): number {
    return this._samples.length;
  }
}

/** Top-of-book imbalance for a given side: bid_liq / (bid_liq + ask_liq). */
function topOfBookImbalance(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
): number | null {
  const bid = ctx.orderBook.bestBidInfo(side);
  const ask = ctx.orderBook.bestAskInfo(side);
  if (!bid || !ask) return null;
  const total = bid.liquidity + ask.liquidity;
  if (total <= 0) return null;
  return bid.liquidity / total;
}

/**
 * Quarter-Kelly fractional sizing on a 0..1 binary market.
 *
 * For a buy at market price `p`, share payout is $1 if correct, $0 if wrong.
 * Net edge against a true probability `q` is (q - p), and the Kelly-optimal
 * fraction of bankroll is (q - p) / (1 - p). We use 1/4 Kelly for safety
 * and clamp to [0, posCap] so a misestimated `q` cannot wreck the bankroll.
 */
function kellyFraction(
  estimatedProb: number,
  marketPrice: number,
  posCap: number,
): number {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  const edge = estimatedProb - marketPrice;
  if (edge <= 0) return 0;
  const fullKelly = edge / (1 - marketPrice);
  const quarter = fullKelly * 0.25;
  return Math.max(0, Math.min(posCap, quarter));
}

/**
 * Estimate the true win probability for `side` given how far BTC has moved
 * away from the slot's open price relative to recent volatility. Cheap
 * heuristic only — used to size, never to gate entries.
 */
function estimateProb(
  side: "UP" | "DOWN",
  btc: number,
  openPrice: number,
  rangeUsd: number,
): number {
  if (rangeUsd <= 0) return 0.5;
  const gap = side === "UP" ? btc - openPrice : openPrice - btc;
  // gap / range mapped through a simple sigmoid. Capped to [0.05, 0.95].
  const z = gap / rangeUsd;
  const sig = 1 / (1 + Math.exp(-z));
  return Math.max(0.05, Math.min(0.95, sig));
}

/** Round price to a tick grid so the CLOB accepts the order. */
function clampToTick(price: number, tickSize: string): number {
  const tick = parseFloat(tickSize) || 0.01;
  return Math.max(tick, Math.min(1 - tick, Math.round(price / tick) * tick));
}

// -----------------------------------------------------------------------------
// Strategy state
// -----------------------------------------------------------------------------

type Position = {
  side: "UP" | "DOWN";
  tokenId: string;
  entryPrice: number;
  shares: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  /** Order id of the resting take-profit sell, if any. */
  takeProfitOrderId?: string;
};

type State = {
  position: Position | null;
  hasOpenedEntry: boolean;
  exitFired: boolean;
};

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

export const momentumImbalance: Strategy = async (ctx) => {
  // ── Prod guard ────────────────────────────────────────────────────────────
  // This strategy is for simulation/paper-trading only. The safety overlay
  // also blocks live orders unless SIMULATION_MODE=false, but we add this
  // belt-and-suspenders guard so the strategy refuses to even start under
  // PROD=true regardless of the SIMULATION_MODE setting.
  if (Env.get("PROD")) {
    ctx.log(
      "[momentum-imbalance] This strategy is paper-trading only. Refusing to run with PROD=true.",
      "red",
    );
    process.exit(1);
  }

  const cfg = readConfig();

  // Bankroll is read from WALLET_BALANCE (the sim starting balance). We
  // intentionally snapshot it once so the per-trade size is deterministic
  // across the slot. If you adapt this for live trading later, replace this
  // with a balance accessor exposed via StrategyContext.
  const bankroll = parseFloat(process.env.WALLET_BALANCE ?? "50");

  ctx.log(
    `[${ctx.slug}] momentum-imbalance: bankroll=$${bankroll.toFixed(2)} ` +
      `posPct=${(cfg.positionPct * 100).toFixed(2)}% kelly=${cfg.useKelly} ` +
      `momWin=${cfg.momentumWindowS}s momTh=$${cfg.momentumThresholdUsd} ` +
      `imbTh=${cfg.imbalanceThreshold} liqMin=$${cfg.minLiquidityUsd}`,
    "cyan",
  );

  // Hold the lifecycle in RUNNING; we run on a polling timer until the slot
  // ends or we exit the position.
  const releaseLock = ctx.hold();

  const state: State = {
    position: null,
    hasOpenedEntry: false,
    exitFired: false,
  };

  const window = new PriceWindow(cfg.momentumWindowS * 1000);
  const reversionWindow = new PriceWindow(30 * 1000);

  // --- Helpers that close over ctx/state ------------------------------------

  const remainingS = () => Math.floor((ctx.slotEndMs - Date.now()) / 1000);

  const placeEntry = (
    side: "UP" | "DOWN",
    fillPrice: number,
    btcSpot: number,
    openPrice: number,
    rangeUsd: number,
  ) => {
    const tokenId = ctx.orderBook.getTokenId(side);
    const tickSize = ctx.orderBook.getTickSize(tokenId);

    // Sizing: fixed-fractional by default, optional 1/4-Kelly capped by posPct.
    let usdToSpend: number;
    if (cfg.useKelly) {
      const q = estimateProb(side, btcSpot, openPrice, rangeUsd);
      const frac = kellyFraction(q, fillPrice, cfg.positionPct);
      usdToSpend = bankroll * frac;
    } else {
      usdToSpend = bankroll * cfg.positionPct;
    }

    const shares = Math.floor(usdToSpend / fillPrice);
    if (shares < 1) {
      ctx.log(
        `[${ctx.slug}] momentum-imbalance: sized to <1 share ($${usdToSpend.toFixed(2)} at ${fillPrice}); skipping entry`,
        "yellow",
      );
      state.hasOpenedEntry = false;
      return;
    }

    const tpRaw = fillPrice * (1 + cfg.takeProfitPct);
    const slRaw = fillPrice * (1 - cfg.stopLossPct);
    const takeProfitPrice = clampToTick(tpRaw, tickSize);
    const stopLossPrice = Math.max(0.01, slRaw);

    ctx.log(
      `[${ctx.slug}] momentum-imbalance: ENTRY ${side} buy ${shares} @ ${fillPrice.toFixed(3)} ` +
        `(TP ${takeProfitPrice.toFixed(3)} / SL ${stopLossPrice.toFixed(3)})`,
      "cyan",
    );

    // FOK so we either get the size or skip — avoids partial-resting drift
    // in fast-moving 5m markets. If you want a resting bid instead, change
    // to "GTC" and add a price-improvement timer.
    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "buy",
          price: fillPrice,
          shares,
          orderType: "FOK",
        },
        expireAtMs: Date.now() + 2000,
        onFilled(filledShares) {
          state.position = {
            side,
            tokenId,
            entryPrice: fillPrice,
            shares: filledShares,
            takeProfitPrice,
            stopLossPrice,
          };
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: ${side} BUY filled ${filledShares}@${fillPrice.toFixed(3)}`,
            "green",
          );
          placeTakeProfit();
        },
        onExpired() {
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: ${side} BUY @ ${fillPrice.toFixed(3)} expired/unfilled`,
            "yellow",
          );
          state.hasOpenedEntry = false;
        },
        onFailed(reason) {
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: ${side} BUY failed: ${reason}`,
            "red",
          );
          state.hasOpenedEntry = false;
        },
      },
    ]);
  };

  const placeTakeProfit = () => {
    const pos = state.position;
    if (!pos) return;
    ctx.postOrders([
      {
        req: {
          tokenId: pos.tokenId,
          action: "sell",
          price: pos.takeProfitPrice,
          shares: pos.shares,
          orderType: "GTC",
        },
        expireAtMs: ctx.slotEndMs,
        onFilled() {
          state.exitFired = true;
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: TP filled @ ${pos.takeProfitPrice.toFixed(3)}`,
            "green",
          );
        },
        onExpired() {
          // Slot ended; engine will redeem if we won.
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: TP expired; holding to resolution`,
            "dim",
          );
        },
        onFailed(reason) {
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: TP placement failed: ${reason}`,
            "yellow",
          );
        },
      },
    ]);
  };

  /** Stop-loss: cancel any resting TP and dump at best bid. */
  const fireStopLoss = async (reason: string) => {
    const pos = state.position;
    if (!pos || state.exitFired) return;
    state.exitFired = true;
    ctx.log(
      `[${ctx.slug}] momentum-imbalance: STOP-LOSS (${reason}) — exiting ${pos.side}`,
      "red",
    );
    const sellIds = ctx.pendingOrders
      .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
      .map((o) => o.orderId);
    if (sellIds.length > 0) {
      // emergencySells cancels the resting TP and re-places at best bid
      await ctx.emergencySells(sellIds);
      return;
    }
    // No resting TP yet — place a fresh sell at best bid.
    const bid = ctx.orderBook.bestBidPrice(pos.side);
    const sellPrice =
      bid !== null
        ? bid
        : Math.max(0.01, pos.entryPrice - 0.05);
    ctx.postOrders([
      {
        req: {
          tokenId: pos.tokenId,
          action: "sell",
          price: sellPrice,
          shares: pos.shares,
          orderType: "GTC",
        },
        expireAtMs: ctx.slotEndMs,
        onFilled() {
          ctx.log(
            `[${ctx.slug}] momentum-imbalance: stop-loss SELL filled @ ${sellPrice.toFixed(3)}`,
            "green",
          );
        },
      },
    ]);
  };

  // --- Entry signal evaluators ----------------------------------------------

  /**
   * Returns the side to enter on, or null if no momentum signal. Requires
   * BTC has moved far enough in the window AND that direction agrees with
   * which side the market itself currently favours.
   */
  const evaluateMomentum = (
    btcSpot: number,
    openPrice: number,
  ): "UP" | "DOWN" | null => {
    const delta = window.delta();
    if (delta === null) return null;
    if (Math.abs(delta) < cfg.momentumThresholdUsd) return null;

    const dir: "UP" | "DOWN" = delta > 0 ? "UP" : "DOWN";

    // Direction must agree with the slot's current "side" (BTC vs open).
    const sideAgrees =
      (dir === "UP" && btcSpot > openPrice) ||
      (dir === "DOWN" && btcSpot < openPrice);
    if (!sideAgrees) return null;

    // Top-of-book imbalance: bids dominate the entry leg.
    const imb = topOfBookImbalance(ctx, dir);
    if (imb === null || imb < cfg.imbalanceThreshold) return null;

    // Liquidity floor on the ask we'd take.
    const ask = ctx.orderBook.bestAskInfo(dir);
    if (!ask || ask.liquidity < cfg.minLiquidityUsd) return null;
    if (ask.price > cfg.maxEntryPrice) return null;

    return dir;
  };

  /**
   * Mean-reversion fallback. If the slot is near the end, the market is
   * heavily one-sided, but BTC has reversed in the last 30 seconds, fade
   * the move with a small buy on the OPPOSITE side.
   */
  const evaluateReversion = (
    btcSpot: number,
    openPrice: number,
  ): { side: "UP" | "DOWN"; ask: number } | null => {
    const remaining = remainingS();
    if (remaining > cfg.reversionRemainingS) return null;
    if (remaining < cfg.minRemainingS) return null;

    // Which side is currently extreme on the market?
    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");
    if (!upAsk || !downAsk) return null;
    const upBid = ctx.orderBook.bestBidPrice("UP") ?? 0;
    const downBid = ctx.orderBook.bestBidPrice("DOWN") ?? 0;

    // The "expensive" side has a bid >= reversionExtremePrice.
    const upExtreme = upBid >= cfg.reversionExtremePrice;
    const downExtreme = downBid >= cfg.reversionExtremePrice;
    if (!upExtreme && !downExtreme) return null;

    // Has BTC reversed against the extreme side over the last 30s?
    const recentDelta = reversionWindow.delta();
    if (recentDelta === null) return null;

    if (upExtreme && recentDelta < -cfg.reversionBtcDeltaUsd) {
      // UP is priced as a near-certain win, but BTC just dropped — fade to DOWN.
      if (downAsk.liquidity < cfg.minLiquidityUsd) return null;
      if (downAsk.price > cfg.maxEntryPrice) return null;
      return { side: "DOWN", ask: downAsk.price };
    }
    if (downExtreme && recentDelta > cfg.reversionBtcDeltaUsd) {
      // DOWN is near-certain, but BTC just rallied — fade to UP.
      if (upAsk.liquidity < cfg.minLiquidityUsd) return null;
      if (upAsk.price > cfg.maxEntryPrice) return null;
      return { side: "UP", ask: upAsk.price };
    }
    // Confirmation that direction agrees with extreme side: ignore.
    void btcSpot;
    void openPrice;
    return null;
  };

  // --- Main tick loop -------------------------------------------------------

  const TICK_MS = 200;
  const tickInterval = setInterval(() => {
    const remaining = remainingS();

    // End-of-slot: stop ticking, release the hold so the lifecycle can settle.
    if (remaining <= 0) {
      clearInterval(tickInterval);
      releaseLock();
      return;
    }

    // Killswitch from the ticker (price feeds diverged > $50). Sit out.
    if (ctx.ticker.isKillswitch) return;

    const btc = ctx.ticker.price;
    if (btc === undefined) return;

    const now = Date.now();
    window.push(now, btc);
    reversionWindow.push(now, btc);

    const openPrice = ctx.getMarketResult()?.openPrice;
    if (openPrice === undefined || openPrice === null) return;

    // ── Position management ────────────────────────────────────────────────
    if (state.position && !state.exitFired) {
      const pos = state.position;
      const bid = ctx.orderBook.bestBidPrice(pos.side);
      // Stop-loss on the bid (the price we could exit at right now).
      if (
        bid !== null &&
        bid <= pos.stopLossPrice &&
        remaining >= cfg.minRemainingS
      ) {
        void fireStopLoss(
          `bid ${bid.toFixed(3)} <= SL ${pos.stopLossPrice.toFixed(3)}`,
        );
      }
      return;
    }

    if (state.position && state.exitFired) return;

    // ── Entry: gate by time window first ───────────────────────────────────
    if (state.hasOpenedEntry) return;
    if (remaining < cfg.minRemainingS) return;
    if (remaining > cfg.maxRemainingS) return;

    // ── Try momentum entry ─────────────────────────────────────────────────
    const momentumSide = evaluateMomentum(btc, openPrice);
    if (momentumSide) {
      const ask = ctx.orderBook.bestAskInfo(momentumSide);
      if (!ask) return;
      const range = window.range();
      const rangeUsd = range ? range.max - range.min : cfg.momentumThresholdUsd;
      state.hasOpenedEntry = true;
      placeEntry(momentumSide, ask.price, btc, openPrice, rangeUsd);
      return;
    }

    // ── Try mean-reversion entry ───────────────────────────────────────────
    const reversion = evaluateReversion(btc, openPrice);
    if (reversion) {
      ctx.log(
        `[${ctx.slug}] momentum-imbalance: reversion fade ${reversion.side} @ ${reversion.ask.toFixed(3)}`,
        "cyan",
      );
      const range = window.range();
      const rangeUsd = range ? range.max - range.min : cfg.momentumThresholdUsd;
      state.hasOpenedEntry = true;
      placeEntry(reversion.side, reversion.ask, btc, openPrice, rangeUsd);
      return;
    }
  }, TICK_MS);

  // Cleanup: clear our timer when the lifecycle is destroyed.
  return () => {
    clearInterval(tickInterval);
  };
};
