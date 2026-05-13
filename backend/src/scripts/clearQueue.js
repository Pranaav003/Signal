require('dotenv').config();

const { scanQueue, addScanJob } = require('../jobs/scanJob');
const pool = require('../db/connection');

async function clearAndRequeue() {
  console.log('Cleaning queue...');

  await scanQueue.clean(0, 'active');
  await scanQueue.clean(0, 'failed');
  await scanQueue.clean(0, 'delayed');
  await scanQueue.empty();
  console.log('✓ Queue cleared');

  const repeatableJobs = await scanQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await scanQueue.removeRepeatableByKey(job.key);
    console.log(`Removed repeatable: ${job.key}`);
  }
  console.log('✓ Repeatables cleared');

  const result = await pool.query(
    'SELECT id, user_id FROM keyword_sets WHERE active = true'
  );
  console.log(`Requeueing ${result.rows.length} keyword sets...`);

  for (const ks of result.rows) {
    if (!ks.user_id) {
      console.warn(`Skipping ${ks.id} — no user_id`);
      continue;
    }
    await addScanJob(ks.id, ks.user_id);
    console.log(`✓ Queued: ${ks.id} (user: ${ks.user_id})`);
  }

  await pool.end();
  console.log('Done — restart your backend now');
  process.exit(0);
}

clearAndRequeue().catch((err) => {
  console.error('Failed:', err);
  pool.end(() => process.exit(1)).catch(() => process.exit(1));
});
