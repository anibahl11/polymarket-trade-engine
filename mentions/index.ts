// Mentions engine CLI.
//   bun mentions/index.ts scan                     — list open mention events
//   bun mentions/index.ts backfill [--max 500]     — closed events + price history → DB
//   bun mentions/index.ts calibrate [--hours 24]   — market calibration report

import { Command } from "commander";
import { fetchAllMentionEvents, fetchPriceHistory } from "./discovery.ts";
import { insertPriceHistory, openMentionsDb, upsertEvent } from "./db.ts";
import { calibrate, priceAt, type CalRow } from "./model/calibration.ts";

const program = new Command().name("mentions");

program
  .command("scan")
  .description("Fetch open mention events and store them")
  .action(async () => {
    const db = openMentionsDb();
    const events = await fetchAllMentionEvents(false, 500);
    for (const ev of events) upsertEvent(db, ev);
    console.table(
      events.map((e) => ({
        slug: e.slug,
        speaker: e.speaker,
        markets: e.markets.length,
        unparsed: e.markets.filter((m) => !m.spec).length,
        start: e.startMs ? new Date(e.startMs).toISOString().slice(0, 16) : "?",
      })),
    );
  });

program
  .command("backfill")
  .description("Store closed mention events and YES price history")
  .option("--max <n>", "max events", "500")
  .option("--fidelity <min>", "price history resolution (minutes)", "10")
  .action(async (opts) => {
    const db = openMentionsDb();
    const events = await fetchAllMentionEvents(true, parseInt(opts.max, 10));
    console.log(`[backfill] ${events.length} closed events`);
    let n = 0;
    for (const ev of events) {
      upsertEvent(db, ev);
      for (const m of ev.markets) {
        const hist = await fetchPriceHistory(m.yesTokenId, parseInt(opts.fidelity, 10));
        insertPriceHistory(db, m.yesTokenId, hist);
        n++;
        await Bun.sleep(100); // be polite to the CLOB API
      }
    }
    console.log(`[backfill] price history for ${n} markets`);
  });

program
  .command("calibrate")
  .description("Market price vs realized frequency on resolved markets")
  .option("--hours <h>", "reference point: hours before event start", "24")
  .action((opts) => {
    const db = openMentionsDb();
    const hours = parseFloat(opts.hours);
    const rows = db
      .query(
        `SELECT m.yes_token AS token, m.resolved_yes AS yes, COALESCE(e.start_ms, e.end_ms) AS ref_ms
         FROM mention_markets m JOIN mention_events e ON e.id = m.event_id
         WHERE m.resolved_yes IS NOT NULL AND COALESCE(e.start_ms, e.end_ms) IS NOT NULL`,
      )
      .all() as { token: string; yes: number; ref_ms: number }[];
    const hq = db.query(`SELECT t, p FROM mention_price_history WHERE token_id = ? ORDER BY t`);
    const cal: CalRow[] = [];
    for (const r of rows) {
      const p = priceAt(hq.all(r.token) as { t: number; p: number }[], r.ref_ms / 1000 - hours * 3600);
      if (p !== null) cal.push({ price: p, yes: r.yes === 1 });
    }
    console.log(`[calibrate] ${cal.length}/${rows.length} markets with a price ${hours}h before start`);
    console.table(
      calibrate(cal).map((b) => ({
        bucket: `${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`,
        n: b.n,
        price: b.meanPrice.toFixed(3),
        realized: b.realized.toFixed(3),
        yesEdge: b.yesEdge.toFixed(3),
        noEdge: b.noEdge.toFixed(3),
      })),
    );
  });

await program.parseAsync();
