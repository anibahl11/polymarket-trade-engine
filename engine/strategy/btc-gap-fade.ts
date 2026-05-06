// =============================================================================
// btc-gap-fade.ts
//
// BTC gap mean-reversion strategy for 5-minute Up/Down markets.
//
// Hypothesis: BTC gaps hard at the slot open but tends to revert toward the
// open price as the slot progresses. Buy the *losing* token side while the gap
// is fading — cheap entry, strong reversion upside.
//
// Edge basis: Gap mean-reversion (sports market research: +4.14% daily fading
// overreaction). In binary prediction markets the losing side is systematically
// underpriced immediately after a hard move.
//
// Entry: 200–240s before close. Gap must exceed BGF_GAP_THRESHOLD and have
// faded ≥ (1 - BGF_FADE_RATIO) from its peak (PGR). RSI and ATR are used as
// volatility-quality gates.
//
// Exit: GTC take-profit at BGF_TAKE_PROFIT_PRICE, expiring 40s before close.
// Two timer-based safety exits:
//   - Review timer at BGF_REVIEW_AT_SECS: if gap re-expanded, emergency exit.
//   - Hard stop at BGF_STOP_AT_SECS: always emergency exit if still holding.
//
// Simulation only (prod guard hardcoded).
// =============================================================================

import type { Strategy } from "./types.ts";
import { Env } from "../../utils/config.ts";
import type { ParamsSchema } from "./strategy-meta.ts";

export const VERSION = "1.0.0";

export const PARAMS_SCHEMA: ParamsSchema = {
  BGF_GAP_THRESHOLD:    { default: 30,   description: "Min absolute BTC gap ($) to trigger entry" },
  BGF_FADE_RATIO:       { default: 0.85, description: "PGR ceiling — enter when gap faded to < this fraction of peak" },
  BGF_MIN_ATR:          { default: 5,    description: "Min ATR value required for entry" },
  BGF_TAKE_PROFIT_PRICE:{ default: 0.65, description: "GTC take-profit sell price" },
  BGF_STOP_AT_SECS:     { default: 30,   description: "Hard-stop: emergency exit this many seconds before close" },
  BGF_REVIEW_AT_SECS:   { default: 60,   description: "Review: check for gap re-expansion this many seconds before close" },
  BGF_ENTRY_MIN_SECS:   { default: 200,  description: "Entry window open (seconds before close)" },
  BGF_ENTRY_MAX_SECS:   { default: 240,  description: "Entry window close (seconds before close)" },
  BGF_POSITION_SHARES:  { default: 5,    description: "Max USDC budget for the position" },
};

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

type Config = {
  gapThreshold: number;
  fadeRatio: number;
  minAtr: number;
  takeProfitPrice: number;
  stopAtSecs: number;
  reviewAtSecs: number;
  entryMinSecs: number;
  entryMaxSecs: number;
  positionShares: number;
};

function readConfig(): Config {
  const f = (key: string, def: number) => {
    const raw = process.env[key];
    if (raw === undefined) return def;
    const n = parseFloat(raw);
    return isNaN(n) ? def : n;
  };
  return {
    gapThreshold:     f("BGF_GAP_THRESHOLD",     30),
    fadeRatio:        f("BGF_FADE_RATIO",         0.85),
    minAtr:           f("BGF_MIN_ATR",            5),
    takeProfitPrice:  f("BGF_TAKE_PROFIT_PRICE",  0.65),
    stopAtSecs:       f("BGF_STOP_AT_SECS",       30),
    reviewAtSecs:     f("BGF_REVIEW_AT_SECS",     60),
    entryMinSecs:     f("BGF_ENTRY_MIN_SECS",     200),
    entryMaxSecs:     f("BGF_ENTRY_MAX_SECS",     240),
    positionShares:   f("BGF_POSITION_SHARES",    5),
  };
}

// -----------------------------------------------------------------------------
// Indicators
// -----------------------------------------------------------------------------

class RSI {
  private _period: number;
  private _prev: number | null = null;
  private _avgGain: number | null = null;
  private _avgLoss: number | null = null;
  private _seedGains: number[] = [];
  private _seedLosses: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) { this._period = period; }

  update(value: number): number | null {
    if (this._prev === null) { this._prev = value; return null; }
    const delta = value - this._prev;
    this._prev = value;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    if (this._avgGain === null) {
      this._seedGains.push(gain);
      this._seedLosses.push(loss);
      if (this._seedGains.length >= this._period) {
        this._avgGain = this._seedGains.reduce((s, v) => s + v, 0) / this._period;
        this._avgLoss = this._seedLosses.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._compute(this._avgGain, this._avgLoss);
      }
      return this._value;
    }
    this._avgGain = (this._avgGain * (this._period - 1) + gain) / this._period;
    this._avgLoss = (this._avgLoss! * (this._period - 1) + loss) / this._period;
    this._value = this._compute(this._avgGain, this._avgLoss!);
    return this._value;
  }

  get value(): number | null { return this._value; }

  private _compute(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }
}

class ATR {
  private _period: number;
  private _prev: number | null = null;
  private _avgTr: number | null = null;
  private _seedTrs: number[] = [];
  private _value: number | null = null;

  constructor(period = 14) { this._period = period; }

  update(price: number): number | null {
    if (this._prev === null) { this._prev = price; return null; }
    const tr = Math.abs(price - this._prev);
    this._prev = price;
    if (this._avgTr === null) {
      this._seedTrs.push(tr);
      if (this._seedTrs.length >= this._period) {
        this._avgTr = this._seedTrs.reduce((s, v) => s + v, 0) / this._period;
        this._value = this._avgTr;
      }
      return this._value;
    }
    this._avgTr = (this._avgTr * (this._period - 1) + tr) / this._period;
    this._value = this._avgTr;
    return this._value;
  }

  get value(): number | null { return this._value; }
}

class Indicators {
  private _rsi = new RSI(14);
  private _atr = new ATR(14);
  private _peakAbsGap = 0;
  private _lastUpdate = 0;

  tick(gap: number | null, btcPrice: number | undefined): void {
    const now = Date.now();
    if (now - this._lastUpdate < 1000) return;
    this._lastUpdate = now;
    if (gap !== null) {
      this._rsi.update(gap);
      const absGap = Math.abs(gap);
      if (absGap > this._peakAbsGap) this._peakAbsGap = absGap;
    }
    if (btcPrice !== undefined) {
      this._atr.update(btcPrice);
    }
  }

  get rsi(): number | null { return this._rsi.value; }
  get atr(): number | null { return this._atr.value; }

  peakGapRatio(gap: number): number | null {
    if (this._peakAbsGap === 0) return null;
    return Math.abs(gap) / this._peakAbsGap;
  }
}

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

export const btcGapFade: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log("[btc-gap-fade] Simulation only — refusing to run with PROD=true.", "red");
    process.exit(1);
  }

  const cfg = readConfig();

  ctx.log(
    `[${ctx.slug}] btc-gap-fade: gapTh=$${cfg.gapThreshold} fadeRatio=${cfg.fadeRatio} ` +
    `atrMin=${cfg.minAtr} tp=${cfg.takeProfitPrice} budget=$${cfg.positionShares}`,
    "cyan",
  );

  const releaseLock = ctx.hold();

  let lockReleased = false;
  const release = () => {
    if (!lockReleased) { lockReleased = true; releaseLock(); }
  };

  const state = {
    hasEntered: false,
    position: null as { side: "UP" | "DOWN"; tokenId: string; entryPrice: number; shares: number } | null,
    exitFired: false,
  };

  const indicators = new Indicators();
  let reviewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer:   ReturnType<typeof setTimeout> | null = null;

  const remainingS = () => Math.floor((ctx.slotEndMs - Date.now()) / 1000);

  // ---------------------------------------------------------------------------
  // Emergency exit helper
  // ---------------------------------------------------------------------------

  const doEmergencyExit = (reason: string) => {
    if (state.exitFired) return;
    state.exitFired = true;

    ctx.log(`[${ctx.slug}] btc-gap-fade: emergency exit (${reason})`, "red");

    const sellIds = ctx.pendingOrders
      .filter((o) => o.action === "sell" && o.tokenId === state.position?.tokenId)
      .map((o) => o.orderId);

    if (sellIds.length > 0) {
      void ctx.emergencySells(sellIds).then(release);
      return;
    }

    // No resting TP yet — post a FOK at best bid.
    if (state.position) {
      const pos = state.position;
      const bid = ctx.orderBook.bestBidPrice(pos.side);
      const sellPrice = bid !== null ? bid : Math.max(0.01, pos.entryPrice - 0.05);
      ctx.postOrders([{
        req: { tokenId: pos.tokenId, action: "sell", price: sellPrice, shares: pos.shares, orderType: "FOK" },
        expireAtMs: ctx.slotEndMs,
        onFilled() { release(); },
        onExpired() { release(); },
        onFailed() { release(); },
      }]);
    } else {
      release();
    }
  };

  // ---------------------------------------------------------------------------
  // Main tick loop
  // ---------------------------------------------------------------------------

  const tickInterval = setInterval(() => {
    const remaining = remainingS();

    if (remaining <= 0) {
      clearInterval(tickInterval);
      if (!state.hasEntered) release();
      return;
    }

    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    if (!openPrice) return;

    const btcPrice = ctx.ticker.price;
    if (btcPrice === undefined) return;

    const gap = btcPrice - openPrice;
    indicators.tick(gap, btcPrice);

    // Skip if outside entry window or already entered.
    if (state.hasEntered) return;
    if (remaining < cfg.entryMinSecs || remaining > cfg.entryMaxSecs) return;

    // ── Entry conditions ────────────────────────────────────────────────────
    const absGap = Math.abs(gap);
    if (absGap < cfg.gapThreshold) return;

    const pgr = indicators.peakGapRatio(gap);
    if (pgr === null || pgr >= cfg.fadeRatio) return;

    const atr = indicators.atr;
    if (atr === null || atr < cfg.minAtr) return;

    // RSI confirms fade: if gap is positive (BTC above open, UP winning),
    // RSI < 50 means momentum is slowing → DOWN is recovering.
    const rsi = indicators.rsi;
    if (rsi === null) return;
    if (gap > 0 && rsi >= 50) return;
    if (gap < 0 && rsi <= 50) return;

    // Fade side: buy the token that is currently losing.
    const fadeSide: "UP" | "DOWN" = gap > 0 ? "DOWN" : "UP";
    const askInfo = ctx.orderBook.bestAskInfo(fadeSide);
    if (!askInfo || askInfo.price > 0.45) return;

    const shares = Math.floor(cfg.positionShares / askInfo.price);
    if (shares < 1) return;

    // ── Place entry ──────────────────────────────────────────────────────────
    state.hasEntered = true;
    const tokenId = fadeSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];

    ctx.log(
      `[${ctx.slug}] btc-gap-fade: ENTRY ${fadeSide} @ ${askInfo.price} ` +
      `(gap ${gap.toFixed(0)}, pgr ${pgr.toFixed(2)}, atr ${atr.toFixed(1)}, rsi ${rsi.toFixed(0)})`,
      "cyan",
    );

    ctx.postOrders([{
      req: { tokenId, action: "buy", price: askInfo.price, shares, orderType: "GTC" },
      expireAtMs: Date.now() + 60_000,
      onFilled(filledShares) {
        state.position = { side: fadeSide, tokenId, entryPrice: askInfo.price, shares: filledShares };
        ctx.blockBuys();

        ctx.log(
          `[${ctx.slug}] btc-gap-fade: BUY filled ${filledShares}@${askInfo.price} — placing TP @ ${cfg.takeProfitPrice}`,
          "green",
        );

        // GTC take-profit, expires 40s before close.
        ctx.postOrders([{
          req: { tokenId, action: "sell", price: cfg.takeProfitPrice, shares: filledShares, orderType: "GTC" },
          expireAtMs: ctx.slotEndMs - 40_000,
          onFilled() {
            state.exitFired = true;
            ctx.log(`[${ctx.slug}] btc-gap-fade: TP filled @ ${cfg.takeProfitPrice}`, "green");
            release();
          },
          onExpired() {
            // Time-based exits handle this path (timers below).
          },
        }]);

        // Timer A: review — emergency exit if gap re-expanded against us.
        const reviewMs = Math.max(0, ctx.slotEndMs - cfg.reviewAtSecs * 1000 - Date.now());
        reviewTimer = setTimeout(() => {
          if (state.exitFired) return;
          const currentOpenPrice = ctx.getMarketResult()?.openPrice ?? null;
          const currentBtcPrice  = ctx.ticker.price;
          if (currentOpenPrice !== null && currentBtcPrice !== undefined) {
            const currentGap = currentBtcPrice - currentOpenPrice;
            // If gap has re-expanded to > 80% of the original and is against us, bail.
            const gapReExpanded =
              (fadeSide === "DOWN" && currentGap >  absGap * 0.8) ||
              (fadeSide === "UP"   && currentGap < -absGap * 0.8);
            if (gapReExpanded) {
              doEmergencyExit(`gap re-expanded: ${currentGap.toFixed(0)}`);
              return;
            }
          }
        }, reviewMs);

        // Timer B: hard stop — always exit at BGF_STOP_AT_SECS before close.
        const stopMs = Math.max(0, ctx.slotEndMs - cfg.stopAtSecs * 1000 - Date.now());
        stopTimer = setTimeout(() => {
          if (!state.exitFired) doEmergencyExit(`hard stop at ${cfg.stopAtSecs}s before close`);
        }, stopMs);
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] btc-gap-fade: BUY expired unfilled`, "yellow");
        release();
      },
      onFailed(reason) {
        ctx.log(`[${ctx.slug}] btc-gap-fade: BUY failed (${reason})`, "red");
        release();
      },
    }]);
  }, 200);

  return () => {
    clearInterval(tickInterval);
    if (reviewTimer !== null) clearTimeout(reviewTimer);
    if (stopTimer   !== null) clearTimeout(stopTimer);
  };
};
