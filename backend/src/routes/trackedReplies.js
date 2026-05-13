const express = require('express');

const pool = require('../db/connection');
const {
  getCommentStats,
  parseRedditCommentUrl,
} = require('../services/redditTracker');

const router = express.Router();

const INVALID_COMMENT_URL_MSG =
  'Use your comment permalink, not the post. Open your comment on Reddit → Share → Copy link. ' +
  'The URL should end with …/comments/<postId>/<slug>/<commentId>/ or include ?comment=t1_…';

function isValidRedditCommentUrl(url) {
  return parseRedditCommentUrl(url) != null;
}

function dbMissingTable(err) {
  return err && (err.code === '42P01' || /relation .* does not exist/i.test(String(err.message)));
}

router.post('/', async (req, res) => {
  const { user_id, lead_id, comment_url } = req.body ?? {};

  if (!user_id || !lead_id || !comment_url) {
    return res.status(400).json({ error: 'user_id, lead_id, and comment_url are required' });
  }

  if (!isValidRedditCommentUrl(String(comment_url))) {
    return res.status(400).json({ error: INVALID_COMMENT_URL_MSG });
  }

  const parsed = parseRedditCommentUrl(String(comment_url));
  const redditCommentId = parsed?.fullCommentId ?? null;

  try {
    const { rows: leadRows } = await pool.query(
      `SELECT id FROM leads WHERE id = $1 AND user_id = $2`,
      [lead_id, user_id]
    );

    if (!leadRows.length) {
      return res.status(404).json({ error: 'Lead not found for this user' });
    }

    const ins = await pool.query(
      `INSERT INTO tracked_replies (
        user_id, lead_id, comment_url, reddit_comment_id
      ) VALUES ($1, $2, $3, $4)
      RETURNING *`,
      [user_id, lead_id, String(comment_url).trim(), redditCommentId]
    );

    let row = ins.rows[0];
    const stats = await getCommentStats(row.comment_url);

    if (stats) {
      const up = await pool.query(
        `UPDATE tracked_replies SET
          upvotes = $1,
          reply_count = $2,
          thread_upvotes = $3,
          thread_reply_count = $4,
          status = $5,
          last_checked_at = NOW()
        WHERE id = $6
        RETURNING *`,
        [
          stats.upvotes,
          stats.reply_count,
          stats.thread_upvotes,
          stats.thread_reply_count,
          stats.status,
          row.id,
        ]
      );
      row = up.rows[0];
    } else {
      const up = await pool.query(
        `UPDATE tracked_replies SET last_checked_at = NOW() WHERE id = $1 RETURNING *`,
        [row.id]
      );
      row = up.rows[0];
    }

    return res.status(201).json(row);
  } catch (err) {
    console.error('[tracked-replies] POST /', err);
    if (dbMissingTable(err)) {
      return res.status(503).json({
        error:
          'Database is missing the tracked_replies table. Run: node src/db/migrate.js (from the backend folder).',
      });
    }
    return res.status(500).json({ error: 'Failed to create tracked reply' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        tr.*,
        l.title AS lead_title,
        l.subreddit AS lead_subreddit
      FROM tracked_replies tr
      JOIN leads l ON l.id = tr.lead_id
      WHERE tr.user_id = $1
      ORDER BY tr.posted_at DESC
      `,
      [req.params.userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error('[tracked-replies] GET /user/:userId', err);
    if (dbMissingTable(err)) {
      return res.status(503).json({
        error:
          'Database is missing the tracked_replies table. Run: node src/db/migrate.js (from the backend folder).',
      });
    }
    return res.status(500).json({ error: 'Failed to fetch tracked replies' });
  }
});

router.delete('/:id', async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query param is required' });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tracked_replies WHERE id = $1 AND user_id = $2`,
      [req.params.id, user_id]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[tracked-replies] DELETE /:id', err);
    return res.status(500).json({ error: 'Failed to delete tracked reply' });
  }
});

module.exports = router;
