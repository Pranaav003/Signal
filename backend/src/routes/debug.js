const express = require('express');

const { generateQueries } = require('../services/keywordProcessor');
const { activeScans, MAX_CONCURRENT_SCANS, isSchedulerStopped } = require('../jobs/scanRunner');

const pool = require('../db/connection');

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
 * Scheduler + scan status for dev — replaces the old Redis/Bull scan-queue endpoint.
 */
router.get('/scan-queue', async (req, res) => {
  try {
    // Active in-process scans
    const active = [...activeScans];

    // Recent scan_runs from DB
    const { rows: recentRuns } = await pool.query(
      `SELECT id, keyword_set_id, status, started_at, completed_at, error_message
       FROM scan_runs
       ORDER BY created_at DESC
       LIMIT 20`
    );

    // Due monitors (next_scan_at <= now)
    const { rows: dueMonitors } = await pool.query(
      `SELECT id, product_description, next_scan_at, scan_interval_hours
       FROM keyword_sets
       WHERE active = true AND next_scan_at <= NOW()
       ORDER BY next_scan_at ASC
       LIMIT 10`
    );

    // Counts by status
    const { rows: statusCounts } = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM scan_runs
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY status`
    );

    const countsByStatus = {};
    for (const row of statusCounts) {
      countsByStatus[row.status] = row.count;
    }

    return res.json({
      scheduler: {
        running: !isSchedulerStopped(),
        active_scans: active,
        max_concurrent_scans: MAX_CONCURRENT_SCANS,
      },
      due_monitors: dueMonitors,
      recent_scan_runs: recentRuns,
      last_24h_counts: countsByStatus,
    });
  } catch (err) {
    console.error('[debug] GET /scan-queue', err);
    return res.status(500).json({
      error: err && err.message ? err.message : 'Failed to read scan status',
    });
  }
});

router.delete('/purge-deleted-monitors', async (req, res) => {
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
