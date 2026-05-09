#!/bin/bash
# stop-sim.sh — gracefully stop all strategy engines and dashboard
cd "$(dirname "$0")/.."

echo "[sim] Stopping all engine and dashboard processes..."
pkill -f "bun index.ts" 2>/dev/null && echo "[sim] Engines stopped" || echo "[sim] No engine processes found"
pkill -f "bun dashboard/server.ts" 2>/dev/null && echo "[sim] Dashboard stopped" || echo "[sim] No dashboard found"
sleep 1
rm -f state/bgf/early-bird.lock state/pm/early-bird.lock state/mlofi/early-bird.lock \
      state/mi/early-bird.lock  state/le/early-bird.lock  state/early-bird.lock
echo "[sim] Locks cleaned. Done."
