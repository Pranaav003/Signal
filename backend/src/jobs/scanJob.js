/**
 * scanJob.js — Core scan processing logic.
 *
 * Exports only the business functions; all Bull/Redis queue mechanics
 * have been removed.  Concurrency, timeout, and scheduling are handled
 * by scanRunner.js and scheduler.js.
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
const { isSchedulerStopped, activeScans } = require('./scanRunner');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setScanProgress(keywordSetId, payload) {
  try {
    await pool.query(
      `UPDATE keyword_sets SET scan_progress = $2::jsonb WHERE id = $1`,
      [keywordSetId, JSON.stringify(payload)]
    );
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

// ---------------------------------------------------------------------------
// processScanJob — core scan pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the full scan pipeline for a keyword set.
 *
 * @param {string|number} keywordSetId
 * @param {string|number|null} userId
 */
async function processScanJob(keywordSetId, userId) {
  console.log(`[scan] processScanJob keywordSetId=${keywordSetId} userId=${userId || 'n/a'}`);

  const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [keywordSetId]);

  let keywordSet = rows[0];

  if (!keywordSet) {
    console.warn(`[scan] skip missing keywordSetId=${keywordSetId}`);
    return;
  }

  if (keywordSet.active === false) {
    const skippedScanRunId = keywordSet.current_scan_run_id || null;
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
      `[scan] complete keywordSetId=${keywordSetId} raw=${stats.collected_raw} deduped=${stats.deduped_count} scored=${stats.scored_count} survivors=${stats.survivors_count} attempted=${stats.attempted_inserts} inserted=${stats.inserted_count} duplicates=${stats.duplicate_count} skipped_url=${stats.skipped_missing_url_count} reddit_errors=${stats.reddit_error_count}`
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
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

// ---------------------------------------------------------------------------
// addScanJob — prepare + dispatch
// ---------------------------------------------------------------------------

/**
 * Prepare a scan in the database and hand it to scanRunner.
 *
 * @param {string|number} keywordSetId
 * @param {string|number|null} userId
 */
async function addScanJob(keywordSetId, userId) {
  if (isSchedulerStopped()) {
    console.warn(`[scan] addScanJob skipped — scheduler stopped`);
    return;
  }
  if (activeScans.has(keywordSetId)) {
    console.warn(`[scan] addScanJob skipped — scan already running for keywordSetId=${keywordSetId}`);
    return;
  }

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
        scan_run_id: scanRunId,
      }),
    ]
  );

  console.log(
    `[scan] addScanJob keywordSetId=${keywordSetId} userId=${userId || 'n/a'} scanRunId=${scanRunId || 'n/a'}`
  );

  const { runScanInBackground } = require('./scanRunner');
  await runScanInBackground(keywordSetId, userId);
}

// ---------------------------------------------------------------------------
// rescheduleRepeatableScanForKeywordSet — DB-based reschedule
// ---------------------------------------------------------------------------

/**
 * Update next_scan_at in the database so the polling scheduler picks
 * up this keyword set on its next cycle.
 *
 * @param {string|number} keywordSetId
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

  await pool.query(
    `UPDATE keyword_sets
     SET next_scan_at = NOW() + ($2 * INTERVAL '1 hour')
     WHERE id = $1`,
    [keywordSetId, hours]
  );

  console.log(
    `[scan] rescheduled keywordSetId=${keywordSetId} interval=${hours}h`
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  processScanJob,
  addScanJob,
  rescheduleRepeatableScanForKeywordSet,
};
