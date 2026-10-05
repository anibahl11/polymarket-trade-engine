// Live word stream → MatchSpec hits. Feed ASR segments as they arrive
// (interim and final). Final hits are counted; interim hits are provisional and
// returned so the snipe strategy can act on them at a stricter confidence.

import { tokenize, variantsOf, type MatchSpec } from "./rules.ts";

export type AsrWord = {
  text: string;
  /** Seconds from stream start. */
  start: number;
  end: number;
  confidence: number;
};

export type MatchHit = {
  marketId: string;
  term: string;
  start: number;
  /** Min word confidence across the matched span. */
  confidence: number;
  final: boolean;
  /** Final count (incl. this hit if final) reaches spec.minCount. */
  resolvesYes: boolean;
  context: string;
};

type Compiled = {
  spec: MatchSpec;
  /** Per alternative: per token position, accepted surface forms. */
  alts: { label: string; positions: Set<string>[] }[];
};

const KEY_RES = 0.25; // seconds; final hits closer than this are the same utterance

export class Matcher {
  private compiled = new Map<string, Compiled>();
  private finalHits = new Map<string, number[]>(); // marketId → hit start times
  private tail: { tok: string; w: AsrWord }[] = [];
  private maxLen = 1;

  setSpecs(specs: Record<string, MatchSpec>): void {
    this.compiled.clear();
    this.maxLen = 1;
    for (const [marketId, spec] of Object.entries(specs)) {
      const alts = spec.terms.map((toks) => {
        this.maxLen = Math.max(this.maxLen, toks.length);
        return {
          label: toks.join(" "),
          positions: toks.map((t, i) =>
            // Inflection applies to the head (last) token only.
            i === toks.length - 1 ? variantsOf(t, spec) : new Set([t]),
          ),
        };
      });
      this.compiled.set(marketId, { spec, alts });
    }
  }

  count(marketId: string): number {
    return this.finalHits.get(marketId)?.length ?? 0;
  }

  /** Manually mark a market as said (UI override). */
  forceHit(marketId: string, start = -1): void {
    const arr = this.finalHits.get(marketId) ?? [];
    arr.push(start);
    this.finalHits.set(marketId, arr);
  }

  scan(words: AsrWord[], isFinal: boolean): MatchHit[] {
    const fresh = words.flatMap((w) => tokenize(w.text).map((tok) => ({ tok, w })));
    const seq = [...this.tail, ...fresh];
    const firstFresh = this.tail.length;
    const hits: MatchHit[] = [];

    for (const [marketId, c] of this.compiled) {
      for (const alt of c.alts) {
        const n = alt.positions.length;
        for (let i = 0; i + n <= seq.length; i++) {
          if (i + n - 1 < firstFresh) continue; // fully inside tail: already reported
          let ok = true;
          for (let j = 0; j < n && ok; j++) {
            ok = tokenMatches(seq[i + j]!.tok, alt.positions[j]!, c.spec, n === 1);
          }
          if (!ok) continue;
          const span = seq.slice(i, i + n);
          const start = span[0]!.w.start;
          const hit: MatchHit = {
            marketId,
            term: alt.label,
            start,
            confidence: Math.min(...span.map((s) => s.w.confidence)),
            final: isFinal,
            resolvesYes: false,
            context: seq
              .slice(Math.max(0, i - 4), i + n + 4)
              .map((s) => s.tok)
              .join(" "),
          };
          if (isFinal) {
            const arr = this.finalHits.get(marketId) ?? [];
            if (arr.some((t) => Math.abs(t - start) < KEY_RES)) continue;
            arr.push(start);
            this.finalHits.set(marketId, arr);
            hit.resolvesYes = arr.length >= c.spec.minCount;
          } else {
            hit.resolvesYes = this.count(marketId) + 1 >= c.spec.minCount;
          }
          hits.push(hit);
        }
      }
    }

    if (isFinal) this.tail = this.maxLen > 1 ? seq.slice(-(this.maxLen - 1)) : [];
    return hits;
  }
}

function tokenMatches(
  tok: string,
  forms: Set<string>,
  spec: MatchSpec,
  singleToken: boolean,
): boolean {
  if (forms.has(tok)) return true;
  if (!spec.allowCompound || !singleToken) return false;
  if (tok.includes("-") && tok.split("-").some((p) => forms.has(p))) return true;
  for (const f of forms) if (f.length >= 4 && tok.includes(f)) return true;
  return false;
}
