#!/usr/bin/env bash
# Run backend API + Bull worker + frontend in one shell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  echo ""
  echo "→ Stopping Signal dev servers…"
  jobs -p 2>/dev/null | xargs kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM

echo "→ Checking Redis…"
if command -v redis-cli >/dev/null 2>&1; then
  if ! redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "✗ Redis is not reachable (redis-cli ping). Start Redis before npm run dev."
    exit 1
  fi
  echo "✓ Redis PONG"
else
  echo "! redis-cli not found — ensure Redis is running on REDIS_URL"
fi
echo ""
(cd "$ROOT/backend" && npm run migrate)
echo ""

echo "→ Backend API:  http://localhost:3001"
echo "→ Worker:       Bull scan worker (required for scans)"
echo "→ Frontend:     http://localhost:5173"
echo "→ Press Ctrl+C to stop all three."
echo ""

# API only — worker runs in a separate process so jobs are not processed twice.
(cd "$ROOT/backend" && SKIP_EMBEDDED_WORKERS=true npm run dev) &
API_PID=$!
(cd "$ROOT/backend" && npm run dev:worker) &
WORKER_PID=$!
(cd "$ROOT/frontend" && npm run dev) &
FRONT_PID=$!

echo "→ Waiting for worker heartbeat (up to 25s)…"
HEARTBEAT_OK=0
for _ in $(seq 1 25); do
  if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli GET signal:worker:heartbeat 2>/dev/null | grep -q last_seen_at; then
      HEARTBEAT_OK=1
      echo "✓ Worker heartbeat detected"
      break
    fi
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "✗ Scan worker process exited. Check logs above (common: Redis down or worker.js error)."
    kill "$API_PID" "$FRONT_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

if [ "$HEARTBEAT_OK" -eq 0 ]; then
  echo "✗ No worker heartbeat after 25s."
  echo "  Scans will stay queued until the worker runs."
  echo "  Try manually: cd backend && npm run worker"
  echo "  Debug: curl http://localhost:3001/api/debug/scan-queue"
fi

wait
