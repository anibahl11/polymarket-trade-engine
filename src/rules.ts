// Resolution-rules parsing: market question + description → MatchSpec.
// Heuristic only. Every spec starts `reviewed: false`; live trading requires a
// human (UI or mentions/specs/<event>.json) to flip it.

export type MatchSpec = {
  /** Alternatives; any one counts. Each is a lowercase token sequence. */
  terms: string[][];
  allowPlural: boolean;
  allowPossessive: boolean;
  /** Term embedded in a larger word (e.g. hyphenated compound) counts. */
  allowCompound: boolean;
  /** Mentions required for YES (e.g. "3+ times" markets). */
  minCount: number;
  reviewed: boolean;
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

const QUOTED = /["“”]([^"“”]+)["“”]|‘([^’]+)’|'([^']{2,})'/;

/** Pull the term from `groupItemTitle` (preferred) or the first quoted span. */
export function extractTerm(question: string, groupItemTitle?: string): string | null {
  if (groupItemTitle?.trim()) return groupItemTitle.trim();
  const m = question.match(QUOTED);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() || null : null;
}

export function parseRules(input: {
  question: string;
  description?: string;
  groupItemTitle?: string;
}): MatchSpec | null {
  const term = extractTerm(input.question, input.groupItemTitle);
  if (!term) return null;
  const desc = (input.description ?? "").toLowerCase();

  const terms = term
    .split(/\s*\/\s*|\s+or\s+/i)
    .map(tokenize)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;

  const pluralOk = /plural/.test(desc) && !/plural\w*[^.]*\b(not|won't|will not)\b/.test(desc);
  const possessiveOk =
    /possessive/.test(desc) && !/possessive\w*[^.]*\b(not|won't|will not)\b/.test(desc);
  const compoundOk =
    /compound/.test(desc) && !/compound\w*[^.]*\b(not|won't|will not)\b/.test(desc);

  const countMatch = (input.question + " " + desc).match(/(\d+)\s*\+?\s*(?:or more\s+)?times/);
  const minCount = countMatch ? Math.max(1, parseInt(countMatch[1]!, 10)) : 1;

  return {
    terms,
    allowPlural: pluralOk,
    allowPossessive: possessiveOk,
    allowCompound: compoundOk,
    minCount,
    reviewed: false,
  };
}

/** All surface forms a single spoken token may take for `base` under `spec`. */
export function variantsOf(base: string, spec: MatchSpec): Set<string> {
  const out = new Set([base]);
  const plurals: string[] = [];
  if (spec.allowPlural) {
    plurals.push(base + "s", base + "es");
    if (/[^aeiou]y$/.test(base)) plurals.push(base.slice(0, -1) + "ies");
    for (const p of plurals) out.add(p);
  }
  if (spec.allowPossessive) {
    out.add(base + "'s");
    out.add(base + "s'");
    for (const p of plurals) out.add(p + "'");
  }
  return out;
}
