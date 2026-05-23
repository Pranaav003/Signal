/**
 * Shared Bull / Redis configuration — API and worker must use the same queue + Redis options.
 */
const Redis = require('ioredis');
const Bull = require('bull');

const SCAN_QUEUE_NAME = 'reddit-scan';
/** Immediate user-triggered scans — separate from repeatable scheduled jobs. */
const MANUAL_SCAN_QUEUE_NAME = 'reddit-scan-manual';
const TRACKER_QUEUE_NAME = 'reply-tracker';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** Shared ioredis options — Bull, worker verify, and Upstash TLS (rediss://). */
function getIoredisConnectionOptions(url = REDIS_URL) {
  const opts = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (String(url || '').startsWith('rediss://')) {
    opts.tls = { rejectUnauthorized: false };
  }
  return opts;
}

/** Bull requires maxRetriesPerRequest: null on ioredis clients. */
function createRedisClient() {
  return new Redis(REDIS_URL, getIoredisConnectionOptions());
}

function createBullQueue(name) {
  return new Bull(name, {
    createClient: () => createRedisClient(),
  });
}

function redactRedisUrl(url = REDIS_URL) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'redis://***';
  }
}

function getRedisDbIndex(url = REDIS_URL) {
  try {
    const u = new URL(url);
    const path = u.pathname?.replace('/', '');
    return path ? Number(path) : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
  TRACKER_QUEUE_NAME,
  REDIS_URL,
  getIoredisConnectionOptions,
  createRedisClient,
  createBullQueue,
  redactRedisUrl,
  getRedisDbIndex,
};
