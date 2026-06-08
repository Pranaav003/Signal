require('../config/loadEnv');

const {
  pruneStaleBullQueues,
  formatCleanupSummary,
} = require('../services/redisCleanup');
const pool = require('../db/connection');

async function main() {
  const summary = await pruneStaleBullQueues();
  console.log('✓ Redis prune complete —', formatCleanupSummary(summary));
  await pool.end();
}

main().catch(async (err) => {
  console.error('✗ Redis prune failed:', err?.message || err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
