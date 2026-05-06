// =============================================================================
// multi-level-ofi.ts
//
// Multi-level Order Flow Imbalance (OFI) strategy with BTC dislocation gate.
//
// Hypothesis: Weighted OFI across the top 3 order book levels is a stronger
// directional signal than single-level OFI (academic basis: ~63% directional
// accuracy). Combined with a BTC dislocation gate (token hasn't repriced to
// match BTC move), it identifies systematic mispricings worth taking.
//
// Edge basis: Multi-level OFI research (Cont et al., ~63% directional
// accuracy). Fee-safe zone enforcement (price < 0.38 or > 0.62) keeps taker
// fees manageable (< 1.3% at those price levels).
//
// Entry: FOK (taker) for immediate fill in fast-moving conditions. Only enter
// in fee-safe zones. Combined OFI + dislocation signal required.
//
// Exit: GTC take-profit at MLOFI_TAKE_PROFIT_PCT above entry. Stop-loss at
// MLOFI_STOP_LOSS_PCT below entry. Emergency exit 20s before close.
//
// Simulation only (prod guard hardcoded).
// =============================================================================

import type { Strategy } from "./types.ts";
import { Env } from "../../utils/config.ts";
import type { ParamsSchema } from "./strategy-meta.ts";

export const VERSION = "1.0.0";

export const PARAMS_SCHEMA: ParamsSchema = {
  MLOFI_OFI_THRESHOLD:    { default: 50,     description: "Min weighted OFI magnitude to consider signal" },
  MLOFI_DISLOC_BTC_PCT:   { default: 0.0005, description: "Min BTC % move in 30s to count as dislocation" },
  MLOFI_DISLOC_TOKEN_GAP: { default: 0.04,   description: "Min token mispricing vs fair value for dislocation" },
  MLOFI_FEE_SAFE_MAX:     { default: 0.38,   description: "Max entry price in fee-safe zone (lower band)" },
  MLOFI_FEE_SAFE_MIN:     { default: 0.62,   description: "Min entry price in fee-safe zone (upper band)" },
  MLOFI_TAKE_PROFIT_PCT:  { default: 0.20,   description: "Take-profit % above entry price" },
  MLOFI_STOP_LOSS_PCT:    { default: 0.30,   description: "Stop-loss % below entry price" },
  MLOFI_MIN_REMAINING_S:  { default: 30,     description: "Don't enter with fewer seconds remaining" },
  MLOFI_MAX_REMAINING_S:  { default: 240,    description: "Don't enter with more seconds remaining" },
  MLOFI_POSITION_SHARES:  { default: 5,      description: "USDC budget for the position" },
};

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

type Config = {
  ofiThreshold: number;
  dislocBtcPct: number;
  dislocTokenGap: number;
  feeSafeMax: number;
  feeSafeMin: number;
  takeProfitPct: number;
  stopLossPct: number;
  minRemainingS: number;
  maxRemainingS: number;
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
    ofiThreshold:    f("MLOFI_OFI_THRESHOLD",    50),
    dislocBtcPct:    f("MLOFI_DISLOC_BTC_PCT",   0.0005),
    dislocTokenGap:  f("MLOFI_DISLOC_TOKEN_GAP", 0.04),
    feeSafeMax:      f("MLOFI_FEE_SAFE_MAX",     0.38),
    feeSafeMin:      f("MLOFI_FEE_SAFE_MIN",     0.62),
    takeProfitPct:   f("MLOFI_TAKE_PROFIT_PCT",  0.20),
    stopLossPct:     f("MLOFI_STOP_LOSS_PCT",    0.30),
    minRemainingS:   f("MLOFI_MIN_REMAINING_S",  30),
    maxRemainingS:   f("MLOFI_MAX_REMAINING_S",  240),
    positionShares:  f("MLOFI_POSITION_SHARES",  5),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type BookSnapshot = {
  bids: [number, number][];
  asks: [number, number][];
} | null;

type OFISnapshot = { up: BookSnapshot; down: BookSnapshot };

/**
 * Weighted multi-level OFI.
 * Positive → bid pressure → UP favoured.
 * Negative → ask pressure → DOWN favoured.
 */
function computeOFI(snapshot: OFISnapshot, side: "UP" | "DOWN"): number {
  const book = side === "UP" ? snapshot.up : snapshot.down;
  if (!book) return 0;
  const weights = [1, 0.7, 0.4];
  let ofi = 0;
  for (let i = 0; i < weights.length; i++) {
    const bidQty = book.bids[i]?.[1] ?? 0;
    const askQty = book.asks[i]?.[1] ?? 0;
    ofi += (bidQty - askQty) * weights[i]!;
  }
  return ofi;
}

/** 30-second sliding price window for BTC dislocation detection. */
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

  oldest(): number | null { return this._samples[0]?.price ?? null; }
  latest(): number | null { return this._samples[this._samples.length - 1]?.price ?? null; }
}

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

export const multiLevelOfi: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log("[multi-level-ofi] Simulation only — refusing to run with PROD=true.", "red");
    process.exit(1);
  }

  const cfg = readConfig();

  ctx.log(
    `[${ctx.slug}] multi-level-ofi: ofiTh=${cfg.ofiThreshold} dislocBtc=${cfg.dislocBtcPct} ` +
    `dislocToken=${cfg.dislocTokenGap} feeSafe=[<${cfg.feeSafeMax}|>${cfg.feeSafeMin}] budget=$${cfg.positionShares}`,
    "cyan",
  );

  const releaseLock = ctx.hold();

  let lockReleased = false;
  const release = () => {
    if (!lockReleased) { lockReleased = true; releaseLock(); }
  };

  const state = {
    hasEntered: false,
    position: null as {
      side: "UP" | "DOWN";
      tokenId: string;
      entryPrice: number;
      shares: number;
      takeProfitPrice: number;
      stopLossPrice: number;
      takeProfitOrderId?: string;
    } | null,
    exitFired: false,
  };

  const btcWindow = new PriceWindow(30_000);
  let emergencyTimer: ReturnType<typeof setTimeout> | null = null;

  const remainingS = () => Math.floor((ctx.slotEndMs - Date.now()) / 1000);

  // ---------------------------------------------------------------------------
  // Stop-loss / emergency exit
  // ---------------------------------------------------------------------------

  const fireExit = async (reason: string) => {
    const pos = state.position;
    if (!pos || state.exitFired) return;
    state.exitFired = true;

    ctx.log(`[${ctx.slug}] multi-level-ofi: exit (${reason}) ${pos.side}`, "red");

    const sellIds = ctx.pendingOrders
      .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
      .map((o) => o.orderId);

    if (sellIds.length > 0) {
      await ctx.emergencySells(sellIds);
      release();
      return;
    }

    const bid = ctx.orderBook.bestBidPrice(pos.side);
    const sellPrice = bid !== null ? bid : Math.max(0.01, pos.entryPrice - 0.05);
    ctx.postOrders([{
      req: { tokenId: pos.tokenId, action: "sell", price: sellPrice, shares: pos.shares, orderType: "GTC" },
      expireAtMs: ctx.slotEndMs,
      onFilled() { release(); },
      onExpired() { release(); },
    }]);
  };

  const placeTakeProfit = () => {
    const pos = state.position;
    if (!pos) return;
    ctx.postOrders([{
      req: {
        tokenId: pos.tokenId,
        action: "sell",
        price: pos.takeProfitPrice,
        shares: pos.shares,
        orderType: "GTC",
      },
      expireAtMs: ctx.slotEndMs - 20_000,
      onFilled() {
        state.exitFired = true;
        ctx.log(`[${ctx.slug}] multi-level-ofi: TP filled @ ${pos.takeProfitPrice.toFixed(3)}`, "green");
        release();
      },
      onExpired() {
        // Emergency timer handles final exit.
      },
    }]);
  };

  // ---------------------------------------------------------------------------
  // Main tick loop
  // ---------------------------------------------------------------------------

  const TICK_MS = 200;
  const tickInterval = setInterval(() => {
    const remaining = remainingS();

    if (remaining <= 0) {
      clearInterval(tickInterval);
      if (!state.hasEntered) release();
      return;
    }

    const btc = ctx.ticker.price;
    if (btc !== undefined) btcWindow.push(Date.now(), btc);

    // ── Position management (stop-loss check) ────────────────────────────────
    if (state.position && !state.exitFired) {
      const pos = state.position;
      const bid = ctx.orderBook.bestBidPrice(pos.side);
      if (bid !== null && bid <= pos.stopLossPrice && remaining >= cfg.minRemainingS) {
        void fireExit(`stop-loss: bid ${bid.toFixed(3)} <= SL ${pos.stopLossPrice.toFixed(3)}`);
        return;
      }
    }

    if (state.hasEntered) return;
    if (remaining < cfg.minRemainingS || remaining > cfg.maxRemainingS) return;

    // ── Compute multi-level OFI for both sides ───────────────────────────────
    const rawSnap = ctx.orderBook.getSnapshotData() as OFISnapshot | null;
    if (!rawSnap) return;

    const ofiUp   = computeOFI(rawSnap, "UP");
    const ofiDown = computeOFI(rawSnap, "DOWN");

    // Signal: UP if ofiUp > threshold AND ofiDown < -threshold (or vice versa).
    let ofiSide: "UP" | "DOWN" | null = null;
    if (ofiUp > cfg.ofiThreshold && ofiUp > -ofiDown) ofiSide = "UP";
    else if (-ofiDown > cfg.ofiThreshold && -ofiDown > ofiUp) ofiSide = "DOWN";
    if (!ofiSide) return;

    // ── Dislocation gate ─────────────────────────────────────────────────────
    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    if (!openPrice || btc === undefined) return;

    // BTC must have moved meaningfully in the last 30s.
    const oldBtc = btcWindow.oldest();
    if (oldBtc === null) return;
    const btcPctMove = Math.abs((btc - oldBtc) / oldBtc);
    if (btcPctMove < cfg.dislocBtcPct) return;

    // BTC direction must agree with OFI signal.
    const btcAgreesUp   = ofiSide === "UP"   && btc > oldBtc;
    const btcAgreesDown = ofiSide === "DOWN"  && btc < oldBtc;
    if (!btcAgreesUp && !btcAgreesDown) return;

    // Token hasn't repriced to reflect BTC move (dislocation).
    const gap = btc - openPrice;
    // Linear fair value approximation: 0.5 + (gap / openPrice) * 5.
    const fairValue = Math.min(0.99, Math.max(0.01, 0.5 + (gap / openPrice) * 5));
    const askInfo = ctx.orderBook.bestAskInfo(ofiSide);
    if (!askInfo) return;
    const dislocation = Math.abs(askInfo.price - fairValue) > cfg.dislocTokenGap;
    if (!dislocation) return;

    // ── Fee-safe zone check ──────────────────────────────────────────────────
    const inFeeSafe = askInfo.price < cfg.feeSafeMax || askInfo.price > cfg.feeSafeMin;
    if (!inFeeSafe) return;

    const shares = Math.floor(cfg.positionShares / askInfo.price);
    if (shares < 1) return;

    // ── Place FOK entry ──────────────────────────────────────────────────────
    state.hasEntered = true;
    const tokenId = ofiSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const takeProfitPrice = Math.min(0.99, askInfo.price * (1 + cfg.takeProfitPct));
    const stopLossPrice   = Math.max(0.01, askInfo.price * (1 - cfg.stopLossPct));

    ctx.log(
      `[${ctx.slug}] multi-level-ofi: FOK ENTRY ${ofiSide} @ ${askInfo.price.toFixed(3)} ` +
      `(ofi=${ofiSide === "UP" ? ofiUp : -ofiDown > 0 ? -ofiDown : ofiDown} ` +
      `btcMove=${(btcPctMove * 100).toFixed(2)}% disloc=${Math.abs(askInfo.price - fairValue).toFixed(3)})`,
      "cyan",
    );

    ctx.postOrders([{
      req: { tokenId, action: "buy", price: askInfo.price, shares, orderType: "FOK" },
      expireAtMs: Date.now() + 3_000,
      onFilled(filledShares) {
        state.position = {
          side: ofiSide!,
          tokenId,
          entryPrice: askInfo.price,
          shares: filledShares,
          takeProfitPrice: Math.round(takeProfitPrice * 100) / 100,
          stopLossPrice,
        };
        ctx.blockBuys();

        ctx.log(
          `[${ctx.slug}] multi-level-ofi: filled ${filledShares}@${askInfo.price.toFixed(3)} ` +
          `TP=${state.position!.takeProfitPrice.toFixed(3)} SL=${stopLossPrice.toFixed(3)}`,
          "green",
        );

        placeTakeProfit();

        // Emergency exit 20s before close.
        const emergencyMs = Math.max(0, ctx.slotEndMs - 20_000 - Date.now());
        emergencyTimer = setTimeout(() => {
          void fireExit("20s before close");
        }, emergencyMs);
      },
      onExpired() {
        ctx.log(`[${ctx.slug}] multi-level-ofi: FOK BUY expired unfilled`, "yellow");
        state.hasEntered = false;
      },
      onFailed(reason) {
        ctx.log(`[${ctx.slug}] multi-level-ofi: FOK BUY failed (${reason})`, "red");
        state.hasEntered = false;
      },
    }]);
  }, TICK_MS);

  return () => {
    clearInterval(tickInterval);
    if (emergencyTimer !== null) clearTimeout(emergencyTimer);
  };
};
