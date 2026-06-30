# Signal: No-Redis Single-Process Architecture

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `refactor/no-redis-single-process`
**Baseline tag:** `stable-bull-worker-working`

## Problem

Signal cannot deploy for free. The current architecture requires:

- 3 Render services (backend API, worker-web, static frontend)
- Upstash Redis (Bull queue transport + worker heartbeat)
- UptimeRobot keepalive (Render free tier sleeps after 15 min inactivity)

Free-tier limits cause real problems: Upstash 500k commands/month is consumed by Bull polling and heartbeats even when idle; Render's sleeping kills scheduled scans; UptimeRobot adds latency on every wake-up.

Budget: $1–3/month. Goal: $0/month within free tiers.

## Solution

Eliminate Redis/Bull and merge the worker into the API process. Deploy as a single Fly.io machine with Cloudflare Pages for the frontend.

### Why this works

- **Fly.io free tier**: 3 shared-cpu-1x VMs with 256MB RAM, no sleeping, auto-restart on crash
- **Fly Postgres**: Free single-node development instance (3GB storage)
- **Cloudflare Pages**: Free, unlimited bandwidth, no sleeping
- **No Redis**: Bull queues replaced by in-process scheduling + Postgres job state
- **No separate worker**: Scans run as async tasks in the same Node process
- **No UptimeRobot**: Fly.io machines don't sleep

**Total monthly cost: $0**

---

## Architecture

### Before (current)

```
Frontend (Render static) → API (Render free web) → Redis/Bull (Upstash) → Worker (Render free web)
                                                          ↓
                                                     Postgres (Neon)
```

Three Render services, one Redis, one Postgres, one keepalive service.

### After (new)

```
Frontend (Cloudflare Pages) → API + Scheduler + Scans (Fly.io single machine)
                                       ↓
                                  Postgres (Fly Postgres)
```

One Fly.io machine, one Postgres, no Redis, no keepalive.

---

## Section 1: Job Scheduling and Execution

### Replacing Bull queues

Bull provides three things we need to replace:

1. **Job scheduling** (repeatable jobs) → Postgres `next_scan_at` column + scheduler poll loop
2. **Job execution** (worker process) → In-process async functions
3. **Job state** (waiting/active/completed) → `scan_runs` table (already exists)

### Scheduler: Postgres polling loop

Every 30 seconds, query Postgres for monitors due for a scan:

```sql
SELECT id, user_id FROM keyword_sets
WHERE active = true AND next_scan_at <= NOW()
ORDER BY next_scan_at ASC
LIMIT 5
```

For each result, call `runScanInBackground(id, userId)`. After scan completes (or fails), set `next_scan_at = NOW() + scan_interval_hours`.

### Scan execution: in-process async tasks

Scans run as fire-and-forget async functions inside the same Node process:

```js
const activeScans = new Set()
const MAX_CONCURRENT_SCANS = 2

async function runScanInBackground(keywordSetId, userId) {
  if (activeScans.size >= MAX_CONCURRENT_SCANS) return
  if (activeScans.has(keywordSetId)) return
  activeScans.add(keywordSetId)
  try {
    await Promise.race([
      processScanJob(keywordSetId, userId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Scan timed out')), SCAN_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    await finishScanFailure(keywordSetId, err.message)
  } finally {
    activeScans.delete(keywordSetId)
    await pool.query(
      `UPDATE keyword_sets SET next_scan_at = NOW() + (scan_interval_hours * INTERVAL '1 hour') WHERE id = $1`,
      [keywordSetId]
    )
  }
}
```

Node.js's event loop handles concurrency naturally — HTTP requests are served between scan steps because every I/O operation (DB query, Reddit API call, OpenAI call) yields to the event loop.

### Manual scan (user clicks "Scan Now")

Set `next_scan_at = NOW()` and call `runScanInBackground()` directly:

```js
router.post('/:id/rescan', async (req, res) => {
  await pool.query(
    `UPDATE keyword_sets SET last_scanned_at = NULL, next_scan_at = NOW() WHERE id = $1`,
    [req.params.id]
  )
  runScanInBackground(req.params.id, userId)
  return res.json({ ok: true })
})
```

### Reply tracker: simplified setInterval

```js
setInterval(async () => {
  await refreshAllTrackedReplies()
}, 2 * 3600 * 1000)
```

No Bull queue, no Redis, no separate worker.

### Heartbeat: eliminated

No separate worker means no need for a heartbeat. The API serves `/health` directly. If it's down, Fly.io restarts it.

---

## Section 2: Database Changes

### New column: `next_scan_at`

```sql
-- 006_scheduler_next_scan_at.sql
ALTER TABLE keyword_sets ADD COLUMN next_scan_at TIMESTAMPTZ;

UPDATE keyword_sets
SET next_scan_at = COALESCE(last_scanned_at, created_at)
  + (COALESCE(scan_interval_hours, 6) * INTERVAL '1 hour')
WHERE active = true AND next_scan_at IS NULL;

UPDATE keyword_sets
SET next_scan_at = NOW()
WHERE active = true AND last_scanned_at IS NULL AND next_scan_at IS NULL;

CREATE INDEX idx_keyword_sets_next_scan ON keyword_sets (next_scan_at)
WHERE active = true;
```

This replaces Bull's repeatable job scheduling entirely. When a monitor is created or a scan completes, set `next_scan_at = NOW() + scan_interval_hours`. The scheduler queries for rows where `next_scan_at <= NOW()`.

### No other schema changes

The `scan_runs` table already tracks scan status. The `scan_progress` JSONB column already stores real-time progress. No new tables needed.

---

## Section 3: Deployment

### Backend: Fly.io

**`fly.toml`:**

```toml
app = "signal-app"
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[env]
  NODE_ENV = "production"
  PORT = "3001"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

**`Dockerfile`** (in repo root):

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ .
RUN node src/db/migrate.js
EXPOSE 3001
CMD ["node", "index.js"]
```

**Fly.io free tier:**
- 3 shared-cpu-1x VMs with 256MB RAM (requires credit card, no charge)
- 160GB outbound data/month
- No sleeping with `auto_stop_machines = "off"`
- Auto-restart on crash within seconds

### Postgres: Fly Postgres

```bash
fly postgres create
# Choose: Development (free), single node
```

Fly Postgres free tier: single-node development instance, 3GB storage. For small beta (10–50 users), this is sufficient. Alternative: Neon free tier (0.5GB, always-on, 5-second cold start) — use only if Fly Postgres limits are hit.

### Frontend: Cloudflare Pages

```bash
cd frontend
npm run build
# Deploy via Cloudflare Pages dashboard or CLI
```

Cloudflare Pages free tier: unlimited sites, unlimited bandwidth, 500 builds/month, custom domains with free SSL.

Frontend connects to backend via `VITE_API_URL=https://signal-app.fly.dev` set at build time. Backend CORS allows `FRONTEND_URL`.

### Environment variables

```bash
fly secrets set \
  DATABASE_URL="postgresql://..." \
  OPENAI_API_KEY="sk-..." \
  REDDIT_USER_AGENT="Signal/1.0 (by /u/Pranaav003)" \
  PROXY_LIST="p.webshare.io:80" \
  PROXY_USERNAMES="..." \
  PROXY_PASSWORD="..." \
  FRONTEND_URL="https://signal.pranaaviyer.com" \
  JWT_SECRET="$(openssl rand -hex 32)"
```

No `REDIS_URL`, no `UPSTASH_REDIS_REST_URL`, no `SKIP_EMBEDDED_WORKERS`, no `WORKER_WEB_PORT`.

### Removed from deployment

| Current | New |
|---------|-----|
| 3 Render services | 1 Fly.io machine + Cloudflare Pages |
| Upstash Redis | Eliminated |
| UptimeRobot keepalive | Eliminated |
| `render.yaml` | `fly.toml` |
| `worker-web.js` | Deleted |
| `.env.render.example` | `.env.fly.example` |

---

## Section 4: Codebase Changes

### Files DELETED

```
backend/worker-web.js
backend/src/jobs/queueFactory.js
backend/src/jobs/worker.js
backend/src/services/workerHeartbeat.js
backend/src/services/redisCleanup.js
backend/src/scripts/pruneRedis.js
backend/src/scripts/testRedisConnection.js
backend/src/scripts/clearQueue.js
backend/src/scripts/testWorkerQueue.js
backend/nodemon.worker.json
render.yaml
```

### Files REWRITTEN

**`backend/src/jobs/scheduler.js`** — Poll Postgres for `next_scan_at <= NOW()` on 30-second interval. Call `runScanInBackground()` directly. No Bull, no Redis.

**`backend/src/jobs/scanJob.js`** — Export `processScanJob(keywordSetId, userId)` async function. `addScanJob()` becomes: update `next_scan_at`, call `runScanInBackground()`. Remove all Bull job state tracking (`getManualScanJobState`, `resolveManualScanJob`, `snapshotOneQueue`, `getScanQueueSnapshot`). Core `processScanJob()` logic stays intact.

**`backend/src/jobs/trackerJob.js`** — `startTrackerScheduler()` sets `setInterval` calling `refreshAllTrackedReplies()`. Remove `trackerQueue` and `initTrackerWorker()`.

**`backend/src/routes/keywordSets.js`** — `/:id/scan-status` route shrinks from ~565 lines to ~150 lines. No Bull job state to check. Status derived from `scan_runs` + `scan_progress` only. No `orphan_waiting`, `in_wait_queue`, `job_state` fields. No worker heartbeat check.

**`backend/src/routes/debug.js`** — Remove Redis/Bull debug endpoints. Replace with Postgres scan status queries.

**`backend/index.js`** — Remove `SKIP_EMBEDDED_WORKERS` flag. Always run scheduler + scan processing. Remove `initWorker()` / `initTrackerWorker()` calls. Add in-memory `activeScans` guard. Wire up new scheduler + scanRunner.

**`backend/package.json`** — Remove `bull` and `ioredis` dependencies. Remove scripts: `worker`, `dev:worker`, `start:worker-web`, `test:redis`, `clear-queue`, `cleanup:redis`, `test:worker-queue`.

**`backend/.env.example`** — Remove `REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SKIP_EMBEDDED_WORKERS`, `WORKER_WEB_PORT`. Add `SCHEDULER_POLL_INTERVAL_MS`, `MAX_CONCURRENT_SCANS`.

### Files UNCHANGED (core business logic)

```
backend/src/services/scanPipeline.js
backend/src/services/redditService.js
backend/src/services/hnService.js
backend/src/services/relevanceScorer.js
backend/src/services/leadQualifier.js
backend/src/services/leadClassifier.js
backend/src/services/keywordProcessor.js
backend/src/services/searchBriefPlanner.js
backend/src/services/marketplacePlan.js
backend/src/services/planValidator.js
backend/src/services/draftService.js
backend/src/services/redditTracker.js
backend/src/services/scanRunService.js
backend/src/services/monitorLifecycle.js
backend/src/services/aiSearchPlanner.js
backend/src/db/connection.js
backend/src/db/schema.sql
backend/src/db/migrate.js
backend/src/routes/leads.js
backend/src/routes/users.js
backend/src/routes/trackedReplies.js
frontend/ (entire frontend unchanged)
```

### New files

```
backend/src/db/migrations/006_scheduler_next_scan_at.sql
backend/src/jobs/scanRunner.js
fly.toml
Dockerfile
frontend/.env.production
backend/.env.fly.example
```

**Relationship between `scanRunner.js` and `scanJob.js`:** `scanRunner.js` is the new orchestration module — it owns `runScanInBackground()`, the `activeScans` concurrency guard, the timeout wrapper, and the memory guard. It imports `processScanJob()` from `scanJob.js`. `scanJob.js` retains the core scan processing logic (preparing the keyword set, running the pipeline, updating progress) but strips all Bull queue mechanics. The split is: `scanRunner.js` = scheduling infrastructure, `scanJob.js` = scan business logic.

### Stray code cleanup

- Remove `.gitkeep` files from directories that now have actual files
- Remove hardcoded CORS origin `https://signal-frontend-e4oa.onrender.com` from `index.js` — use env var only
- `signal-landing/index.html` — evaluate whether to integrate into React Landing page or delete

---

## Section 5: Startup Recovery and Operational Safety

### Startup: recover orphaned scan runs

On startup, mark any `scan_runs` stuck in `running` or `queued` status as `failed`:

```js
async function recoverOrphanedScans() {
  const { rows } = await pool.query(
    `UPDATE scan_runs
     SET status = 'failed', error_message = 'Process restarted during scan'
     WHERE status IN ('running', 'queued')
       AND started_at < NOW() - INTERVAL '5 minutes'
     RETURNING id, keyword_set_id`
  )
  for (const run of rows) {
    await pool.query(
      `UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`,
      [run.keyword_set_id, JSON.stringify({
        phase: 'error',
        message: 'Scan interrupted — server restarted. It will retry on the next schedule.',
        completed_at: new Date().toISOString()
      })]
    )
  }
  if (rows.length) {
    console.log(`[recovery] Marked ${rows.length} orphaned scan runs as failed`)
  }
}
```

The scheduler will pick these up on the next poll cycle since `next_scan_at` has passed.

### Graceful shutdown

```js
let schedulerStopped = false

async function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} received`)
  schedulerStopped = true
  const deadline = Date.now() + 30_000
  while (activeScans.size > 0 && Date.now() < deadline) {
    console.log(`[shutdown] Waiting for ${activeScans.size} active scan(s)...`)
    await new Promise(r => setTimeout(r, 2000))
  }
  if (activeScans.size > 0) {
    console.warn(`[shutdown] ${activeScans.size} scan(s) still running — will be recovered on restart`)
  }
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
```

### Health check

```js
app.get('/health', async (req, res) => {
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false)
  res.json({
    ok: dbOk,
    service: 'signal-backend',
    activeScans: activeScans.size,
    maxConcurrentScans: MAX_CONCURRENT_SCANS,
    uptimeSeconds: Math.round(process.uptime()),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  })
})
```

### Scan timeout

25-minute timeout (same as current Bull timeout), enforced via `Promise.race`:

```js
const SCAN_TIMEOUT_MS = 25 * 60 * 1000

await Promise.race([
  processScanJob(keywordSetId, userId),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Scan timed out')), SCAN_TIMEOUT_MS)
  )
])
```

### Memory guard

256MB RAM is tight. Don't start new scans if heap usage is high:

```js
function memoryUsageOk() {
  const used = process.memoryUsage()
  const heapUsedMB = used.heapUsed / 1024 / 1024
  return heapUsedMB < 200
}

// In scheduler tick — skip if memory is high
if (!memoryUsageOk()) {
  console.warn(`[scheduler] Skipping scan — heap at ${Math.round(heapUsedMB)}MB`)
  return
}
```

---

## Section 6: Development and Migration

### Local development

Only Postgres required (no Redis):

```bash
brew install postgresql@16
brew services start postgresql@16
createdb signal_dev

cd backend
cp .env.example .env
# Edit DATABASE_URL, REDDIT/OPENAI keys — no REDIS_URL needed
npm install
npm run migrate
npm run dev    # API + scheduler + scans in one process

cd frontend
npm install
npm run dev
```

One terminal for backend, one for frontend. No separate worker process.

### Migration steps

1. Create baseline tag: `git tag stable-bull-worker-working` on current main
2. Create branch: `refactor/no-redis-single-process`
3. Add `006_scheduler_next_scan_at.sql` migration
4. Create `scanRunner.js` — in-process scan executor
5. Rewrite `scheduler.js` — Postgres polling loop
6. Simplify `scanJob.js` — strip Bull, export `processScanJob()`
7. Simplify `trackerJob.js` — setInterval
8. Update `index.js` — wire up new modules, remove SKIP_EMBEDDED_WORKERS
9. Simplify `keywordSets.js` scan-status route
10. Delete Redis/Bull files
11. Remove `bull` and `ioredis` from package.json
12. Clean up stray code (.gitkeep, hardcoded CORS, old scripts)
13. Add `fly.toml` + `Dockerfile`
14. Test locally: create monitor → scan → leads appear → delete monitor
15. Deploy to Fly.io
16. Deploy frontend to Cloudflare Pages
17. Delete Render services

### Verification checklist

After migration, from a clean clone:

- [ ] `cd backend && npm install && npm run migrate` succeeds
- [ ] `npm run dev` starts on port 3001 without Redis
- [ ] Scheduler starts: "Scheduler polling every 30s"
- [ ] Create a keyword set — scan starts immediately
- [ ] Scan completes — leads appear
- [ ] Manual rescan works
- [ ] Delete monitor hides leads
- [ ] `GET /health` returns `ok: true`, `activeScans: 0`
- [ ] Restart mid-scan — orphaned scans recovered on startup
- [ ] `cd frontend && npm run build` succeeds
- [ ] No `ioredis` or `bull` in `node_modules`
- [ ] No `REDIS_URL` references in codebase
