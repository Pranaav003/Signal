const express = require('express');

const pool = require('../db/connection');
const { generateDraft } = require('../services/draftService');
const { scoreResultDetailed } = require('../services/relevanceScorer');

const router = express.Router();

router.get('/user/:userId', async (req, res) => {
  const { seen, sort, limit } = req.query ?? {};

  console.log('[leads] fetching for userId:', req.params.userId);
  console.log('[leads] query params:', req.query);

  const limitNum = Math.min(
    Math.max(parseInt(limit != null ? String(limit) : '500', 10) || 500, 1),
    500
  );

  /** Whitelist ORDER BY fragments only — default aligns with Reddit score UX */
  const orderClause =
    sort === 'created' ? `l.created_at DESC` : `l.relevance_score DESC`;

  const params = [req.params.userId];
  const parts = [
    'l.user_id = $1',
    `NOT EXISTS (
      SELECT 1 FROM thread_suppressions ts
      WHERE ts.user_id = l.user_id
        AND ts.post_id = l.post_id
        AND (
          ts.kind = 'mute'
          OR (ts.kind = 'snooze' AND ts.snooze_until > NOW())
        )
    )`,
  ];

  if (seen === 'false') {
    parts.push('l.seen = false');
  } else if (seen === 'true') {
    parts.push('l.seen = true');
  }

  params.push(limitNum);
  const limitIdx = params.length;

  const whereClause = parts.join(' AND ');

  try {
    const result = await pool.query(
      `
      SELECT l.*, ks.product_description AS monitor_name
      FROM leads l
      JOIN keyword_sets ks ON l.keyword_set_id = ks.id
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT $${limitIdx}
      `,
      params
    );

    console.log('[leads] returning', result.rows.length, 'leads');

    return res.json({ leads: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('[leads] GET /user/:userId', err);
    if (err && err.code === '42P01') {
      return res.status(503).json({
        error:
          'Database schema mismatch. Run migrations from the backend folder: node src/db/migrate.js',
      });
    }
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

router.get('/:id/why', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'user_id query param is required' });
  }

  try {
    const leadResult = await pool.query(
      `SELECT l.*, ks.product_description, ks.queries, ks.subreddits
       FROM leads l
       JOIN keyword_sets ks ON l.keyword_set_id = ks.id
       WHERE l.id = $1 AND l.user_id = $2`,
      [req.params.id, userId]
    );

    const row = leadResult.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const stored = row.score_reasons;
    if (Array.isArray(stored) && stored.length > 0) {
      return res.json({
        score: Number(row.relevance_score) || 0,
        reasons: stored,
      });
    }

    const keywordSet = {
      product_description: row.product_description,
      queries: row.queries,
      subreddits: row.subreddits,
    };

    const { score, reasons } = scoreResultDetailed(
      {
        title: row.title,
        body_snippet: row.body_snippet,
        subreddit: row.subreddit,
        created_utc: row.created_utc,
        upvotes: row.upvotes,
        comment_count: row.comment_count,
      },
      keywordSet
    );

    return res.json({ score, reasons });
  } catch (err) {
    console.error('[leads] GET /:id/why', err);
    return res.status(500).json({ error: 'Failed to explain score' });
  }
});

router.post('/:id/suppress', async (req, res) => {
  const { user_id, mode, snooze_hours } = req.body ?? {};

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }
  if (mode !== 'mute' && mode !== 'snooze') {
    return res.status(400).json({ error: 'mode must be "mute" or "snooze"' });
  }

  try {
    const leadResult = await pool.query(
      `SELECT id, user_id, post_id FROM leads WHERE id = $1`,
      [req.params.id]
    );
    const lead = leadResult.rows[0];
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (String(lead.user_id) !== String(user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (mode === 'mute') {
      await pool.query(
        `INSERT INTO thread_suppressions (user_id, post_id, kind, snooze_until)
         VALUES ($1, $2, 'mute', NULL)
         ON CONFLICT (user_id, post_id) DO UPDATE SET
           kind = 'mute',
           snooze_until = NULL`,
        [lead.user_id, lead.post_id]
      );
    } else {
      const hours = Math.min(
        Math.max(parseInt(String(snooze_hours ?? '24'), 10) || 24, 1),
        168
      );
      const until = new Date(Date.now() + hours * 3600 * 1000);
      await pool.query(
        `INSERT INTO thread_suppressions (user_id, post_id, kind, snooze_until)
         VALUES ($1, $2, 'snooze', $3)
         ON CONFLICT (user_id, post_id) DO UPDATE SET
           kind = 'snooze',
           snooze_until = EXCLUDED.snooze_until`,
        [lead.user_id, lead.post_id, until]
      );
    }

    await pool.query(`DELETE FROM leads WHERE id = $1`, [req.params.id]);

    return res.json({ ok: true, mode });
  } catch (err) {
    console.error('[leads] POST /:id/suppress', err);
    return res.status(500).json({ error: 'Failed to suppress thread' });
  }
});

router.patch('/:id/seen', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE leads SET seen = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('[leads] PATCH /:id/seen', err);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
});

router.patch('/:id/unseen', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE leads SET seen = false WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('[leads] PATCH /:id/unseen', err);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM leads WHERE id = $1`, [req.params.id]);

    return res.json({ success: true });
  } catch (err) {
    console.error('[leads] DELETE /:id', err);
    return res.status(500).json({ error: 'Failed to delete lead' });
  }
});

router.post('/:id/draft', async (req, res) => {
  try {
    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [
      req.params.id,
    ]);
    const lead = leadResult.rows[0];
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const ksResult = await pool.query(
      `SELECT * FROM keyword_sets WHERE id = $1`,
      [lead.keyword_set_id]
    );
    const keywordSet = ksResult.rows[0];
    if (!keywordSet) {
      return res.status(404).json({ error: 'Monitor not found for lead' });
    }

    const force =
      req.body?.force === true ||
      req.body?.force === 'true' ||
      req.query?.force === 'true';

    if (lead.ai_draft && !force) {
      return res.json({ draft: lead.ai_draft, cached: true });
    }

    const draft = await generateDraft(lead, keywordSet);

    if (draft == null) {
      return res.status(502).json({ error: 'Failed to generate draft' });
    }

    await pool.query(`UPDATE leads SET ai_draft = $1 WHERE id = $2`, [
      draft,
      lead.id,
    ]);

    return res.json({ draft, cached: false });
  } catch (err) {
    console.error('[leads] POST /:id/draft', err);
    return res.status(500).json({ error: 'Failed to generate draft' });
  }
});

module.exports = router;
