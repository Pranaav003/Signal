# Signal

Reddit lead intelligence for small businesses.

## Local development

### First-time dependencies

```bash
brew install postgresql@16
brew services start postgresql@16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
createdb signal_dev || true
```

Set `DATABASE_URL` in `backend/.env` (see `.env.example`). For the default Homebrew role on this machine, `postgresql://YOUR_USERNAME@127.0.0.1:5432/signal_dev` usually works.

**Reddit optional for local demos:** set `USE_MOCK_REDDIT=true` to use `mockRedditService` (realistic fake posts/comments; no Reddit API keys).

### Backend API (single process — scheduler + scans run in-process)

```bash
cd backend
cp .env.example .env
# Edit .env: set DATABASE_URL, OPENAI_API_KEY, REDDIT_USER_AGENT
# Optional: PROXY_* for Reddit scraping
npm install
npm run migrate
npm run dev
```

You should see:

- `Signal backend running on port 3001`
- `✓ Database connected`
- `✓ Scheduler started: N monitors active`

No separate worker process needed — the scheduler polls Postgres every 30s and runs scans in-process (max 2 concurrent).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (Vite proxies `/api` to the backend in dev).

---

## Architecture

Signal uses a **single-process** architecture:

- **Express backend** — serves API + runs the scheduler + executes scans in-process
- **React frontend** — Vite SPA
- **Postgres** — all state (monitors, leads, scan_runs, scheduling via `next_scan_at`)
- **AI planner/classifier** — OpenAI for search planning and lead qualification
- **Public Reddit JSON search** — no Reddit API key required (optional proxy for blocking)

No Redis. No Bull. No separate worker. The scheduler is a 30-second Postgres polling loop.

### Key modules

- `backend/src/jobs/scanRunner.js` — in-process scan executor with concurrency guard + memory guard
- `backend/src/jobs/scheduler.js` — Postgres polling loop (checks `next_scan_at`)
- `backend/src/jobs/scanJob.js` — scan pipeline orchestration
- `backend/src/jobs/trackerJob.js` — reply tracker (setInterval, 2-hour cycle)
- `backend/src/services/scanRunService.js` — scan_runs lifecycle

### Safety features

- **Max 2 concurrent scans** — prevents memory exhaustion on 256MB VM
- **25-minute scan timeout** — prevents hung scans from blocking the scheduler
- **Memory guard** — won't start new scans if heap > 200MB
- **Graceful shutdown** — SIGTERM/SIGINT wait up to 30s for in-flight scans
- **Orphan recovery** — marks stuck `scan_runs` as failed on startup

---

## Deployment (Fly.io + Cloudflare Pages)

| Component | Service | Cost |
|-----------|---------|------|
| Backend | Fly.io shared-cpu-1x, 256MB | Free (Hobby plan) |
| Frontend | Cloudflare Pages | Free |
| Postgres | Neon free tier | Free |
| Total | | **$0/month** |

### Deploy backend to Fly.io

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Create the app (first time only)
fly apps create signal-backend

# Set secrets
fly secrets set DATABASE_URL="postgres://..." OPENAI_API_KEY="sk-..." FRONTEND_URL="https://your-app.pages.dev"

# Deploy
fly deploy

# Verify
curl https://signal-backend.fly.dev/health
```

### Deploy frontend to Cloudflare Pages

1. Connect your GitHub repo to Cloudflare Pages
2. Build command: `cd frontend && npm install && npm run build`
3. Output directory: `frontend/dist`
4. Set `VITE_API_URL` = `https://signal-backend.fly.dev`

---

## Environment variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| OPENAI_API_KEY | From platform.openai.com |
| FRONTEND_URL | Frontend URL for CORS (e.g. `https://your-app.pages.dev`) |
| CORS_EXTRA_ORIGINS | Comma-separated additional CORS origins |
| REDDIT_USER_AGENT | Format: `Signal/1.0 (by /u/YourUsername)` |
| PROXY_PASSWORD | Webshare proxy password (optional) |
| PROXY_LIST | Proxy gateway `host:port` (optional) |
| PROXY_USERNAME | Single rotating proxy username (optional) |
| PROXY_USERNAMES | Comma-separated regional usernames (optional) |
| PROXY_ROTATING | Set `true` for rotating gateway (optional) |
| PROXY_ENABLED | Set `false` to disable proxying (optional) |
| OPENAI_MODEL | Optional; default `gpt-4o-mini` |
| SCHEDULER_POLL_INTERVAL_MS | Scheduler tick interval (default 30000) |
| MAX_CONCURRENT_SCANS | Max parallel scans (default 2) |

---

## Smoke tests

```bash
cd backend
npm run test:db
npm run test:keyword-plan -- --description "Therapup - service where dog/cat owners can rent their animals out to centers that people can come visit and spend time with the animals for a price"
```

---

## Baseline

The pre-refactor Bull/Redis/worker architecture is preserved at tag `stable-bull-worker-working` on branch `stable-bull-worker-baseline`.
