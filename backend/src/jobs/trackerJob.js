const Bull = require('bull');

const pool = require('../db/connection');
const { getCommentStats } = require('../services/redditTracker');

const trackerQueue = new Bull('reply-tracker', process.env.REDIS_URL);

let trackerWorkerStarted = false;

async function refreshAllTrackedReplies() {
  const { rows } = await pool.query(
    `SELECT id, comment_url FROM tracked_replies WHERE status = 'active'`
  );

  let ok = 0;

  for (const row of rows) {
    const stats = await getCommentStats(row.comment_url);
    if (stats == null) continue;

    await pool.query(
      `UPDATE tracked_replies SET
        upvotes = $1,
        reply_count = $2,
        thread_upvotes = $3,
        thread_reply_count = $4,
        status = $5,
        last_checked_at = NOW()
      WHERE id = $6`,
      [
        stats.upvotes,
        stats.reply_count,
        stats.thread_upvotes,
        stats.thread_reply_count,
        stats.status,
        row.id,
      ]
    );
    ok += 1;
  }

  console.log(`✓ Tracker refreshed ${ok} replies`);
}

function initTrackerWorker() {
  if (trackerWorkerStarted) return;
  trackerWorkerStarted = true;

  trackerQueue.process(1, async () => {
    await refreshAllTrackedReplies();
  });

  trackerQueue.on('failed', (job, err) => {
    console.error(
      'Reply tracker job failed:',
      err && err.message ? err.message : err
    );
  });
}

async function startTrackerScheduler() {
  await trackerQueue.add(
    {},
    {
      repeat: { every: 2 * 3600 * 1000 },
      jobId: 'reply-tracker-refresh',
    }
  );
  console.log('✓ Reply tracker scheduler: every 2 hours');
}

module.exports = {
  trackerQueue,
  initTrackerWorker,
  startTrackerScheduler,
  refreshAllTrackedReplies,
};
