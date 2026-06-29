# No-Redis Single-Process Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Redis/Bull from Signal by merging the worker into the API process and replacing Bull queues with Postgres-based scheduling, enabling free deployment on Fly.io.

**Architecture:** Single Express process handles HTTP requests, scheduled scanning (Postgres polling loop), and scan execution (in-process async tasks). No Redis, no separate worker, no Bull. Frontend deploys to Cloudflare Pages.

**Tech Stack:** Node.js 20, Express, PostgreSQL (Fly Postgres), React/Vite (Cloudflare Pages)

## Global Constraints

- Budget: $0/month (free tiers only)
- Target platform: Fly.io (shared-cpu-1x, 256MB RAM)
- No Redis/Bull/ioredis dependencies in final codebase
- All scan state in Postgres (`scan_runs`, `keyword_sets.scan_progress`, `keyword_sets.next_scan_at`)
- Max 2 concurrent scans (memory constraint on 256MB VM)
- 25-minute scan timeout (same as current Bull timeout)
- Baseline tag before starting: `stable-bull-worker-working`
- Working branch: `refactor/no-redis-single-process`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `backend/src/db/migrations/006_scheduler_next_scan_at.sql` | Add `next_scan_at` column + index to `keyword_sets` |
| `backend/src/jobs/scanRunner.js` | In-process scan executor: concurrency guard, timeout, memory guard, graceful shutdown |
| `fly.toml` | Fly.io deployment config |
| `Dockerfile` | Container build for Fly.io |
| `backend/.env.fly.example` | Fly.io env var reference |
| `frontend/.env.production` | Production API URL for Cloudflare Pages build |

### Modified files

| File | Change |
|------|--------|
| `backend/src/db/migrate.js` | Add migration 006 |
| `backend/src/jobs/scheduler.js` | Rewrite: Postgres polling loop replacing Bull repeatable jobs |
| `backend/src/jobs/scanJob.js` | Simplify: strip all Bull queue code, export `processScanJob()` only |
| `backend/src/jobs/trackerJob.js` | Simplify: setInterval replacing Bull queue |
| `backend/src/routes/keywordSets.js` | Simplify scan-status route: remove Bull job state checks |
| `backend/src/routes/debug.js` | Replace Redis/Bull endpoints with Postgres queries |
| `backend/src/services/monitorLifecycle.js` | Remove Bull job cancellation, use Postgres only |
| `backend/index.js` | Remove SKIP_EMBEDDED_WORKERS, wire scanRunner, add graceful shutdown, simplify health |
| `backend/package.json` | Remove `bull`/`ioredis` deps, remove Redis/worker scripts |
| `backend/.env.example` | Remove Redis vars, add scheduler vars |
| `backend/nodemon.api.json` | Watch `src/jobs/` again (was ignored for worker) |
| `scripts/dev-all.sh` | Simplify: no Redis check, no separate worker process |
| `scripts/local-up.sh` | Simplify: no Redis start |
| `README.md` | Update deployment and local dev instructions |

### Deleted files

| File | Reason |
|------|--------|
| `backend/worker-web.js` | Render worker entrypoint — no separate worker |
| `backend/src/jobs/queueFactory.js` | Bull/Redis config — no Redis |
| `backend/src/jobs/worker.js` | Separate worker process — merged into API |
| `backend/src/services/workerHeartbeat.js` | Redis heartbeat — no worker to monitor |
| `backend/src/services/redisCleanup.js` | Bull queue cleanup — no Redis |
| `backend/src/scripts/pruneRedis.js` | Redis maintenance — no Redis |
| `backend/src/scripts/testRedisConnection.js` | Redis test — no Redis |
| `backend/src/scripts/clearQueue.js` | Bull queue clearing — no Bull |
| `backend/src/scripts/testWorkerQueue.js` | Worker queue test — no Bull |
| `backend/nodemon.worker.json` | Worker dev config — no separate worker |
| `render.yaml` | Render Blueprint — replaced by fly.toml |

---

### Task 1: Baseline tag and branch

**Files:**
- None (git operations only)

**Interfaces:**
- Consumes: current `main` branch
- Produces: tag `stable-bull-worker-working`, branch `refactor/no-redis-single-process`

- [ ] **Step 1: Create baseline tag**

```bash
cd /private/tmp/Signal
git tag stable-bull-worker-working
```

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b refactor/no-redis-single-process
```

- [ ] **Step 3: Verify tag and branch exist**

Run: `git tag -l stable-bull-worker-working && git branch --show-current`
Expected: `stable-bull-worker-working` and `refactor/no-redis-single-process`

- [ ] **Step 4: Commit**

No commit needed — tag and branch only.

---

### Task 2: Database migration — `next_scan_at` column

**Files:**
- Create: `backend/src/db/migrations/006_scheduler_next_scan_at.sql`
- Modify: `backend/src/db/migrate.js:99` (add migration 006)

**Interfaces:**
- Consumes: existing `keyword_sets` table
- Produces: `keyword_sets.next_scan_at TIMESTAMPTZ` column, partial index `idx_keyword_sets_next_scan`

- [ ] **Step 1: Write migration SQL file**

```sql
-- 006_scheduler_next_scan_at.sql
-- Replace Bull repeatable job scheduling with Postgres-based next_scan_at.

ALTER TABLE keyword_sets ADD COLUMN IF NOT EXISTS next_scan_at TIMESTAMPTZ;

-- Backfill: set next_scan_at based on last scan time + interval
UPDATE keyword_sets
SET next_scan_at = COALESCE(last_scanned_at, created_at)
  + (COALESCE(scan_interval_hours, 6) * INTERVAL '1 hour')
WHERE active = true AND next_scan_at IS NULL;

-- Monitors never scanned should scan immediately on first boot
UPDATE keyword_sets
SET next_scan_at = NOW()
WHERE active = true AND last_scanned_at IS NULL AND next_scan_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_keyword_sets_next_scan ON keyword_sets (next_scan_at)
WHERE active = true;
```

Write this to `backend/src/db/migrations/006_scheduler_next_scan_at.sql`.

- [ ] **Step 2: Add migration to migrate.js**

In `backend/src/db/migrate.js`, after line 98 (the migration005 block), add:

```js
    const migration006 = fs.readFileSync(
      path.join(__dirname, 'migrations/006_scheduler_next_scan_at.sql'),
      'utf8'
    );
    await pool.query(migration006);
```

- [ ] **Step 3: Run migration locally**

```bash
cd /private/tmp/Signal/backend && node src/db/migrate.js
```

Expected: `✓ Migration complete` with no errors.

- [ ] **Step 4: Verify column exists**

```bash
psql signal_dev -c "\d keyword_sets" | grep next_scan_at
```

Expected: `next_scan_at | timestamp with time zone |`

- [ ] **Step 5: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/db/migrations/006_scheduler_next_scan_at.sql backend/src/db/migrate.js
git commit -m "feat: add next_scan_at column for Postgres-based scheduling"
```

---

### Task 3: Create `scanRunner.js` — in-process scan executor

**Files:**
- Create: `backend/src/jobs/scanRunner.js`

**Interfaces:**
- Consumes: `processScanJob()` from `backend/src/jobs/scanJob.js` (Task 4 will refactor scanJob to export this)
- Consumes: `pool` from `backend/src/db/connection.js`
- Produces: `runScanInBackground(keywordSetId, userId)` — fire-and-forget async scan
- Produces: `activeScans` Set — track in-flight scans (used by scheduler, health check, graceful shutdown)
- Produces: `recoverOrphanedScans()` — startup recovery
- Produces: `startGracefulShutdownHandlers()` — SIGTERM/SIGINT handlers
- Produces: `schedulerStopped` flag — signal to stop scheduler
- Produces: `memoryUsageOk()` — memory guard

- [ ] **Step 1: Write scanRunner.js**

```js
/**
 * In-process scan executor — replaces Bull queue + separate worker.
 * Owns concurrency guard, timeout, memory guard, and graceful shutdown.
 */
const pool = require('../db/connection');

const MAX_CONCURRENT_SCANS =
  Number(process.env.MAX_CONCURRENT_SCANS) > 0
    ? Number(process.env.MAX_CONCURRENT_SCANS)
    : 2;

const SCAN_TIMEOUT_MS =
  Number(process.env.SCAN_JOB_TIMEOUT_MS) > 0
    ? Number(process.env.SCAN_JOB_TIMEOUT_MS)
    : 25 * 60 * 1000;

const HEAP_LIMIT_MB = 200;

const activeScans = new Set();
let schedulerStopped = false;

function memoryUsageOk() {
  const used = process.memoryUsage();
  const heapUsedMB = used.heapUsed / 1024 / 1024;
  return heapUsedMB < HEAP_LIMIT_MB;
}

async function finishScanFailure(keywordSetId, message) {
  try {
    await pool.query(
      `UPDATE keyword_sets SET last_scanned_at = NOW(), scan_progress = $2::jsonb WHERE id = $1`,
      [
        keywordSetId,
        JSON.stringify({
          phase: 'error',
          message: String(message || 'Scan failed'),
          completed_at: new Date().toISOString(),
        }),
      ]
    );
  } catch (err) {
    console.warn('[scanRunner] scan_progress update skipped:', err?.message || err);
  }
}

/**
 * Run a scan as a fire-and-forget async task.
 * Does not block the caller — the promise is intentionally not awaited by the caller.
 */
async function runScanInBackground(keywordSetId, userId) {
  if (schedulerStopped) {
    console.warn(`[scanRunner] Skipping scan for ${keywordSetId} — scheduler stopped`);
    return;
  }

  if (activeScans.has(keywordSetId)) {
    console.warn(`[scanRunner] Skipping scan for ${keywordSetId} — already running`);
    return;
  }

  if (activeScans.size >= MAX_CONCURRENT_SCANS) {
    console.warn(
      `[scanRunner] Skipping scan for ${keywordSetId} — ${activeScans.size}/${MAX_CONCURRENT_SCANS} concurrent scans active`
    );
    return;
  }

  if (!memoryUsageOk()) {
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.warn(`[scanRunner] Skipping scan — heap at ${heapMB}MB (limit ${HEAP_LIMIT_MB}MB)`);
    return;
  }

  activeScans.add(keywordSetId);
  console.log(
    `[scanRunner] Starting scan for ${keywordSetId} (${activeScans.size}/${MAX_CONCURRENT_SCANS} active)`
  );

  try {
    const { processScanJob } = require('./scanJob');
    await Promise.race([
      processScanJob(keywordSetId, userId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Scan timed out')), SCAN_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[scanRunner] Scan failed for ${keywordSetId}:`, msg);
    await finishScanFailure(keywordSetId, msg);
  } finally {
    activeScans.delete(keywordSetId);
    try {
      await pool.query(
        `UPDATE keyword_sets
         SET next_scan_at = NOW() + (COALESCE(scan_interval_hours, 6) * INTERVAL '1 hour')
         WHERE id = $1`,
        [keywordSetId]
      );
    } catch (updateErr) {
      console.warn('[scanRunner] next_scan_at update skipped:', updateErr?.message || updateErr);
    }
  }
}

/**
 * On startup, mark any scan_runs stuck in running/queued as failed.
 * These are orphans from a previous process crash.
 */
async function recoverOrphanedScans() {
  try {
    const { rows } = await pool.query(
      `UPDATE scan_runs
       SET status = 'failed', error_message = 'Process restarted during scan'
       WHERE status IN ('running', 'queued')
         AND started_at < NOW() - INTERVAL '5 minutes'
       RETURNING id, keyword_set_id`
    );

    for (const run of rows) {
      await pool.query(
        `UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`,
        [
          run.keyword_set_id,
          JSON.stringify({
            phase: 'error',
            message: 'Scan interrupted — server restarted. It will retry on the next schedule.',
            completed_at: new Date().toISOString(),
          }),
        ]
      );
    }

    if (rows.length) {
      console.log(`[recovery] Marked ${rows.length} orphaned scan run(s) as failed`);
    }
  } catch (err) {
    console.warn('[recovery] Orphan scan recovery failed:', err?.message || err);
  }
}

/**
 * Graceful shutdown: stop accepting new scans, wait up to 30s for in-flight scans.
 */
function startGracefulShutdownHandlers() {
  async function gracefulShutdown(signal) {
    console.log(`[shutdown] ${signal} received`);
    schedulerStopped = true;

    const deadline = Date.now() + 30_000;
    while (activeScans.size > 0 && Date.now() < deadline) {
      console.log(`[shutdown] Waiting for ${activeScans.size} active scan(s)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (activeScans.size > 0) {
      console.warn(
        `[shutdown] ${activeScans.size} scan(s) still running — will be recovered on restart`
      );
    }

    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = {
  activeScans,
  MAX_CONCURRENT_SCANS,
  SCAN_TIMEOUT_MS,
  schedulerStopped,
  memoryUsageOk,
  runScanInBackground,
  recoverOrphanedScans,
  startGracefulShutdownHandlers,
};
```

Write this to `backend/src/jobs/scanRunner.js`.

- [ ] **Step 2: Verify file loads without syntax errors**

```bash
cd /private/tmp/Signal/backend && node -e "require('./src/jobs/scanRunner'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/jobs/scanRunner.js
git commit -m "feat: add scanRunner — in-process scan executor replacing Bull worker"
```

---

### Task 4: Rewrite `scheduler.js` — Postgres polling loop

**Files:**
- Modify: `backend/src/jobs/scheduler.js`

**Interfaces:**
- Consumes: `pool` from `../db/connection.js`
- Consumes: `runScanInBackground()` from `./scanRunner.js`
- Produces: `startScheduler()` — starts the 30-second polling loop
- Produces: `stopScheduler()` — stops the loop (for graceful shutdown)

- [ ] **Step 1: Rewrite scheduler.js**

Replace entire contents of `backend/src/jobs/scheduler.js` with:

```js
/**
 * Postgres-based scheduler — replaces Bull repeatable jobs.
 * Polls keyword_sets.next_scan_at every 30 seconds and fires in-process scans.
 */
const pool = require('../db/connection');
const { runScanInBackground, schedulerStopped, memoryUsageOk } = require('./scanRunner');

const SCHEDULER_POLL_INTERVAL_MS =
  Number(process.env.SCHEDULER_POLL_INTERVAL_MS) > 0
    ? Number(process.env.SCHEDULER_POLL_INTERVAL_MS)
    : 30_000;

let schedulerTimer = null;

async function schedulerTick() {
  if (schedulerStopped) return;

  try {
    const { rows } = await pool.query(
      `SELECT id, user_id
       FROM keyword_sets
       WHERE active = true
         AND next_scan_at <= NOW()
         AND deleted_at IS NULL
       ORDER BY next_scan_at ASC
       LIMIT 5`
    );

    for (const row of rows) {
      if (!row.user_id) {
        console.warn(`[scheduler] Skipping ${row.id} — no user_id`);
        continue;
      }
      runScanInBackground(row.id, row.user_id);
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err?.message || err);
  }
}

async function startScheduler() {
  // Count active monitors for the startup log
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM keyword_sets WHERE active = true AND deleted_at IS NULL`
  );
  const count = rows[0]?.n ?? 0;

  // Immediate first tick
  void schedulerTick();

  schedulerTimer = setInterval(() => {
    void schedulerTick();
  }, SCHEDULER_POLL_INTERVAL_MS);

  if (schedulerTimer.unref) schedulerTimer.unref();

  console.log(
    `✓ Scheduler started: ${count} monitors active, polling every ${Math.round(SCHEDULER_POLL_INTERVAL_MS / 1000)}s`
  );
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = { startScheduler, stopScheduler };
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "require('./src/jobs/scheduler'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/jobs/scheduler.js
git commit -m "feat: rewrite scheduler as Postgres polling loop replacing Bull repeatable jobs"
```

---

### Task 5: Simplify `scanJob.js` — strip Bull, export processScanJob

**Files:**
- Modify: `backend/src/jobs/scanJob.js`

**Interfaces:**
- Consumes: `pool` from `../db/connection.js`
- Consumes: `runScanPipeline`, `buildCompleteProgress`, `syncInsertedCountFromDb`, `maxLeadsPerRun`, `prepareKeywordSetForScan` from `../services/scanPipeline.js`
- Consumes: `createScanRun`, `deactivateStaleLeads`, `finishScanRun`, `updateScanRunDiagnostics` from `../services/scanRunService.js`
- Consumes: `generateQueries` from `../services/keywordProcessor.js`
- Consumes: `runScanInBackground` from `./scanRunner.js` (for `addScanJob`)
- Produces: `processScanJob(keywordSetId, userId)` — core scan business logic
- Produces: `addScanJob(keywordSetId, userId)` — triggers a scan (updates next_scan_at, calls runScanInBackground)
- Produces: `rescheduleRepeatableScanForKeywordSet(keywordSetId)` — updates next_scan_at (replaces Bull repeatable reschedule)

- [ ] **Step 1: Rewrite scanJob.js**

Replace entire contents of `backend/src/jobs/scanJob.js` with:

```js
/**
 * Scan job business logic — stripped of Bull queue mechanics.
 * processScanJob() is called by scanRunner.js, which handles concurrency and timeouts.
 * addScanJob() triggers a scan by updating next_scan_at and calling runScanInBackground().
 */
const pool = require('../db/connection');
const {
  runScanPipeline,
  buildCompleteProgress,
  syncInsertedCountFromDb,
  maxLeadsPerRun,
} = require('../services/scanPipeline');
const {
  createScanRun,
  deactivateStaleLeads,
  finishScanRun,
  updateScanRunDiagnostics,
} = require('../services/scanRunService');
const { sanitizeRedditMessage } = require('../services/redditService');

async function setScanProgress(keywordSetId, payload) {
  try {
    await pool.query(`UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`, [
      keywordSetId,
      JSON.stringify(payload),
    ]);
  } catch (err) {
    console.warn('[scan] scan_progress update skipped:', err?.message || err);
  }
}

async function finishScanFailure(keywordSetId, message) {
  await pool.query(
    `UPDATE keyword_sets SET last_scanned_at = NOW(), scan_progress = $2::jsonb WHERE id = $1`,
    [
      keywordSetId,
      JSON.stringify({
        phase: 'error',
        message: String(message || 'Scan failed'),
        completed_at: new Date().toISOString(),
      }),
    ]
  );
}

async function finishScanSuccess(keywordSetId, stats) {
  const progress =
    stats && stats.phase === 'complete'
      ? stats
      : buildCompleteProgress(stats || { inserted_count: 0 });

  await pool.query(
    `UPDATE keyword_sets
     SET last_scanned_at = NOW(),
         scan_progress = $2::jsonb
     WHERE id = $1`,
    [keywordSetId, JSON.stringify(progress)]
  );
}

/**
 * Core scan processing logic — called by scanRunner.runScanInBackground().
 * No Bull job wrapper; keywordSetId and userId are passed directly.
 */
async function processScanJob(keywordSetId, userId) {
  console.log(`[scan] active keywordSetId=${keywordSetId} userId=${userId || 'n/a'}`);

  const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [keywordSetId]);

  let keywordSet = rows[0];

  if (!keywordSet) {
    console.warn(`[scan] skip missing keywordSetId=${keywordSetId}`);
    return;
  }

  if (keywordSet.active === false) {
    console.warn(`[scan] skip inactive monitor keywordSetId=${keywordSetId}`);
    return;
  }

  let scanRunId = null;
  let stats = null;

  try {
    const workerStartedAt = new Date().toISOString();
    const prepared = await require('../services/scanPipeline').prepareKeywordSetForScan(
      pool,
      keywordSet
    );
    const brief = prepared.search_brief || {};

    await deactivateStaleLeads(pool, keywordSetId, keywordSet.user_id);
    const scanRun = await createScanRun(pool, prepared, brief);
    scanRunId = scanRun.id;

    await pool.query(`UPDATE scan_runs SET status = 'running' WHERE id = $1`, [scanRunId]);
    await pool.query(`UPDATE keyword_sets SET current_scan_run_id = $2 WHERE id = $1`, [
      keywordSetId,
      scanRunId,
    ]);
    await updateScanRunDiagnostics(pool, scanRunId, {
      query_count: (prepared.queries || []).length,
      subreddit_count: (prepared.subreddits || []).length,
      planner_source: brief.planner_source || brief._source,
      planner_model: brief.planner_model,
    });

    keywordSet = prepared;

    await setScanProgress(keywordSetId, {
      phase: 'active',
      message: 'Scan worker started…',
      started_at: workerStartedAt,
      scan_run_id: scanRunId,
      planner_source: brief.planner_source || brief._source,
      planner_model: brief.planner_model,
    });

    const pipelineResult = await runScanPipeline(keywordSet, {
      pool,
      insertLeads: true,
      scanRunId,
      onProgress: (payload) => setScanProgress(keywordSetId, payload),
    });
    stats = pipelineResult.stats;

    if (
      process.env.REQUIRE_AI_CLASSIFIER === 'true' &&
      stats.classifier_source === 'fallback' &&
      stats.classifier_error
    ) {
      const errMsg =
        stats.classifier_error ||
        'AI classifier required but fell back to conservative rules';
      await finishScanRun(pool, scanRunId, 'failed', stats, errMsg);
      await finishScanFailure(keywordSetId, `Scan failed: ${errMsg}`);
      throw new Error(errMsg);
    }

    if (pool && scanRunId) {
      await syncInsertedCountFromDb(pool, stats);
    }
    const cap = maxLeadsPerRun();
    if (stats.inserted_count > cap) {
      const errMsg = `Lead cap violated: inserted ${stats.inserted_count}, max ${cap}`;
      await finishScanRun(pool, scanRunId, 'failed', stats, errMsg);
      await finishScanFailure(keywordSetId, `Scan failed: ${errMsg}`);
      throw new Error(errMsg);
    }

    const completeProgress = buildCompleteProgress(stats);
    await finishScanRun(pool, scanRunId, 'complete', completeProgress.diagnostics || stats);
    await finishScanSuccess(keywordSetId, completeProgress);

    console.log(
      `[scan] complete keywordSetId=${keywordSetId} raw=${stats.collected_raw} deduped=${stats.deduped_count} scored=${stats.scored_count} survivors=${stats.survivors_count} inserted=${stats.inserted_count}`
    );
  } catch (err) {
    const msg = err?.message || String(err);

    const benignAfterInsert =
      stats?.inserted_count > 0 && /Bull job is still active|diagnostics consistency/i.test(msg);
    if (benignAfterInsert && scanRunId) {
      try {
        await syncInsertedCountFromDb(pool, stats);
        const recovered = buildCompleteProgress(stats);
        await finishScanRun(pool, scanRunId, 'complete', recovered.diagnostics || stats);
        await finishScanSuccess(keywordSetId, recovered);
        console.warn(
          `[scan] recovered complete after error keywordSetId=${keywordSetId} inserted=${stats.inserted_count} err=${msg}`
        );
        return;
      } catch (recoverErr) {
        console.error('[scan] recovery failed:', recoverErr?.message || recoverErr);
      }
    }

    const safeMsg = sanitizeRedditMessage(msg);
    console.error(`Scan job failed [${keywordSetId}]:`, safeMsg);
    if (
      err?.redditError?.code === 'REDDIT_BLOCKED' ||
      err?.redditError?.code === 'REDDIT_AUTH_FAILED' ||
      err?.redditError?.code === 'REDDIT_RATE_LIMITED'
    ) {
      await pool.query(
        `UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`,
        [
          keywordSetId,
          JSON.stringify({
            phase: 'error',
            message: safeMsg,
            reddit_auth_error: true,
            completed_at: new Date().toISOString(),
          }),
        ]
      );
    } else {
      await finishScanFailure(keywordSetId, safeMsg);
    }
    if (scanRunId) {
      await finishScanRun(pool, scanRunId, 'failed', {}, safeMsg);
    }
    throw err;
  }
}

/**
 * Trigger a scan for a keyword set.
 * Updates next_scan_at so the scheduler knows this monitor is being handled,
 * then fires runScanInBackground.
 */
async function addScanJob(keywordSetId, userId) {
  await pool.query(
    `UPDATE keyword_sets SET next_scan_at = NOW() + (COALESCE(scan_interval_hours, 6) * INTERVAL '1 hour') WHERE id = $1`,
    [keywordSetId]
  );

  const { runScanInBackground } = require('./scanRunner');
  runScanInBackground(keywordSetId, userId);
}

/**
 * Reschedule the next scan for a monitor (called after monitor update).
 * Replaces Bull repeatable job rescheduling.
 */
async function rescheduleRepeatableScanForKeywordSet(keywordSetId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, COALESCE(scan_interval_hours, 6) AS scan_interval_hours
     FROM keyword_sets
     WHERE id = $1 AND active = true`,
    [keywordSetId]
  );

  if (!rows.length || !rows[0].user_id) return;

  // If a scan is already in progress, don't change next_scan_at — it will be set after the scan completes
  const { runScanInBackground, activeScans } = require('./scanRunner');
  if (activeScans.has(keywordSetId)) return;

  await pool.query(
    `UPDATE keyword_sets SET next_scan_at = NOW() + ($2 * INTERVAL '1 hour') WHERE id = $1`,
    [keywordSetId, rows[0].scan_interval_hours]
  );
}

module.exports = {
  processScanJob,
  addScanJob,
  rescheduleRepeatableScanForKeywordSet,
};
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "const m = require('./src/jobs/scanJob'); console.log(Object.keys(m))"
```

Expected: `[ 'processScanJob', 'addScanJob', 'rescheduleRepeatableScanForKeywordSet' ]`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/jobs/scanJob.js
git commit -m "feat: simplify scanJob — strip Bull, export processScanJob directly"
```

---

### Task 6: Simplify `trackerJob.js` — setInterval replacing Bull

**Files:**
- Modify: `backend/src/jobs/trackerJob.js`

**Interfaces:**
- Consumes: `refreshAllTrackedReplies()` from `../services/redditTracker.js`
- Produces: `startTrackerScheduler()` — starts 2-hour setInterval
- Produces: `stopTrackerScheduler()` — stops the interval

- [ ] **Step 1: Rewrite trackerJob.js**

Replace entire contents of `backend/src/jobs/trackerJob.js` with:

```js
/**
 * Reply tracker scheduler — simplified from Bull queue to setInterval.
 */
const { refreshAllTrackedReplies } = require('../services/redditTracker');

const TRACKER_INTERVAL_MS = 2 * 3600 * 1000; // 2 hours

let trackerTimer = null;

async function startTrackerScheduler() {
  // Immediate first run
  try {
    await refreshAllTrackedReplies();
  } catch (err) {
    console.error('[tracker] initial refresh failed:', err?.message || err);
  }

  trackerTimer = setInterval(async () => {
    try {
      await refreshAllTrackedReplies();
    } catch (err) {
      console.error('[tracker] refresh failed:', err?.message || err);
    }
  }, TRACKER_INTERVAL_MS);

  if (trackerTimer.unref) trackerTimer.unref();

  console.log('✓ Reply tracker scheduler: every 2 hours');
}

function stopTrackerScheduler() {
  if (trackerTimer) {
    clearInterval(trackerTimer);
    trackerTimer = null;
  }
}

module.exports = {
  startTrackerScheduler,
  stopTrackerScheduler,
};
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "const m = require('./src/jobs/trackerJob'); console.log(Object.keys(m))"
```

Expected: `[ 'startTrackerScheduler', 'stopTrackerScheduler' ]`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/jobs/trackerJob.js
git commit -m "feat: simplify trackerJob — setInterval replacing Bull queue"
```

---

### Task 7: Simplify `monitorLifecycle.js` — remove Bull job cancellation

**Files:**
- Modify: `backend/src/services/monitorLifecycle.js`

**Interfaces:**
- Consumes: `pool` from `../db/connection.js`
- Consumes: `activeScans` from `../jobs/scanRunner.js`
- Produces: `deleteMonitorForUser(keywordSetId, userId)` — soft-delete monitor, hide leads, cancel scan runs
- Produces: `cancelJobsForKeywordSet(keywordSetId)` — no-op for Bull compatibility, returns 0

- [ ] **Step 1: Rewrite monitorLifecycle.js**

Replace entire contents of `backend/src/services/monitorLifecycle.js` with:

```js
/**
 * Monitor lifecycle — soft-delete monitors and hide associated leads.
 * Bull job cancellation removed; scan runs are cancelled in Postgres.
 */
const pool = require('../db/connection');

/**
 * No-op: previously cancelled Bull jobs. Kept for API compatibility.
 * Returns 0 because there are no queue jobs to cancel.
 */
async function cancelJobsForKeywordSet(_keywordSetId) {
  return 0;
}

/**
 * Soft-delete monitor and hide associated leads (transaction).
 */
async function deleteMonitorForUser(keywordSetId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ks = await client.query(
      `SELECT id, user_id FROM keyword_sets WHERE id = $1 AND user_id = $2`,
      [keywordSetId, userId]
    );
    if (!ks.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404 };
    }

    await client.query(
      `UPDATE keyword_sets
       SET active = false,
           deleted_at = NOW(),
           scan_progress = COALESCE(scan_progress, '{}'::jsonb) || $3::jsonb
       WHERE id = $1 AND user_id = $2`,
      [
        keywordSetId,
        userId,
        JSON.stringify({
          phase: 'cancelled',
          message: 'Monitor deleted',
          completed_at: new Date().toISOString(),
        }),
      ]
    );

    const leadsResult = await client.query(
      `UPDATE leads
       SET is_active = false,
           deleted_at = NOW()
       WHERE keyword_set_id = $1 AND user_id = $2
         AND COALESCE(is_active, true) = true
       RETURNING id`,
      [keywordSetId, userId]
    );

    const runsResult = await client.query(
      `UPDATE scan_runs
       SET status = 'cancelled',
           completed_at = COALESCE(completed_at, NOW()),
           error_message = 'Monitor deleted'
       WHERE keyword_set_id = $1
         AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING id`,
      [keywordSetId]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      deleted_monitor_id: keywordSetId,
      hidden_leads_count: leadsResult.rowCount || 0,
      cancelled_scan_runs_count: runsResult.rowCount || 0,
      jobs_removed: 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  deleteMonitorForUser,
  cancelJobsForKeywordSet,
};
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "const m = require('./src/services/monitorLifecycle'); console.log(Object.keys(m))"
```

Expected: `[ 'deleteMonitorForUser', 'cancelJobsForKeywordSet' ]`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/services/monitorLifecycle.js
git commit -m "feat: simplify monitorLifecycle — remove Bull job cancellation"
```

---

### Task 8: Rewrite `index.js` — wire new modules, add graceful shutdown

**Files:**
- Modify: `backend/index.js`

**Interfaces:**
- Consumes: `startScheduler` from `./src/jobs/scheduler.js`
- Consumes: `startTrackerScheduler` from `./src/jobs/trackerJob.js`
- Consumes: `activeScans`, `MAX_CONCURRENT_SCANS`, `recoverOrphanedScans`, `startGracefulShutdownHandlers`, `memoryUsageOk` from `./src/jobs/scanRunner.js`

- [ ] **Step 1: Rewrite index.js**

Replace entire contents of `backend/index.js` with:

```js
require('./src/config/loadEnv');

require('./src/db/connection');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const apiRouter = require('./src/routes');
const usersRouter = require('./src/routes/users');
const keywordSetsRouter = require('./src/routes/keywordSets');
const leadsRouter = require('./src/routes/leads');
const trackedRepliesRouter = require('./src/routes/trackedReplies');
const debugRouter = require('./src/routes/debug');

const { startScheduler } = require('./src/jobs/scheduler');
const { startTrackerScheduler } = require('./src/jobs/trackerJob');
const {
  activeScans,
  MAX_CONCURRENT_SCANS,
  recoverOrphanedScans,
  startGracefulShutdownHandlers,
  memoryUsageOk,
} = require('./src/jobs/scanRunner');

const app = express();
const port = Number(process.env.PORT) || 3001;

if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const isDev = process.env.NODE_ENV !== 'production';

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function withWwwAliases(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  const aliases = new Set([normalized]);
  try {
    const url = new URL(normalized);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      aliases.add(url.toString().replace(/\/$/, ''));
    } else {
      url.hostname = `www.${url.hostname}`;
      aliases.add(url.toString().replace(/\/$/, ''));
    }
  } catch {
    /* ignore invalid URL */
  }
  return [...aliases];
}

const allowedOrigins = new Set(
  [
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
    ...(process.env.CORS_EXTRA_ORIGINS || '').split(','),
  ]
    .flatMap((entry) => withWwwAliases(entry))
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const normalized = normalizeOrigin(origin);
    if (normalized && allowedOrigins.has(normalized)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(helmet());
app.use(express.json());

function rateLimitJsonHandler(message = 'Too many requests. Please wait and try again.') {
  return (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message,
      retryAfter: req.rateLimit?.resetTime ?? null,
    });
  };
}

function isPollingReadRoute(req) {
  if (req.method !== 'GET') return false;
  const path = req.path || '';
  return (
    /^\/api\/keyword-sets\/[^/]+\/scan-status$/.test(path) ||
    /^\/api\/leads\/user\/[^/]+$/.test(path)
  );
}

const pollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isDev ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  handler: rateLimitJsonHandler('Polling too frequently. Please wait and try again.'),
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isDev ? 2000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isPollingReadRoute(req),
  handler: rateLimitJsonHandler(),
});

function selectRateLimiter(req, res, next) {
  if (isPollingReadRoute(req)) {
    return pollingLimiter(req, res, next);
  }
  return globalLimiter(req, res, next);
}

app.use(selectRateLimiter);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'signal-backend',
    message: 'Signal backend is running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await require('./src/db/connection').query('SELECT 1');
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.json({
    ok: dbOk,
    service: 'signal-backend',
    activeScans: activeScans.size,
    maxConcurrentScans: MAX_CONCURRENT_SCANS,
    uptimeSeconds: Math.round(process.uptime()),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    trustProxy: app.get('trust proxy'),
  });
});

app.use('/api', apiRouter);
app.use('/api/users', usersRouter);
app.use('/api/keyword-sets', keywordSetsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/tracked-replies', trackedRepliesRouter);
app.use('/api/debug', debugRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error('[backend] unhandled error:', err);

  if (err.message && err.message.startsWith('CORS blocked origin:')) {
    return res.status(403).json({
      error: 'cors_blocked',
      message: err.message,
    });
  }

  res.status(err.status || 500).json({
    error: err.code || 'internal_server_error',
    message:
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
});

const server = app.listen(port, async () => {
  console.log(`Signal backend running on port ${port}`);

  // Recover any orphaned scans from a previous crash
  await recoverOrphanedScans();

  // Start scheduler — polls Postgres for due scans
  startScheduler().catch((err) => {
    console.error(
      'Scheduler bootstrap failed:',
      err && err.message ? err.message : err
    );
  });

  // Start reply tracker — 2-hour interval
  startTrackerScheduler().catch((err) => {
    console.error(
      'Reply tracker scheduler failed:',
      err && err.message ? err.message : err
    );
  });

  // Register graceful shutdown handlers
  startGracefulShutdownHandlers();
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[api] Port ${port} is already in use. Stop the other process (lsof -i :${port}) or run only one API instance.`
    );
    process.exit(1);
  }
  console.error('[api] Server error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "require('./index'); console.log('OK')" 2>&1 | head -5
```

Expected: No `Cannot find module` errors. May fail on DB connection (expected without Postgres).

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/index.js
git commit -m "feat: rewrite index.js — wire scanRunner, add graceful shutdown, simplify health"
```

---

### Task 9: Simplify `keywordSets.js` scan-status route

**Files:**
- Modify: `backend/src/routes/keywordSets.js`

**Interfaces:**
- Consumes: `addScanJob`, `rescheduleRepeatableScanForKeywordSet` from `../jobs/scanJob.js`
- Consumes: `getScanRunForStatus` from `../services/scanRunService.js`
- Consumes: `activeScans` from `../jobs/scanRunner.js`

This is the largest rewrite. The scan-status route (lines ~299-576) must be simplified to remove all Bull job state checks. The rest of the routes (preview-plan, POST /, DELETE /duplicates, GET /user/:userId, DELETE /:id, PATCH /:id) need minor updates to remove Bull imports.

- [ ] **Step 1: Update imports at top of keywordSets.js**

Replace lines 1-15 (the require statements) with:

```js
const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const {
  addScanJob,
  rescheduleRepeatableScanForKeywordSet,
} = require('../jobs/scanJob');
const { getScanRunForStatus } = require('../services/scanRunService');
const { generateExamplePost } = require('../services/draftService');
const { normalizeSearchFocus } = require('../utils/searchFocus');
const { deleteMonitorForUser } = require('../services/monitorLifecycle');
const { activeScans } = require('../jobs/scanRunner');

const router = express.Router();
```

- [ ] **Step 2: Rewrite the scan-status route (/:id/scan-status)**

Replace the entire scan-status route (from `router.get('/:id/scan-status'` to the closing `})`) with:

```js
router.get('/:id/scan-status', async (req, res) => {
  try {
    const { id } = req.params;

    const ksResult = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [id]);

    if (!ksResult.rows.length) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    const keywordSet = ksResult.rows[0];

    if (keywordSet.active === false) {
      const deletedAt = keywordSet.deleted_at || null;
      return res.status(404).json({
        error: 'keyword_set_not_found',
        inactive: true,
        deleted_at: deletedAt,
        message: deletedAt
          ? 'This monitor was deleted. Select another monitor from the sidebar or create a new one.'
          : 'This monitor is inactive. Select another monitor from the sidebar or create a new one.',
      });
    }

    const parseJsonField = (value, fallback = {}) => {
      if (!value) return fallback;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return fallback; }
    };

    const scanProgress = parseJsonField(keywordSet.scan_progress, {});
    const scanRun = await getScanRunForStatus(pool, keywordSet);
    const runStatus = String(scanRun?.status || '').toLowerCase();
    const runDiagnostics = parseJsonField(scanRun?.diagnostics, {});
    const progressDiagnostics = parseJsonField(scanProgress.diagnostics, {});

    const diagnostics =
      runStatus === 'complete' || runStatus === 'failed'
        ? { ...runDiagnostics, scan_run_id: scanRun?.id || runDiagnostics.scan_run_id }
        : { ...runDiagnostics, ...progressDiagnostics };

    let insertedThisRun = Number(
      diagnostics.inserted_count ?? scanProgress.inserted_count ?? scanProgress.leads_saved ?? 0
    );

    if (scanRun?.id) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS c
         FROM leads
         WHERE scan_run_id = $1 AND COALESCE(is_active, true) = true`,
        [scanRun.id]
      );
      const dbCount = countResult.rows[0]?.c;
      if (Number.isFinite(dbCount)) insertedThisRun = dbCount;
    }

    const activeMonitorResult = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM leads
       WHERE keyword_set_id = $1
         AND user_id = $2
         AND COALESCE(is_active, true) = true`,
      [id, keywordSet.user_id]
    );
    const activeMonitorLeadCount = activeMonitorResult.rows[0]?.c ?? 0;

    const totalMonitorResult = await pool.query(
      `SELECT COUNT(*)::int AS c FROM leads WHERE keyword_set_id = $1 AND user_id = $2`,
      [id, keywordSet.user_id]
    );
    const totalMonitorLeadCount = totalMonitorResult.rows[0]?.c ?? 0;

    const leadsFound = insertedThisRun;

    const queryCount = Array.isArray(keywordSet.queries) ? keywordSet.queries.length : 0;
    const subredditCount = Array.isArray(keywordSet.subreddits) ? keywordSet.subreddits.length : 0;

    const queuedAt = scanProgress.queued_at || scanProgress.started_at;
    const queuedForSeconds = queuedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 1000))
      : 0;

    const progressPhase = String(scanProgress.phase || '').toLowerCase();

    // Determine status from scan_runs + scan_progress only (no Bull job state)
    let status = 'idle';
    const scanIsActive = activeScans.has(id);

    if (runStatus === 'complete') {
      status = 'complete';
    } else if (progressPhase === 'complete' && keywordSet.last_scanned_at) {
      status = 'complete';
    } else if (runStatus === 'failed') {
      const runError = String(scanRun?.error_message || scanProgress.message || '');
      const recoverableFailedScan =
        insertedThisRun > 0 &&
        (/diagnostics consistency/i.test(runError) || progressPhase === 'complete');
      if (recoverableFailedScan) {
        status = 'complete';
      } else {
        status = 'failed';
      }
    } else if (progressPhase === 'error') {
      status = 'failed';
    } else if (scanIsActive || runStatus === 'running') {
      status = 'scanning';
    } else if (
      ['collecting', 'scoring', 'qualifying', 'saving', 'persist', 'qualify', 'reddit_global', 'subreddit', 'active'].includes(progressPhase)
    ) {
      status = 'scanning';
    } else if (progressPhase === 'queued') {
      status = 'queued';
    } else if (keywordSet.last_scanned_at) {
      status = 'complete';
    }

    let workerHint = null;
    if (status === 'queued') {
      workerHint = 'Scan is queued — it will start shortly.';
    } else if (status === 'failed' && scanProgress.reddit_auth_error) {
      workerHint = 'Reddit blocked requests. Check PROXY_LIST and proxy credentials.';
    } else if (status === 'scanning') {
      workerHint = 'Scan is running.';
    }

    const plannerSource = diagnostics.planner_source || scanProgress.planner_source || null;
    const classifierSource = diagnostics.classifier_source || scanProgress.classifier_source || null;

    const scanProgressOut = {
      ...scanProgress,
      ...diagnostics,
      inserted_count: insertedThisRun,
      leads_saved: insertedThisRun,
      leads_found: leadsFound,
      planner_source: plannerSource,
      classifier_source: classifierSource,
      diagnostic_summary: scanProgress.diagnostic_summary || diagnostics.diagnostic_summary || null,
    };

    const classifierWarning =
      plannerSource === 'ai' && classifierSource === 'fallback'
        ? `AI classifier failed; fallback qualification used. ${diagnostics.classifier_error || ''}`.trim()
        : null;

    return res.json({
      id: keywordSet.id,
      status,
      scan_is_active: scanIsActive,
      started_at: scanProgress.started_at || scanRun?.started_at || null,
      queued_for_seconds: queuedForSeconds,
      last_scanned_at: keywordSet.last_scanned_at,
      leads_found: leadsFound,
      current_scan_inserted_count: insertedThisRun,
      active_monitor_lead_count: activeMonitorLeadCount,
      total_monitor_lead_count: totalMonitorLeadCount,
      classifier_warning: classifierWarning,
      classifier_error: diagnostics.classifier_error || null,
      diagnostics,
      scan_progress: scanProgressOut,
      queries: keywordSet.queries || [],
      subreddits: keywordSet.subreddits || [],
      query_count: queryCount,
      subreddit_count: subredditCount,
      live_queries: keywordSet.queries || [],
      live_subreddits: keywordSet.subreddits || [],
      product_description: keywordSet.product_description,
      scan_interval_hours: keywordSet.scan_interval_hours,
      worker_hint: workerHint,
      planner_source: plannerSource,
      planner_model: diagnostics.planner_model || scanProgress.planner_model || null,
      classifier_source: classifierSource,
      classifier_model: diagnostics.classifier_model || null,
      scan_run_id: scanRun?.id || keywordSet.current_scan_run_id || null,
    });
  } catch (err) {
    console.error('[scan-status] ERROR:', err);
    return res.status(500).json({
      error: 'scan_status_failed',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Failed to read scan status'
          : err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    });
  }
});
```

- [ ] **Step 3: Update rescan route**

Replace the rescan route with:

```js
/** Queue an immediate rescan. */
router.post('/:id/rescan', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id FROM keyword_sets WHERE id = $1 AND (active IS NULL OR active = true)`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Monitor not found' });
    }

    const { deactivateStaleLeads } = require('../services/scanRunService');
    await deactivateStaleLeads(pool, rows[0].id, rows[0].user_id);

    await pool.query(`UPDATE keyword_sets SET last_scanned_at = NULL, next_scan_at = NOW() WHERE id = $1`, [
      req.params.id,
    ]);
    addScanJob(req.params.id, rows[0].user_id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[keywordSets] POST /:id/rescan', err);
    return res.status(500).json({ error: 'Failed to queue scan' });
  }
});
```

- [ ] **Step 4: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "require('./src/routes/keywordSets'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/routes/keywordSets.js
git commit -m "feat: simplify keywordSets scan-status route — remove Bull job state checks"
```

---

### Task 10: Rewrite `debug.js` — replace Redis/Bull endpoints

**Files:**
- Modify: `backend/src/routes/debug.js`

**Interfaces:**
- Consumes: `pool` from `../db/connection.js`
- Consumes: `activeScans`, `MAX_CONCURRENT_SCANS`, `memoryUsageOk` from `../jobs/scanRunner.js`

- [ ] **Step 1: Rewrite debug.js**

Replace entire contents of `backend/src/routes/debug.js` with:

```js
const express = require('express');

const { generateQueries } = require('../services/keywordProcessor');
const { activeScans, MAX_CONCURRENT_SCANS, memoryUsageOk } = require('../jobs/scanRunner');

const router = express.Router();

router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
});

router.post('/keyword-plan', async (req, res) => {
  const description = req.body?.description;
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }

  try {
    const plan = await generateQueries(description.trim());
    return res.json({
      queries: plan.queries,
      subreddits: plan.subreddits,
      negative_keywords: plan.negative_keywords || [],
      ideal_post_patterns: plan.ideal_post_patterns || [],
      source: plan.source || 'mixed',
      planner_source: plan.planner_source,
      planner_model: plan.planner_model,
      reddit_fit: plan.reddit_fit,
      warning: plan.warning,
      suggestion: plan.suggestion,
      lead_definition: plan.lead_definition,
      required_evidence: plan.required_evidence,
      disqualifying_evidence: plan.disqualifying_evidence,
      reasoning_summary: plan.reasoning_summary || null,
    });
  } catch (err) {
    console.error('[debug] POST /keyword-plan', err);
    return res.status(err.code === 'invalid_search_plan' ? 400 : 500).json({
      error: err.code || 'keyword_generation_failed',
      message: err.message,
      stack: err.stack,
    });
  }
});

/**
 * Scan status for dev — shows in-process scan state instead of Redis/Bull queue state.
 */
router.get('/scan-status', async (req, res) => {
  const pool = require('../db/connection');
  try {
    const { rows: activeMonitors } = await pool.query(
      `SELECT id, user_id, product_description, next_scan_at, last_scanned_at
       FROM keyword_sets
       WHERE active = true AND deleted_at IS NULL
       ORDER BY next_scan_at ASC
       LIMIT 20`
    );

    const { rows: runningScans } = await pool.query(
      `SELECT sr.id, sr.keyword_set_id, sr.status, sr.started_at
       FROM scan_runs sr
       WHERE sr.status IN ('running', 'queued')
       ORDER BY sr.started_at DESC
       LIMIT 10`
    );

    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    return res.json({
      scheduler: {
        active_scans: activeScans.size,
        max_concurrent_scans: MAX_CONCURRENT_SCANS,
        memory_ok: memoryUsageOk(),
        heap_mb: heapMB,
      },
      monitors: activeMonitors,
      running_scans: runningScans,
    });
  } catch (err) {
    console.error('[debug] GET /scan-status', err);
    return res.status(500).json({
      error: err?.message || 'Failed to read scan status',
    });
  }
});

router.delete('/purge-deleted-monitors', async (req, res) => {
  const pool = require('../db/connection');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leads = await client.query(
      `DELETE FROM leads l
       USING keyword_sets ks
       WHERE l.keyword_set_id = ks.id
         AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)`
    );
    const runs = await client.query(
      `DELETE FROM scan_runs sr
       USING keyword_sets ks
       WHERE sr.keyword_set_id = ks.id
         AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)`
    );
    const ks = await client.query(
      `DELETE FROM keyword_sets
       WHERE COALESCE(active, false) = false OR deleted_at IS NOT NULL`
    );
    await client.query('COMMIT');
    return res.json({
      purged_keyword_sets: ks.rowCount || 0,
      purged_leads: leads.rowCount || 0,
      purged_scan_runs: runs.rowCount || 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[debug] purge-deleted-monitors', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
```

- [ ] **Step 2: Verify file loads**

```bash
cd /private/tmp/Signal/backend && node -e "require('./src/routes/debug'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /private/tmp/Signal
git add backend/src/routes/debug.js
git commit -m "feat: rewrite debug routes — replace Redis/Bull endpoints with Postgres queries"
```

---

### Task 11: Delete Redis/Bull files and remove dependencies

**Files:**
- Delete: `backend/worker-web.js`
- Delete: `backend/src/jobs/queueFactory.js`
- Delete: `backend/src/jobs/worker.js`
- Delete: `backend/src/services/workerHeartbeat.js`
- Delete: `backend/src/services/redisCleanup.js`
- Delete: `backend/src/scripts/pruneRedis.js`
- Delete: `backend/src/scripts/testRedisConnection.js`
- Delete: `backend/src/scripts/clearQueue.js`
- Delete: `backend/src/scripts/testWorkerQueue.js`
- Delete: `backend/nodemon.worker.json`
- Delete: `render.yaml`
- Modify: `backend/package.json` — remove `bull`, `ioredis` deps, remove scripts
- Modify: `backend/.env.example` — remove Redis vars, add scheduler vars

**Interfaces:**
- Produces: codebase with no `bull` or `ioredis` dependencies

- [ ] **Step 1: Delete files**

```bash
cd /private/tmp/Signal
rm backend/worker-web.js
rm backend/src/jobs/queueFactory.js
rm backend/src/jobs/worker.js
rm backend/src/services/workerHeartbeat.js
rm backend/src/services/redisCleanup.js
rm backend/src/scripts/pruneRedis.js
rm backend/src/scripts/testRedisConnection.js
rm backend/src/scripts/clearQueue.js
rm backend/src/scripts/testWorkerQueue.js
rm backend/nodemon.worker.json
rm render.yaml
```

- [ ] **Step 2: Update package.json**

In `backend/package.json`, remove `"bull"` and `"ioredis"` from dependencies, and remove these scripts: `worker`, `dev:worker`, `start:worker-web`, `test:redis`, `clear-queue`, `cleanup:redis`, `test:worker-queue`.

The resulting scripts block should be:

```json
"scripts": {
  "start": "node index.js",
  "dev": "nodemon --config nodemon.api.json index.js",
  "migrate": "node src/db/migrate.js",
  "test:db": "node src/scripts/testDbConnection.js",
  "test:reddit": "node src/scripts/testReddit.js",
  "compare:scan": "node src/scripts/compareScanSources.js",
  "test:keyword-plan": "node src/scripts/testKeywordPlan.js",
  "test:marketplace-planner": "node src/scripts/testMarketplacePlanner.js",
  "test:lead-qualification": "node src/scripts/testLeadQualification.js",
  "test:lead-types": "node src/scripts/testLeadTypes.js",
  "test:scan-pipeline": "node src/scripts/testScanPipelineOnce.js",
  "test:create-keyword-set": "node src/scripts/testCreateKeywordSet.js",
  "test:delete-monitor": "node src/scripts/testDeleteMonitorLifecycle.js",
  "cleanup:deleted-monitors": "node src/scripts/cleanupDeletedMonitorData.js",
  "cleanup:inactive-leads": "node src/scripts/cleanupInactiveLeads.js",
  "test:dynamic-lead-qualification": "node src/scripts/testDynamicLeadQualification.js",
  "seed": "node src/scripts/seedLeads.js"
}
```

And the dependencies should be:

```json
"dependencies": {
  "axios": "^1.13.5",
  "cors": "^2.8.5",
  "dotenv": "^16.6.1",
  "express": "^4.21.2",
  "express-rate-limit": "^8.4.1",
  "helmet": "^8.1.0",
  "https-proxy-agent": "^5.0.1",
  "node-fetch": "^2.7.0",
  "pg": "^8.16.3"
}
```

- [ ] **Step 3: Update .env.example**

Replace `backend/.env.example` with:

```
PORT=3001
DATABASE_URL=postgresql://YOUR_USER@127.0.0.1:5432/signal_dev
# Neon (production): use pooled connection string; SSL auto-enabled for neon.tech hosts
# DB_SSL=true

# Reddit public JSON (via optional Webshare proxy rotation)
REDDIT_USER_AGENT=Signal/1.0 (by /u/YourRedditUsername)
REDDIT_REQUEST_DELAY_MS=2000
REDDIT_SEARCH_LIMIT=25
PROXY_USERNAME=
PROXY_PASSWORD=
# Webshare rotating endpoint (recommended): p.webshare.io:80 with username ending in -rotate
PROXY_LIST=
# PROXY_HOST=p.webshare.io
# PROXY_PORT=80
# PROXY_ROTATING=true
# PROXY_ENABLED=false

# Hacker News (Algolia) — on by default in development
ENABLE_HN_SEARCH=true

# Scheduler
SCHEDULER_POLL_INTERVAL_MS=30000
MAX_CONCURRENT_SCANS=2
SCAN_JOB_TIMEOUT_MS=1500000

# Scan breadth
SCAN_MAX_QUERIES=18
SCAN_MAX_SUBREDDITS=10
SCAN_MAX_LEADS_PER_RUN=40
SCAN_MAX_RAW_TOTAL=500
SCAN_MAX_RAW_PER_PAIR=50
SCAN_MAX_PAIRS=30
MAX_QUALIFICATION_CANDIDATES=80
# Do not insert leads during collection — only one final capped insert pass
SCAN_INCREMENTAL_PERSIST=false
# Fail scan instead of saving leads when AI classifier is unavailable
REQUIRE_AI_CLASSIFIER=true
LEAD_SCORE_THRESHOLD=10
SCAN_SCORE_FLOOR=5
SAVE_TOP_CANDIDATES_WHEN_LOW=true
FORCE_REGENERATE_QUERIES=false

# Used for AI search-plan generation (queries/subreddits) and reply drafts
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
JWT_SECRET=changeme
```

- [ ] **Step 4: Reinstall dependencies**

```bash
cd /private/tmp/Signal/backend && rm -rf node_modules package-lock.json && npm install
```

- [ ] **Step 5: Verify no Redis/Bull imports remain**

```bash
cd /private/tmp/Signal && grep -r "bull\|ioredis\|REDIS_URL\|queueFactory\|workerHeartbeat\|redisCleanup" backend/src/ backend/index.js --include="*.js" -l
```

Expected: No output (no files match)

- [ ] **Step 6: Verify frontend still builds**

```bash
cd /private/tmp/Signal/frontend && npm run build
```

Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
cd /private/tmp/Signal
git add -A
git commit -m "feat: delete Redis/Bull files and dependencies — no Redis required"
```

---

### Task 12: Clean up stray code and update dev scripts

**Files:**
- Modify: `backend/nodemon.api.json` — watch `src/jobs/` again
- Modify: `scripts/dev-all.sh` — no Redis check, no worker process
- Modify: `scripts/local-up.sh` — no Redis start
- Delete: `.gitkeep` files from directories with actual files
- Modify: `backend/index.js` — remove hardcoded Render CORS origin

**Interfaces:**
- Produces: clean dev experience with no Redis requirement

- [ ] **Step 1: Update nodemon.api.json**

Replace `backend/nodemon.api.json` with:

```json
{
  "watch": ["index.js", "src/routes", "src/db", "src/jobs"],
  "ignore": ["src/scripts/**", "src/services/**"],
  "ext": "js,json,sql"
}
```

- [ ] **Step 2: Rewrite dev-all.sh**

Replace `scripts/dev-all.sh` with:

```bash
#!/usr/bin/env bash
# Run backend API + frontend in one shell (no separate worker needed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  echo ""
  echo "→ Stopping Signal dev servers…"
  jobs -p 2>/dev/null | xargs kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM

(cd "$ROOT/backend" && npm run migrate)
echo ""

echo "→ Backend:      http://localhost:3001"
echo "→ Frontend:     http://localhost:5173"
echo "→ Scans run in-process (no separate worker needed)"
echo "→ Press Ctrl+C to stop."
echo ""

(cd "$ROOT/backend" && npm run dev) &
(cd "$ROOT/frontend" && npm run dev) &

wait
```

- [ ] **Step 3: Rewrite local-up.sh**

Replace `scripts/local-up.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ Starting PostgreSQL (Homebrew service)…"
brew services start postgresql@16 >/dev/null 2>&1 || true

echo "→ Running migrations…"
(cd "$ROOT/backend" && npm run migrate)

echo "→ Launching backend (3001) + frontend (5173)…"
(cd "$ROOT/backend" && npm run dev) &
BACK_PID=$!
(cd "$ROOT/frontend" && npm run dev) &
FRONT_PID=$!

cleanup() {
  echo
  echo "→ Shutting down (Ctrl+C again if needed)…"
  kill "$BACK_PID" "$FRONT_PID" 2>/dev/null || true
}

trap cleanup INT TERM

wait
```

- [ ] **Step 4: Remove .gitkeep files**

```bash
cd /private/tmp/Signal
find . -name ".gitkeep" -delete
```

- [ ] **Step 5: Verify no remaining references to deleted modules**

```bash
cd /private/tmp/Signal && grep -r "queueFactory\|workerHeartbeat\|redisCleanup\|worker-web\|SKIP_EMBEDDED_WORKERS\|manualScanQueue\|scanQueue\|trackerQueue" backend/ scripts/ --include="*.js" --include="*.sh" -l
```

Expected: No output

- [ ] **Step 6: Commit**

```bash
cd /private/tmp/Signal
git add -A
git commit -m "feat: clean up stray code, update dev scripts for no-Redis architecture"
```

---

### Task 13: Add deployment files — fly.toml, Dockerfile, .env.fly.example

**Files:**
- Create: `fly.toml`
- Create: `Dockerfile`
- Create: `backend/.env.fly.example`
- Create: `frontend/.env.production`

**Interfaces:**
- Produces: Fly.io deployment configuration

- [ ] **Step 1: Create fly.toml**

Write to `/private/tmp/Signal/fly.toml`:

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

- [ ] **Step 2: Create Dockerfile**

Write to `/private/tmp/Signal/Dockerfile`:

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

- [ ] **Step 3: Create .env.fly.example**

Write to `/private/tmp/Signal/backend/.env.fly.example`:

```
# Fly.io deployment reference — set real values via `fly secrets set` only, never commit secrets.

DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
REDDIT_USER_AGENT=Signal/1.0 (by /u/Pranaav003)
REDDIT_REQUEST_DELAY_MS=3000
PROXY_PASSWORD=your-webshare-password
PROXY_LIST=p.webshare.io:80
PROXY_USERNAMES=qcceojoh-gb-1,qcceojoh-ca-2,qcceojoh-de-3
USE_MOCK_REDDIT=false
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
REQUIRE_AI_CLASSIFIER=true
SCHEDULER_POLL_INTERVAL_MS=30000
MAX_CONCURRENT_SCANS=2
SCAN_JOB_TIMEOUT_MS=1500000
REDDIT_STARTUP_PROBE_MS=45000
SCAN_INCREMENTAL_PERSIST=false
SCAN_MAX_LEADS_PER_RUN=40
SCAN_MAX_RAW_TOTAL=500
SCAN_MAX_RAW_PER_PAIR=50
SCAN_MAX_PAIRS=30
MAX_QUALIFICATION_CANDIDATES=80
JWT_SECRET=replace-with-generated-value
FRONTEND_URL=https://signal.pranaaviyer.com
```

- [ ] **Step 4: Create frontend/.env.production**

Write to `/private/tmp/Signal/frontend/.env.production`:

```
VITE_API_URL=https://signal-app.fly.dev
```

- [ ] **Step 5: Commit**

```bash
cd /private/tmp/Signal
git add fly.toml Dockerfile backend/.env.fly.example frontend/.env.production
git commit -m "feat: add Fly.io deployment config, Dockerfile, and env examples"
```

---

### Task 14: Update README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: documentation reflecting the new architecture

- [ ] **Step 1: Update README.md**

This is a documentation-only change. Replace the entire README with content reflecting:
- No Redis requirement for local dev
- Fly.io deployment instead of Render
- Updated env var table (no Redis vars, add scheduler vars)
- Simplified local dev instructions (one terminal for backend, one for frontend)
- Remove all Render/UptimeRobot/Upstash references

The key changes from the current README:

1. **Local development** — Remove Redis from prerequisites. Remove "Terminal 2 — Background worker". Backend runs everything in one process.
2. **Render deploy** section — Replace with **Fly.io deploy** section.
3. **Environment variables** table — Remove `REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SKIP_EMBEDDED_WORKERS`, `WORKER_WEB_PORT`. Add `SCHEDULER_POLL_INTERVAL_MS`, `MAX_CONCURRENT_SCANS`, `SCAN_JOB_TIMEOUT_MS`.
4. **Current Stable Architecture** — Update to reflect single-process (no separate worker, no Redis/Bull).
5. **Free/Low-Cost Deployment Notes** — Replace with Fly.io + Cloudflare Pages ($0/month).
6. Remove **Option A deployment checklist** (Render-specific).
7. Update **Working-baseline verification** to remove worker step.

- [ ] **Step 2: Commit**

```bash
cd /private/tmp/Signal
git add README.md
git commit -m "docs: update README for Fly.io deployment and no-Redis architecture"
```

---

### Task 15: Final verification — no Redis references, build passes

**Files:**
- None (verification only)

**Interfaces:**
- Produces: verified codebase with no Redis/Bull references

- [ ] **Step 1: Grep for any remaining Redis/Bull references**

```bash
cd /private/tmp/Signal && grep -ri "redis\|ioredis\|bull\|REDIS_URL\|UPSTASH\|queueFactory\|workerHeartbeat\|redisCleanup\|SKIP_EMBEDDED_WORKERS\|WORKER_WEB_PORT" backend/ --include="*.js" --include="*.json" --include="*.env*" -l 2>/dev/null
```

Expected: No output (no files match). If files are found, fix them and commit.

- [ ] **Step 2: Grep for remaining Render-specific references**

```bash
cd /private/tmp/Signal && grep -ri "render\|uptimero bot\|onrender\.com" backend/ --include="*.js" -l 2>/dev/null
```

Expected: No output. If found, update.

- [ ] **Step 3: Verify backend can load all modules**

```bash
cd /private/tmp/Signal/backend && node -e "
  require('./src/jobs/scanRunner');
  require('./src/jobs/scheduler');
  require('./src/jobs/scanJob');
  require('./src/jobs/trackerJob');
  require('./src/services/monitorLifecycle');
  require('./src/routes/keywordSets');
  require('./src/routes/debug');
  console.log('All modules loaded OK');
"
```

Expected: `All modules loaded OK`

- [ ] **Step 4: Verify package.json has no bull/ioredis**

```bash
cd /private/tmp/Signal/backend && cat package.json | grep -E "bull|ioredis"
```

Expected: No output

- [ ] **Step 5: Verify frontend builds**

```bash
cd /private/tmp/Signal/frontend && npm run build
```

Expected: Build succeeds

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
cd /private/tmp/Signal && git add -A && git diff --cached --quiet || git commit -m "fix: clean up remaining Redis/Render references"
```

---

### Task 16: Manual smoke test (requires Postgres running locally)

**Files:**
- None (testing only)

**Interfaces:**
- Produces: verified working application

This task requires a local Postgres instance with the Signal database. Skip if Postgres is not available.

- [ ] **Step 1: Run migrations**

```bash
cd /private/tmp/Signal/backend && node src/db/migrate.js
```

Expected: `✓ Migration complete`

- [ ] **Step 2: Start backend**

```bash
cd /private/tmp/Signal/backend && npm run dev
```

Expected output includes:
- `Signal backend running on port 3001`
- `✓ Database connected`
- `✓ Scheduler started: N monitors active, polling every 30s`
- `✓ Reply tracker scheduler: every 2 hours`
- No errors about Redis or Bull

- [ ] **Step 3: Test health endpoint**

```bash
curl http://localhost:3001/health
```

Expected: `{"ok":true,"service":"signal-backend","activeScans":0,...}`

- [ ] **Step 4: Test keyword-plan generation**

```bash
curl -X POST http://localhost:3001/api/keyword-sets/preview-plan \
  -H "Content-Type: application/json" \
  -d '{"product_description":"A dog walking service in Austin TX"}'
```

Expected: JSON with `queries`, `subreddits`, `planner_source`

- [ ] **Step 5: Kill backend and verify no Redis errors in output**

Stop the server. The output should not contain any Redis or Bull error messages.
