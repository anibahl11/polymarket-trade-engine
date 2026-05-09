#!/bin/bash
# start-sim.sh — launch all five strategy simulators + dashboard
#
# Mode:        PAPER TRADING (simulated balance, no real orders)
# Dashboard:   http://localhost:3001
# Logs:        /tmp/bgf.log  /tmp/pm.log  /tmp/mlofi.log  /tmp/mi.log  /tmp/le.log  /tmp/dashboard.log
#
# Thresholds are loosened from defaults to fire more frequently in
# low-volatility conditions. Tighten them back once you have enough
# data to evaluate real-market entry quality.
#
# To stop:              bash scripts/stop-sim.sh
# To restart dashboard: bash scripts/restart-dashboard.sh

set -e
cd "$(dirname "$0")/.."
BUN=~/.bun/bin/bun

echo "[sim] Checking bun..."
$BUN --version

echo "[sim] Stopping any existing engine/dashboard processes..."
pkill -f "bun index.ts" 2>/dev/null || true
pkill -f "bun dashboard/server.ts" 2>/dev/null || true
sleep 1

echo "[sim] Removing stale locks..."
rm -f state/bgf/early-bird.lock state/pm/early-bird.lock state/mlofi/early-bird.lock \
      state/mi/early-bird.lock  state/le/early-bird.lock  state/early-bird.lock

echo "[sim] Creating state dirs..."
mkdir -p state/bgf state/pm state/mlofi state/mi state/le

# Reset sessionLoss in each state file so carried-over losses from prior sim
# runs don't trip the MAX_SESSION_LOSS gate on startup.
echo "[sim] Resetting sessionLoss in state files..."
for f in \
  state/early-bird-btc-gap-fade.json \
  state/early-bird-passive-maker.json \
  state/early-bird-multi-level-ofi.json \
  state/early-bird-momentum-imbalance.json \
  state/early-bird-late-entry.json \
  state/early-bird-simulation.json; do
  if [ -f "$f" ]; then
    ~/.bun/bin/bun -e "
      import { readFileSync, writeFileSync, renameSync } from 'fs';
      const s = JSON.parse(readFileSync('$f', 'utf8'));
      s.sessionLoss = 0;
      s.sessionPnl  = 0;
      const tmp = '$f.tmp';
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
      renameSync(tmp, '$f');
      console.log('  reset $f');
    " 2>/dev/null || true
  fi
done

# --- Dashboard ----------------------------------------------------------------
echo "[sim] Starting dashboard on :3001..."
DASHBOARD_PORT=3001 $BUN dashboard/server.ts > /tmp/dashboard.log 2>&1 &
DASH_PID=$!
sleep 2
if ! kill -0 $DASH_PID 2>/dev/null; then
  echo "[sim] ERROR: dashboard failed to start. Check /tmp/dashboard.log"
  cat /tmp/dashboard.log
  exit 1
fi
echo "[sim] Dashboard running (PID $DASH_PID) -> http://localhost:3001"

# --- btc-gap-fade -------------------------------------------------------------
echo "[sim] Starting btc-gap-fade..."
PERF_DB=true \
WALLET_BALANCE=10000 \
MAX_SESSION_LOSS=9999 \
MAX_DRAWDOWN_PCT=1.0 \
LOCK_DIR=state/bgf \
STATE_FILE=state/early-bird-btc-gap-fade.json \
BGF_GAP_THRESHOLD=5 \
BGF_MIN_ATR=1 \
BGF_ENTRY_MIN_SECS=60 \
BGF_ENTRY_MAX_SECS=240 \
BGF_FADE_RATIO=0.90 \
BGF_TAKE_PROFIT_PRICE=0.52 \
  $BUN index.ts --strategy btc-gap-fade > /tmp/bgf.log 2>&1 &
echo "[sim] btc-gap-fade PID: $!"

sleep 1

# --- passive-maker ------------------------------------------------------------
echo "[sim] Starting passive-maker..."
PERF_DB=true \
WALLET_BALANCE=10000 \
MAX_SESSION_LOSS=9999 \
MAX_DRAWDOWN_PCT=1.0 \
LOCK_DIR=state/pm \
STATE_FILE=state/early-bird-passive-maker.json \
PM_CERTAINTY_THRESHOLD=0.58 \
PM_ENTRY_MIN_SECS=30 \
PM_ENTRY_MAX_SECS=150 \
PM_ENTRY_DISCOUNT=0.01 \
  $BUN index.ts --strategy passive-maker > /tmp/pm.log 2>&1 &
echo "[sim] passive-maker PID: $!"

sleep 1

# --- multi-level-ofi ----------------------------------------------------------
echo "[sim] Starting multi-level-ofi..."
PERF_DB=true \
WALLET_BALANCE=10000 \
MAX_SESSION_LOSS=9999 \
MAX_DRAWDOWN_PCT=1.0 \
LOCK_DIR=state/mlofi \
STATE_FILE=state/early-bird-multi-level-ofi.json \
MLOFI_OFI_THRESHOLD=5 \
MLOFI_DISLOC_BTC_PCT=0.0001 \
MLOFI_DISLOC_TOKEN_GAP=0.01 \
MLOFI_MAX_REMAINING_S=270 \
MLOFI_FEE_SAFE_MAX=0.45 \
MLOFI_FEE_SAFE_MIN=0.55 \
  $BUN index.ts --strategy multi-level-ofi > /tmp/mlofi.log 2>&1 &
echo "[sim] multi-level-ofi PID: $!"

sleep 1

# --- momentum-imbalance -------------------------------------------------------
echo "[sim] Starting momentum-imbalance..."
PERF_DB=true \
WALLET_BALANCE=10000 \
MAX_SESSION_LOSS=9999 \
MAX_DRAWDOWN_PCT=1.0 \
LOCK_DIR=state/mi \
STATE_FILE=state/early-bird-momentum-imbalance.json \
MI_MOMENTUM_THRESHOLD_USD=15 \
MI_IMBALANCE_THRESHOLD=0.55 \
MI_MIN_LIQUIDITY_USD=20 \
  $BUN index.ts --strategy momentum-imbalance > /tmp/mi.log 2>&1 &
echo "[sim] momentum-imbalance PID: $!"

sleep 1

# --- late-entry ---------------------------------------------------------------
echo "[sim] Starting late-entry..."
PERF_DB=true \
WALLET_BALANCE=10000 \
MAX_SESSION_LOSS=9999 \
MAX_DRAWDOWN_PCT=1.0 \
LOCK_DIR=state/le \
STATE_FILE=state/early-bird-late-entry.json \
LE_REMAINING_MAX_S=120 \
LE_ATR_MAX=5 \
LE_GAP_SAFETY_MIN=10 \
LE_PEAK_GAP_RATIO_MIN=0.50 \
LE_CERTAINTY_MIN=0.60 \
  $BUN index.ts --strategy late-entry > /tmp/le.log 2>&1 &
echo "[sim] late-entry PID: $!"

sleep 3
echo ""
echo "========================================================"
echo "  PAPER TRADING -- simulated balances, no real money"
echo "========================================================"
echo ""
echo "  Dashboard  ->  http://localhost:3001"
echo "  Logs       ->  tail -f /tmp/bgf.log /tmp/pm.log /tmp/mlofi.log /tmp/mi.log /tmp/le.log"
echo ""
ps aux | grep -E "bun (index|dashboard)" | grep -v grep | \
  awk '{print "  PID "$2" "$11" "$12" "$13" "$14}'
echo ""
