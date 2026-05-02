#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ Starting Redis + PostgreSQL (Homebrew services)…"
brew services start redis >/dev/null 2>&1 || true
brew services start postgresql@16 >/dev/null 2>&1 || true

echo "→ Running migrations…"
(cd "$ROOT/backend" && npm run migrate)

echo "→ Launching backend (3001), worker, and frontend (5173)…"
(cd "$ROOT/backend" && npm run dev) &
BACK_PID=$!
(cd "$ROOT/backend" && node src/jobs/worker.js) &
WORKER_PID=$!
(cd "$ROOT/frontend" && npm run dev) &
FRONT_PID=$!

cleanup() {
  echo
  echo "→ Shutting down (Ctrl+C again if needed)…"
  kill "$BACK_PID" "$WORKER_PID" "$FRONT_PID" 2>/dev/null || true
}

trap cleanup INT TERM

wait
