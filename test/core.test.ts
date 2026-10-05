import { describe, test, expect } from "bun:test";
import { buyEdge, feePerShare, kellyFraction } from "../src/fees.ts";
import { parseRules, variantsOf, type MatchSpec } from "../src/rules.ts";
import { Matcher, type AsrWord } from "../src/matcher.ts";
import { pAtLeast, fitPrior, observe, type TranscriptDoc } from "../src/model/prior.ts";
import { liveFair } from "../src/model/hazard.ts";
import { calibrate, priceAt } from "../src/model/calibration.ts";
import { parseEvent } from "../src/discovery.ts";
import { MultiOrderBook } from "../src/book.ts";

const spec = (terms: string[][], o: Partial<MatchSpec> = {}): MatchSpec => ({
  terms,
  allowPlural: true,
  allowPossessive: true,
  allowCompound: false,
  minCount: 1,
  reviewed: true,
  ...o,
});

const words = (text: string, t0 = 0, conf = 0.95): AsrWord[] =>
  text.split(" ").map((w, i) => ({ text: w, start: t0 + i * 0.3, end: t0 + i * 0.3 + 0.3, confidence: conf }));

describe("fees", () => {
  test("mentions fee caps at 1¢/share at 0.50", () => {
    expect(feePerShare(0.5)).toBeCloseTo(0.01, 10);
    expect(feePerShare(0.1)).toBeCloseTo(0.0036, 10);
    expect(feePerShare(0.5, false)).toBe(0);
  });
  test("edge and kelly", () => {
    expect(buyEdge(0.3, 0.2)).toBeCloseTo(0.3 - 0.2 - 0.0064, 10);
    expect(kellyFraction(0.3, 0.2)).toBeCloseTo(0.125, 10);
    expect(kellyFraction(0.1, 0.2)).toBe(0);
  });
});

describe("rules", () => {
  test("parses term, slashes, plural/possessive, count", () => {
    const s = parseRules({
      question: 'Will Powell say "Tariff / Trade War" 3+ times during the press conference?',
      description:
        "Pluralization/possessive of the term will count toward the resolution of this market. Compound words will not count.",
    })!;
    expect(s.terms).toEqual([["tariff"], ["trade", "war"]]);
    expect(s.allowPlural).toBe(true);
    expect(s.allowPossessive).toBe(true);
    expect(s.allowCompound).toBe(false);
    expect(s.minCount).toBe(3);
    expect(s.reviewed).toBe(false);
  });
  test("variants", () => {
    const v = variantsOf("policy", spec([["policy"]]));
    expect(v.has("policies")).toBe(true);
    expect(v.has("policy's")).toBe(true);
  });
});

describe("matcher", () => {
  test("single token, plural, dedupe finals", () => {
    const m = new Matcher();
    m.setSpecs({ a: spec([["tariff"]]) });
    expect(m.scan(words("we will raise tariffs now"), false)).toHaveLength(1);
    const h = m.scan(words("we will raise tariffs now"), true);
    expect(h[0]!.resolvesYes).toBe(true);
    expect(m.scan(words("we will raise tariffs now"), true)).toHaveLength(0);
    expect(m.count("a")).toBe(1);
  });
  test("multi-word across final segment boundary", () => {
    const m = new Matcher();
    m.setSpecs({ b: spec([["trade", "war"]]) });
    expect(m.scan(words("a big trade", 0), true)).toHaveLength(0);
    const h = m.scan(words("war is coming", 1), true);
    expect(h).toHaveLength(1);
    expect(h[0]!.term).toBe("trade war");
  });
  test("no false positive on substring without compound", () => {
    const m = new Matcher();
    m.setSpecs({ c: spec([["crypto"]]) });
    expect(m.scan(words("cryptocurrency is great"), true)).toHaveLength(0);
    m.setSpecs({ c: spec([["crypto"]], { allowCompound: true }) });
    expect(m.scan(words("pro-crypto stance", 5), true)).toHaveLength(1);
  });
  test("minCount", () => {
    const m = new Matcher();
    m.setSpecs({ d: spec([["china"]], { minCount: 2 }) });
    expect(m.scan(words("china", 0), true)[0]!.resolvesYes).toBe(false);
    expect(m.scan(words("china", 10), true)[0]!.resolvesYes).toBe(true);
  });
});

describe("prior + hazard", () => {
  test("closed form", () => {
    expect(pAtLeast({ alpha: 1, beta: 60 }, 60)).toBeCloseTo(0.5, 10);
    expect(pAtLeast({ alpha: 1, beta: 60 }, 0)).toBe(0);
    expect(pAtLeast({ alpha: 2, beta: 60 }, 60, 2)).toBeLessThan(pAtLeast({ alpha: 2, beta: 60 }, 60, 1));
  });
  test("observe uses token position as time", () => {
    const o = observe({ speaker: "x", eventType: "s", durationMin: 10, text: "a b c d e tariffs f g h i" }, spec([["tariff"]]));
    expect(o.firstHitMin).toBeCloseTo(5, 10);
    expect(o.count).toBe(1);
  });
  test("hierarchical fit shrinks toward speaker history", () => {
    const corpus: TranscriptDoc[] = [
      ...Array.from({ length: 10 }, () => ({ speaker: "A", eventType: "rally", durationMin: 60, text: "tariff ".repeat(1) + "x ".repeat(99) })),
      ...Array.from({ length: 10 }, () => ({ speaker: "B", eventType: "rally", durationMin: 60, text: "x ".repeat(100) })),
    ];
    const a = fitPrior(corpus, spec([["tariff"]]), { speaker: "A", eventType: "rally" });
    const b = fitPrior(corpus, spec([["tariff"]]), { speaker: "B", eventType: "rally" });
    expect(pAtLeast(a.post, 60)).toBeGreaterThan(0.8);
    expect(pAtLeast(b.post, 60)).toBeLessThan(0.15);
    expect(a.n).toEqual([20, 10, 10]);
  });
  test("live fair decays monotonically and snaps on events", () => {
    const fit = { post: { alpha: 1, beta: 60 }, model: "first" as const, n: [0, 0, 0] as [number, number, number] };
    const st = (e: number, o: Partial<{ hits: number; ended: boolean }> = {}) =>
      liveFair(fit, { elapsedMin: e, hits: 0, minCount: 1, ended: false, ...o }, [60]);
    expect(st(0)).toBeCloseTo(0.5, 10);
    expect(st(30)).toBeCloseTo(0.25, 10);
    expect(st(45)).toBeLessThan(st(30));
    expect(st(10, { hits: 1 })).toBe(1);
    expect(st(10, { ended: true })).toBe(0);
  });
});

describe("calibration", () => {
  test("buckets and priceAt", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ price: 0.3, yes: i < 1 })),
      ...Array.from({ length: 10 }, () => ({ price: 0.9, yes: true })),
    ];
    const c = calibrate(rows);
    const low = c.find((b) => b.lo === 0.2)!;
    expect(low.realized).toBeCloseTo(0.1, 10);
    expect(low.noEdge).toBeGreaterThan(0.1);
    expect(priceAt([{ t: 1, p: 0.1 }, { t: 5, p: 0.2 }, { t: 9, p: 0.3 }], 6)).toBe(0.2);
    expect(priceAt([{ t: 5, p: 0.2 }], 1)).toBeNull();
  });
});

describe("discovery + book", () => {
  test("parseEvent maps yes/no tokens by outcome label", () => {
    const ev = parseEvent({
      id: "1",
      slug: "what-will-trump-say",
      title: "What will Trump say during the rally?",
      eventStartTime: "2026-10-06T18:00:00Z",
      markets: [
        {
          id: "m1",
          conditionId: "c1",
          question: 'Will Trump say "Crypto"?',
          groupItemTitle: "Crypto",
          clobTokenIds: '["NO_ID","YES_ID"]',
          outcomes: '["No","Yes"]',
          outcomePrices: '["0.7","0.3"]',
          closed: false,
        },
      ],
    });
    expect(ev.speaker).toBe("Trump");
    expect(ev.markets[0]!.yesTokenId).toBe("YES_ID");
    expect(ev.markets[0]!.prices).toEqual([0.3, 0.7]);
    expect(ev.startMs).toBe(Date.parse("2026-10-06T18:00:00Z"));
  });
  test("multi book snapshot + depth", () => {
    const b = new MultiOrderBook();
    let updates = 0;
    b.onUpdate(() => updates++);
    b.handle([
      { event_type: "book", asset_id: "y", bids: [{ price: "0.2", size: "100" }], asks: [{ price: "0.25", size: "50" }, { price: "0.3", size: "70" }] },
    ]);
    b.handle({ event_type: "price_change", price_changes: [{ asset_id: "y", price: "0.25", size: "0", side: "SELL" }] });
    expect(b.bestAsk("y")).toBe(0.3);
    expect(b.bestBid("y")).toBe(0.2);
    expect(b.askDepth("y", 0.3)).toBe(70);
    expect(updates).toBe(2);
  });
});
