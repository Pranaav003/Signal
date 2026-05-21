const express = require('express');

const {
  getScanQueueSnapshot,
  SCAN_QUEUE_NAME,
  MANUAL_SCAN_QUEUE_NAME,
} = require('../jobs/scanJob');
const { generateQueries } = require('../services/keywordProcessor');
const {
  REDIS_URL,
  redactRedisUrl,
  createRedisClient,
} = require('../jobs/queueFactory');
const {
  readWorkerHeartbeat,
  isHeartbeatFresh,
} = require('../services/workerHeartbeat');

const router = express.Router();

router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
});

router.post('/keyword-plan', async (req, res) => {
  const description = req.body?.description;
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }

  try {
    const plan = await generateQueries(description.trim());
    return res.json({
      queries: plan.queries,
      subreddits: plan.subreddits,
      negative_keywords: plan.negative_keywords || [],
      ideal_post_patterns: plan.ideal_post_patterns || [],
      source: plan.source || 'mixed',
      planner_source: plan.planner_source,
      planner_model: plan.planner_model,
      reddit_fit: plan.reddit_fit,
      warning: plan.warning,
      suggestion: plan.suggestion,
      lead_definition: plan.lead_definition,
      required_evidence: plan.required_evidence,
      disqualifying_evidence: plan.disqualifying_evidence,
      reasoning_summary: plan.reasoning_summary || null,
    });
  } catch (err) {
    console.error('[debug] POST /keyword-plan', err);
    return res.status(err.code === 'invalid_search_plan' ? 400 : 500).json({
      error: err.code || 'keyword_generation_failed',
      message: err.message,
      stack: err.stack,
    });
  }
});

/**
 * Queue health for dev — API + worker must share REDIS_URL and manual queue name.
 */
router.get('/scan-queue', async (req, res) => {
  const client = createRedisClient();
  let redisConnected = false;

  try {
    const pong = await client.ping();
    redisConnected = pong === 'PONG';
  } catch (err) {
    return res.status(503).json({
      redis: { connected: false, url: redactRedisUrl(REDIS_URL), error: err.message },
      queues: null,
      worker: { heartbeat_seen: false, message: 'Redis unreachable' },
    });
  } finally {
    client.disconnect();
  }

  try {
    const heartbeat = await readWorkerHeartbeat();
    const heartbeatSeen = isHeartbeatFresh(heartbeat, 30);
    const snapshot = await getScanQueueSnapshot();

    const worker = heartbeatSeen
      ? {
          heartbeat_seen: true,
          last_heartbeat_at: heartbeat.last_seen_at,
          process_id: heartbeat.pid,
          consumer_queues: heartbeat.consumer_queues || [
            MANUAL_SCAN_QUEUE_NAME,
            SCAN_QUEUE_NAME,
          ],
          consumer_queue_name: heartbeat.consumer_queue_name || SCAN_QUEUE_NAME,
          started_at: heartbeat.started_at,
        }
      : {
          heartbeat_seen: false,
          message:
            'Worker is not running or not connected to this Redis queue. Start: cd backend && npm run worker',
        };

    const sched = snapshot.scheduled;
    const man = snapshot.manual;

    return res.json({
      redis: {
        connected: redisConnected,
        url: redactRedisUrl(REDIS_URL),
      },
      queues: {
        manual: {
          name: man.name,
          prefix: man.prefix,
          waiting: man.counts.waiting,
          active: man.counts.active,
          delayed: man.counts.delayed,
          completed: man.counts.completed,
          failed: man.counts.failed,
          stalled: man.counts.stalled ?? 0,
          sample_waiting: man.waiting,
          sample_active: man.active,
        },
        scheduled: {
          name: sched.name,
          prefix: sched.prefix,
          waiting: sched.counts.waiting,
          active: sched.counts.active,
          delayed: sched.counts.delayed,
          completed: sched.counts.completed,
          failed: sched.counts.failed,
          stalled: sched.counts.stalled ?? 0,
          sample_waiting: sched.waiting,
          sample_active: sched.active,
        },
      },
      worker,
      recent_jobs: {
        manual_waiting: man.waiting,
        manual_active: man.active,
        manual_failed: man.failed,
        scheduled_waiting: sched.waiting,
        scheduled_active: sched.active,
        scheduled_failed: sched.failed,
      },
    });
  } catch (err) {
    console.error('[debug] GET /scan-queue', err);
    return res.status(500).json({
      error: err && err.message ? err.message : 'Failed to read scan queue',
    });
  }
});

router.delete('/purge-deleted-monitors', async (req, res) => {
  const pool = require('../db/connection');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leads = await client.query(
      `DELETE FROM leads l
       USING keyword_sets ks
       WHERE l.keyword_set_id = ks.id
         AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)`
    );
    const runs = await client.query(
      `DELETE FROM scan_runs sr
       USING keyword_sets ks
       WHERE sr.keyword_set_id = ks.id
         AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)`
    );
    const ks = await client.query(
      `DELETE FROM keyword_sets
       WHERE COALESCE(active, false) = false OR deleted_at IS NOT NULL`
    );
    await client.query('COMMIT');
    return res.json({
      purged_keyword_sets: ks.rowCount || 0,
      purged_leads: leads.rowCount || 0,
      purged_scan_runs: runs.rowCount || 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[debug] purge-deleted-monitors', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
