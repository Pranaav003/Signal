const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { addScanJob } = require('../jobs/scanJob');
const { getScanRunForStatus } = require('../services/scanRunService');
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

    const scanProgress = parseJsonField(keywordSet.scan_progress, {});
    const scanRun = await getScanRunForStatus(pool, keywordSet);

    // Derive status purely from scan_runs + scan_progress — no Bull, no worker heartbeat
    const runStatus = String(scanRun?.status || '').toLowerCase();
    const progressPhase = String(scanProgress.phase || '').toLowerCase();
    const runDiagnostics = parseJsonField(scanRun?.diagnostics, {});

    // Merge diagnostics: completed/failed runs use DB diagnostics; running uses live progress
    const diagnostics =
      runStatus === 'complete' || runStatus === 'failed'
        ? { ...runDiagnostics, scan_run_id: scanRun?.id || runDiagnostics.scan_run_id }
        : { ...runDiagnostics, ...parseJsonField(scanProgress.diagnostics, {}) };

    // Authoritative lead count from DB
    let insertedThisRun = Number(diagnostics.inserted_count ?? 0);
    if (scanRun?.id) {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM leads WHERE scan_run_id = $1 AND COALESCE(is_active, true) = true`,
        [scanRun.id]
      );
      const dbCount = countRows[0]?.c;
      if (Number.isFinite(dbCount)) insertedThisRun = dbCount;
    }

    // Monitor-level lead counts
    const { rows: activeRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM leads WHERE keyword_set_id = $1 AND user_id = $2 AND COALESCE(is_active, true) = true`,
      [id, keywordSet.user_id]
    );
    const activeMonitorLeadCount = activeRows[0]?.c ?? 0;

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM leads WHERE keyword_set_id = $1 AND user_id = $2`,
      [id, keywordSet.user_id]
    );
    const totalMonitorLeadCount = totalRows[0]?.c ?? 0;

    const queryCount = Array.isArray(keywordSet.queries) ? keywordSet.queries.length : 0;
    const subredditCount = Array.isArray(keywordSet.subreddits) ? keywordSet.subreddits.length : 0;

    const queuedAt = scanProgress.queued_at || scanProgress.started_at;
    const queuedForSeconds = queuedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 1000))
      : 0;

    // Determine scan status from scan_runs only
    let status = 'idle';

    if (runStatus === 'complete') {
      status = 'complete';
    } else if (runStatus === 'failed') {
      // If the run failed but we still inserted leads, treat as complete
      const runError = String(scanRun?.error_message || '');
      if (insertedThisRun > 0 && /diagnostics consistency/i.test(runError)) {
        status = 'complete';
      } else {
        status = 'failed';
      }
    } else if (runStatus === 'running') {
      status = 'scanning';
    } else if (runStatus === 'queued') {
      // Stuck detection: queued for >5 min with no progress
      status = queuedForSeconds >= 300 ? 'stuck' : 'queued';
    } else if (['collecting', 'scoring', 'qualifying', 'saving', 'persist', 'qualify', 'reddit_global', 'subreddit', 'active'].includes(progressPhase)) {
      status = 'scanning';
    } else if (progressPhase === 'complete' && keywordSet.last_scanned_at) {
      status = 'complete';
    } else if (progressPhase === 'error') {
      status = 'failed';
    } else if (progressPhase === 'queued') {
      status = queuedForSeconds >= 300 ? 'stuck' : 'queued';
    } else if (keywordSet.last_scanned_at) {
      status = 'complete';
    }

    // Worker hint — simplified for single-process architecture
    let workerHint = null;
    if (status === 'failed' && /reddit blocked|network security|REDDIT_BLOCKED/i.test(String(scanRun?.error_message || ''))) {
      workerHint = 'Reddit blocked this request. Check PROXY_LIST and proxy credentials, then retry.';
    } else if (status === 'stuck') {
      workerHint = 'Scan appears stuck. Click Retry scan to re-queue it.';
    } else if (status === 'queued') {
      workerHint = 'Scan is queued and will start shortly.';
    }

    const plannerSource = diagnostics.planner_source || scanProgress.planner_source || null;
    const classifierSource = diagnostics.classifier_source || scanProgress.classifier_source || null;

    const scanProgressOut = {
      ...scanProgress,
      ...diagnostics,
      inserted_count: insertedThisRun,
      leads_saved: insertedThisRun,
      leads_found: insertedThisRun,
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
      scan_run_id: scanRun?.id || keywordSet.current_scan_run_id || null,
      started_at: scanProgress.started_at || scanRun?.started_at || null,
      queued_for_seconds: queuedForSeconds,
      last_scanned_at: keywordSet.last_scanned_at,
      leads_found: insertedThisRun,
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
