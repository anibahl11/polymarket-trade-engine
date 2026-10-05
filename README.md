# mention-engine

Trading engine for Polymarket **mention markets**: "Will X say Y during event Z?".

Three strategies (see [docs/PLAN.md](docs/PLAN.md)):

| # | Strategy | When | Edge |
|---|----------|------|------|
| S1 | Prior mispricing | Pre-event | Historical-transcript base rates vs market price (longshot bias) |
| S2 | Live decay | During event | Fair value decays every minute the word goes unsaid; markets lag |
| S3 | Live snipe | During event | Streaming ASR (Deepgram) detects the word → buy YES before reprice |

Simulation is the default. Live trading needs `SIMULATION_MODE=false` **and** `--prod`.

## Quick start

```bash
bun install
cp .env.sample .env
bun run scan        # open mention events → state/mentions.db
bun run backfill    # closed events + price history
bun run calibrate   # market price vs realized YES rate, after fees
bun test && bun run check
```

## Layout

```
src/
  cli.ts            scan | backfill | calibrate
  discovery.ts      Gamma API events/markets, CLOB price history
  rules.ts          resolution text → MatchSpec (reviewed before live)
  matcher.ts        ASR word stream → hits
  fees.ts           Polymarket fee schedule, edge, Kelly
  book.ts           N-token order book (WS)
  db.ts             mention_* tables
  model/            prior (Gamma-Poisson), hazard (live decay), calibration
  venue/            Polymarket CLOB client (sim + live)
  lib/              env, safety gates, logging, sqlite, ws, fetch
```

## Credits

The Polymarket client and infrastructure utilities derive from
[polymarket-trade-engine](https://github.com/anibahl11/polymarket-trade-engine) (MIT, see LICENSE).
