const express = require('express');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { addScanJob } = require('../jobs/scanJob');

const router = express.Router();

router.post('/', async (req, res) => {
  const { user_id, product_description } = req.body ?? {};

  if (!user_id || !product_description) {
    return res
      .status(400)
      .json({ error: 'user_id and product_description are required' });
  }

  try {
    const { queries, subreddits } = generateQueries(product_description);

    const { rows } = await pool.query(
      `INSERT INTO keyword_sets (
          id,
          user_id,
          product_description,
          queries,
          subreddits
        )
        VALUES (gen_random_uuid(), $1, $2, $3, $4)
        RETURNING *`,
      [user_id, product_description, queries, subreddits]
    );

    const newSet = rows[0];

    await addScanJob(newSet.id);

    return res.status(201).json(newSet);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    console.error('[keywordSets] POST /', err);
    return res.status(500).json({ error: 'Failed to create keyword set' });
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

module.exports = router;
