#!/usr/bin/env bash
# Run backend + frontend in one shell so one tab stays "alive" (better for Cursor / IDE process view).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  echo ""
  echo "→ Stopping Signal dev servers…"
  jobs -p 2>/dev/null | xargs kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM

echo "→ Backend http://localhost:3001  +  Frontend http://localhost:5173"
echo "→ Press Ctrl+C to stop both."
echo ""

(cd "$ROOT/backend" && npm run dev) &
(cd "$ROOT/frontend" && npm run dev) &

wait
