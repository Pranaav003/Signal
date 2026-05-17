require('dotenv').config();

const Redis = require('ioredis');

const { initWorker } = require('./scanJob');
const { initTrackerWorker } = require('./trackerJob');
const { validateRedditCredentials } = require('../services/redditService');

/** Repeatable enqueue runs from the HTTP service (`index.js` → `startScheduler`). */

async function verifyRedis() {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis response: ${pong}`);
    }
    console.log('✓ Redis connected (PONG)');
  } catch (err) {
    console.error(
      '✗ Redis connection failed. Start Redis and verify REDIS_URL in backend/.env'
    );
    console.error('  Try: redis-cli ping  (expected PONG)');
    console.error('  Error:', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

async function main() {
  await verifyRedis();

  const redditCheck = await validateRedditCredentials();
  if (!redditCheck.ok) {
    console.error(
      '✗ Reddit public JSON API unreachable; scans may return 0 leads until fixed.'
    );
    console.error('  ', redditCheck.error?.message || 'Unknown error');
  } else {
    console.log(
      `✓ Reddit public JSON API OK (sample results: ${redditCheck.sample_count ?? 0})`
    );
  }

  initWorker();
  initTrackerWorker();

  console.log('✓ Signal worker started');
  console.log('✓ Reddit scan worker listening');
  console.log('✓ Reply tracker worker listening');
}

main().catch((err) => {
  console.error('Worker startup failed:', err && err.message ? err.message : err);
  process.exit(1);
});
