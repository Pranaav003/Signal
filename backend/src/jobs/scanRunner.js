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
let _schedulerStopped = false;

function isSchedulerStopped() {
  return _schedulerStopped;
}

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
  if (_schedulerStopped) {
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
    _schedulerStopped = true;

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
  isSchedulerStopped,
  memoryUsageOk,
  runScanInBackground,
  recoverOrphanedScans,
  startGracefulShutdownHandlers,
};
