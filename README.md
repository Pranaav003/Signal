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
# Edit .env: set DATABASE_URL, REDIS_URL, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
# REDDIT_USER_AGENT, OPENAI_API_KEY (and JWT_SECRET for future auth).
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

1. **Push** this repository to **GitHub** on the **`main`** branch.
2. Go to **render.com → New → Blueprint**.
3. Point Render at the **repo root** (it will pick up **`render.yaml`**).
4. **Blueprint file:** Redis-compatible storage is a **`type: keyvalue`** service (`signal-redis`), not a legacy root-level `redis:` block. `fromService` references include the required **`type`** (`keyvalue` or `web`).
5. **Costs:** Render may reject **`plan: free`** for **`type: web`** (including static sites). This blueprint uses **`plan: starter`** for **signal-frontend** and **signal-worker**. **signal-backend** still uses **free** where your workspace allows it; if validation fails, bump it to **`starter`** the same way.
6. In the Render dashboard, **manually add** these secrets (they are `sync: false` in the blueprint):
   - `REDDIT_CLIENT_ID`
   - `REDDIT_CLIENT_SECRET`
   - `OPENAI_API_KEY`
7. Click **Deploy**.
8. **Logs to verify**
   - **signal-backend:** `✓ Database connected` and `✓ Scheduler started: …`
   - **signal-worker:** `✓ Signal worker started`
9. Open the **signal-frontend** URL, create your first **keyword set**, then wait for the first scan (or trigger via queue as configured).

---

## Environment variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| REDIS_URL | Redis connection string |
| REDDIT_CLIENT_ID | From reddit.com/prefs/apps |
| REDDIT_CLIENT_SECRET | From reddit.com/prefs/apps |
| REDDIT_USER_AGENT | Format: `Signal/1.0 by YourUsername` (Render blueprint sets a default; override if you prefer) |
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

## Free/Low-Cost Deployment Notes

- The **current stable app** uses Redis/Bull and a **separate worker** (`signal-worker` in `render.yaml`).
- **Removing Redis/Bull** or inlining the worker into the API is a **future architecture project**, not a quick deploy change. A previous in-process-only experiment broke scans and scheduling.
- **For now**, deploy the stable version with: **backend + frontend + Postgres + Redis/Key Value + worker**.
- If you want to reduce cost later, do it on a **separate branch** and keep this baseline restorable.

Experimental branch name (do not use on `main` without a tag):

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
