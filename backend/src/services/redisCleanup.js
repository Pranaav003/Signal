const pool = require('../db/connection');
const {
  scanQueue,
  manualScanQueue,
  MANUAL_SCAN_QUEUE_NAME,
  SCAN_QUEUE_NAME,
} = require('../jobs/scanJob');
const { trackerQueue, TRACKER_QUEUE_NAME } = require('../jobs/trackerJob');

const FAILED_JOBS_TO_KEEP = Number(process.env.REDIS_FAILED_JOBS_TO_KEEP) || 5;
const STALE_ACTIVE_MS =
  Number(process.env.REDIS_STALE_ACTIVE_MS) > 0
    ? Number(process.env.REDIS_STALE_ACTIVE_MS)
    : 30 * 60 * 1000;
const STALE_DELAYED_MS =
  Number(process.env.REDIS_STALE_DELAYED_MS) > 0
    ? Number(process.env.REDIS_STALE_DELAYED_MS)
    : 7 * 24 * 60 * 60 * 1000;

function removedCount(result) {
  return Array.isArray(result) ? result.length : 0;
}

async function trimFailedJobs(queue, keep = FAILED_JOBS_TO_KEEP) {
  const failed = await queue.getFailed(0, 500);
  let removed = 0;
  for (let i = keep; i < failed.length; i += 1) {
    try {
      await failed[i].remove();
      removed += 1;
    } catch {
      /* ignore per-job cleanup errors */
    }
  }
  return removed;
}

async function cleanQueue(queue, name) {
  const completed = removedCount(await queue.clean(0, 'completed'));
  const active = removedCount(await queue.clean(STALE_ACTIVE_MS, 'active'));
  const delayed = removedCount(await queue.clean(STALE_DELAYED_MS, 'delayed'));
  const failed = await trimFailedJobs(queue);

  return { name, completed, active, delayed, failed };
}

async function pruneOrphanRepeatables() {
  const { rows } = await pool.query('SELECT id FROM keyword_sets WHERE active = true');
  const activeRepeatIds = new Set(rows.map((row) => `scan-${row.id}`));

  const repeatable = await scanQueue.getRepeatableJobs();
  let removed = 0;
  for (const job of repeatable) {
    if (!activeRepeatIds.has(job.id)) {
      await scanQueue.removeRepeatableByKey(job.key);
      removed += 1;
    }
  }
  return removed;
}

async function pruneStaleBullQueues(options = {}) {
  const pruneRepeatables = options.pruneRepeatables !== false;
  const queues = [
    { queue: manualScanQueue, name: MANUAL_SCAN_QUEUE_NAME },
    { queue: scanQueue, name: SCAN_QUEUE_NAME },
    { queue: trackerQueue, name: TRACKER_QUEUE_NAME },
  ];

  const summary = {
    queues: [],
    orphanRepeatables: 0,
  };

  for (const { queue, name } of queues) {
    summary.queues.push(await cleanQueue(queue, name));
  }

  if (pruneRepeatables) {
    summary.orphanRepeatables = await pruneOrphanRepeatables();
  }

  return summary;
}

function formatCleanupSummary(summary) {
  const parts = summary.queues.map((q) => {
    const total = q.completed + q.failed + q.active + q.delayed;
    return `${q.name}: removed ${total} (completed=${q.completed}, failed=${q.failed}, active=${q.active}, delayed=${q.delayed})`;
  });
  if (summary.orphanRepeatables > 0) {
    parts.push(`orphan repeatables=${summary.orphanRepeatables}`);
  }
  return parts.join('; ');
}

module.exports = {
  pruneStaleBullQueues,
  formatCleanupSummary,
  FAILED_JOBS_TO_KEEP,
};
