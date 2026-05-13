const express = require('express');

const pool = require('../db/connection');

const router = express.Router();

router.post('/', async (req, res) => {
  const email = req.body?.email;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  const normalized = email.trim();

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO users (id, email)
      VALUES (gen_random_uuid(), $1)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id, email, created_at
      `,
      [normalized]
    );

    const row = rows[0];
    console.log('[users] upserted:', row);
    return res.status(200).json(row);
  } catch (err) {
    console.error('[users] POST failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to create user' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [
      req.params.id,
    ]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('[users] GET /:id', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
