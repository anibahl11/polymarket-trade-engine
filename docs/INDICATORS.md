# Indicators

All indicators update on a **fixed 1-second interval** regardless of how fast the loop runs or whether the asset price changed. This means period=14 always means "last 14 seconds."

---

## RSI (Relative Strength Index) on Gap

**Used in:** `engine/strategy/late-entry.ts`, `engine/strategy/btc-gap-fade.ts`

### What it measures

RSI measures the momentum of the gap (`btcPrice - priceToBeat`). It answers: *is the gap consistently growing or shrinking over the last N price changes?*

Since `priceToBeat` is fixed per slot, changes in the gap are identical to changes in BTC price. RSI on gap = RSI on BTC price direction.

### How it works

Each second, compute the change in gap:

```
delta = gap(now) - gap(1s ago)
gain  = delta > 0 ? delta : 0
loss  = delta < 0 ? |delta| : 0
```

**Seed phase** (first 14 periods): simple average of gains and losses to establish the initial baseline.

```
avg_gain = sum(gains[0..13]) / 14
avg_loss = sum(losses[0..13]) / 14
```

**Subsequent periods**: Wilder's smoothing:

```
avg_gain = (prev_avg_gain × 13 + gain) / 14
avg_loss = (prev_avg_loss × 13 + loss) / 14

RS  = avg_gain / avg_loss
RSI = 100 - (100 / (1 + RS))
```

The smoothing means a single bad tick contributes only 1/14th weight — one-second spikes barely move it.

### Interpretation

RSI is **direction-aware** — the same value means different things depending on which side the gap is on.

| RSI | Gap positive (UP territory) | Gap negative (DOWN territory) |
|---|---|---|
| > 70 (UP trend) | Green — RSI confirms UP, gap expanding | Red — RSI opposes DOWN, gap recovering toward zero |
| < 30 (DOWN trend) | Red — RSI opposes UP, gap shrinking | Green — RSI confirms DOWN, gap expanding downward |
| 30–70 (neutral) | Yellow — no clear trend, oscillating | Yellow — no clear trend, oscillating |

### Use in stop-loss suppression (late-entry)

RSI is used as a second layer of confirmation alongside the instantaneous gap check:

```
UP position   → rsiConfirmsMomentum if RSI >= 50
DOWN position → rsiConfirmsMomentum if RSI <= 50
```

Stop-loss windows:
- **remaining 80–20s**: suppress if gap confirms OR RSI confirms momentum
- **remaining < 20s**: suppress on gap confirmation only (not enough time for RSI to matter)

### Use as volatility quality gate (btc-gap-fade)

In `btc-gap-fade`, RSI is applied to the gap itself (not the price) to track whether momentum is truly shifting. It does not gate entry directly — ATR and PGR do — but it is updated each tick and contributes to the `Indicators` state tracked throughout the slot.

### When you see reversal (RSI < 30)

Reversal only appears when a previously large gap has been **consistently shrinking** over 14 seconds. A brief dip that recovers won't move RSI much. You need sustained gap contraction to reach < 30 — which is exactly the signal that a position is genuinely reversing.

---

## ATR (Average True Range)

**Used in:** `engine/strategy/late-entry.ts`, `engine/strategy/btc-gap-fade.ts`

### What it measures

ATR measures how much BTC price moves per second on average — the current volatility. It answers: *how jumpy is BTC right now?*

Note: this is a simplified ATR computed on raw price ticks, not OHLC candles. The formula is structurally identical to standard ATR (Wilder's smoothing of absolute moves) but the input is tick-to-tick changes rather than candle high-low range.

### How it works

Each second:

```
TR   = |btcPrice(now) - btcPrice(1s ago)|   // absolute dollar move
ATR  = (prev_ATR × 13 + TR) / 14           // Wilder's smoothing
```

### Interpretation

| ATR | Meaning |
|---|---|
| $1–5 | Low volatility — BTC moving slowly |
| $5–15 | Normal volatility |
| $15–30 | High volatility — BTC making large moves per second |
| > $30 | Very high volatility — significant market event |

### Safety ratio (late-entry)

The display shows `Safety: Nx` which is:

```
safety = abs(gap) / ATR
```

This answers: *how many average BTC moves would it take to close the gap?*

| Safety | Meaning |
|---|---|
| > 10x | Very safe — gap is large relative to current volatility |
| 3–10x | Moderate — gap could close with sustained movement |
| 1–3x | Risky — a few large ticks could flip the outcome |
| < 1x | Dangerous — gap is within normal noise range |

### Use as minimum gate (btc-gap-fade)

In `btc-gap-fade`, ATR must exceed `BGF_MIN_ATR` (default: 3) to enter. This blocks entries during dead periods when BTC is barely moving and the gap might be a statistical artefact rather than a real directional signal. Low ATR means reversion could stall rather than complete.

---

## RTV (Rolling Tick Volatility)

**Used in:** `engine/strategy/late-entry.ts`

### What it measures

RTV measures the average absolute BTC price move per second over a rolling 30-second window. It answers: *how much is BTC jumping around right now, independent of direction?*

This is distinct from ATR — ATR uses Wilder's smoothing over a longer history, while RTV is a plain rolling average of recent ticks with no smoothing bias.

### How it works

Each second, append the latest BTC price to a sliding window of up to 30 prices. Compute the mean absolute tick:

```
sum = Σ |price[i] - price[i-1]|   for all consecutive pairs in window
RTV = sum / (window_size - 1)
```

The window slides — prices older than 30 seconds are dropped. Returns `null` until at least 3 prices are available.

### Interpretation

| RTV | Meaning |
|---|---|
| < $1 | Very quiet — BTC barely moving tick-to-tick |
| $1–5 | Normal activity |
| > $5 | Choppy — large per-second swings, gap less predictable |

### Relationship to ATR

Both ATR and RTV measure BTC volatility per second, but:
- **ATR** smooths via Wilder's exponential average over 14 periods — slow to react, stable signal
- **RTV** is a plain rolling mean over the last 30 ticks — faster to react, more sensitive to recent bursts

---

## PGR (Peak Gap Ratio)

**Used in:** `engine/strategy/late-entry.ts`, `engine/strategy/btc-gap-fade.ts`

### What it measures

PGR measures how much of the slot's strongest move is still intact. It answers: *has the gap faded significantly from its peak, signaling momentum exhaustion?*

### How it works

Each second, track the maximum absolute gap seen this slot:

```
peakAbsGap = max(peakAbsGap, |gap|)
PGR        = |currentGap| / peakAbsGap
```

Reset to 0 between slots.

### Interpretation

| PGR | Meaning |
|---|---|
| 0.90–1.00 | Fresh/strong — gap near its peak |
| 0.75–0.90 | Normal fluctuation — some fade, still acceptable |
| < 0.75 | Momentum exhaustion — gap has lost 25%+ from peak |

### Use in entry gating (late-entry)

Case 4 requires:

```
peakGapRatio >= 0.75
```

If PGR is below 0.75, entry is blocked regardless of how safe the instantaneous indicators look.

### Use as fade confirmation (btc-gap-fade)

In `btc-gap-fade`, PGR is used inversely — the strategy *wants* the gap to have faded significantly. Entry requires:

```
pgr < BGF_FADE_RATIO   (default: 0.70)
```

This means the gap must have faded to less than 70% of its peak before entry. A higher `BGF_FADE_RATIO` allows entry earlier in the fade; a lower value waits for a more complete reversion.

**Why this matters:** A gap of $84 with a peak of $126 (PGR ≈ 0.67) is in meaningful reversion territory. Markets that have faded this much tend to continue declining into a full reversal, making the losing side a favorable buy.

---

## OFI (Order Flow Imbalance)

**Used in:** `engine/strategy/multi-level-ofi.ts`

### What it measures

OFI measures the balance between buy pressure (bids) and sell pressure (asks) at multiple levels of the order book. It answers: *is the market currently being pushed higher (buy pressure) or lower (sell pressure)?*

A positive OFI indicates bid pressure dominating — the UP side is favoured. A negative OFI indicates ask pressure — the DOWN side is favoured.

### How it works (multi-level weighted)

The top 3 price levels of the order book are used, with exponentially decaying weights:

```
weights = [1.0, 0.7, 0.4]

OFI = Σ (bidQty[i] - askQty[i]) × weights[i]    for i = 0, 1, 2
```

Where `bidQty[i]` and `askQty[i]` are the quantities at the i-th level from the top of the book.

### Signal construction

OFI is computed for both the UP and DOWN sides independently:

```
ofiUp   = OFI(UP book)
ofiDown = OFI(DOWN book)

Signal UP:   ofiUp > threshold AND ofiUp > -ofiDown
Signal DOWN: -ofiDown > threshold AND -ofiDown > ofiUp
```

Both conditions must hold to qualify as a signal. This filters out weak or ambiguous imbalances.

### Interpretation

| OFI | Meaning |
|---|---|
| Large positive | Strong bid pressure — buyers dominating, price likely to move up |
| Near zero | Balanced — no clear directional pressure |
| Large negative | Strong ask pressure — sellers dominating, price likely to move down |

### Academic basis

Multi-level OFI is derived from research by Cont et al. which found approximately 63% directional accuracy when OFI is used as a short-term price impact predictor. The weighted multi-level version outperforms single-level OFI because it captures the depth of the imbalance, not just the top of the book.

### Dislocation gate (multi-level-ofi strategy)

OFI alone is not sufficient for entry. The strategy also requires a BTC dislocation: BTC must have moved meaningfully (> `MLOFI_DISLOC_BTC_PCT`, default 0.02%) in the last 30 seconds in the same direction as the OFI signal, AND the token price must not yet reflect that move.

```
fairValue ≈ 0.5 + (gap / openPrice) × 5   // linear approximation
dislocation = |askPrice - fairValue| > MLOFI_DISLOC_TOKEN_GAP
```

This combination — OFI confirming direction + BTC moving + token lagging — identifies the specific moment when a systematic mispricing is both real and about to correct.

---

## PriceWindow (30-second sliding price window)

**Used in:** `engine/strategy/multi-level-ofi.ts`

### What it measures

PriceWindow maintains a sliding window of recent BTC price samples over the last N milliseconds. It answers: *how much has BTC moved in the last 30 seconds?*

### How it works

```
push(ts, price):
  append {ts, price} to samples
  drop all samples where ts < (now - windowMs)

oldest() → samples[0].price
latest() → samples[last].price

pctMove = |latest - oldest| / oldest
```

### Use in dislocation detection

In `multi-level-ofi`, a 30-second window (`windowMs = 30_000`) is used to compute BTC's recent percentage move. This is compared against `MLOFI_DISLOC_BTC_PCT` to qualify whether a real move has occurred that the token market hasn't yet priced in.

---

## Display

```
Indicators: ATR: $8.23  |  Safety: 9.1x  |  RTV: $3.12  |  PGR: 0.85
```

RSI is color-coded based on whether it confirms or opposes the current gap direction:
- Green — RSI supports the current gap side holding
- Red — RSI is working against the current gap side
- Yellow — neutral, no clear momentum
