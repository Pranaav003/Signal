require('../config/loadEnv');

const { hasClassifierConfigConflict } = require('../services/leadQualifier');

if (process.env.OPENAI_API_KEY) {
  console.log('[worker] OPENAI_API_KEY loaded — AI planner/classifier enabled');
} else {
  console.warn(
    '[worker] OPENAI_API_KEY missing — scans will use fallback qualification (set backend/.env)'
  );
}

if (hasClassifierConfigConflict()) {
  console.error(
    '[worker] REQUIRE_AI_CLASSIFIER=true conflicts with SKIP_AI_LEAD_CLASSIFIER=true — scans will fail until SKIP_AI_LEAD_CLASSIFIER is removed from this service.'
  );
}

const Redis = require('ioredis');

const {
  initWorker,
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
} = require('./scanJob');
const { initTrackerWorker } = require('./trackerJob');
const { validateRedditCredentials, sanitizeRedditMessage } = require('../services/redditService');
const {
  pruneStaleBullQueues,
  formatCleanupSummary,
} = require('../services/redisCleanup');
const {
  REDIS_URL,
  redactRedisUrl,
  getRedisDbIndex,
  getIoredisConnectionOptions,
} = require('./queueFactory');
const { startWorkerHeartbeatLoop } = require('../services/workerHeartbeat');

/** Repeatable enqueue runs from the HTTP service (`index.js` → `startScheduler`). */

async function verifyRedis() {
  const url = REDIS_URL;
  const client = new Redis(url, {
    ...getIoredisConnectionOptions(url),
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

function withTimeout(promise, ms, label) {
  const timeoutMs = Number(ms) > 0 ? Number(ms) : 30_000;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function probeRedditAtStartup() {
  if (process.env.SKIP_REDDIT_STARTUP_PROBE === 'true') {
    console.log('[worker] Reddit startup probe skipped (SKIP_REDDIT_STARTUP_PROBE=true)');
    return;
  }

  const probeMs = Number(process.env.REDDIT_STARTUP_PROBE_MS) || 45_000;
  try {
    const redditCheck = await withTimeout(
      validateRedditCredentials(),
      probeMs,
      'Reddit startup probe'
    );
    if (!redditCheck.ok) {
      const detail =
        redditCheck.error?.message ||
        (redditCheck.sample_count === 0
          ? 'Reddit returned 0 sample posts through proxy'
          : 'Reddit probe failed');
      console.warn(
        '⚠ Reddit startup probe failed; scans may return 0 leads until proxies work.'
      );
      console.warn('  ', sanitizeRedditMessage(detail));
      if (redditCheck.meta?.proxy_username) {
        console.warn(`  Last proxy username tried: ${redditCheck.meta.proxy_username}`);
      }
      return;
    }
    console.log(
      `✓ Reddit startup probe OK (sample results: ${redditCheck.sample_count ?? 0})`
    );
  } catch (err) {
    console.warn(
      '[worker] Reddit startup probe skipped:',
      err && err.message ? err.message : err
    );
  }
}

async function startWorker() {
  await verifyRedis();

  try {
    const pruneMs = Number(process.env.REDIS_PRUNE_TIMEOUT_MS) || 30_000;
    const summary = await withTimeout(
      pruneStaleBullQueues(),
      pruneMs,
      'Redis prune'
    );
    const detail = formatCleanupSummary(summary);
    if (/removed [1-9]|orphan repeatables=[1-9]/.test(detail)) {
      console.log(`✓ Redis pruned stale Bull data — ${detail}`);
    } else {
      console.log('✓ Redis Bull queues checked (no stale jobs to prune)');
    }
  } catch (err) {
    console.warn(
      '[worker] Redis prune skipped:',
      err && err.message ? err.message : err
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
  console.log('✓ Worker heartbeat: signal:worker:heartbeat');
  console.log('✓ Reply tracker worker listening');

  void probeRedditAtStartup();
}

module.exports = { startWorker };

if (require.main === module) {
  startWorker().catch((err) => {
    console.error('Worker startup failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
