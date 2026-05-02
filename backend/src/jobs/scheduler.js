const pool = require('../db/connection');
const { scanQueue } = require('./scanJob');

async function startScheduler() {
  const { rows } = await pool.query(
    `SELECT id, scan_interval_hours FROM keyword_sets WHERE active = true`
  );

  for (const row of rows) {
    const hours = Number(row.scan_interval_hours) || 6;
    const every = Math.max(hours, 1) * 3600 * 1000;

    await scanQueue.add(
      { keywordSetId: row.id },
      { repeat: { every }, jobId: String(row.id) }
    );
  }

  console.log(`✓ Scheduler started: ${rows.length} monitors active`);
}

module.exports = { startScheduler };
