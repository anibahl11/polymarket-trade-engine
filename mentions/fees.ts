// Polymarket fee model. Mirrors the Gamma `feeSchedule` object:
//   fee = shares · rate · (p · (1 − p))^exponent
// Mentions category: rate 0.04, exponent 1 → max 1¢/share at p = 0.50.

export type FeeSchedule = {
  rate: number;
  exponent: number;
  takerOnly: boolean;
  rebateRate: number;
};

export const MENTIONS_FEE: FeeSchedule = {
  rate: 0.04,
  exponent: 1,
  takerOnly: true,
  rebateRate: 0,
};

/** Fee in USDC per share filled at `price`. Makers pay 0 when `takerOnly`. */
export function feePerShare(
  price: number,
  taker = true,
  schedule: FeeSchedule = MENTIONS_FEE,
): number {
  if (!taker && schedule.takerOnly) return 0;
  const x = Math.max(0, price * (1 - price));
  return schedule.rate * Math.pow(x, schedule.exponent);
}

export function totalFee(
  price: number,
  shares: number,
  taker = true,
  schedule: FeeSchedule = MENTIONS_FEE,
): number {
  return shares * feePerShare(price, taker, schedule);
}

/**
 * Expected profit per share of buying an outcome that wins with probability
 * `prob` at `price` (YES: prob = fair; NO: prob = 1 − fair, price = NO ask).
 */
export function buyEdge(
  prob: number,
  price: number,
  taker = true,
  schedule: FeeSchedule = MENTIONS_FEE,
): number {
  return prob - price - feePerShare(price, taker, schedule);
}

/**
 * Kelly fraction of bankroll to spend buying an outcome with win prob `prob`
 * at all-in cost `cost` per share (price + fee). Returns 0 when there is no edge.
 */
export function kellyFraction(prob: number, cost: number): number {
  if (cost <= 0 || cost >= 1) return 0;
  return Math.max(0, (prob - cost) / (1 - cost));
}
