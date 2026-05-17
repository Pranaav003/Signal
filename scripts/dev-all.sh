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

echo "→ Backend API:  http://localhost:3001"
echo "→ Worker:       Bull scan worker (npm run dev:worker)"
echo "→ Frontend:     http://localhost:5173"
echo "→ Press Ctrl+C to stop all three."
echo ""

# API only — worker runs in a separate process so jobs are not processed twice.
(cd "$ROOT/backend" && SKIP_EMBEDDED_WORKERS=true npm run dev) &
(cd "$ROOT/backend" && npm run dev:worker) &
(cd "$ROOT/frontend" && npm run dev) &

wait
