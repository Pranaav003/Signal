const {
  createRedisClient,
  SCAN_QUEUE_NAME,
  REDIS_URL,
  redactRedisUrl,
  getRedisDbIndex,
} = require('../jobs/queueFactory');

const HEARTBEAT_KEY = 'signal:worker:heartbeat';
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) || 30_000;
const HEARTBEAT_TTL_SEC = Number(process.env.WORKER_HEARTBEAT_TTL_SEC) || 90;

let heartbeatTimer = null;
let heartbeatClient = null;

async function writeWorkerHeartbeat(extra = {}) {
  const client = heartbeatClient || createRedisClient();
  const payload = {
    pid: process.pid,
    started_at: extra.started_at || new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    queue_name: SCAN_QUEUE_NAME,
    redis_url: redactRedisUrl(REDIS_URL),
    redis_db: getRedisDbIndex(),
    node_env: process.env.NODE_ENV || 'development',
    ...extra,
  };
  await client.set(HEARTBEAT_KEY, JSON.stringify(payload), 'EX', HEARTBEAT_TTL_SEC);
  return payload;
}

async function readWorkerHeartbeat() {
  const client = createRedisClient();
  try {
    const raw = await client.get(HEARTBEAT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    client.disconnect();
  }
}

function isHeartbeatFresh(heartbeat, maxAgeSec = 30) {
  if (!heartbeat?.last_seen_at) return false;
  const ageMs = Date.now() - new Date(heartbeat.last_seen_at).getTime();
  return ageMs >= 0 && ageMs <= maxAgeSec * 1000;
}

async function isWorkerAlive(maxAgeSec = 30) {
  const hb = await readWorkerHeartbeat();
  return isHeartbeatFresh(hb, maxAgeSec);
}

function startWorkerHeartbeatLoop(meta = {}) {
  if (heartbeatTimer) return;

  heartbeatClient = createRedisClient();
  const startedAt = new Date().toISOString();

  const tick = async () => {
    try {
      await writeWorkerHeartbeat({ ...meta, started_at: startedAt });
    } catch (err) {
      console.warn('[worker] heartbeat write failed:', err?.message || err);
    }
  };

  void tick();
  heartbeatTimer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);

  heartbeatTimer.unref?.();
}

function stopWorkerHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatClient) {
    heartbeatClient.disconnect();
    heartbeatClient = null;
  }
}

module.exports = {
  HEARTBEAT_KEY,
  writeWorkerHeartbeat,
  readWorkerHeartbeat,
  isHeartbeatFresh,
  isWorkerAlive,
  startWorkerHeartbeatLoop,
  stopWorkerHeartbeatLoop,
};
