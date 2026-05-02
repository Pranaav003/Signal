const express = require('express');

const pool = require('../db/connection');
const { generateDraft } = require('../services/draftService');

const router = express.Router();

router.get('/user/:userId', async (req, res) => {
  const { seen, sort, limit } = req.query ?? {};

  const limitNum = Math.min(
    Math.max(parseInt(limit != null ? String(limit) : '50', 10) || 50, 1),
    500
  );

  let whereSeen = '';
  if (seen === 'false') {
    whereSeen = ` AND l.seen = false`;
  } else if (seen === 'true') {
    whereSeen = ` AND l.seen = true`;
  }

  /** Whitelist ORDER BY fragments only */
  const orderClause =
    sort === 'score' ? `l.relevance_score DESC` : `l.created_at DESC`;

  const params = [req.params.userId, limitNum];

  try {
    const { rows } = await pool.query(
      `
      SELECT l.*, k.product_description AS product_description
      FROM leads l
      JOIN keyword_sets k ON l.keyword_set_id = k.id
      WHERE l.user_id = $1 ${whereSeen}
      ORDER BY ${orderClause}
      LIMIT $2
      `,
      params
    );

    return res.json(rows);
  } catch (err) {
    console.error('[leads] GET /user/:userId', err);
    return res.status(500).json({ error: 'Failed to fetch leads' });
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
    const { rows } = await pool.query(
      `
      SELECT l.*, k.product_description AS product_description
      FROM leads l
      JOIN keyword_sets k ON l.keyword_set_id = k.id
      WHERE l.id = $1
      `,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const lead = rows[0];

    if (lead.ai_draft) {
      return res.json({ draft: lead.ai_draft, cached: true });
    }

    const draft = await generateDraft(
      {
        title: lead.title,
        body_snippet: lead.body_snippet,
        subreddit: lead.subreddit,
      },
      lead.product_description
    );

    await pool.query(`UPDATE leads SET ai_draft = $1 WHERE id = $2`, [
      draft,
      lead.id,
    ]);

    return res.json({ draft, cached: false });
  } catch (err) {
    if (err && err.message === 'Failed to generate draft') {
      return res.status(502).json({ error: 'Failed to generate draft' });
    }

    console.error('[leads] POST /:id/draft', err);
    return res.status(500).json({ error: 'Failed to generate draft' });
  }
});

module.exports = router;
