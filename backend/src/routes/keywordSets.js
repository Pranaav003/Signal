const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { addScanJob } = require('../jobs/scanJob');
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

    const lastScanned = keywordSet.last_scanned_at
      ? new Date(keywordSet.last_scanned_at)
      : null;

    let status;
    if (lastScanned) {
      status = 'complete';
    } else if (leadsFound > 0) {
      status = 'complete';
    } else {
      status = 'scanning';
    }

    console.log(`[scan-status] id=${id} status=${status} leads=${leadsFound}`);

    return res.json({
      id: keywordSet.id,
      status,
      last_scanned_at: keywordSet.last_scanned_at,
      leads_found: leadsFound,
      queries: keywordSet.queries || [],
      subreddits: keywordSet.subreddits || [],
      product_description: keywordSet.product_description,
      scan_interval_hours: keywordSet.scan_interval_hours,
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
  const { product_description } = req.body ?? {};

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
      return res.status(404).json({ error: 'Keyword set not found' });
    }

    const {
      queries,
      subreddits,
      reddit_fit = 'good',
      warning,
      suggestion,
    } = await generateQueries(desc);

    const { rows } = await pool.query(
      `UPDATE keyword_sets
       SET product_description = $2,
           queries = $3,
           subreddits = $4,
           reddit_fit = $5,
           fit_warning = $6,
           fit_suggestion = $7
       WHERE id = $1 AND active = true
       RETURNING *`,
      [req.params.id, desc, queries, subreddits, reddit_fit, warning, suggestion]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Keyword set not found' });
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
