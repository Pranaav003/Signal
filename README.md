# Signal

Reddit lead intelligence for small businesses.

## Local development (quick checklist)

**One command (after first-time `brew install` deps below):**

```bash
./scripts/local-up.sh
```

This starts Redis + Postgres (if installed via Homebrew), runs migrations, then launches **API + worker + Vite** in one terminal (`Ctrl+C` stops all three). The stable setup uses a **separate worker process** (`npm run dev:worker` via `scripts/dev-all.sh`), not in-process-only scanning.

From the repository root (after `git clone`, the folder is usually `Signal` or `signal`):

### First-time dependencies (Homebrew)

```bash
brew install redis postgresql@16
brew services start redis
brew services start postgresql@16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
createdb signal_dev || true
```

Set `DATABASE_URL` in `backend/.env` (see `.env.example`). For the default Homebrew role on this machine, `postgresql://YOUR_USERNAME@127.0.0.1:5432/signal_dev` usually works.

**Reddit optional for local demos:** set `USE_MOCK_REDDIT=true` to use `mockRedditService` (realistic fake posts/comments; no Reddit API keys).

### Terminal 1 — Backend API

```bash
cd backend
cp .env.example .env
# Edit .env: set DATABASE_URL, REDIS_URL, REDDIT_USER_AGENT, PROXY_* (optional),
# OPENAI_API_KEY (and JWT_SECRET for future auth).
npm install
npm run migrate
npm run dev
```

You should see:

- `Signal backend running on port 3001`
- `✓ Database connected`
- `✓ Scheduler started: N monitors active` (N may be 0 until you create a keyword set)

### Terminal 2 — Background worker

```bash
cd backend
node src/jobs/worker.js
```

You should see:

- `✓ Database connected` (from loading the DB pool)
- `✓ Signal worker started`

### Terminal 3 — Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (Vite proxies `/api` to the backend in dev).

### Optional — Reddit smoke test

```bash
cd backend
npm run test:scan
```

Prints scored Reddit results to the console (requires Reddit credentials in `.env`).

---

## Render deploy (checklist)

**Option A (free demo):** Use the Blueprint in **`render.yaml`** — backend + **signal-worker-web** + static frontend. Add **Neon** `DATABASE_URL` and **Upstash** `REDIS_URL` manually. See **Option A deployment checklist** below.

1. **Push** this repository to **GitHub**.
2. Go to **render.com → New → Blueprint** and select the repo root.
3. After deploy, set **`DATABASE_URL`**, **`REDIS_URL`**, and **`OPENAI_API_KEY`** on **signal-backend** and **signal-worker-web**.
4. Configure **UptimeRobot** to ping both `/health` endpoints.
5. **Logs to verify**
   - **signal-backend:** `✓ Database connected`, `✓ Scheduler started`, `GET /health` returns `ok: true`
   - **signal-worker-web:** `[worker-web] Bull worker started`, `/health` shows `workerStarted: true`
6. Open **signal-frontend**, create a keyword set, confirm scan completes.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| REDIS_URL | Redis connection string (`rediss://` for Upstash TLS) |
| WORKER_WEB_PORT | Optional local port for `npm run start:worker-web` (default 3002; use when `.env` sets `PORT=3001` for API) |
| REDDIT_USER_AGENT | Format: `Signal/1.0 (by /u/YourUsername)` |
| PROXY_PASSWORD | Webshare proxy password (shared across regions) |
| PROXY_LIST | Proxy gateway `host:port` — `p.webshare.io:80` for Webshare backbone |
| PROXY_USERNAMES | Comma-separated regional usernames (e.g. `qcceojoh-gb-1,qcceojoh-ca-2,…`) |
| PROXY_USERNAME | Legacy single username; use `PROXY_USERNAMES` for residential rotation |
| PROXY_ROTATING | Set `true` when using a single rotating gateway (auto-detected for `*.webshare.io`) |
| PROXY_ENABLED | Set `false` to disable proxying (debugging) |
| OPENAI_API_KEY | From platform.openai.com (ChatGPT / OpenAI API) |
| OPENAI_MODEL | Optional; default `gpt-4o-mini` |
| JWT_SECRET | Random string; auto-generated on Render for the web service |

For the **static frontend** build, **`VITE_API_URL`** is set from the backend’s **`RENDER_EXTERNAL_URL`** (via Blueprint `fromService` / `envVarKey`) so the browser calls the correct `https://…onrender.com` API.

---

## Current Stable Architecture

Signal currently uses:

- Express backend
- React frontend
- Postgres
- Redis/Bull queues
- Separate worker process (`backend/src/jobs/worker.js`)
- AI planner/classifier
- Public Reddit JSON search

Job pipeline (do not remove from the stable baseline):

- `backend/src/jobs/scanJob.js`
- `backend/src/jobs/scheduler.js`
- `backend/src/jobs/worker.js`
- `backend/src/jobs/trackerJob.js`
- `backend/src/jobs/queueFactory.js`
- `backend/src/services/workerHeartbeat.js`

Local dev requires **all** of:

- backend API
- backend worker
- frontend
- Postgres
- Redis

Redis is **not** optional for the stable version. The API schedules work; the worker processes Bull queues.

---

## Working-baseline verification

Run from a clean clone (with `backend/.env` configured and Redis + Postgres running):

```bash
cd backend
npm install
npm run migrate
npm run test:create-keyword-set
npm run test:delete-monitor
npm run test:keyword-plan -- --description "Therapup - service where dog/cat owners can rent their animals out to centers that people can come visit and spend time with the animals for a price"

cd ../frontend
npm install
npm run build
```

Then from the repository root:

```bash
npm run dev
```

**Expected:**

- Backend starts on port 3001
- Worker starts and writes a Redis heartbeat
- Redis connects
- Frontend starts on port 5173
- Monitor creation works
- Deleting monitors hides associated leads
- Scan status works
- No `search_focus is not defined` errors
- No React hook order errors
- No 429 spam
- No impossible scan diagnostics

`test:keyword-plan` uses two layers:

- **Production minimum (PASS/FAIL):** ≥5 non-placeholder queries, ≥1 `required_evidence`, valid `search_focus`, rubric present, no crash.
- **Quality warnings (non-blocking):** e.g. fewer than 8 queries, fewer than 2 evidence items, fallback planner, missing marketplace sides for marketplace-like descriptions. Warnings do not fail the baseline.

---

## Option A: Render free deployment with worker-web

This preserves the **working Bull/Redis/worker architecture**. The worker is deployed as a **Render free web service** (`signal-worker-web`) because free Render services require an HTTP endpoint. It still processes **real** Bull jobs from Redis — nothing is mocked or hardcoded.

| Component | Service |
|-----------|---------|
| Frontend | Render static site (`signal-frontend`) |
| Backend API | Render free web (`signal-backend`) — `GET /health` |
| Worker | Render free web (`signal-worker-web`) — `npm run start:worker-web`, `GET /health` |
| Postgres | **Neon** pooled `DATABASE_URL` (use pooler host, not direct Neon host) |
| Redis/Bull | **Upstash** TCP `REDIS_URL` (`rediss://…`) — Bull uses this, **not** Upstash REST |
| Keepalive | **UptimeRobot** pings backend and worker-web `/health` |

**Committed config:** `render.yaml` and `backend/.env.render.example` include **rotated placeholder** Neon/Upstash values showing the exact format. **Replace with fresh Neon/Upstash credentials before a real deployment.** `OPENAI_API_KEY` stays `sync: false` in the blueprint — add it in the Render dashboard.

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are optional reference env vars only; Bull/ioredis use `REDIS_URL`.

**Caveats (demo/MVP):**

- Free Render web services **sleep** after inactivity; scans may queue until UptimeRobot wakes the worker.
- Upstash free tier limits **Redis commands** (500k/month), not storage bytes. Bull queue polling + heartbeats consume commands even when idle.
- Worker startup runs automatic Bull cleanup (`pruneStaleBullQueues`). Manual: `npm run cleanup:redis`.
- Completed jobs are removed immediately; only the last few failed jobs are kept (`REDIS_FAILED_JOBS_TO_KEEP`, default 5).
- OpenAI is not free without credits.
- For production reliability, use a paid real worker service later.

**Smoke tests (with Render env values loaded):**

```bash
cd backend
npm run test:db      # SELECT NOW() against DATABASE_URL
npm run test:redis   # PING against REDIS_URL (rediss:// TLS)
```

**Local dev unchanged:** API + `npm run worker` or `npm run dev`. Optional worker-web test:

```bash
cd backend
# Optional: cp .env.render.example values into shell or a local env file for smoke tests
WORKER_WEB_PORT=3002 npm run start:worker-web
# http://localhost:3002/health — expect workerStarted: true
```

### Option A deployment checklist

1. Replace placeholder values in `render.yaml` with fresh **Neon pooled** and **Upstash** URLs (or use committed placeholders only for format review).
2. Deploy Render Blueprint from repo root.
3. Set **`OPENAI_API_KEY`** on `signal-backend` and `signal-worker-web` in Render.
4. Confirm **`VITE_API_URL`** on frontend points at backend `RENDER_EXTERNAL_URL`.
5. **UptimeRobot** (every 5–10 min):
   - `https://<signal-backend>/health`
   - `https://<signal-worker-web>/health`
6. Create a test monitor; verify scan completes and leads appear.
7. Delete monitor; confirm leads disappear.

---

## Free/Low-Cost Deployment Notes

- **Option A (recommended for $0 demo):** Neon + Upstash + Render free web (backend + worker-web + static frontend). See above.
- **Paid Render baseline:** Render Postgres + Key Value + paid `type: worker` — see tag `stable-bull-worker-working`.
- **Removing Redis/Bull** or inlining the worker into the API is a **future architecture project**, not a quick deploy change.

Experimental branch name (do not use on the stable baseline without a tag):

```bash
git checkout -b experiment-no-redis-scheduler
```

---

## Baseline branch and tag (before any migration)

Before any future architecture migration (e.g. removing Bull/Redis or merging the worker into the API), create a restore point:

```bash
git checkout -b stable-bull-worker-baseline
git tag stable-bull-worker-working
```

Do not continue on `main` without a restore point you can return to.

---

## Safety checklist (before merging Cursor changes)

- [ ] `cd frontend && npm run build` passes
- [ ] Backend tests pass: `test:create-keyword-set`, `test:delete-monitor`, `test:keyword-plan`
- [ ] Worker starts (`npm run dev` or `npm run dev:worker`)
- [ ] Redis connects (`redis-cli ping` or worker heartbeat)
- [ ] Monitor create works in the UI
- [ ] Scan starts and completes
- [ ] Delete monitor hides leads
- [ ] No stale deleted leads visible
- [ ] No `search_focus` ReferenceError
- [ ] No React hook-order errors
- [ ] No 500 from `/api/leads/user`
