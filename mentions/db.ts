// Mentions tables live in the shared state/performance.db (WAL), alongside the
// crypto engine tables. Migrations are idempotent.

import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/schema.ts";
import type { MentionEvent } from "./discovery.ts";
import type { MatchSpec } from "./rules.ts";

export function runMentionMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mention_events (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      speaker     TEXT,
      event_type  TEXT,
      start_ms    INTEGER,
      end_ms      INTEGER,
      closed      INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mention_markets (
      id            TEXT PRIMARY KEY,
      event_id      TEXT NOT NULL,
      condition_id  TEXT NOT NULL,
      question      TEXT NOT NULL,
      term          TEXT NOT NULL,
      yes_token     TEXT NOT NULL,
      no_token      TEXT NOT NULL,
      tick_size     TEXT NOT NULL,
      neg_risk      INTEGER NOT NULL,
      closed        INTEGER NOT NULL,
      yes_price     REAL,
      resolved_yes  INTEGER,            -- NULL until closed
      description   TEXT,
      spec          TEXT,               -- JSON MatchSpec
      reviewed      INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mention_markets_event ON mention_markets(event_id);

    CREATE TABLE IF NOT EXISTS mention_price_history (
      token_id  TEXT    NOT NULL,
      t         INTEGER NOT NULL,       -- unix seconds
      p         REAL    NOT NULL,
      PRIMARY KEY (token_id, t)
    );
  `);
}

export function openMentionsDb(): Database {
  const db = openDatabase();
  runMentionMigrations(db);
  return db;
}

export function upsertEvent(db: Database, ev: MentionEvent, eventType: string | null = null): void {
  const now = Date.now();
  db.query(
    `INSERT INTO mention_events (id, slug, title, speaker, event_type, start_ms, end_ms, closed, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET title=?3, speaker=?4, event_type=COALESCE(?5, event_type),
       start_ms=?6, end_ms=?7, closed=?8, updated_at=?9`,
  ).run(ev.id, ev.slug, ev.title, ev.speaker, eventType, ev.startMs, ev.endMs, ev.closed ? 1 : 0, now);

  const q = db.query(
    `INSERT INTO mention_markets (id, event_id, condition_id, question, term, yes_token, no_token,
       tick_size, neg_risk, closed, yes_price, resolved_yes, description, spec, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(id) DO UPDATE SET closed=?10, yes_price=?11, resolved_yes=?12, updated_at=?15,
       -- never overwrite a human-reviewed spec
       spec=CASE WHEN reviewed=1 THEN spec ELSE ?14 END`,
  );
  for (const m of ev.markets) {
    const resolved =
      m.closed && (m.prices[0] === 1 || m.prices[0] === 0) ? (m.prices[0] === 1 ? 1 : 0) : null;
    q.run(
      m.id, ev.id, m.conditionId, m.question, m.term, m.yesTokenId, m.noTokenId,
      m.tickSize, m.negRisk ? 1 : 0, m.closed ? 1 : 0,
      Number.isFinite(m.prices[0]) ? m.prices[0] : null, resolved,
      m.description, m.spec ? JSON.stringify(m.spec) : null, now,
    );
  }
}

export function insertPriceHistory(db: Database, tokenId: string, hist: { t: number; p: number }[]): void {
  const q = db.query(`INSERT OR IGNORE INTO mention_price_history (token_id, t, p) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const h of hist) q.run(tokenId, h.t, h.p);
  })();
}

export function setReviewedSpec(db: Database, marketId: string, spec: MatchSpec): void {
  db.query(`UPDATE mention_markets SET spec = ?, reviewed = 1, updated_at = ? WHERE id = ?`).run(
    JSON.stringify({ ...spec, reviewed: true }),
    Date.now(),
    marketId,
  );
}
