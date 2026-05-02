const express = require('express');

const pool = require('../db/connection');

const router = express.Router();

router.post('/', async (req, res) => {
  const email = req.body?.email;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, email) VALUES (gen_random_uuid(), $1) RETURNING *`,
      [email.trim()]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }

    console.error('[users] POST /', err);
    return res.status(500).json({ error: 'Failed to create user' });
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
