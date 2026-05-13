const pool = require('../db/connection');
const { scanQueue } = require('./scanJob');

async function startScheduler() {
  const result = await pool.query(
    `SELECT id, user_id, scan_interval_hours FROM keyword_sets WHERE active = true`
  );

  for (const ks of result.rows) {
    if (!ks.user_id) {
      console.warn(`[scheduler] Skipping ${ks.id} — no user_id`);
      continue;
    }

    const hours = Number(ks.scan_interval_hours) || 6;
    const every = Math.max(hours, 1) * 3600 * 1000;

    await scanQueue.add(
      { keywordSetId: ks.id, userId: ks.user_id },
      {
        repeat: { every },
        jobId: `scan-${ks.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );

    console.log(`[scheduler] Scheduled ${ks.id} every ${hours}h`);
  }

  console.log(`✓ Scheduler started: ${result.rows.length} monitors active`);
}

module.exports = { startScheduler };
