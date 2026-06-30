/**
 * Postgres-based scheduler — replaces Bull repeatable jobs.
 * Polls keyword_sets.next_scan_at every 30 seconds and fires in-process scans.
 */
const pool = require('../db/connection');
const { runScanInBackground, isSchedulerStopped, memoryUsageOk } = require('./scanRunner');

const SCHEDULER_POLL_INTERVAL_MS =
  Number(process.env.SCHEDULER_POLL_INTERVAL_MS) > 0
    ? Number(process.env.SCHEDULER_POLL_INTERVAL_MS)
    : 30_000;

let schedulerTimer = null;

async function schedulerTick() {
  if (isSchedulerStopped()) return;

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
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM keyword_sets WHERE active = true AND deleted_at IS NULL`
  );
  const count = rows[0]?.n ?? 0;

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