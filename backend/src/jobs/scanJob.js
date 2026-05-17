const Bull = require('bull');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const {
  runScanPipeline,
  buildCompleteProgress,
} = require('../services/scanPipeline');

const scanQueue = new Bull('reddit-scan', process.env.REDIS_URL);

let workerStarted = false;
let queueEventsAttached = false;

function manualScanJobId(keywordSetId) {
  return `manual-scan-${keywordSetId}`;
}

async function setScanProgress(keywordSetId, payload) {
  try {
    await pool.query(`UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`, [
      keywordSetId,
      JSON.stringify(payload),
    ]);
  } catch (err) {
    console.warn('[scan] scan_progress update skipped:', err && err.message ? err.message : err);
  }
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

/** Bull job options: timeout fails stuck Reddit scans so `last_scanned_at` can be set in catch. */
const SCAN_QUEUE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  timeout:
    Number(process.env.SCAN_JOB_TIMEOUT_MS) > 0
      ? Number(process.env.SCAN_JOB_TIMEOUT_MS)
      : 25 * 60 * 1000,
};

async function getManualScanJobState(keywordSetId) {
  try {
    const job = await scanQueue.getJob(manualScanJobId(keywordSetId));
    if (!job) return { job: null, state: null };
    const state = await job.getState();
    return { job, state };
  } catch (err) {
    return { job: null, state: null, error: err && err.message ? err.message : String(err) };
  }
}

async function addScanJob(keywordSetId, userId) {
  const jobId = manualScanJobId(keywordSetId);

  try {
    const existing = await scanQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'delayed', 'active', 'paused'].includes(state)) {
        return existing;
      }
      try {
        await existing.remove();
      } catch (_e) {
        /* completed/failed job cleanup */
      }
    }
  } catch (err) {
    console.warn('[scan] could not inspect existing job:', err && err.message ? err.message : err);
  }

  const { rows: ksRows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
    keywordSetId,
  ]);
  if (ksRows[0]) {
    const { prepareKeywordSetForScan } = require('../services/scanPipeline');
    await prepareKeywordSetForScan(pool, ksRows[0]);
  }

  const startedAt = new Date().toISOString();
  await pool.query(
    `UPDATE keyword_sets
     SET last_scanned_at = NULL,
         scan_progress = $2::jsonb
     WHERE id = $1`,
    [
      keywordSetId,
      JSON.stringify({
        phase: 'queued',
        message: 'Scan queued — waiting for worker…',
        queued_at: startedAt,
        started_at: startedAt,
        job_id: jobId,
      }),
    ]
  );

  return scanQueue.add(
    { keywordSetId, userId: userId || null },
    {
      ...SCAN_QUEUE_JOB_OPTS,
      jobId,
    }
  );
}

/**
 * Re-register this monitor's Bull repeatable scan job using `scan_interval_hours` from the DB.
 */
async function rescheduleRepeatableScanForKeywordSet(keywordSetId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, COALESCE(scan_interval_hours, 6) AS scan_interval_hours
     FROM keyword_sets
     WHERE id = $1 AND active = true`,
    [keywordSetId]
  );

  if (!rows.length || !rows[0].user_id) {
    return;
  }

  const ks = rows[0];
  const hours = Number(ks.scan_interval_hours) || 6;
  const every = Math.max(hours, 1) * 3600 * 1000;
  const jobIdStr = `scan-${keywordSetId}`;

  const repeatable = await scanQueue.getRepeatableJobs();
  for (const rj of repeatable) {
    if (rj.id === jobIdStr) {
      await scanQueue.removeRepeatableByKey(rj.key);
      break;
    }
  }

  await scanQueue.add(
    { keywordSetId: ks.id, userId: ks.user_id },
    {
      repeat: { every },
      jobId: jobIdStr,
      ...SCAN_QUEUE_JOB_OPTS,
    }
  );
}

function attachQueueEventLogging() {
  if (queueEventsAttached) return;
  queueEventsAttached = true;

  scanQueue.on('waiting', (jobId) => {
    console.log(`[scan] waiting jobId=${jobId}`);
  });

  scanQueue.on('active', (job) => {
    const kid = job?.data?.keywordSetId;
    console.log(`[scan] active keywordSetId=${kid || '?'}`);
  });

  scanQueue.on('completed', (job) => {
    const kid = job?.data?.keywordSetId;
    console.log(`[scan] completed keywordSetId=${kid || '?'}`);
  });

  scanQueue.on('failed', (job, err) => {
    const kid = job?.data?.keywordSetId;
    console.error(
      `[scan] failed keywordSetId=${kid || '?'}:`,
      err && err.message ? err.message : err
    );
  });

  scanQueue.on('stalled', (job) => {
    const kid = job?.data?.keywordSetId;
    console.warn(`[scan] stalled keywordSetId=${kid || '?'}`);
  });

  scanQueue.on('error', (err) => {
    console.error('[scan] queue error:', err && err.message ? err.message : err);
  });
}

function initWorker() {
  if (workerStarted) {
    console.warn('[scan] initWorker already registered — skipping duplicate processor');
    return;
  }
  workerStarted = true;
  attachQueueEventLogging();

  scanQueue.process(1, async (job) => {
    const { keywordSetId } = job.data;

    const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
      keywordSetId,
    ]);

    const keywordSet = rows[0];

    if (!keywordSet || !keywordSet.active) {
      return;
    }

    try {
      const workerStartedAt = new Date().toISOString();
      await setScanProgress(keywordSetId, {
        phase: 'active',
        message: 'Scan worker started…',
        started_at: workerStartedAt,
        job_id: manualScanJobId(keywordSetId),
      });

      const { stats } = await runScanPipeline(keywordSet, {
        pool,
        insertLeads: true,
        onProgress: (payload) => setScanProgress(keywordSetId, payload),
      });

      const completeProgress = buildCompleteProgress(stats);
      await finishScanSuccess(keywordSetId, completeProgress);

      console.log(
        `[scan] complete keywordSetId=${keywordSetId} raw=${stats.collected_raw} deduped=${stats.deduped_count} scored=${stats.scored_count} survivors=${stats.survivors_count} attempted=${stats.attempted_inserts} inserted=${stats.inserted_count} duplicates=${stats.duplicate_count} skipped_url=${stats.skipped_missing_url_count} reddit_errors=${stats.reddit_error_count}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`Scan job failed [${keywordSetId}]:`, msg);
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
              message: msg,
              reddit_auth_error: true,
              completed_at: new Date().toISOString(),
            }),
          ]
        );
      } else {
        await finishScanFailure(keywordSetId, msg);
      }
      throw err;
    }
  });
}

module.exports = {
  scanQueue,
  addScanJob,
  getManualScanJobState,
  manualScanJobId,
  rescheduleRepeatableScanForKeywordSet,
  initWorker,
  runScanPipeline,
};
