const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const {
  addScanJob,
  getManualScanJobState,
  rescheduleRepeatableScanForKeywordSet,
} = require('../jobs/scanJob');
const { generateExamplePost } = require('../services/draftService');

const router = express.Router();

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
  const { user_id, product_description, scan_interval_hours, pitch_line } =
    req.body ?? {};

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
        message: 'You have reached the maximum number of monitors.',
      });
    }

    const {
      queries,
      subreddits,
      reddit_fit = 'good',
      warning,
      suggestion,
    } = await generateQueries(product_description);

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
          fit_suggestion
        )
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    return res.status(500).json({ error: 'Failed to create keyword set' });
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

const SCANNING_PROGRESS_PHASES = new Set([
  'active',
  'starting',
  'scanning',
  'reddit_global',
  'subreddit',
  'dedupe',
  'score',
  'persist',
  'finalize',
]);

function resolveScanStatus(keywordSet, _leadsFound, jobState) {
  const progress = keywordSet.scan_progress;
  const progressPhase = progress && progress.phase ? String(progress.phase) : null;

  let status;

  // Current scan in progress — must win over stale last_scanned_at from an older run.
  if (progressPhase === 'queued') {
    status = 'queued';
  } else if (SCANNING_PROGRESS_PHASES.has(progressPhase)) {
    status = 'scanning';
  } else if (jobState === 'active') {
    status = 'scanning';
  } else if (jobState === 'waiting' || jobState === 'delayed' || jobState === 'paused') {
    status = 'queued';
  } else if (progressPhase === 'error') {
    status = 'failed';
  } else if (progressPhase === 'complete') {
    status = 'complete';
  } else if (jobState === 'failed') {
    status = 'failed';
  } else if (keywordSet.last_scanned_at) {
    status = 'complete';
  } else if (jobState === 'completed') {
    status = 'unknown';
  } else {
    status = 'unknown';
  }

  let worker_hint = null;

  if (status === 'queued') {
    const queuedAt = progress?.queued_at ? new Date(progress.queued_at).getTime() : null;
    if (queuedAt && Date.now() - queuedAt > 60 * 1000) {
      worker_hint =
        'Scan is queued. Make sure the Bull worker is running: cd backend && npm run worker';
    } else {
      worker_hint = 'Scan is waiting in the queue for the worker.';
    }
  } else if (status === 'unknown' && !keywordSet.last_scanned_at) {
    worker_hint =
      'No completed scan yet. Check Redis (redis-cli ping) and run the worker (npm run worker).';
  } else if (status === 'failed' && progress?.message) {
    worker_hint = progress.message;
  }

  return { status, worker_hint };
}

router.get('/:id/scan-status', async (req, res) => {
  try {
    const { id } = req.params;

    const ksResult = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
      id,
    ]);

    if (!ksResult.rows.length) {
      return res.status(404).json({ error: 'keyword_set not found' });
    }

    const keywordSet = ksResult.rows[0];

    const leadsResult = await pool.query(
      'SELECT COUNT(*) as count FROM leads WHERE keyword_set_id = $1',
      [id]
    );
    const leadsFound = parseInt(leadsResult.rows[0].count, 10);

    const { state: jobState } = await getManualScanJobState(id);
    const { status, worker_hint } = resolveScanStatus(keywordSet, leadsFound, jobState);

    const progress = keywordSet.scan_progress;
    const queries = keywordSet.queries || [];
    const subreddits = keywordSet.subreddits || [];

    console.log(
      `[scan-status] id=${id} status=${status} job=${jobState || 'none'} leads=${leadsFound}`
    );

    const diagnostics = progress
      ? {
          collected_raw: progress.collected_raw ?? null,
          raw_global_count: progress.raw_global_count ?? null,
          raw_subreddit_count: progress.raw_subreddit_count ?? null,
          deduped_count: progress.deduped_count ?? null,
          scored_count: progress.scored_count ?? null,
          survivors_count: progress.survivors_count ?? null,
          inserted_count: progress.inserted_count ?? progress.leads_saved ?? null,
          duplicate_count: progress.duplicate_count ?? null,
          reddit_error_count: progress.reddit_error_count ?? null,
          reddit_auth_error: progress.reddit_auth_error ?? null,
          last_reddit_error: progress.last_reddit_error ?? null,
          threshold_used: progress.threshold_used ?? null,
          filtered_out_count: progress.filtered_out_count ?? null,
        }
      : null;

    return res.json({
      id: keywordSet.id,
      status,
      job_state: jobState,
      worker_hint,
      last_scanned_at: keywordSet.last_scanned_at,
      leads_found: leadsFound,
      queries,
      subreddits,
      live_queries: queries,
      live_subreddits: subreddits,
      product_description: keywordSet.product_description,
      scan_interval_hours: keywordSet.scan_interval_hours,
      scan_progress: progress || null,
      diagnostics,
    });
  } catch (err) {
    console.error('[scan-status] ERROR:', err);
    return res.status(500).json({ error: err.message });
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

    await pool.query(`UPDATE keyword_sets SET last_scanned_at = NULL WHERE id = $1`, [
      req.params.id,
    ]);
    await addScanJob(req.params.id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[keywordSets] POST /:id/rescan', err);
    return res.status(500).json({ error: 'Failed to queue scan' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM keyword_sets WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error('[keywordSets] GET /user/:userId', err);
    return res.status(500).json({ error: 'Failed to fetch keyword sets' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE keyword_sets SET active = false WHERE id = $1`,
      [req.params.id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[keywordSets] DELETE /:id', err);
    return res.status(500).json({ error: 'Failed to deactivate keyword set' });
  }
});

router.patch('/:id', async (req, res) => {
  const { product_description, scan_interval_hours, pitch_line } = req.body ?? {};

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
    const { rows: existingRows } = await pool.query(
      `SELECT * FROM keyword_sets WHERE id = $1 AND active = true`,
      [req.params.id]
    );

    if (!existingRows.length) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    const existing = existingRows[0];
    const prevDesc = String(existing.product_description || '').trim();
    const descChanged = desc !== prevDesc;

    let scanHours = Number(existing.scan_interval_hours) || 6;
    if (scan_interval_hours !== undefined && scan_interval_hours !== null) {
      const hours = parseInt(String(scan_interval_hours), 10);
      scanHours = [6, 12, 24].includes(hours) ? hours : 6;
    }

    let pitch = existing.pitch_line ?? null;
    if (pitch_line !== undefined) {
      if (pitch_line === null || pitch_line === '') {
        pitch = null;
      } else if (typeof pitch_line === 'string') {
        const t = pitch_line.trim();
        pitch = t ? t : null;
      }
    }

    let queries = existing.queries;
    let subreddits = existing.subreddits;
    let reddit_fit = existing.reddit_fit ?? 'good';
    let warning = existing.fit_warning ?? null;
    let suggestion = existing.fit_suggestion ?? null;

    if (descChanged) {
      const generated = await generateQueries(desc);
      queries = generated.queries;
      subreddits = generated.subreddits;
      reddit_fit = generated.reddit_fit ?? 'good';
      warning = generated.warning ?? null;
      suggestion = generated.suggestion ?? null;
    }

    const { rows } = await pool.query(
      `UPDATE keyword_sets
       SET product_description = $2,
           queries = $3,
           subreddits = $4,
           reddit_fit = $5,
           fit_warning = $6,
           fit_suggestion = $7,
           scan_interval_hours = $8,
           pitch_line = $9
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
        scanHours,
        pitch,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    try {
      await rescheduleRepeatableScanForKeywordSet(req.params.id);
    } catch (schedErr) {
      console.error('[keywordSets] reschedule repeat after PATCH', schedErr);
    }

    if (descChanged) {
      await addScanJob(rows[0].id);
    }

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
