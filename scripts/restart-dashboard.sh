#!/bin/bash
# restart-dashboard.sh — restart ONLY the dashboard, leave engines running
cd "$(dirname "$0")/.."
BUN=~/.bun/bin/bun

echo "[sim] Restarting dashboard..."
pkill -f "bun dashboard/server.ts" 2>/dev/null || true
sleep 1

DASHBOARD_PORT=3001 $BUN dashboard/server.ts > /tmp/dashboard.log 2>&1 &
sleep 2
echo "[sim] Dashboard running → http://localhost:3001"
