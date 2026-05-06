// =============================================================================
// passive-maker.ts
//
// Maker-rebate strategy for the final 60–90 seconds of a 5-minute slot.
//
// Hypothesis: In the final minutes of a near-certain slot (one side >= $0.80),
// retail takers keep buying the winning side. Post a resting GTC limit *below*
// the best ask on the winning side to capture maker fill from that retail flow.
// GTC orders earn a maker rebate (zero taker fee); the position is then held to
// resolution for a near-certain $1.00 payout.
//
// Edge basis: Becker/Kalshi research: +1.12% systematic maker edge from resting
// limit orders in high-certainty binary markets.
//
// Entry: GTC limit placed PM_ENTRY_DISCOUNT below bestAsk on the winning side.
// BTC gap must confirm the winning side's direction.
// Exit: Hold to resolution. Emergency sell if still holding PM_EMERGENCY_EXIT_SECS
// before close.
//
// Simulation only (prod guard hardcoded).
// =============================================================================

import type { Strategy } from "./types.ts";
import { Env } from "../../utils/config.ts";
import type { ParamsSchema } from "./strategy-meta.ts";

export const VERSION = "1.0.0";

export const PARAMS_SCHEMA: ParamsSchema = {
  PM_ENTRY_MIN_SECS:       { default: 60,   description: "Entry window open (seconds before close)" },
  PM_ENTRY_MAX_SECS:       { default: 90,   description: "Entry window close (seconds before close)" },
  PM_CERTAINTY_THRESHOLD:  { default: 0.80, description: "Min token ask price to count as near-certain winner" },
  PM_ENTRY_DISCOUNT:       { default: 0.02, description: "Place GTC buy this far below bestAsk (maker improvement)" },
  PM_MIN_LIQUIDITY_USD:    { default: 2,    description: "Min USDC at best ask to confirm market depth" },
  PM_EMERGENCY_EXIT_SECS:  { default: 15,   description: "Hard emergency sell this many seconds before close" },
  PM_POSITION_SHARES:      { default: 5,    description: "USDC budget for the position" },
};

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

type Config = {
  entryMinSecs: number;
  entryMaxSecs: number;
  certaintyThreshold: number;
  entryDiscount: number;
  minLiquidityUsd: number;
  emergencyExitSecs: number;
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
    entryMinSecs:      f("PM_ENTRY_MIN_SECS",      60),
    entryMaxSecs:      f("PM_ENTRY_MAX_SECS",      90),
    certaintyThreshold:f("PM_CERTAINTY_THRESHOLD", 0.80),
    entryDiscount:     f("PM_ENTRY_DISCOUNT",      0.02),
    minLiquidityUsd:   f("PM_MIN_LIQUIDITY_USD",   2),
    emergencyExitSecs: f("PM_EMERGENCY_EXIT_SECS", 15),
    positionShares:    f("PM_POSITION_SHARES",     5),
  };
}

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

export const passiveMaker: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log("[passive-maker] Simulation only — refusing to run with PROD=true.", "red");
    process.exit(1);
  }

  const cfg = readConfig();

  ctx.log(
    `[${ctx.slug}] passive-maker: window=${cfg.entryMinSecs}–${cfg.entryMaxSecs}s ` +
    `certainty=${cfg.certaintyThreshold} discount=${cfg.entryDiscount} budget=$${cfg.positionShares}`,
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

  let emergencyTimer: ReturnType<typeof setTimeout> | null = null;

  const remainingS = () => Math.floor((ctx.slotEndMs - Date.now()) / 1000);

  // ---------------------------------------------------------------------------
  // Emergency exit helper
  // ---------------------------------------------------------------------------

  const doEmergencyExit = () => {
    if (state.exitFired || !state.position) { release(); return; }
    state.exitFired = true;

    const pos = state.position;
    ctx.log(`[${ctx.slug}] passive-maker: emergency exit ${pos.side}`, "red");

    const sellIds = ctx.pendingOrders
      .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
      .map((o) => o.orderId);

    if (sellIds.length > 0) {
      void ctx.emergencySells(sellIds).then(release);
      return;
    }

    const bid = ctx.orderBook.bestBidPrice(pos.side);
    const sellPrice = bid !== null ? bid : Math.max(0.01, pos.entryPrice - 0.05);
    ctx.postOrders([{
      req: { tokenId: pos.tokenId, action: "sell", price: sellPrice, shares: pos.shares, orderType: "FOK" },
      expireAtMs: ctx.slotEndMs,
      onFilled() { release(); },
      onExpired() { release(); },
      onFailed() { release(); },
    }]);
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

    if (state.hasEntered) return;
    if (remaining < cfg.entryMinSecs || remaining > cfg.entryMaxSecs) return;

    // ── Find near-certain winning side ───────────────────────────────────────
    const upAsk  = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");

    let winningSide: "UP" | "DOWN" | null = null;
    let askPrice: number | null = null;

    if (upAsk && upAsk.price >= cfg.certaintyThreshold) {
      winningSide = "UP";
      askPrice = upAsk.price;
    } else if (downAsk && downAsk.price >= cfg.certaintyThreshold) {
      winningSide = "DOWN";
      askPrice = downAsk.price;
    }

    if (!winningSide || askPrice === null) return;

    // ── BTC gap must confirm the winning side ────────────────────────────────
    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice  = ctx.ticker.price;
    if (openPrice !== null && btcPrice !== undefined) {
      const gap = btcPrice - openPrice;
      const gapConfirms =
        (winningSide === "UP"   && gap > 0) ||
        (winningSide === "DOWN" && gap < 0);
      if (!gapConfirms) return;
    }

    // ── Liquidity check ──────────────────────────────────────────────────────
    const askInfo = ctx.orderBook.bestAskInfo(winningSide);
    if (!askInfo || askInfo.liquidity < cfg.minLiquidityUsd) return;

    // Place the resting GTC maker limit below bestAsk.
    const entryPrice = Math.max(0.01, Math.round((askPrice - cfg.entryDiscount) * 100) / 100);
    const shares = Math.floor(cfg.positionShares / entryPrice);
    if (shares < 1) return;

    state.hasEntered = true;
    const tokenId = winningSide === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];

    ctx.log(
      `[${ctx.slug}] passive-maker: resting GTC BUY ${winningSide} @ ${entryPrice} ` +
      `(askWas ${askPrice}, ${shares} shares) — waiting for taker fill`,
      "cyan",
    );

    ctx.postOrders([{
      req: { tokenId, action: "buy", price: entryPrice, shares, orderType: "GTC" },
      expireAtMs: ctx.slotEndMs - cfg.emergencyExitSecs * 1000,
      onFilled(filledShares) {
        state.position = { side: winningSide!, tokenId, entryPrice, shares: filledShares };
        ctx.blockBuys();

        ctx.log(
          `[${ctx.slug}] passive-maker: maker fill ${filledShares}@${entryPrice} ` +
          `— holding to resolution`,
          "green",
        );

        // Emergency timer — sell if still holding this close to the end.
        const emergencyMs = Math.max(0, ctx.slotEndMs - cfg.emergencyExitSecs * 1000 - Date.now());
        emergencyTimer = setTimeout(doEmergencyExit, emergencyMs);
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] passive-maker: GTC BUY expired unfilled (no takers matched our limit)`,
          "yellow",
        );
        release();
      },
      onFailed(reason) {
        ctx.log(`[${ctx.slug}] passive-maker: BUY failed (${reason})`, "red");
        release();
      },
    }]);
  }, 200);

  return () => {
    clearInterval(tickInterval);
    if (emergencyTimer !== null) clearTimeout(emergencyTimer);
  };
};
