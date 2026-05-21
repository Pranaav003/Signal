require('../config/loadEnv');

if (process.env.OPENAI_API_KEY) {
  console.log('[worker] OPENAI_API_KEY loaded — AI planner/classifier enabled');
} else {
  console.warn(
    '[worker] OPENAI_API_KEY missing — scans will use fallback qualification (set backend/.env)'
  );
}

const Redis = require('ioredis');

const {
  initWorker,
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
} = require('./scanJob');
const { initTrackerWorker } = require('./trackerJob');
const { validateRedditCredentials } = require('../services/redditService');
const {
  REDIS_URL,
  redactRedisUrl,
  getRedisDbIndex,
} = require('./queueFactory');
const { startWorkerHeartbeatLoop } = require('../services/workerHeartbeat');

/** Repeatable enqueue runs from the HTTP service (`index.js` → `startScheduler`). */

async function verifyRedis() {
  const url = REDIS_URL;
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
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

  startWorkerHeartbeatLoop({
    consumer_queues: [MANUAL_SCAN_QUEUE_NAME, SCAN_QUEUE_NAME],
    consumer_queue_name: `${MANUAL_SCAN_QUEUE_NAME}+${SCAN_QUEUE_NAME}`,
    process_id: String(process.pid),
  });

  initWorker();
  initTrackerWorker();

  console.log('✓ Signal worker started (pid %s)', process.pid);
  console.log(`✓ Redis: ${redactRedisUrl(REDIS_URL)} (db ${getRedisDbIndex()})`);
  console.log(`✓ Manual scan queue: ${MANUAL_SCAN_QUEUE_NAME}`);
  console.log(`✓ Scheduled scan queue: ${SCAN_QUEUE_NAME}`);
  console.log('✓ Worker heartbeat: signal:worker:heartbeat (every 10s)');
  console.log('✓ Reply tracker worker listening');
}

main().catch((err) => {
  console.error('Worker startup failed:', err && err.message ? err.message : err);
  process.exit(1);
});
