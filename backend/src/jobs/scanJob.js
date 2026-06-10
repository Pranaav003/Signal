const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
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
const {
  createBullQueue,
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
  REDIS_URL,
  redactRedisUrl,
  getRedisDbIndex,
} = require('./queueFactory');
const { isWorkerAlive } = require('../services/workerHeartbeat');
const { sanitizeRedditMessage } = require('../services/redditService');

const scanQueue = createBullQueue(SCAN_QUEUE_NAME);
const manualScanQueue = createBullQueue(MANUAL_SCAN_QUEUE_NAME);

const MANUAL_JOB_PRIORITY = 1;
const REPEAT_JOB_PRIORITY = 10;
const STALE_WAITING_MS = 2 * 60 * 1000;

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

async function isJobInWaitList(queue, jobId) {
  try {
    const waiting = await queue.getWaiting(0, 200);
    return waiting.some((j) => String(j.id) === String(jobId));
  } catch {
    return false;
  }
}

async function getManualScanJobState(keywordSetId) {
  const jobId = manualScanJobId(keywordSetId);
  try {
    const job = await manualScanQueue.getJob(jobId);
    if (!job) return { job: null, state: null, in_wait_queue: false, queue_name: MANUAL_SCAN_QUEUE_NAME };
    const state = await job.getState();
    const inWait =
      state === 'waiting' ? await isJobInWaitList(manualScanQueue, jobId) : false;
    return {
      job,
      state,
      in_wait_queue: inWait,
      queue_name: MANUAL_SCAN_QUEUE_NAME,
      orphan_waiting: state === 'waiting' && !inWait,
    };
  } catch (err) {
    return {
      job: null,
      state: null,
      in_wait_queue: false,
      orphan_waiting: false,
      queue_name: MANUAL_SCAN_QUEUE_NAME,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function jobAgeMs(job) {
  const ts = job?.timestamp || job?.processedOn;
  if (!ts) return 0;
  return Date.now() - Number(ts);
}

async function resolveManualScanJob(jobId) {
  try {
    try {
      const legacy = await scanQueue.getJob(jobId);
      if (legacy) {
        console.warn(`[scan] removing legacy manual job from ${SCAN_QUEUE_NAME} id=${jobId}`);
        await legacy.remove();
      }
    } catch (_e) {
      /* ignore */
    }

    const existing = await manualScanQueue.getJob(jobId);
    if (!existing) return null;

    const state = await existing.getState();
    const ageMs = jobAgeMs(existing);
    const alive = await isWorkerAlive(30);

    if (state === 'active') {
      return existing;
    }

    if (['waiting', 'delayed', 'paused'].includes(state)) {
      if (alive && ageMs < STALE_WAITING_MS) {
        return existing;
      }
      console.warn(
        `[scan] removing stale manual job ${jobId} state=${state} ageMs=${ageMs} workerAlive=${alive}`
      );
      try {
        await existing.remove();
      } catch (_e) {
        /* ignore */
      }
      return null;
    }

    try {
      await existing.remove();
    } catch (_e) {
      /* completed/failed cleanup */
    }
    return null;
  } catch (err) {
    console.warn('[scan] could not inspect existing job:', err && err.message ? err.message : err);
    return null;
  }
}

async function addScanJob(keywordSetId, userId) {
  const jobId = manualScanJobId(keywordSetId);

  await resolveManualScanJob(jobId);

  const { rows: ksRows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
    keywordSetId,
  ]);
  let prepared = ksRows[0] || null;
  let scanRunId = null;
  if (prepared) {
    const { prepareKeywordSetForScan } = require('../services/scanPipeline');
    prepared = await prepareKeywordSetForScan(pool, prepared);
    await deactivateStaleLeads(pool, keywordSetId, prepared.user_id);
    const brief = prepared.search_brief || {};
    const scanRun = await createScanRun(pool, prepared, brief, 'queued');
    scanRunId = scanRun.id;
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
        scan_run_id: scanRunId,
      }),
    ]
  );

  const job = await manualScanQueue.add(
    { keywordSetId, userId: userId || null, manual: true, scanRunId },
    {
      ...SCAN_QUEUE_JOB_OPTS,
      jobId,
      priority: MANUAL_JOB_PRIORITY,
      removeOnComplete: true,
      removeOnFail: Number(process.env.REDIS_FAILED_JOBS_TO_KEEP) || 5,
    }
  );

  const state = await job.getState();
  const inQueue = await isJobInWaitList(manualScanQueue, jobId);
  console.log(
    `[scan] queued manual job redis=${redactRedisUrl(REDIS_URL)} db=${getRedisDbIndex()} queue=${MANUAL_SCAN_QUEUE_NAME} prefix=${manualScanQueue.opts?.prefix || 'bull'} jobId=${jobId} keywordSetId=${keywordSetId} userId=${userId || 'n/a'} scanRunId=${scanRunId || 'n/a'} state=${state} inWaitList=${inQueue}`
  );

  if (state === 'waiting' && !inQueue) {
    console.warn(`[scan] orphan waiting job ${jobId} — removing and re-adding`);
    try {
      await job.remove();
    } catch (_e) {
      /* ignore */
    }
    return manualScanQueue.add(
      { keywordSetId, userId: userId || null, manual: true, scanRunId },
      {
        ...SCAN_QUEUE_JOB_OPTS,
        jobId,
        priority: MANUAL_JOB_PRIORITY,
        removeOnComplete: true,
        removeOnFail: Number(process.env.REDIS_FAILED_JOBS_TO_KEEP) || 5,
      }
    );
  }

  return job;
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
    { keywordSetId: ks.id, userId: ks.user_id, manual: false },
    {
      repeat: { every },
      jobId: jobIdStr,
      priority: REPEAT_JOB_PRIORITY,
      removeOnComplete: true,
      removeOnFail: Number(process.env.REDIS_FAILED_JOBS_TO_KEEP) || 5,
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

async function processScanJob(job) {
    const { keywordSetId, userId, scanRunId: queuedScanRunId } = job.data || {};
    console.log(
      `[scan] active job id=${job.id} queue=${job.queue?.name || MANUAL_SCAN_QUEUE_NAME} keywordSetId=${keywordSetId} userId=${userId || 'n/a'} scanRunId=${queuedScanRunId || 'n/a'} priority=${job.opts?.priority ?? 'default'}`
    );

    const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
      keywordSetId,
    ]);

    let keywordSet = rows[0];

    if (!keywordSet) {
      console.warn(`[scan] skip missing keywordSetId=${keywordSetId}`);
      return;
    }

    if (keywordSet.active === false) {
      const skippedScanRunId = queuedScanRunId || keywordSet.current_scan_run_id || null;
      console.warn(
        `[scan] skip inactive monitor keywordSetId=${keywordSetId} scanRunId=${skippedScanRunId || 'n/a'}`
      );
      if (skippedScanRunId) {
        try {
          await finishScanRun(
            pool,
            skippedScanRunId,
            'cancelled',
            {},
            'Monitor deleted or inactive'
          );
        } catch (finishErr) {
          console.warn(
            `[scan] could not cancel scan run for inactive monitor keywordSetId=${keywordSetId}:`,
            finishErr?.message || finishErr
          );
        }
      }
      return;
    }

    let scanRunId = queuedScanRunId || null;
    let stats = null;
    try {
      const workerStartedAt = new Date().toISOString();
      const prepared = await require('../services/scanPipeline').prepareKeywordSetForScan(
        pool,
        keywordSet
      );
      const brief = prepared.search_brief || {};
      if (scanRunId) {
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
      } else {
        await deactivateStaleLeads(pool, keywordSetId, keywordSet.user_id);
        const scanRun = await createScanRun(pool, prepared, brief);
        scanRunId = scanRun.id;
      }
      keywordSet = prepared;

      await setScanProgress(keywordSetId, {
        phase: 'active',
        message: 'Scan worker started…',
        started_at: workerStartedAt,
        job_id: manualScanJobId(keywordSetId),
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

      try {
        const finishedJob = await manualScanQueue.getJob(manualScanJobId(keywordSetId));
        if (finishedJob) await finishedJob.remove();
      } catch (cleanupErr) {
        console.warn(
          `[scan] manual job cleanup skipped keywordSetId=${keywordSetId}:`,
          cleanupErr?.message || cleanupErr
        );
      }

      console.log(
        `[scan] complete keywordSetId=${keywordSetId} raw=${stats.collected_raw} deduped=${stats.deduped_count} scored=${stats.scored_count} survivors=${stats.survivors_count} attempted=${stats.attempted_inserts} inserted=${stats.inserted_count} duplicates=${stats.duplicate_count} skipped_url=${stats.skipped_missing_url_count} reddit_errors=${stats.reddit_error_count}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);

      const benignAfterInsert =
        stats?.inserted_count > 0 &&
        /Bull job is still active|diagnostics consistency/i.test(msg);
      if (benignAfterInsert && scanRunId) {
        try {
          await syncInsertedCountFromDb(pool, stats);
          const recovered = buildCompleteProgress(stats);
          await finishScanRun(pool, scanRunId, 'complete', recovered.diagnostics || stats);
          await finishScanSuccess(keywordSetId, recovered);
          console.warn(
            `[scan] recovered complete after error keywordSetId=${keywordSetId} inserted=${stats.inserted_count} err=${msg}`
          );
          try {
            const finishedJob = await manualScanQueue.getJob(manualScanJobId(keywordSetId));
            if (finishedJob) await finishedJob.remove();
          } catch (_e) {
            /* ignore */
          }
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

function initWorker() {
  if (workerStarted) {
    console.warn('[scan] initWorker already registered — skipping duplicate processor');
    return;
  }
  workerStarted = true;
  attachQueueEventLogging();

  const concurrency = Number(process.env.SCAN_WORKER_CONCURRENCY) > 0
    ? Number(process.env.SCAN_WORKER_CONCURRENCY)
    : 1;

  manualScanQueue.process(concurrency, processScanJob);
  scanQueue.process(concurrency, processScanJob);

  manualScanQueue.on('active', (job) => {
    console.log(`[scan-manual] active id=${job?.id} keywordSetId=${job?.data?.keywordSetId || '?'}`);
  });
  manualScanQueue.on('failed', (job, err) => {
    console.error(
      `[scan-manual] failed id=${job?.id}:`,
      err && err.message ? err.message : err
    );
  });

  console.log(
    `[scan] worker ready — manual="${MANUAL_SCAN_QUEUE_NAME}" scheduled="${SCAN_QUEUE_NAME}" redis=${redactRedisUrl(REDIS_URL)} concurrency=${concurrency}`
  );
}

async function snapshotOneQueue(queue, name) {
  const counts = await queue.getJobCounts();
  const [waiting, active, delayed, failed] = await Promise.all([
    queue.getWaiting(0, 15),
    queue.getActive(0, 10),
    queue.getDelayed(0, 10),
    queue.getFailed(0, 10),
  ]);

  const summarize = async (jobs) => {
    const out = [];
    for (const job of jobs) {
      out.push({
        id: job.id,
        keywordSetId: job.data?.keywordSetId ?? null,
        manual: Boolean(job.data?.manual),
        priority: job.opts?.priority ?? null,
        state: await job.getState().catch(() => 'unknown'),
        age_ms: jobAgeMs(job),
      });
    }
    return out;
  };

  return {
    name,
    prefix: queue.opts?.prefix || 'bull',
    counts,
    waiting: await summarize(waiting),
    active: await summarize(active),
    delayed: await summarize(delayed),
    failed: await summarize(failed),
  };
}

async function getScanQueueSnapshot() {
  const scheduled = await snapshotOneQueue(scanQueue, SCAN_QUEUE_NAME);
  const manual = await snapshotOneQueue(manualScanQueue, MANUAL_SCAN_QUEUE_NAME);
  return { scheduled, manual };
}

module.exports = {
  scanQueue,
  manualScanQueue,
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
  REDIS_URL,
  addScanJob,
  getManualScanJobState,
  manualScanJobId,
  resolveManualScanJob,
  rescheduleRepeatableScanForKeywordSet,
  initWorker,
  runScanPipeline,
  getScanQueueSnapshot,
};
