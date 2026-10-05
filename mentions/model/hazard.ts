// Live fair value: condition the prior on what has (not) happened so far.

import { pAtLeastOverDurations, type GammaPost, type PriorFit } from "./prior.ts";

export type LiveState = {
  elapsedMin: number;
  /** Final hits counted so far. */
  hits: number;
  minCount: number;
  ended: boolean;
};

/** Remaining minutes if the event outlasts every duration sample. */
const TAIL_MIN = 2;

/**
 * P(YES) given the prior fit, live state and samples of TOTAL event duration
 * (minutes). Samples ≤ elapsed are dropped (the event is still running).
 */
export function liveFair(fit: PriorFit, s: LiveState, durationSamples: number[]): number {
  if (s.hits >= s.minCount) return 1;
  if (s.ended) return 0;

  const post: GammaPost =
    fit.model === "first"
      ? { alpha: fit.post.alpha, beta: fit.post.beta + s.elapsedMin }
      : { alpha: fit.post.alpha + s.hits, beta: fit.post.beta + s.elapsedMin };

  let remaining = durationSamples.filter((d) => d > s.elapsedMin).map((d) => d - s.elapsedMin);
  if (remaining.length === 0) remaining = [TAIL_MIN];
  return pAtLeastOverDurations(post, remaining, s.minCount - s.hits);
}
