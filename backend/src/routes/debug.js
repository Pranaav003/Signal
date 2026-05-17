const express = require('express');

const { scanQueue } = require('../jobs/scanJob');

const router = express.Router();

router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
});

async function jobSummaries(jobs) {
  const out = [];
  for (const job of jobs) {
    let state = null;
    try {
      state = await job.getState();
    } catch (_e) {
      state = 'unknown';
    }
    out.push({
      id: job.id,
      keywordSetId: job.data?.keywordSetId ?? null,
      state,
      failedReason: job.failedReason || null,
    });
  }
  return out;
}

router.get('/scan-queue', async (req, res) => {
  try {
    const counts = await scanQueue.getJobCounts();

    const [waiting, active, delayed, failed, completed] = await Promise.all([
      scanQueue.getWaiting(0, 20),
      scanQueue.getActive(0, 20),
      scanQueue.getDelayed(0, 20),
      scanQueue.getFailed(0, 20),
      scanQueue.getCompleted(0, 20),
    ]);

    return res.json({
      counts,
      waiting: await jobSummaries(waiting),
      active: await jobSummaries(active),
      delayed: await jobSummaries(delayed),
      failed: await jobSummaries(failed),
      completed: await jobSummaries(completed),
    });
  } catch (err) {
    console.error('[debug] GET /scan-queue', err);
    return res.status(500).json({
      error: err && err.message ? err.message : 'Failed to read scan queue',
    });
  }
});

module.exports = router;
