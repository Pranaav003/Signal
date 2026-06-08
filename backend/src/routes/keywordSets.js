const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const {
  addScanJob,
  getManualScanJobState,
  rescheduleRepeatableScanForKeywordSet,
} = require('../jobs/scanJob');
const { getScanRunForStatus } = require('../services/scanRunService');
const { readWorkerHeartbeat, isHeartbeatFresh } = require('../services/workerHeartbeat');
const { generateExamplePost } = require('../services/draftService');
const { normalizeSearchFocus } = require('../utils/searchFocus');
const { deleteMonitorForUser } = require('../services/monitorLifecycle');

const router = express.Router();

router.post('/preview-plan', async (req, res) => {
  const description = req.body?.product_description ?? req.body?.description;

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'product_description is required' });
  }

  try {
    const searchFocus = req.body?.search_focus;
    const plan = await generateQueries(description.trim(), { search_focus: searchFocus });
    const brief = plan.search_brief || {};
    return res.json({
      rewritten_monitor: plan.rewritten_prompt || brief.rewritten_monitor || description.trim(),
      product_type: plan.product_type || brief.product_type || 'unknown',
      sides: plan.sides || brief.sides || [],
      primary_side: plan.primary_side || brief.primary_side || 'demand_side',
      primary_side_reason: plan.primary_side_reason || brief.primary_side_reason || null,
      search_focus: plan.search_focus || searchFocus || brief.search_focus || brief.primary_side,
      rewritten_prompt: plan.rewritten_prompt || brief.rewritten_monitor || description.trim(),
      lead_definition: brief.lead_definition || plan.lead_definition || null,
      customer_personas: brief.customer_personas || plan.target_customer || [],
      positive_lead_patterns: plan.positive_lead_patterns || brief.positive_lead_patterns || [],
      negative_lead_patterns: plan.negative_lead_patterns || brief.negative_lead_patterns || [],
      required_evidence: brief.required_evidence || plan.required_concepts || [],
      disqualifying_evidence: brief.disqualifying_evidence || plan.disqualifiers || [],
      acceptable_edge_cases: brief.acceptable_edge_cases || [],
      product_summary: plan.product_summary || null,
      target_customer: plan.target_customer || [],
      pain_points: plan.pain_points || [],
      queries: plan.queries || [],
      subreddits: plan.subreddits || [],
      negative_keywords: plan.negative_keywords || [],
      reddit_fit: plan.reddit_fit || 'good',
      warning: plan.warning || null,
      suggestion: plan.suggestion || null,
      planner_source: plan.planner_source || brief.planner_source || plan.source || 'mixed',
      planner_model: plan.planner_model || brief.planner_model || null,
      reasoning_summary: plan.reasoning_summary || null,
      search_brief: brief,
    });
  } catch (err) {
    console.error('[keywordSets] POST /preview-plan', err);
    return res.status(500).json({
      error: 'keyword_generation_failed',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Failed to generate search strategy.'
          : err.message,
    });
  }
});

router.post('/preview-example', async (req, res) => {
  const description = req.body?.description;

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }

  try {
    const result = await generateExamplePost({
      product_description: description.trim(),
    });

    if (!result) {
      return res.status(502).json({ error: 'Failed to generate preview' });
    }

    return res.json({ title: result.title, body: result.body });
  } catch (err) {
    console.error('[keywordSets] POST /preview-example', err);
    return res.status(500).json({ error: 'Failed to generate preview' });
  }
});

router.post('/', async (req, res) => {
  const {
    user_id,
    product_description,
    scan_interval_hours,
    pitch_line,
    search_focus: bodySearchFocus,
    searchFocus: bodySearchFocusCamel,
  } = req.body ?? {};

  if (!user_id || !product_description) {
    return res
      .status(400)
      .json({ error: 'user_id and product_description are required' });
  }

  const hours = parseInt(String(scan_interval_hours), 10);
  const scanHours = [6, 12, 24].includes(hours) ? hours : 6;

  const pitch =
    typeof pitch_line === 'string' && pitch_line.trim()
      ? pitch_line.trim()
      : null;

  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM keyword_sets WHERE user_id = $1 AND active = true`,
      [user_id]
    );

    const count = countRows[0]?.n ?? 0;
    if (count >= 3) {
      return res.status(403).json({
        error: 'monitor_limit_reached',
        message:
          'You have reached the maximum number of monitors. Delete one before creating another.',
      });
    }

    const requestedSearchFocus = bodySearchFocus || bodySearchFocusCamel;

    let plan;
    try {
      plan = await generateQueries(product_description, {
        search_focus: requestedSearchFocus,
      });
    } catch (genErr) {
      console.error('[keywordSets] POST / generateQueries failed', genErr);
      const isPlan = genErr?.code === 'invalid_search_plan';
      return res.status(isPlan ? 400 : 500).json({
        error: isPlan ? 'invalid_search_plan' : 'keyword_generation_failed',
        message:
          process.env.NODE_ENV === 'production' && !isPlan
            ? 'Failed to generate search strategy.'
            : genErr.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : genErr.stack,
      });
    }

    const {
      queries,
      subreddits,
      reddit_fit = 'good',
      warning,
      suggestion,
    } = plan;

    if (!Array.isArray(queries) || !queries.length || !Array.isArray(subreddits) || !subreddits.length) {
      return res.status(500).json({
        error: 'keyword_generation_failed',
        message: 'Search plan was empty after generation.',
      });
    }

    const searchFocus = normalizeSearchFocus(
      requestedSearchFocus,
      plan.search_focus || plan.primary_side || 'demand_side'
    );

    const searchBrief = {
      ...(plan.search_brief || {}),
      rewritten_prompt: plan.rewritten_prompt,
      queries,
      subreddits,
      search_focus: searchFocus,
      negative_keywords: plan.negative_keywords,
      required_concepts: plan.required_concepts,
      disqualifiers: plan.disqualifiers,
      positive_lead_patterns: plan.positive_lead_patterns,
      negative_lead_patterns: plan.negative_lead_patterns,
      target_customer: plan.target_customer,
      pain_points: plan.pain_points,
    };

    const { rows } = await pool.query(
      `INSERT INTO keyword_sets (
          id,
          user_id,
          product_description,
          pitch_line,
          queries,
          subreddits,
          scan_interval_hours,
          reddit_fit,
          fit_warning,
          fit_suggestion,
          search_brief,
          search_focus
        )
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        RETURNING *`,
      [
        user_id,
        product_description,
        pitch,
        queries,
        subreddits,
        scanHours,
        reddit_fit,
        warning,
        suggestion,
        JSON.stringify(searchBrief),
        searchFocus,
      ]
    );

    const newSet = rows[0];

    await addScanJob(newSet.id, newSet.user_id);

    return res.status(201).json({
      ...newSet,
      suggestion: newSet.fit_suggestion ?? null,
    });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    console.error('[keywordSets] POST /', err);
    return res.status(500).json({
      error: 'failed_to_create_keyword_set',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Failed to create keyword set'
          : err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    });
  }
});

/**
 * Hard-delete orphan duplicate monitors: same user, zero leads, duplicate description
 * of another monitor that already has leads (see Dashboard onScanComplete).
 */
router.delete('/duplicates', async (req, res) => {
  const { user_id } = req.body ?? {};

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const { rows } = await pool.query(
      `
      DELETE FROM keyword_sets
      WHERE user_id = $1
        AND id IN (
          SELECT ks.id
          FROM keyword_sets ks
          LEFT JOIN leads l ON l.keyword_set_id = ks.id
          GROUP BY ks.id
          HAVING COUNT(l.id) = 0
        )
        AND product_description IN (
          SELECT ks2.product_description
          FROM keyword_sets ks2
          JOIN leads l2 ON l2.keyword_set_id = ks2.id
          WHERE ks2.user_id = $1
          GROUP BY ks2.product_description
          HAVING COUNT(l2.id) > 0
        )
      RETURNING id
      `,
      [user_id]
    );

    return res.json({
      deleted: rows.map((r) => r.id),
    });
  } catch (err) {
    console.error('[keywordSets] DELETE /duplicates', err);
    return res.status(500).json({ error: 'Failed to purge duplicate monitors' });
  }
});

function parseJsonField(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

router.get('/:id/scan-status', async (req, res) => {
  try {
    const { id } = req.params;

    const ksResult = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [id]);

    if (!ksResult.rows.length) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    const keywordSet = ksResult.rows[0];

    if (keywordSet.active === false) {
      return res.status(404).json({
        error: 'keyword_set_not_found',
        inactive: true,
        message: 'This monitor no longer exists or is inactive.',
      });
    }

    const scanProgress = parseJsonField(keywordSet.scan_progress, {});
    const scanRun = await getScanRunForStatus(pool, keywordSet);
    const runStatusEarly = String(scanRun?.status || '').toLowerCase();
    const runDiagnostics = parseJsonField(scanRun?.diagnostics, {});
    const progressDiagnostics = parseJsonField(scanProgress.diagnostics, {});
    const { job, state: jobState, orphan_waiting, in_wait_queue, queue_name: manualQueueName } =
      await getManualScanJobState(id);

    const liveProgressFields = Object.fromEntries(
      Object.entries(scanProgress).filter(
        ([k]) =>
          !['phase', 'message', 'completed_at', 'queued_at', 'started_at', 'job_id'].includes(k)
      )
    );

    const diagnostics =
      runStatusEarly === 'complete' || runStatusEarly === 'failed'
        ? { ...runDiagnostics, scan_run_id: scanRun?.id || runDiagnostics.scan_run_id }
        : {
            ...runDiagnostics,
            ...progressDiagnostics,
            ...liveProgressFields,
          };

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
    const currentScanInsertedCount = insertedThisRun;

    const heartbeat = await readWorkerHeartbeat();
    const workerAlive = isHeartbeatFresh(heartbeat, 30);
    const workerState = workerAlive ? 'available' : 'missing';

    const queryCount = Array.isArray(keywordSet.queries) ? keywordSet.queries.length : 0;
    const subredditCount = Array.isArray(keywordSet.subreddits)
      ? keywordSet.subreddits.length
      : 0;

    const queuedAt = scanProgress.queued_at || scanProgress.started_at;
    const queuedForSeconds = queuedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 1000))
      : 0;

    const runStatus = String(scanRun?.status || '').toLowerCase();
    let status = 'idle';
    const progressPhase = String(scanProgress.phase || '').toLowerCase();
    let displayJobState = jobState;

    if (runStatus === 'complete') {
      status = 'complete';
      displayJobState = null;
    } else if (progressPhase === 'complete' && keywordSet.last_scanned_at) {
      status = 'complete';
      displayJobState = null;
    } else if (runStatus === 'failed') {
      const runError = String(scanRun?.error_message || scanProgress.message || '');
      const recoverableFailedScan =
        insertedThisRun > 0 &&
        (/Bull job is still active|diagnostics consistency/i.test(runError) ||
          progressPhase === 'complete');
      if (recoverableFailedScan) {
        status = 'complete';
        displayJobState = null;
      } else {
        status = 'failed';
        displayJobState = job ? 'failed' : null;
      }
    } else if (progressPhase === 'error') {
      status = 'failed';
    } else if (orphan_waiting) {
      status = 'stuck';
    } else if (!job && progressPhase === 'queued' && !keywordSet.last_scanned_at && queuedForSeconds >= 90) {
      status = 'stuck';
    } else if (
      ['collecting', 'scoring', 'qualifying', 'saving', 'persist', 'qualify', 'reddit_global', 'subreddit', 'active'].includes(
        progressPhase
      ) ||
      runStatus === 'running'
    ) {
      status = 'scanning';
      if (jobState === 'active') displayJobState = 'active';
    } else if (jobState === 'active' && runStatus !== 'complete') {
      status = 'scanning';
    } else if (
      ['waiting', 'delayed', 'paused'].includes(jobState || '') ||
      progressPhase === 'queued'
    ) {
      const stuckNoWorker = !workerAlive && queuedForSeconds >= 30;
      const stuckLongWait =
        (jobState === 'waiting' || jobState === 'delayed') && queuedForSeconds >= 180;
      status = stuckNoWorker || stuckLongWait ? 'stuck' : 'queued';
    } else if (runStatus === 'queued' || progressPhase === 'queued') {
      const stuckNoWorker = !workerAlive && queuedForSeconds >= 30;
      const stuckLongWait =
        (jobState === 'waiting' || jobState === 'delayed') && queuedForSeconds >= 180;
      status = stuckNoWorker || stuckLongWait || orphan_waiting ? 'stuck' : 'queued';
    } else if (progressPhase === 'complete' && runStatus === 'complete') {
      status = 'complete';
    } else if (keywordSet.last_scanned_at && runStatus !== 'running' && runStatus !== 'queued') {
      status = 'complete';
      displayJobState = null;
    }

    if (
      progressPhase === 'queued' &&
      runStatus !== 'complete' &&
      (jobState === null || jobState === 'unknown') &&
      queuedForSeconds >= 120 &&
      !keywordSet.last_scanned_at
    ) {
      status = 'stuck';
    }

    let workerHint = null;
    const isProduction = process.env.NODE_ENV === 'production';
    const localWorkerStartHint =
      'Start it with: cd backend && npm run worker (or npm run dev from the repo root).';
    const prodWorkerStartHint =
      'Check signal-worker-web on Render (GET /health). Free tier sleeps when idle — keep it awake with UptimeRobot every 5 minutes.';

    if (orphan_waiting) {
      workerHint = isProduction
        ? 'Scan is queued but the job is missing from the worker queue. Click Retry scan, or redeploy signal-worker-web on Render.'
        : 'Scan is queued but the job is not in the worker queue (orphan). Click Rescan on this monitor, or restart the backend worker.';
    } else if (status === 'stuck' && !workerAlive) {
      workerHint = isProduction ? prodWorkerStartHint : localWorkerStartHint;
    } else if (status === 'stuck') {
      workerHint = isProduction
        ? 'Scan is queued but not progressing. Try Retry scan or check signal-worker-web logs on Render.'
        : 'Scan is queued but not progressing. Try Retry scan or check GET /api/debug/scan-queue.';
    } else if (!job && !keywordSet.last_scanned_at && progressPhase !== 'complete') {
      workerHint = isProduction ? prodWorkerStartHint : localWorkerStartHint;
    } else if (status === 'queued') {
      workerHint = workerAlive
        ? 'Scan is queued — worker is running and will pick this up soon.'
        : isProduction
          ? prodWorkerStartHint
          : localWorkerStartHint;
    } else if (jobState === 'active') {
      workerHint = 'Worker is running this scan.';
    } else if (
      status === 'failed' &&
      (scanProgress.reddit_auth_error ||
        /reddit blocked|network security|REDDIT_BLOCKED/i.test(
          String(scanRun?.error_message || scanProgress.message || '')
        ))
    ) {
      workerHint = isProduction
        ? 'Reddit blocked requests from signal-worker-web. Check PROXY_LIST / PROXY_USERNAME / PROXY_PASSWORD on Render, or replace blocked Webshare IPs.'
        : 'Reddit blocked this request. Set PROXY_LIST and proxy credentials in backend/.env, then restart the worker.';
    }

    const plannerSource =
      diagnostics.planner_source || scanProgress.planner_source || null;
    const classifierSource =
      diagnostics.classifier_source || scanProgress.classifier_source || null;

    const scanProgressOut = {
      ...scanProgress,
      ...diagnostics,
      inserted_count: insertedThisRun,
      leads_saved: insertedThisRun,
      leads_found: leadsFound,
      planner_source: plannerSource,
      classifier_source: classifierSource,
      diagnostic_summary:
        scanProgress.diagnostic_summary ||
        diagnostics.diagnostic_summary ||
        null,
    };

    const classifierWarning =
      plannerSource === 'ai' && classifierSource === 'fallback'
        ? `AI classifier failed; fallback qualification used. ${diagnostics.classifier_error || ''}`.trim()
        : null;

    return res.json({
      id: keywordSet.id,
      status,
      job_state: displayJobState,
      job_in_wait_list: in_wait_queue,
      job_orphan_waiting: orphan_waiting,
      worker_state: workerState,
      manual_scan_queue: manualQueueName,
      in_manual_wait_queue: Boolean(in_wait_queue),
      orphan_job: Boolean(orphan_waiting),
      job_id: job?.id || scanProgress.job_id || null,
      scan_run_id: scanRun?.id || keywordSet.current_scan_run_id || null,
      started_at: scanProgress.started_at || scanRun?.started_at || null,
      queued_for_seconds: queuedForSeconds,
      last_scanned_at: keywordSet.last_scanned_at,
      leads_found: leadsFound,
      current_scan_inserted_count: currentScanInsertedCount,
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

/** Queue an immediate rescan (clears `last_scanned_at` so the UI can show progress again). */
router.post('/:id/rescan', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM keyword_sets WHERE id = $1 AND (active IS NULL OR active = true)`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Monitor not found' });
    }

    const { rows: ksRows } = await pool.query(
      `SELECT id, user_id FROM keyword_sets WHERE id = $1`,
      [req.params.id]
    );
    if (ksRows[0]) {
      const { deactivateStaleLeads } = require('../services/scanRunService');
      await deactivateStaleLeads(pool, ksRows[0].id, ksRows[0].user_id);
    }

    await pool.query(`UPDATE keyword_sets SET last_scanned_at = NULL WHERE id = $1`, [
      req.params.id,
    ]);
    await addScanJob(req.params.id, ksRows[0]?.user_id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[keywordSets] POST /:id/rescan', err);
    return res.status(500).json({ error: 'Failed to queue scan' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM keyword_sets
       WHERE user_id = $1
         AND COALESCE(active, true) = true
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [req.params.userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error('[keywordSets] GET /user/:userId', err);
    return res.status(500).json({ error: 'Failed to fetch keyword sets' });
  }
});

router.delete('/:id', async (req, res) => {
  const userId = req.query?.user_id || req.body?.user_id;
  if (!userId) {
    return res.status(400).json({
      error: 'user_id_required',
      message: 'Pass user_id as a query parameter when deleting a monitor.',
    });
  }

  try {
    const result = await deleteMonitorForUser(req.params.id, userId);
    if (!result.ok) {
      return res.status(404).json({
        error: 'keyword_set_not_found',
        message: 'Monitor not found or already deleted.',
      });
    }
    return res.json({
      success: true,
      deleted_monitor_id: result.deleted_monitor_id,
      hidden_leads_count: result.hidden_leads_count,
      cancelled_scan_runs_count: result.cancelled_scan_runs_count,
      jobs_removed: result.jobs_removed,
    });
  } catch (err) {
    console.error('[keywordSets] DELETE /:id', err);
    return res.status(500).json({
      error: 'Failed to deactivate keyword set',
      message:
        process.env.NODE_ENV === 'production' ? 'Failed to delete monitor.' : err.message,
    });
  }
});

router.patch('/:id', async (req, res) => {
  const { product_description, search_focus } = req.body ?? {};

  if (!product_description || typeof product_description !== 'string') {
    return res.status(400).json({ error: 'product_description is required' });
  }

  const desc = product_description.trim();

  if (!desc) {
    return res.status(400).json({ error: 'product_description cannot be empty' });
  }

  if (desc.length > 240) {
    return res.status(400).json({ error: 'product_description must be 240 characters or less' });
  }

  try {
    const { rows: found } = await pool.query(
      `SELECT id FROM keyword_sets WHERE id = $1 AND active = true`,
      [req.params.id]
    );

    if (!found.length) {
      return res.status(404).json({
        error: 'keyword_set_not_found',
        message: 'This monitor no longer exists or is inactive.',
      });
    }

    let plan;
    try {
      plan = await generateQueries(desc, { search_focus });
    } catch (genErr) {
      console.error('[keywordSets] PATCH generateQueries failed', genErr);
      return res.status(500).json({
        error: 'keyword_generation_failed',
        message:
          process.env.NODE_ENV === 'production'
            ? 'Failed to generate search strategy.'
            : genErr.message,
      });
    }

    const { queries, subreddits, reddit_fit = 'good', warning, suggestion } = plan;
    const searchFocus = normalizeSearchFocus(
      search_focus,
      plan.search_focus || plan.primary_side || 'demand_side'
    );
    const searchBrief = {
      ...(plan.search_brief || {}),
      search_focus: searchFocus,
    };

    const { rows } = await pool.query(
      `UPDATE keyword_sets
       SET product_description = $2,
           queries = $3,
           subreddits = $4,
           reddit_fit = $5,
           fit_warning = $6,
           fit_suggestion = $7,
           search_brief = $8::jsonb,
           search_focus = $9
       WHERE id = $1 AND active = true
       RETURNING *`,
      [
        req.params.id,
        desc,
        queries,
        subreddits,
        reddit_fit,
        warning,
        suggestion,
        JSON.stringify(searchBrief),
        searchFocus,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: 'keyword_set_not_found',
        message: 'This monitor no longer exists or is inactive.',
      });
    }

    await addScanJob(rows[0].id, rows[0].user_id);

    return res.json({
      ...rows[0],
      suggestion: rows[0].fit_suggestion ?? null,
    });
  } catch (err) {
    console.error('[keywordSets] PATCH /:id', err);
    return res.status(500).json({ error: 'Failed to update keyword set' });
  }
});

module.exports = router;
