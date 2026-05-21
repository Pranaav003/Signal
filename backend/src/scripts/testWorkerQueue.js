/**
 * Smoke test: Redis reachable, worker heartbeat recent, manual + scheduled Bull queues OK.
 * Run with worker process already running for heartbeat to pass.
 *
 * Optional: WORKER_SMOKE_KEYWORD_SET_ID=<uuid> — after checks, calls addScanJob and polls up to 90s.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { REDIS_URL, createRedisClient } = require('../jobs/queueFactory');
const {
  getScanQueueSnapshot,
  addScanJob,
  getManualScanJobState,
  MANUAL_SCAN_QUEUE_NAME,
  SCAN_QUEUE_NAME,
} = require('../jobs/scanJob');
const { readWorkerHeartbeat, isHeartbeatFresh } = require('../services/workerHeartbeat');

async function pingRedis() {
  const c = createRedisClient();
  try {
    const pong = await c.ping();
    return pong === 'PONG';
  } finally {
    c.disconnect();
  }
}

async function main() {
  console.log('\n=== Worker / queue smoke test ===\n');
  console.log(`REDIS_URL: ${REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`Manual queue: ${MANUAL_SCAN_QUEUE_NAME}`);
  console.log(`Scheduled queue: ${SCAN_QUEUE_NAME}\n`);

  if (!(await pingRedis())) {
    console.error('FAIL: Redis ping did not return PONG');
    process.exit(1);
  }
  console.log('✓ Redis PONG');

  const hb = await readWorkerHeartbeat();
  if (!isHeartbeatFresh(hb, 35)) {
    console.error(
      'FAIL: No fresh worker heartbeat (signal:worker:heartbeat). Start: cd backend && npm run worker'
    );
    if (hb) console.error('  Last heartbeat:', hb.last_seen_at);
    process.exit(1);
  }
  console.log('✓ Worker heartbeat OK (pid %s)', hb.pid);

  const snap = await getScanQueueSnapshot();
  const m = snap.manual;
  const s = snap.scheduled;
  console.log(
    'Manual queue:',
    `waiting=${m.counts.waiting} active=${m.counts.active} delayed=${m.counts.delayed}`
  );
  console.log(
    'Scheduled queue:',
    `waiting=${s.counts.waiting} active=${s.counts.active} delayed=${s.counts.delayed}`
  );

  const smokeId = process.env.WORKER_SMOKE_KEYWORD_SET_ID;
  if (smokeId) {
    console.log(`\n→ Queuing smoke scan for keyword set ${smokeId} ...`);
    await addScanJob(smokeId, null);
    const deadline = Date.now() + 90_000;
    let lastState = null;
    while (Date.now() < deadline) {
      const st = await getManualScanJobState(smokeId);
      lastState = st.state;
      if (st.state === 'active' || st.state === 'completed') {
        console.log(`✓ Job reached state: ${st.state}`);
        process.exit(0);
      }
      if (st.orphan_waiting) {
        console.error('FAIL: orphan waiting job (in Redis but not in wait list)');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error(`FAIL: job still ${lastState} after 90s`);
    process.exit(1);
  }

  console.log('\n✓ Smoke test passed (set WORKER_SMOKE_KEYWORD_SET_ID to test job pickup)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
