const Bull = require('bull');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { searchReddit, searchSubreddit } = require('../services/redditService');
const { searchHN } = require('../services/hnService');
const { scoreResultDetailed, filterLowSignal } = require('../services/relevanceScorer');

const scanQueue = new Bull('reddit-scan', process.env.REDIS_URL);

function addScanJob(keywordSetId) {
  return scanQueue.add({ keywordSetId }, { attempts: 3, backoff: 5000 });
}

/**
 * Re-register this monitor's Bull repeatable scan job using `scan_interval_hours` from the DB.
 * Call after PATCH when the interval may have changed (safe to call if unchanged).
 */
async function rescheduleRepeatableScanForKeywordSet(keywordSetId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, COALESCE(scan_interval_hours, 6) AS scan_interval_hours
     FROM keyword_sets
     WHERE id = $1 AND active = true`,
    [keywordSetId]
  );

  if (!rows.length || !rows[0].user_id) {
    return;
  }

  const ks = rows[0];
  const hours = Number(ks.scan_interval_hours) || 6;
  const every = Math.max(hours, 1) * 3600 * 1000;
  const jobIdStr = `scan-${keywordSetId}`;

  const repeatable = await scanQueue.getRepeatableJobs();
  for (const rj of repeatable) {
    if (rj.id === jobIdStr) {
      await scanQueue.removeRepeatableByKey(rj.key);
      break;
    }
  }

  await scanQueue.add(
    { keywordSetId: ks.id, userId: ks.user_id },
    {
      repeat: { every },
      jobId: jobIdStr,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }
  );
}

function initWorker() {
  scanQueue.process(1, async (job) => {
    const { keywordSetId } = job.data;

    const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
      keywordSetId,
    ]);

    const keywordSet = rows[0];

    if (!keywordSet || !keywordSet.active) {
      return;
    }

    const { queries, subreddits } = generateQueries(keywordSet.product_description);

    const collected = [];

    for (const q of queries) {
      const batch = await searchReddit(q);
      collected.push(...batch);
      const hnBatch = await searchHN(q);
      collected.push(...hnBatch);
    }

    for (const sub of subreddits) {
      for (const q of queries) {
        const batch = await searchSubreddit(sub, q);
        collected.push(...batch);
      }
    }

    const deduped = [];
    const seen = new Set();

    for (const item of collected) {
      if (!item || !item.post_id) continue;
      if (seen.has(item.post_id)) continue;

      seen.add(item.post_id);
      deduped.push(item);
    }

    const { rows: supRows } = await pool.query(
      `SELECT post_id FROM thread_suppressions
       WHERE user_id = $1
         AND (
           kind = 'mute'
           OR (kind = 'snooze' AND snooze_until > NOW())
         )`,
      [keywordSet.user_id]
    );
    const suppressed = new Set(supRows.map((row) => row.post_id));

    const surviving = filterLowSignal(deduped, keywordSet).filter(
      (r) => r.post_id && !suppressed.has(r.post_id)
    );

    let newLeads = 0;

    for (const r of surviving) {
      if (!r.url) continue;

      const { score: relevanceScore, reasons: scoreReasons } = scoreResultDetailed(
        r,
        keywordSet
      );

      const ins = await pool.query(
        `INSERT INTO leads (
            user_id,
            keyword_set_id,
            platform,
            post_id,
            title,
            body_snippet,
            url,
            author,
            subreddit,
            relevance_score,
            upvotes,
            comment_count,
            score_reasons
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (user_id, post_id) DO NOTHING`,
        [
          keywordSet.user_id,
          keywordSet.id,
          r.platform || 'reddit',
          r.post_id,
          r.title ?? '',
          r.body_snippet ?? '',
          r.url,
          r.author ?? null,
          r.subreddit ?? null,
          relevanceScore,
          Number(r.upvotes) || 0,
          Number(r.comment_count) || 0,
          Array.isArray(scoreReasons) ? scoreReasons : [],
        ]
      );

      newLeads += ins.rowCount || 0;
    }

    await pool.query('UPDATE keyword_sets SET last_scanned_at = NOW() WHERE id = $1', [
      keywordSetId,
    ]);

    console.log(`✓ Scan complete [${keywordSetId}]: ${newLeads} new leads`);
  });

  scanQueue.on('failed', (job, err) => {
    console.error('Scan job failed:', err && err.message ? err.message : err);
  });
}

module.exports = {
  scanQueue,
  addScanJob,
  rescheduleRepeatableScanForKeywordSet,
  initWorker,
};
