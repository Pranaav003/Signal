const Bull = require('bull');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { searchReddit, searchSubreddit } = require('../services/redditService');
const { scoreResult, filterLowSignal } = require('../services/relevanceScorer');

const scanQueue = new Bull('reddit-scan', process.env.REDIS_URL);

function addScanJob(keywordSetId) {
  return scanQueue.add({ keywordSetId }, { attempts: 3, backoff: 5000 });
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

    const surviving = filterLowSignal(deduped, keywordSet);

    let newLeads = 0;

    for (const r of surviving) {
      if (!r.url) continue;

      const relevanceScore = scoreResult(r, keywordSet);

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
            relevance_score
          )
          VALUES ($1, $2, 'reddit', $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (user_id, post_id) DO NOTHING`,
        [
          keywordSet.user_id,
          keywordSet.id,
          r.post_id,
          r.title ?? '',
          r.body_snippet ?? '',
          r.url,
          r.author ?? null,
          r.subreddit ?? null,
          relevanceScore,
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
  initWorker,
};
