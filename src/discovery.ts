// Gamma API discovery for mention events/markets + CLOB price history.
// NOTE: tag slug and some field names are unverified against live API
// (network blocked in the build env). Override with MENTIONS_TAG_SLUG.

import { fetchWithRetry } from "./lib/fetch-retry.ts";
import { MENTIONS_FEE, type FeeSchedule } from "./fees.ts";
import { parseRules, type MatchSpec } from "./rules.ts";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const TAG_SLUG = process.env.MENTIONS_TAG_SLUG ?? "mention-markets";

type RawMarket = {
  id: string;
  conditionId: string;
  question: string;
  groupItemTitle?: string;
  description?: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices: string;
  closed: boolean;
  endDate?: string;
  orderPriceMinTickSize?: number;
  negRisk?: boolean;
  feeSchedule?: FeeSchedule;
};

type RawEvent = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  eventStartTime?: string;
  negRisk?: boolean;
  closed?: boolean;
  markets: RawMarket[];
};

export type MentionMarket = {
  id: string;
  conditionId: string;
  question: string;
  term: string;
  yesTokenId: string;
  noTokenId: string;
  tickSize: string;
  negRisk: boolean;
  closed: boolean;
  /** [yes, no] last prices. After resolution: 1/0. */
  prices: [number, number];
  fee: FeeSchedule;
  description: string;
  spec: MatchSpec | null;
};

export type MentionEvent = {
  id: string;
  slug: string;
  title: string;
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  closed: boolean;
  markets: MentionMarket[];
};

function parseJsonArr(s: string | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** "What will Trump say during …" → "Trump". */
export function inferSpeaker(title: string): string | null {
  const m = title.match(/will\s+(.+?)\s+say\b/i);
  return m ? m[1]!.trim() : null;
}

export function parseMarket(raw: RawMarket, eventNegRisk = false): MentionMarket | null {
  const ids = parseJsonArr(raw.clobTokenIds);
  const outcomes = parseJsonArr(raw.outcomes).map((o) => o.toLowerCase());
  const prices = parseJsonArr(raw.outcomePrices).map(Number);
  const yi = outcomes.indexOf("yes");
  const ni = outcomes.indexOf("no");
  if (yi < 0 || ni < 0 || !ids[yi] || !ids[ni]) return null;
  const spec = parseRules({
    question: raw.question,
    description: raw.description,
    groupItemTitle: raw.groupItemTitle,
  });
  return {
    id: raw.id,
    conditionId: raw.conditionId,
    question: raw.question,
    term: raw.groupItemTitle?.trim() || spec?.terms.map((t) => t.join(" ")).join(" / ") || raw.question,
    yesTokenId: ids[yi]!,
    noTokenId: ids[ni]!,
    tickSize: String(raw.orderPriceMinTickSize ?? "0.01"),
    negRisk: raw.negRisk ?? eventNegRisk,
    closed: raw.closed,
    prices: [prices[yi] ?? NaN, prices[ni] ?? NaN],
    fee: raw.feeSchedule ?? MENTIONS_FEE,
    description: raw.description ?? "",
    spec,
  };
}

export function parseEvent(raw: RawEvent): MentionEvent {
  const ms = (s?: string) => (s ? Date.parse(s) || null : null);
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    speaker: inferSpeaker(raw.title),
    startMs: ms(raw.eventStartTime) ?? ms(raw.startDate),
    endMs: ms(raw.endDate),
    closed: raw.closed ?? false,
    markets: raw.markets
      .map((m) => parseMarket(m, raw.negRisk))
      .filter((m): m is MentionMarket => m !== null),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithRetry(url);
  return (await res.json()) as T;
}

export async function fetchMentionEvents(opts: {
  closed: boolean;
  limit?: number;
  offset?: number;
}): Promise<MentionEvent[]> {
  const u = new URL(`${GAMMA}/events`);
  u.searchParams.set("tag_slug", TAG_SLUG);
  u.searchParams.set("closed", String(opts.closed));
  u.searchParams.set("limit", String(opts.limit ?? 100));
  u.searchParams.set("offset", String(opts.offset ?? 0));
  const raw = await getJson<RawEvent[]>(u.toString());
  return raw.map(parseEvent);
}

export async function fetchAllMentionEvents(closed: boolean, max = 2000): Promise<MentionEvent[]> {
  const out: MentionEvent[] = [];
  for (let offset = 0; offset < max; offset += 100) {
    const page = await fetchMentionEvents({ closed, limit: 100, offset });
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

export async function fetchEventBySlug(slug: string): Promise<MentionEvent | null> {
  const raw = await getJson<RawEvent[]>(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  return raw[0] ? parseEvent(raw[0]) : null;
}

/** CLOB price history for one token. `fidelity` in minutes. */
export async function fetchPriceHistory(
  tokenId: string,
  fidelity = 10,
): Promise<{ t: number; p: number }[]> {
  const r = await getJson<{ history: { t: number; p: number }[] }>(
    `${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=${fidelity}`,
  );
  return r.history ?? [];
}
