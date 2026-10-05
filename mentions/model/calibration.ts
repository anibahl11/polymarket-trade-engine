// Market calibration: is the crowd's YES price an unbiased probability?
// Input: (reference price, resolved outcome) pairs from closed mention markets.

import { buyEdge } from "../fees.ts";

export type CalRow = { price: number; yes: boolean };

export type CalBucket = {
  lo: number;
  hi: number;
  n: number;
  meanPrice: number;
  realized: number;
  /** Avg taker profit/share buying YES at meanPrice if realized were the truth. */
  yesEdge: number;
  /** Same for buying NO at (1 − meanPrice). */
  noEdge: number;
};

export function calibrate(rows: CalRow[], edges = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1]): CalBucket[] {
  const out: CalBucket[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    const inB = rows.filter((r) => r.price >= lo && (r.price < hi || (hi === 1 && r.price <= 1)));
    if (inB.length === 0) continue;
    const meanPrice = inB.reduce((s, r) => s + r.price, 0) / inB.length;
    const realized = inB.filter((r) => r.yes).length / inB.length;
    out.push({
      lo,
      hi,
      n: inB.length,
      meanPrice,
      realized,
      yesEdge: buyEdge(realized, meanPrice),
      noEdge: buyEdge(1 - realized, 1 - meanPrice),
    });
  }
  return out;
}

/** Price at or just before `ts` (seconds) from a CLOB prices-history series. */
export function priceAt(history: { t: number; p: number }[], ts: number): number | null {
  let best: { t: number; p: number } | null = null;
  for (const h of history) if (h.t <= ts && (!best || h.t > best.t)) best = h;
  return best?.p ?? null;
}
