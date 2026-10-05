// Gamma-Poisson mention model.
//
// λ (mentions per minute) ~ Gamma(alpha, beta), beta is a rate in minutes.
// Two fits share the same math:
//   - "first": hazard of the FIRST mention. Each historical event adds
//     alpha += 1 if mentioned, beta += minutes until first mention (or full
//     duration if never). Best for minCount = 1 (robust to bursty repeats).
//   - "count": total mention rate. alpha += count, beta += duration.
//     Used for "N+ times" markets.
// Predictive over a window T is negative binomial with q = beta / (beta + T):
//   P(N ≥ 1) = 1 − q^alpha.

import { Matcher, type AsrWord } from "../matcher.ts";
import { tokenize, type MatchSpec } from "../rules.ts";

export type GammaPost = { alpha: number; beta: number };

export type TranscriptDoc = {
  speaker: string;
  eventType: string;
  durationMin: number;
  text: string;
  date?: string;
};

export type EventObs = {
  durationMin: number;
  /** Minutes until first mention, null if never mentioned. */
  firstHitMin: number | null;
  count: number;
};

/** Default base rate when nothing is known: ~10% chance in a 60-min event. */
export const DEFAULT_BASE_RATE = -Math.log(0.9) / 60;

export function mean(p: GammaPost): number {
  return p.alpha / p.beta;
}

/** Weak prior centered on `ratePerMin`; `strength` = pseudo-events. */
export function priorFromRate(ratePerMin: number, strength = 1): GammaPost {
  const r = Math.max(ratePerMin, 1e-6);
  return { alpha: strength, beta: strength / r };
}

export function updateFirstHit(p: GammaPost, obs: EventObs[]): GammaPost {
  let { alpha, beta } = p;
  for (const o of obs) {
    if (o.firstHitMin !== null) {
      alpha += 1;
      beta += o.firstHitMin;
    } else {
      beta += o.durationMin;
    }
  }
  return { alpha, beta };
}

export function updateCount(p: GammaPost, obs: EventObs[]): GammaPost {
  let { alpha, beta } = p;
  for (const o of obs) {
    alpha += o.count;
    beta += o.durationMin;
  }
  return { alpha, beta };
}

/** P(N ≥ k) over `minutes` under the negative-binomial predictive. */
export function pAtLeast(p: GammaPost, minutes: number, k = 1): number {
  if (k <= 0) return 1;
  if (minutes <= 0) return 0;
  const q = p.beta / (p.beta + minutes);
  // P(N = n) = Γ(n+α)/(Γ(α) n!) q^α (1−q)^n, accumulated iteratively.
  let term = Math.pow(q, p.alpha);
  let cdf = term;
  for (let n = 1; n < k; n++) {
    term *= ((n - 1 + p.alpha) / n) * (1 - q);
    cdf += term;
  }
  return clamp01(1 - cdf);
}

/** Average of pAtLeast over a sample of possible window lengths. */
export function pAtLeastOverDurations(p: GammaPost, durations: number[], k = 1): number {
  if (durations.length === 0) return 0;
  let s = 0;
  for (const d of durations) s += pAtLeast(p, d, k);
  return s / durations.length;
}

/**
 * Observe a transcript against a spec. Word timing is approximated by token
 * position × duration (transcripts rarely carry timestamps).
 */
export function observe(doc: TranscriptDoc, spec: MatchSpec): EventObs {
  const toks = tokenize(doc.text);
  const per = toks.length > 0 ? doc.durationMin / toks.length : 0;
  const words: AsrWord[] = toks.map((t, i) => ({
    text: t,
    start: i * per,
    end: (i + 1) * per,
    confidence: 1,
  }));
  const m = new Matcher();
  m.setSpecs({ x: spec });
  const hits = m.scan(words, true);
  return {
    durationMin: doc.durationMin,
    firstHitMin: hits.length > 0 ? Math.min(...hits.map((h) => h.start)) : null,
    count: hits.length,
  };
}

export type PriorFit = {
  post: GammaPost;
  model: "first" | "count";
  /** Events behind each level: [all speakers, speaker, speaker+eventType]. */
  n: [number, number, number];
};

/**
 * Hierarchical fit: all-speaker term rate → speaker → speaker × eventType,
 * each level used as a `strength`-pseudo-event prior for the next.
 */
export function fitPrior(
  corpus: TranscriptDoc[],
  spec: MatchSpec,
  target: { speaker: string; eventType: string },
  opts: { strength?: number; baseRate?: number } = {},
): PriorFit {
  const strength = opts.strength ?? 1;
  const model = spec.minCount > 1 ? "count" : "first";
  const upd = model === "first" ? updateFirstHit : updateCount;
  const obsAll = corpus.map((d) => ({ d, o: observe(d, spec) }));
  const spk = obsAll.filter((x) => x.d.speaker === target.speaker);
  const typ = spk.filter((x) => x.d.eventType === target.eventType);

  let post = priorFromRate(opts.baseRate ?? DEFAULT_BASE_RATE, strength);
  post = upd(post, obsAll.map((x) => x.o));
  post = upd(priorFromRate(mean(post), strength), spk.map((x) => x.o));
  post = upd(priorFromRate(mean(post), strength), typ.map((x) => x.o));
  return { post, model, n: [obsAll.length, spk.length, typ.length] };
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
