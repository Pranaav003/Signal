const { generateQueries, shouldRegenerateQueries } = require('./keywordProcessor');
const {
  searchRedditStructured,
  searchSubredditStructured,
} = require('./redditService');
const { scoreResultDetailed, leadScoreThreshold } = require('./relevanceScorer');

function emptyStats() {
  return {
    raw_global_count: 0,
    raw_subreddit_count: 0,
    collected_raw: 0,
    deduped_count: 0,
    suppressed_count: 0,
    scored_count: 0,
    filtered_out_count: 0,
    survivors_count: 0,
    attempted_inserts: 0,
    inserted_count: 0,
    duplicate_count: 0,
    skipped_missing_url_count: 0,
    skipped_missing_post_id_count: 0,
    reddit_error_count: 0,
    reddit_auth_error: false,
    last_reddit_error: null,
    threshold_used: leadScoreThreshold(),
    low_confidence_candidates: [],
  };
}

async function prepareKeywordSetForScan(pool, keywordSet) {
  let queries = Array.isArray(keywordSet.queries) ? keywordSet.queries.filter(Boolean) : [];
  let subreddits = Array.isArray(keywordSet.subreddits)
    ? keywordSet.subreddits.filter(Boolean)
    : [];

  const needsRegen =
    !queries.length ||
    !subreddits.length ||
    shouldRegenerateQueries(queries, keywordSet.product_description);

  if (needsRegen) {
    const g = generateQueries(keywordSet.product_description);
    queries = g.queries || [];
    subreddits = g.subreddits || [];

    if (pool && keywordSet.id) {
      const { rows } = await pool.query(
        `UPDATE keyword_sets
         SET queries = $2::jsonb, subreddits = $3::jsonb
         WHERE id = $1
         RETURNING *`,
        [keywordSet.id, JSON.stringify(queries), JSON.stringify(subreddits)]
      );
      if (rows[0]) {
        console.log(
          `[scan] regenerated queries for keywordSetId=${keywordSet.id} (${queries.length} queries, ${subreddits.length} subs)`
        );
        return rows[0];
      }
    }
    return { ...keywordSet, queries, subreddits };
  }

  return keywordSet;
}

function capScanLists(queries, subreddits) {
  const devDefaults = process.env.NODE_ENV !== 'production';
  const maxQ =
    Number(process.env.SCAN_MAX_QUERIES) > 0
      ? Number(process.env.SCAN_MAX_QUERIES)
      : devDefaults
        ? 10
        : 10;
  const maxS =
    Number(process.env.SCAN_MAX_SUBREDDITS) > 0
      ? Number(process.env.SCAN_MAX_SUBREDDITS)
      : devDefaults
        ? 8
        : 8;
  return {
    queries: queries.slice(0, maxQ),
    subreddits: subreddits.slice(0, maxS),
  };
}

function recordRedditError(stats, error) {
  stats.reddit_error_count += 1;
  stats.last_reddit_error = error?.message || String(error || 'Reddit error');
  if (error?.code === 'REDDIT_BLOCKED' || error?.code === 'REDDIT_AUTH_FAILED') {
    stats.reddit_auth_error = true;
  }
}

async function fetchGlobal(query, stats) {
  const result = await searchRedditStructured(query);
  if (result.ok) {
    stats.raw_global_count += result.items.length;
    return result.items;
  }
  recordRedditError(stats, result.error);
  if (result.error?.code === 'REDDIT_BLOCKED' || result.error?.code === 'REDDIT_AUTH_FAILED') {
    throw Object.assign(new Error(result.error.message), { redditError: result.error });
  }
  return [];
}

async function fetchSubreddit(sub, query, stats) {
  const result = await searchSubredditStructured(sub, query);
  if (result.ok) {
    stats.raw_subreddit_count += result.items.length;
    return result.items;
  }
  recordRedditError(stats, result.error);
  if (result.error?.code === 'REDDIT_BLOCKED' || result.error?.code === 'REDDIT_AUTH_FAILED') {
    throw Object.assign(new Error(result.error.message), { redditError: result.error });
  }
  return [];
}

function explainZeroLeads(stats) {
  if (stats.reddit_auth_error) {
    return 'Reddit blocked or rate-limited requests. Set REDDIT_USER_AGENT in backend/.env and slow down scans if needed.';
  }
  if (stats.collected_raw === 0) {
    if (stats.reddit_error_count > 0) {
      return `Reddit returned 0 raw results after ${stats.reddit_error_count} error(s). ${stats.last_reddit_error || 'Check REDDIT_USER_AGENT and rate limits.'}`;
    }
    return 'Reddit returned 0 raw results. Restart the worker after code changes and verify with: npm run test:reddit';
  }
  if (stats.deduped_count === 0) {
    return 'Reddit returned results but none had valid post_id values after dedupe.';
  }
  if (stats.survivors_count === 0 && stats.scored_count > 0) {
    return `Reddit returned ${stats.collected_raw} raw / ${stats.deduped_count} deduped, but 0 passed scoring threshold ${stats.threshold_used}.`;
  }
  if (stats.survivors_count > 0 && stats.inserted_count === 0) {
    return `${stats.survivors_count} passed scoring but 0 inserted (${stats.duplicate_count} duplicates, ${stats.skipped_missing_url_count} missing URL).`;
  }
  return 'Scan complete with 0 new leads saved.';
}

/**
 * Run Reddit → dedupe → score → insert pipeline.
 * @param {object} keywordSet - row from keyword_sets
 * @param {object} options
 * @param {import('pg').Pool} [options.pool]
 * @param {boolean} [options.insertLeads=true]
 * @param {(payload: object) => Promise<void>} [options.onProgress]
 */
async function runScanPipeline(keywordSet, options = {}) {
  const pool = options.pool;
  const insertLeads = options.insertLeads !== false;
  const onProgress = options.onProgress || (async () => {});

  const stats = emptyStats();
  const prepared = pool
    ? await prepareKeywordSetForScan(pool, keywordSet)
    : keywordSet;
  const { queries, subreddits } = capScanLists(
    prepared.queries || [],
    prepared.subreddits || []
  );
  keywordSet = prepared;
  const collected = [];

  await onProgress({
    phase: 'starting',
    message: `Starting scan with ${queries.length} queries across ${subreddits.length} subreddits…`,
    queries_total: queries.length,
    subreddits_total: subreddits.length,
    ...stats,
  });

  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i];
    await onProgress({
      phase: 'reddit_global',
      message: `Reddit (site-wide): "${String(q).slice(0, 80)}"`,
      query_index: i + 1,
      queries_total: queries.length,
      collected_raw: collected.length,
      ...stats,
    });
    const batch = await fetchGlobal(q, stats);
    collected.push(...batch);
    stats.collected_raw = collected.length;
  }

  let pairIdx = 0;
  const pairTotal = subreddits.length * queries.length;

  for (const sub of subreddits) {
    for (let j = 0; j < queries.length; j += 1) {
      const q = queries[j];
      pairIdx += 1;
      await onProgress({
        phase: 'subreddit',
        message: `r/${sub}: "${String(q).slice(0, 72)}" (${pairIdx}/${pairTotal})`,
        subreddit: sub,
        pair_index: pairIdx,
        pairs_total: pairTotal,
        collected_raw: collected.length,
        ...stats,
      });
      const batch = await fetchSubreddit(sub, q, stats);
      collected.push(...batch);
      stats.collected_raw = collected.length;
    }
  }

  await onProgress({
    phase: 'dedupe',
    message: `Deduplicating ${collected.length} raw results…`,
    ...stats,
  });

  const deduped = [];
  const seen = new Set();

  for (const item of collected) {
    if (!item) continue;
    if (!item.post_id) {
      stats.skipped_missing_post_id_count += 1;
      continue;
    }
    if (seen.has(item.post_id)) continue;
    seen.add(item.post_id);
    deduped.push(item);
  }

  stats.deduped_count = deduped.length;

  let suppressed = new Set();
  if (pool && keywordSet.user_id) {
    try {
      const { rows: supRows } = await pool.query(
        `SELECT post_id FROM thread_suppressions
         WHERE user_id = $1
           AND (kind = 'mute' OR (kind = 'snooze' AND snooze_until > NOW()))`,
        [keywordSet.user_id]
      );
      suppressed = new Set(supRows.map((row) => row.post_id));
    } catch (err) {
      console.warn('[scan] thread_suppressions skipped:', err?.message || err);
    }
  }

  const afterSuppression = deduped.filter((r) => {
    if (suppressed.has(r.post_id)) return false;
    return true;
  });
  stats.suppressed_count = deduped.length - afterSuppression.length;

  const scored = afterSuppression
    .map((r) => {
      const detail = scoreResultDetailed(r, keywordSet);
      return {
        ...r,
        relevance_score: detail.score,
        score_reasons: detail.reasons,
      };
    })
    .sort((a, b) => b.relevance_score - a.relevance_score);

  stats.scored_count = scored.length;

  const threshold = stats.threshold_used;
  const scoreFloor =
    Number(process.env.SCAN_SCORE_FLOOR) > 0 ? Number(process.env.SCAN_SCORE_FLOOR) : 8;
  const maxLeadsPerRun =
    Number(process.env.SCAN_MAX_LEADS_PER_RUN) > 0
      ? Number(process.env.SCAN_MAX_LEADS_PER_RUN)
      : process.env.NODE_ENV === 'production'
        ? 30
        : 40;

  let survivors = scored.filter((r) => r.relevance_score >= threshold);
  stats.filtered_out_count = scored.length - survivors.length;

  if (survivors.length < maxLeadsPerRun && scored.length > survivors.length) {
    const have = new Set(survivors.map((r) => r.post_id));
    for (const r of scored) {
      if (survivors.length >= maxLeadsPerRun) break;
      if (have.has(r.post_id)) continue;
      if (r.relevance_score < scoreFloor) continue;
      have.add(r.post_id);
      survivors.push({
        ...r,
        score_reasons: [
          ...(r.score_reasons || []),
          ...(r.relevance_score < threshold
            ? [`Included in top ${maxLeadsPerRun} (score ${r.relevance_score} < threshold ${threshold}).`]
            : []),
        ],
      });
    }
    stats.filtered_out_count = Math.max(0, scored.length - survivors.length);
  }

  if (
    survivors.length === 0 &&
    scored.length > 0 &&
    process.env.SAVE_LOW_CONFIDENCE_DEBUG === 'true'
  ) {
    survivors = scored.slice(0, 5).map((r) => ({
      ...r,
      score_reasons: [
        ...(r.score_reasons || []),
        'Saved as low-confidence debug lead (no candidates passed threshold).',
      ],
    }));
  }

  stats.survivors_count = survivors.length;
  stats.low_confidence_candidates = scored.slice(0, 5).map((r) => ({
    post_id: r.post_id,
    subreddit: r.subreddit,
    title: (r.title || r.body_snippet || '').slice(0, 120),
    relevance_score: r.relevance_score,
  }));

  await onProgress({
    phase: 'score',
    message: `Scored ${stats.scored_count}; ${stats.survivors_count} above threshold ${threshold}`,
    ...stats,
  });

  if (!insertLeads || !pool) {
    return { stats, inserted: stats.inserted_count, queries, subreddits };
  }

  await onProgress({
    phase: 'persist',
    message: `Saving ${survivors.length} leads to database…`,
    ...stats,
  });

  for (const r of survivors) {
    if (!r.post_id) {
      stats.skipped_missing_post_id_count += 1;
      continue;
    }
    if (!r.url) {
      stats.skipped_missing_url_count += 1;
      continue;
    }

    stats.attempted_inserts += 1;

    const ins = await pool.query(
      `INSERT INTO leads (
        user_id, keyword_set_id, platform, post_id, title, body_snippet, url,
        author, subreddit, relevance_score, upvotes, comment_count, score_reasons
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (user_id, keyword_set_id, post_id) DO NOTHING`,
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
        r.relevance_score,
        Number(r.upvotes) || 0,
        Number(r.comment_count) || 0,
        Array.isArray(r.score_reasons) ? r.score_reasons : [],
      ]
    );

    if (ins.rowCount === 1) {
      stats.inserted_count += 1;
    } else {
      stats.duplicate_count += 1;
    }
  }

  return { stats, inserted: stats.inserted_count, queries, subreddits };
}

function buildCompleteProgress(stats) {
  const inserted = stats.inserted_count || 0;
  return {
    phase: 'complete',
    message:
      inserted > 0
        ? `Scan complete — ${inserted} new lead${inserted === 1 ? '' : 's'} saved`
        : explainZeroLeads(stats),
    completed_at: new Date().toISOString(),
    leads_saved: inserted,
    ...stats,
  };
}

module.exports = {
  runScanPipeline,
  prepareKeywordSetForScan,
  capScanLists,
  emptyStats,
  explainZeroLeads,
  buildCompleteProgress,
};
