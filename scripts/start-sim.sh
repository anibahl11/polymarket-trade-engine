#!/bin/bash
# start-sim.sh — launch all three strategy simulators + dashboard
#
# Mode:        PAPER TRADING (simulated balance, no real orders)
# Dashboard:   http://localhost:3001
# Logs:        /tmp/bgf.log  /tmp/pm.log  /tmp/mlofi.log  /tmp/dashboard.log
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
rm -f state/bgf/early-bird.lock state/pm/early-bird.lock state/mlofi/early-bird.lock state/early-bird.lock

echo "[sim] Creating state dirs..."
mkdir -p state/bgf state/pm state/mlofi

# ─── Dashboard ────────────────────────────────────────────────────────────────
echo "[sim] Starting dashboard on :3001..."
DASHBOARD_PORT=3001 $BUN dashboard/server.ts > /tmp/dashboard.log 2>&1 &
DASH_PID=$!
sleep 2
if ! kill -0 $DASH_PID 2>/dev/null; then
  echo "[sim] ERROR: dashboard failed to start. Check /tmp/dashboard.log"
  cat /tmp/dashboard.log
  exit 1
fi
echo "[sim] Dashboard running (PID $DASH_PID) → http://localhost:3001"

# ─── btc-gap-fade ─────────────────────────────────────────────────────────────
# Loosened: gap threshold $15 (was $30), ATR floor 2 (was 5)
echo "[sim] Starting btc-gap-fade..."
PERF_DB=true \
WALLET_BALANCE=100 \
MAX_SESSION_LOSS=20 \
LOCK_DIR=state/bgf \
BGF_GAP_THRESHOLD=15 \
BGF_MIN_ATR=2 \
BGF_ENTRY_MIN_SECS=180 \
BGF_ENTRY_MAX_SECS=260 \
  $BUN index.ts --strategy btc-gap-fade --rounds 50 > /tmp/bgf.log 2>&1 &
echo "[sim] btc-gap-fade PID: $!"

sleep 1

# ─── passive-maker ────────────────────────────────────────────────────────────
# Loosened: certainty threshold 0.65 (was 0.80), entry window 45–105s (was 60–90s)
echo "[sim] Starting passive-maker..."
PERF_DB=true \
WALLET_BALANCE=100 \
MAX_SESSION_LOSS=20 \
LOCK_DIR=state/pm \
PM_CERTAINTY_THRESHOLD=0.65 \
PM_ENTRY_MIN_SECS=45 \
PM_ENTRY_MAX_SECS=105 \
  $BUN index.ts --strategy passive-maker --rounds 50 > /tmp/pm.log 2>&1 &
echo "[sim] passive-maker PID: $!"

sleep 1

# ─── multi-level-ofi ─────────────────────────────────────────────────────────
# Loosened: OFI threshold 20 (was 50), BTC move 0.02% (was 0.05%), token gap 0.02 (was 0.04)
echo "[sim] Starting multi-level-ofi..."
PERF_DB=true \
WALLET_BALANCE=100 \
MAX_SESSION_LOSS=20 \
LOCK_DIR=state/mlofi \
MLOFI_OFI_THRESHOLD=20 \
MLOFI_DISLOC_BTC_PCT=0.0002 \
MLOFI_DISLOC_TOKEN_GAP=0.02 \
MLOFI_MAX_REMAINING_S=260 \
  $BUN index.ts --strategy multi-level-ofi --rounds 50 > /tmp/mlofi.log 2>&1 &
echo "[sim] multi-level-ofi PID: $!"

sleep 3
echo ""
echo "════════════════════════════════════════════════════════"
echo "  📋 PAPER TRADING — simulated balances, no real money"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Dashboard  →  http://localhost:3001"
echo "  Logs       →  tail -f /tmp/bgf.log /tmp/pm.log /tmp/mlofi.log"
echo ""
ps aux | grep -E "bun (index|dashboard)" | grep -v grep | \
  awk '{print "  PID "$2" "$11" "$12" "$13" "$14}'
echo ""
