# Mention Markets Engine — Plan (branch `claude/mention-markets`)

## Context
Standalone project (spun out of a crypto slot-market engine; only the Polymarket client, safety gates and infra utils were kept, under `src/venue` and `src/lib`).
Mention markets: one live event → N binary word markets, uncertain start/duration, outcome driven by speech.
Venue: Polymarket first. ASR: Deepgram streaming. Strategies: S1 pre-event mispricing, S2 live decay, S3 live snipe. Cross-venue arb deferred.

## Module layout `src/`
- `discovery.ts`: Gamma API lookup of mention events and markets (verify tag/series filter in P1), mapping event → markets → YES/NO token ids, tick size, negRisk, end time, rules text.
- `rules.ts`: rules text → `MatchSpec {terms[], variants (plural/possessive/hyphen), speakerOnly, includesQA, window}`. Heuristic parse, then saved to DB with `reviewed=false`. **Live trading on a market requires `reviewed=true`** (set from the UI or a JSON override in `specs/<event>.json`).
- `fees.ts`: Polymarket taker fee = `0.04 · shares · p · (1−p)` (max 1¢/share at 0.50); maker fee 0, configurable. `edgeAfterFees(fair, price, side)`.
- `model/prior.ts`: Gamma-Poisson rate λ (mentions/min) for each speaker × event type × term, shrunk toward speaker-wide and then global priors. `P(yes) = 1 − (β/(β+T))^α` for expected duration T. Optional manual "news multiplier" per term.
- `model/hazard.ts`: live posterior after t minutes with no mention: `β' = β + t`, with the remaining-duration distribution by event type. Event-end signal (manual or ASR silence) sets remaining → 0, so fair value → 0.
- `model/calibration.ts`: backfill resolved Polymarket mention markets plus CLOB price history to measure market miscalibration by price bucket (longshot bias). This feeds S1 thresholds and is the first proof of edge.
- `corpus/`: transcript loaders (Fed press conference PDFs, factba.se/Roll Call, C-SPAN, earnings calls) → normalized `{speaker, eventType, durationMin, text}` → term counts for the prior.
- `ingest/audio.ts`: `yt-dlp` / HLS → `ffmpeg` → 16k PCM. `ingest/deepgram.ts`: WS `nova-3`, interim results, keyterm boosting for active terms, word timestamps and confidence. Every word is recorded to disk for replay.
- `matcher.ts`: tokenized word stream → `MatchSpec` hits, handling multi-word terms across chunk boundaries, interim vs final confidence thresholds, and de-duplication.
- `positions.ts`: per-market YES/NO inventory, average cost, exposure caps (per market, per event, daily loss), shared across strategies.
- `strategies/`:
  - `prior-mispricing.ts` (S1, pre-event): trade when `|fair − price| > fee + margin`. Fractional Kelly sizing, capped. Mostly NO on overpriced longshots.
  - `decay.ts` (S2, live): re-price every N seconds from `hazard.ts`. Rest or take NO when the YES bid is above fair + edge. Cap NO exposure, because a mention costs up to (1 − p).
  - `snipe.ts` (S3, live): on a matcher hit, first cancel our resting NO orders and sells on that market, then FOK buy YES up to `maxPrice − fee`, sized to book depth. On a final-confidence miss (interim hit later revised), flatten.
- `session.ts`: `EventSession` orchestrator. States: DISCOVER → PRE → LIVE → ENDED → RESOLVED (redeem). Wires the book, positions, strategies, ingest and DB.
- `replay.ts`: replay recorded word stream plus book snapshots through the same session in sim mode (the backtest).
- `server.ts`: engine-side live API on localhost. SSE stream (books, fair values, transcript, hits, fills, P&L) plus POST controls: kill switch, toggle strategy per market, mark spec reviewed, manual "said" / "event ended".
- CLI (`commander`, like `index.ts`): `bun src/cli.ts scan | backfill | run --event <slug> --stream <url> --strategies prior,decay,snipe [--prod] | replay --session <id>`.

## DB (`src/db.ts`, `state/mentions.db`)
`mention_events`, `mention_markets` (spec JSON, reviewed), `mention_words` (ts, word, conf, final), `mention_hits`, `mention_signals` (fair, price, edge, strategy), `mention_orders` / `mention_fills`, `mention_calibration`.

## UI: `ui/index.html` served by the engine (`src/server.ts`)
- **Scanner**: upcoming mention events with market count, total edge after fees, and spec review status.
- **Live event board**: one tile per term showing YES bid/ask, fair value, edge, position, status (unsaid / said / dead), and enabled strategies. Live transcript ticker with highlighted hits. Fair-value decay sparkline per term.
- **Controls**: kill switch, per-market strategy toggles, review spec, manual "said" / "event ended".
- **Analytics**: calibration chart (market price vs realized frequency), P&L by strategy and event type.
- Mobile-first, dark/light, no build step (matches the current single-file dashboard). Single server: history from the DB, live state via SSE.

## Phases (each ends green on `bun test` + `bun run check`, then commit and push)
1. **Data foundation**: `discovery`, `rules`, `fees`, `MultiOrderBook`, DB migrations, `backfill` + calibration report. Gate: the report shows whether a longshot bias exists after fees.
2. **Models**: `corpus` loaders, `prior`, `hazard`, plus unit tests (closed-form checks, shrinkage, decay monotonicity).
3. **Engine + S1/S2 in sim**: `positions`, `session`, `prior-mispricing`, `decay`, `replay`.
4. **ASR + S3**: `audio`, `deepgram`, `matcher` (tests for variants, plurals, homophones, chunk boundaries), `snipe`, recording to disk.
5. **UI**: engine `server.ts` + `mentions.html` + dashboard API routes.
6. **Go-live gate**: one or more live events paper-traded end to end, replay P&L reviewed, all specs reviewed, caps set. Then `--prod` + `SIMULATION_MODE=false`.

New env: `DEEPGRAM_API_KEY`, `MENTIONS_MAX_MARKET_USD`, `MENTIONS_MAX_EVENT_USD`, `MENTIONS_DAILY_LOSS_USD`, `MENTIONS_KELLY_FRACTION`, `MENTIONS_SNIPE_MAX_PRICE`, `MENTIONS_MIN_EDGE`. Requires `yt-dlp` and `ffmpeg` on the host.

## Verification
- `bun test test/mentions/*` for fees, rules parsing, matcher, prior/hazard math, positions caps, and snipe cancel-before-buy ordering.
- `bun run check` for types.
- `bun src/cli.ts backfill`, then inspect the calibration output.
- `bun src/cli.ts replay --session <fixture>` should give deterministic P&L on a recorded fixture.
- Paper run on a real live event: `run --event <slug> --stream <url>` in sim mode, watching `mentions.html` live. Hits should appear within about 1s of the audio, with no orders sent outside sim.
