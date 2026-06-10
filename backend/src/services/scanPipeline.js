const {
  generateQueries,
  shouldRegenerateQueries,
  getSearchStrategyFromKeywordSet,
  orderSubredditsByPriority,
  shouldRunSubredditQuery,
  resolveScanStrategy,
} = require('./keywordProcessor');
const { shouldSkipByNegativeFilter, qualifyCandidates } = require('./leadQualifier');
const {
  searchRedditStructured,
  searchSubredditStructured,
  getActiveRedditMode,
  sanitizeRedditMessage,
} = require('./redditService');
const { searchHNStructured } = require('./hnService');
const {
  scoreInitialDetailed,
  computeFinalScore,
  buildQualificationReasons,
  leadScoreThreshold,
} = require('./relevanceScorer');
const {
  assertDiagnosticsConsistency,
  countActiveLeadsForScanRun,
  purgeScanRunLeads,
  updateScanRunDiagnostics,
} = require('./scanRunService');

function isHnSearchEnabled() {
  if (process.env.ENABLE_HN_SEARCH === 'false') return false;
  if (process.env.ENABLE_HN_SEARCH === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

function maxLeadsPerRun() {
  const raw = Number(process.env.SCAN_MAX_LEADS_PER_RUN);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 40;
}

function rawCollectionCaps() {
  return {
    maxTotal:
      Number(process.env.SCAN_MAX_RAW_TOTAL) > 0 ? Number(process.env.SCAN_MAX_RAW_TOTAL) : 500,
    maxPerPair:
      Number(process.env.SCAN_MAX_RAW_PER_PAIR) > 0
        ? Number(process.env.SCAN_MAX_RAW_PER_PAIR)
        : 50,
    maxPairs: Number(process.env.SCAN_MAX_PAIRS) > 0 ? Number(process.env.SCAN_MAX_PAIRS) : 30,
  };
}

function appendCollectedItems(collected, items, stats) {
  const { maxTotal, maxPerPair } = rawCollectionCaps();
  const batch = Array.isArray(items) ? items : [];
  stats.raw_seen_total = (stats.raw_seen_total || 0) + batch.length;

  if (collected.length >= maxTotal) {
    stats.raw_truncated = true;
    stats.collection_stopped = true;
    return false;
  }

  const cappedBatch = batch.slice(0, maxPerPair);
  const room = maxTotal - collected.length;
  const toAdd = cappedBatch.slice(0, room);
  collected.push(...toAdd);

  if (batch.length > toAdd.length || collected.length >= maxTotal) {
    stats.raw_truncated = true;
  }
  if (collected.length >= maxTotal) {
    stats.collection_stopped = true;
  }

  stats.collected_raw = collected.length;
  return !stats.collection_stopped;
}

function statsToDiagnostics(stats, options = {}) {
  return assertDiagnosticsConsistency(
    {
    scan_run_id: stats.scan_run_id || null,
    planner_source: stats.planner_source || stats.search_strategy?.planner_source || null,
    planner_model: stats.planner_model || null,
    classifier_source: stats.classifier_source || null,
    classifier_model: stats.classifier_model || null,
    classifier_error: stats.classifier_error || null,
    classifier_attempted: stats.classifier_attempted ?? null,
    classifier_batch_count: stats.classifier_batch_count ?? null,
    classifier_response_parse_error: stats.classifier_response_parse_error || null,
    classifier_duration_ms: stats.classifier_duration_ms ?? null,
    max_leads_per_run: maxLeadsPerRun(),
    query_count: stats.query_count || 0,
    subreddit_count: stats.subreddit_count || 0,
    reddit_raw_count: (stats.raw_global_count || 0) + (stats.raw_subreddit_count || 0),
    hn_raw_count: stats.raw_hn_count || 0,
    raw_seen_total: stats.raw_seen_total ?? stats.collected_raw ?? 0,
    raw_truncated: Boolean(stats.raw_truncated),
    raw_candidates: stats.raw_candidates ?? stats.deduped_count ?? stats.collected_raw ?? 0,
    search_focus: stats.search_focus || null,
    rejection_summary: stats.rejection_summary || null,
    side_counts: stats.side_counts || null,
    deduped_count: stats.deduped_count || 0,
    negative_filtered_count: stats.skipped_negative_count || 0,
    initially_scored_count: stats.initially_scored || 0,
    sent_to_ai_qualification_count: stats.sent_to_ai_qualification_count || 0,
    ai_qualified_count: stats.ai_qualified_count || 0,
    ai_rejected_count: stats.ai_rejected_count || 0,
    rules_qualified_count: stats.semantically_qualified || 0,
    rejected_semantic_count: stats.rejected_semantic_count || 0,
    final_candidates_count: stats.survivors_count || 0,
    attempted_inserts: stats.attempted_inserts || 0,
    inserted_count: stats.inserted_count || 0,
    duplicate_count: stats.duplicate_count || 0,
    skipped_missing_required_fields_count:
      (stats.skipped_missing_url_count || 0) + (stats.skipped_missing_post_id_count || 0),
    threshold_used: stats.threshold_used,
    reddit_mode: stats.reddit_mode,
    errors: stats.errors || [],
    rejected_examples: stats.rejected_examples || [],
    saved_examples: stats.saved_examples || [],
    leads_found: stats.inserted_count || 0,
    collected_raw: stats.collected_raw || 0,
    },
    options
  );
}

function emptyStats(scanRunId = null) {
  return {
    scan_run_id: scanRunId,
    errors: [],
    saved_examples: [],
    reddit_mode: getActiveRedditMode(),
    raw_global_count: 0,
    raw_subreddit_count: 0,
    raw_hn_count: 0,
    reddit_post_count: 0,
    reddit_comment_count: 0,
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
    hn_error_count: 0,
    reddit_auth_error: false,
    last_reddit_error: null,
    last_hn_error: null,
    query_warning: null,
    threshold_used: leadScoreThreshold(),
    low_confidence_candidates: [],
    skipped_negative_count: 0,
    skipped_food_sub_pairs: 0,
    raw_candidates: 0,
    initially_scored: 0,
    semantically_qualified: 0,
    rejected_semantic_count: 0,
    rejected_examples: [],
    search_strategy: null,
    raw_seen_total: 0,
    raw_truncated: false,
    collection_stopped: false,
    search_focus: null,
    rejection_summary: null,
    side_counts: null,
  };
}

async function prepareKeywordSetForScan(pool, keywordSet) {
  let queries = Array.isArray(keywordSet.queries) ? keywordSet.queries.filter(Boolean) : [];
  let subreddits = Array.isArray(keywordSet.subreddits)
    ? keywordSet.subreddits.filter(Boolean)
    : [];

  const forceRegen = process.env.FORCE_REGENERATE_QUERIES === 'true';
  const missing = !queries.length || !subreddits.length;

  let queryWarning = null;
  if (!missing && !forceRegen && shouldRegenerateQueries(queries, keywordSet.product_description)) {
    queryWarning =
      'Stored queries look generic or off-domain. Keeping existing queries. Set FORCE_REGENERATE_QUERIES=true to refresh.';
  }

  if (forceRegen || missing) {
    const g = await generateQueries(keywordSet.product_description, {
      search_focus: keywordSet.search_focus,
    });
    queries = g.queries || [];
    subreddits = g.subreddits || [];
    const searchBrief = g.search_brief || null;

    if (pool && keywordSet.id) {
      const { rows } = await pool.query(
        `UPDATE keyword_sets
         SET queries = $2::jsonb, subreddits = $3::jsonb, search_brief = $4::jsonb
         WHERE id = $1
         RETURNING *`,
        [
          keywordSet.id,
          JSON.stringify(queries),
          JSON.stringify(subreddits),
          JSON.stringify(searchBrief || {}),
        ]
      );
      if (rows[0]) {
        console.log(
          `[scan] regenerated queries for keywordSetId=${keywordSet.id} (${queries.length} queries, ${subreddits.length} subs)`
        );
        const strat = resolveScanStrategy(
          rows[0].search_brief || searchBrief || {},
          rows[0].search_focus
        );
        rows[0].queries = strat.queries;
        rows[0].subreddits = strat.subreddits;
        rows[0].search_brief = strat.search_brief;
        rows[0]._query_warning = queryWarning;
        return rows[0];
      }
    }
    const strat = resolveScanStrategy(searchBrief || {}, keywordSet.search_focus);
    return {
      ...keywordSet,
      queries: strat.queries,
      subreddits: strat.subreddits,
      search_brief: strat.search_brief,
      _query_warning: queryWarning,
    };
  }

  const strat = resolveScanStrategy(keywordSet.search_brief || {}, keywordSet.search_focus);
  return {
    ...keywordSet,
    queries: strat.queries.length ? strat.queries : keywordSet.queries,
    subreddits: strat.subreddits.length ? strat.subreddits : keywordSet.subreddits,
    search_brief: strat.search_brief,
    _query_warning: queryWarning,
  };
}

function capScanLists(queries, subreddits) {
  const devDefaults = process.env.NODE_ENV !== 'production';
  const { maxPairs } = rawCollectionCaps();
  const maxQ =
    Number(process.env.SCAN_MAX_QUERIES) > 0
      ? Number(process.env.SCAN_MAX_QUERIES)
      : devDefaults
        ? 8
        : 10;
  const maxS =
    Number(process.env.SCAN_MAX_SUBREDDITS) > 0
      ? Number(process.env.SCAN_MAX_SUBREDDITS)
      : devDefaults
        ? 6
        : 8;

  let qs = queries.slice(0, maxQ);
  let ss = subreddits.slice(0, maxS);
  while (qs.length * ss.length > maxPairs && (qs.length > 1 || ss.length > 1)) {
    if (qs.length >= ss.length && qs.length > 1) qs = qs.slice(0, -1);
    else if (ss.length > 1) ss = ss.slice(0, -1);
    else break;
  }

  return { queries: qs, subreddits: ss, pairs_budget: maxPairs };
}

function recordRedditError(stats, error) {
  stats.reddit_error_count += 1;
  stats.last_reddit_error = sanitizeRedditMessage(
    error?.message || String(error || 'Reddit error')
  );
  if (error?.code === 'REDDIT_BLOCKED' || error?.code === 'REDDIT_AUTH_FAILED') {
    stats.reddit_auth_error = true;
  }
}

function applyRedditMeta(stats, meta) {
  if (!meta) return;
  stats.reddit_post_count += Number(meta.post_count || 0);
  stats.reddit_comment_count += Number(meta.comment_count || 0);
}

async function fetchGlobal(query, stats) {
  const result = await searchRedditStructured(query);
  if (result.ok) {
    stats.raw_global_count += result.items.length;
    applyRedditMeta(stats, result.meta);
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
    applyRedditMeta(stats, result.meta);
    return result.items;
  }
  recordRedditError(stats, result.error);
  if (result.error?.code === 'REDDIT_BLOCKED' || result.error?.code === 'REDDIT_AUTH_FAILED') {
    throw Object.assign(new Error(result.error.message), { redditError: result.error });
  }
  return [];
}

async function fetchHN(query, stats) {
  const result = await searchHNStructured(query);
  if (result.ok) {
    stats.raw_hn_count += result.items.length;
    if (result.meta) {
      stats.hn_story_count = (stats.hn_story_count || 0) + Number(result.meta.story_count || 0);
      stats.hn_comment_count = (stats.hn_comment_count || 0) + Number(result.meta.comment_count || 0);
    }
    return result.items;
  }
  stats.hn_error_count += 1;
  stats.last_hn_error = result.error?.message || 'HN search failed';
  return [];
}

function buildSurvivors(scored, keywordSet, stats) {
  const threshold = stats.threshold_used;
  const cap = maxLeadsPerRun();

  const confirmed = scored
    .filter((r) => r.qualification?.is_lead === true && r.relevance_score >= threshold)
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  let survivors = confirmed.slice(0, cap);
  stats.qualified_for_insert_count = confirmed.length;

  const allowDebug =
    process.env.SAVE_LOW_CONFIDENCE_DEBUG === 'true' &&
    survivors.length === 0 &&
    scored.length > 0;

  if (allowDebug) {
    survivors = scored
      .filter((r) => r.relevance_score >= 20)
      .slice(0, 5)
      .map((r) => ({
        ...r,
        score_reasons: [
          ...(r.score_reasons || []),
          'Debug candidate — not a confirmed lead.',
        ],
      }));
  }

  stats.filtered_out_count = scored.length - survivors.length;
  stats.survivors_count = survivors.length;

  const rejectedSamples = scored
    .filter((r) => !r.qualification?.is_lead)
    .slice(0, 12)
    .map((r) => ({
      title: (r.title || r.body_snippet || '').slice(0, 100),
      subreddit: r.subreddit,
      reject_reason: r.qualification?.reject_reason || 'Not a lead',
    }));

  stats.low_confidence_candidates = rejectedSamples;

  return survivors;
}

function buildRejectionSummary(stats, keywordSet) {
  const parts = [];
  if (stats.rejection_summary) return stats.rejection_summary;

  const focus = stats.search_focus || keywordSet?.search_focus || 'demand_side';
  if (focus === 'supply_side') {
    parts.push('Scan targeted the supply/provider side; posts may not match demand-side lead criteria.');
  } else if (focus === 'demand_side') {
    parts.push('Scan targeted the demand/buyer side of the market.');
  }

  if (stats.qualification_skipped_reason) {
    parts.push(stats.qualification_skipped_reason);
  }

  if (stats.classifier_source === 'fallback' && stats.classifier_error) {
    parts.push(
      `AI classifier unavailable (${stats.classifier_error}); conservative rules rejected candidates.`
    );
  } else if (stats.classifier_source === 'ai' && stats.rejected_semantic_count > 0) {
    parts.push(
      `${stats.rejected_semantic_count} candidates reviewed by AI and rejected against the search brief.`
    );
  }

  if (stats.raw_truncated && stats.raw_seen_total > stats.collected_raw) {
    parts.push(
      `${stats.raw_seen_total} posts seen, capped to ${stats.collected_raw} for scoring.`
    );
  }

  if (stats.rejected_examples?.length) {
    const sample = stats.rejected_examples[0]?.reject_reason;
    if (sample) parts.push(`Example rejection: ${sample}`);
  }

  return parts.length ? parts.join(' ') : 'No candidates matched the AI lead definition for this monitor.';
}

function explainZeroLeads(stats) {
  if (stats.rejection_summary) {
    return `Scan complete — no qualified leads found. ${stats.rejection_summary}`;
  }
  if (stats.reddit_auth_error) {
    return 'Reddit blocked this server (network security). Check PROXY_LIST and Webshare proxy credentials on signal-worker-web.';
  }
  if (stats.collected_raw === 0) {
    if (stats.reddit_error_count > 0 || stats.hn_error_count > 0) {
      return `0 raw results (${stats.reddit_error_count} Reddit errors, ${stats.hn_error_count} HN errors). ${stats.last_reddit_error || stats.last_hn_error || ''}`;
    }
    return '0 raw results from Reddit and HN. Check worker logs and run npm run compare:scan.';
  }
  if (stats.deduped_count === 0) {
    return 'Results returned but none had valid post_id after dedupe.';
  }
  if (stats.survivors_count === 0 && stats.scored_count > 0) {
    return `Found ${stats.collected_raw} raw (${stats.raw_global_count} Reddit global, ${stats.raw_subreddit_count} subreddit, ${stats.raw_hn_count} HN). ${stats.scored_count} scored, 0 passed threshold ${stats.threshold_used}.`;
  }
  if (stats.survivors_count > 0 && stats.inserted_count === 0) {
    return `${stats.survivors_count} candidates passed scoring but 0 inserted (${stats.duplicate_count} duplicates, ${stats.skipped_missing_url_count} missing URL).`;
  }
  return 'Scan complete with 0 new leads saved.';
}

function dedupeCollected(collected, stats) {
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
  stats.raw_candidates = deduped.length;
  return deduped;
}

let suppressionCache = { userId: null, postIds: null };

async function loadSuppressedPostIds(pool, userId) {
  if (!pool || !userId) return new Set();
  if (suppressionCache.userId === userId && suppressionCache.postIds) {
    return suppressionCache.postIds;
  }
  try {
    const { rows } = await pool.query(
      `SELECT post_id FROM thread_suppressions
       WHERE user_id = $1
         AND (kind = 'mute' OR (kind = 'snooze' AND snooze_until > NOW()))`,
      [userId]
    );
    const postIds = new Set(rows.map((row) => row.post_id));
    suppressionCache = { userId, postIds };
    return postIds;
  } catch (err) {
    console.warn('[scan] thread_suppressions skipped:', err?.message || err);
    return new Set();
  }
}

function applyNegativeFilters(collected, keywordSet, stats) {
  const kept = [];
  for (const item of collected) {
    const skip = shouldSkipByNegativeFilter(item, keywordSet);
    if (skip.skip) {
      stats.skipped_negative_count += 1;
      if (stats.low_confidence_candidates.length < 20) {
        stats.low_confidence_candidates.push({
          post_id: item?.post_id,
          title: (item?.title || item?.body_snippet || '').slice(0, 100),
          relevance_score: 0,
          reject_reason: skip.reason,
        });
      }
      continue;
    }
    kept.push(item);
  }
  return kept;
}

async function scoreAndQualify(collected, pool, keywordSet, stats) {
  if (!keywordSet?.id && pool) return { survivors: [], scored: [] };

  const filtered = applyNegativeFilters(collected, keywordSet, stats);
  const deduped = dedupeCollected(filtered, stats);
  stats.raw_candidates = deduped.length;

  const suppressed = await loadSuppressedPostIds(pool, keywordSet.user_id);
  const afterSuppression = deduped.filter((r) => !suppressed.has(r.post_id));
  stats.suppressed_count = deduped.length - afterSuppression.length;

  const scoredInitial = afterSuppression
    .map((r) => {
      const detail = scoreInitialDetailed(r, keywordSet);
      return {
        ...r,
        initial_score: detail.score,
        initial_reasons: detail.reasons,
      };
    })
    .sort((a, b) => b.initial_score - a.initial_score);

  stats.initially_scored = scoredInitial.length;

  const cheapFloor =
    Number(process.env.SCAN_QUALIFY_FLOOR) > 0 ? Number(process.env.SCAN_QUALIFY_FLOOR) : 8;
  const maxQual =
    Number(process.env.MAX_QUALIFICATION_CANDIDATES) > 0
      ? Number(process.env.MAX_QUALIFICATION_CANDIDATES)
      : 80;

  const topForQualification = scoredInitial
    .filter((r) => r.initial_score >= cheapFloor)
    .slice(0, maxQual);

  if (!topForQualification.length && scoredInitial.length > 0) {
    stats.qualification_skipped_reason = `No candidates met the initial score floor (${cheapFloor}) for AI review.`;
  }

  const qualifiedBatch = await qualifyCandidates(topForQualification, keywordSet, stats);
  const qualMap = new Map(qualifiedBatch.map((r) => [r.post_id, r]));

  const scored = scoredInitial.map((r) => {
    const reviewed = qualMap.get(r.post_id);
    const qualification = reviewed?.qualification || {
      is_lead: false,
      confidence: 0,
      reject_reason: 'Not reviewed (below initial score cutoff for semantic qualification).',
    };

    if (!qualification.is_lead) {
      stats.rejected_semantic_count += 1;
      if (stats.rejected_examples.length < 15 && reviewed) {
        stats.rejected_examples.push({
          title: (r.title || r.body_snippet || '').slice(0, 100),
          subreddit: r.subreddit,
          reject_reason: qualification.reject_reason,
        });
      }
    } else {
      stats.semantically_qualified += 1;
    }

    const relevance_score = computeFinalScore(r.initial_score, qualification);
    const score_reasons = buildQualificationReasons(qualification, r.initial_score);
    score_reasons.push(`Final score: ${relevance_score} (threshold ${stats.threshold_used}).`);

    return {
      ...r,
      qualification,
      relevance_score,
      score_reasons,
      score_meta: {
        qualified: qualification.is_lead,
        initial_score: r.initial_score,
        confidence: qualification.confidence,
        reject_reason: qualification.reject_reason,
        classifier: qualification.classifier || 'rules',
      },
    };
  });

  stats.scored_count = scored.length;
  const survivors = buildSurvivors(scored, keywordSet, stats);
  stats.final_candidates_count = survivors.length;
  stats.rules_qualified_count = stats.semantically_qualified;
  stats.rejection_summary = buildRejectionSummary(stats, keywordSet);

  if (!pool) {
    stats.diagnostic_summary = formatDiagnosticSummary(stats);
    return { survivors, scored };
  }

  return { survivors, scored };
}

async function syncInsertedCountFromDb(pool, stats) {
  if (!pool || !stats?.scan_run_id) return stats?.inserted_count || 0;
  const dbCount = await countActiveLeadsForScanRun(pool, stats.scan_run_id);
  stats.inserted_count = dbCount;
  stats.leads_found = dbCount;
  return dbCount;
}

async function insertFinalLeads(survivors, pool, keywordSet, stats) {
  if (!pool) return;

  const cap = maxLeadsPerRun();
  const toInsert = (survivors || []).slice(0, cap);
  if (!toInsert.length) {
    stats.inserted_count = 0;
    stats.leads_found = 0;
    return;
  }

  for (const r of toInsert) {
    if (!r.post_id) {
      stats.skipped_missing_post_id_count += 1;
      continue;
    }
    if (!r.url) {
      stats.skipped_missing_url_count += 1;
      continue;
    }

    stats.attempted_inserts += 1;

    const qualJson = r.qualification
      ? {
          qualification_source:
            r.qualification.qualification_source || r.qualification.classifier || 'unknown',
          source: r.qualification.classifier || r.score_meta?.classifier || 'unknown',
          confidence: r.qualification.confidence,
          lead_type: r.qualification.lead_type,
          recommended_visibility: r.qualification.recommended_visibility,
          evidence: r.qualification.evidence,
          reject_reason: r.qualification.reject_reason,
          matched_required_evidence: r.qualification.matched_required_concepts,
          matched_positive_patterns: r.qualification.matched_positive_patterns,
          disqualifying_evidence_checked: r.qualification.disqualifying_evidence_checked,
        }
      : {};

    const leadType = r.qualification?.lead_type || 'direct_demand';
    const recommendedVisibility =
      r.qualification?.recommended_visibility || (r.qualification?.is_lead ? 'show' : 'hide');

    const ins = await pool.query(
      `INSERT INTO leads (
        user_id, keyword_set_id, platform, post_id, title, body_snippet, url,
        author, subreddit, relevance_score, upvotes, comment_count, score_reasons,
        scan_run_id, qualification, lead_type, recommended_visibility, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, true)
      ON CONFLICT (user_id, keyword_set_id, post_id) DO UPDATE SET
        relevance_score = EXCLUDED.relevance_score,
        score_reasons = EXCLUDED.score_reasons,
        qualification = EXCLUDED.qualification,
        lead_type = EXCLUDED.lead_type,
        recommended_visibility = EXCLUDED.recommended_visibility,
        scan_run_id = EXCLUDED.scan_run_id,
        is_active = true
      RETURNING id, (xmax = 0) AS is_new_insert`,
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
        stats.scan_run_id || null,
        JSON.stringify(qualJson),
        leadType,
        recommendedVisibility,
      ]
    );

    if (ins.rows[0]?.is_new_insert) {
      stats.inserted_count += 1;
      if (stats.saved_examples.length < 8) {
        stats.saved_examples.push({
          title: (r.title || '').slice(0, 100),
          subreddit: r.subreddit,
          evidence: qualJson.evidence,
        });
      }
    } else if (ins.rowCount === 1) {
      stats.updated_count = (stats.updated_count || 0) + 1;
    } else {
      stats.duplicate_count += 1;
    }
  }

  await syncInsertedCountFromDb(pool, stats);

  if (stats.inserted_count > cap) {
    throw new Error(
      `Lead cap violated: inserted ${stats.inserted_count}, max ${cap}`
    );
  }

  stats.diagnostic_summary = formatDiagnosticSummary(stats);
}

function formatDiagnosticSummary(stats) {
  const d = statsToDiagnostics(stats);
  const src = d.classifier_source ? `Classifier: ${d.classifier_source}` : '';
  const plan = d.planner_source ? `Planner: ${d.planner_source}` : '';
  const focus = d.search_focus ? `Focus: ${d.search_focus}` : '';
  const rawLine =
    d.raw_truncated && d.raw_seen_total > d.raw_candidates
      ? `${d.raw_seen_total} seen, capped to ${d.raw_candidates} for scoring`
      : `${d.raw_candidates} raw`;
  return (
    `This scan: ${rawLine} → ${d.initially_scored_count} ranked → ${d.inserted_count} saved ` +
    `(${d.rejected_semantic_count} rejected, ${d.negative_filtered_count} pre-filtered). ` +
    `${plan}${plan && src ? '; ' : ''}${src}${focus ? `; ${focus}` : ''}. Mode: ${d.reddit_mode}.`
  );
}

async function runScanPipeline(keywordSet, options = {}) {
  const pool = options.pool;
  const insertLeads = options.insertLeads !== false;
  const onProgress = options.onProgress || (async () => {});

  const stats = emptyStats(options.scanRunId || null);
  const brief = keywordSet?.search_brief || {};
  stats.planner_source = brief.planner_source || brief._source || null;
  stats.planner_model = brief.planner_model || brief._planner_model || null;
  suppressionCache = { userId: null, postIds: null };
  const prepared = pool ? await prepareKeywordSetForScan(pool, keywordSet) : keywordSet;
  stats.query_warning = prepared._query_warning || null;

  const orderedSubs = orderSubredditsByPriority(prepared.subreddits || [], prepared);
  const { queries, subreddits } = capScanLists(prepared.queries || [], orderedSubs);
  keywordSet = prepared;
  stats.query_count = queries.length;
  stats.subreddit_count = subreddits.length;
  stats.search_strategy = getSearchStrategyFromKeywordSet(keywordSet);
  stats.search_focus =
    keywordSet.search_focus || brief.search_focus || brief.primary_side || 'demand_side';
  const collected = [];
  const hnEnabled = isHnSearchEnabled();
  const caps = rawCollectionCaps();

  const pushProgress = async (payload) => {
    Object.assign(stats, payload);
    stats.raw_candidates = stats.collected_raw ?? stats.raw_candidates;
    const diagnostics = statsToDiagnostics(stats);
    if (pool && stats.scan_run_id) {
      await updateScanRunDiagnostics(pool, stats.scan_run_id, diagnostics);
    }
    await onProgress({
      ...stats,
      ...diagnostics,
      diagnostics,
      scan_progress: { ...stats, diagnostics },
    });
  };

  await pushProgress({
    phase: 'starting',
    message: `Starting scan (${stats.reddit_mode}${hnEnabled ? ' + HN' : ''}): ${queries.length} queries, ${subreddits.length} subreddits`,
    queries_total: queries.length,
    subreddits_total: subreddits.length,
    hn_enabled: hnEnabled,
    search_strategy: stats.search_strategy,
  });

  for (let i = 0; i < queries.length && !stats.collection_stopped; i += 1) {
    const q = queries[i];
    await pushProgress({
      phase: 'reddit_global',
      message: `Reddit global: "${String(q).slice(0, 80)}"`,
      query_index: i + 1,
      queries_total: queries.length,
      collected_raw: collected.length,
      raw_seen_total: stats.raw_seen_total,
      ...stats,
    });
    appendCollectedItems(collected, await fetchGlobal(q, stats), stats);

    if (hnEnabled && !stats.collection_stopped) {
      await pushProgress({
        phase: 'hn',
        message: `HN: "${String(q).slice(0, 80)}"`,
        query_index: i + 1,
        collected_raw: collected.length,
        raw_seen_total: stats.raw_seen_total,
        ...stats,
      });
      appendCollectedItems(collected, await fetchHN(q, stats), stats);
    }
  }

  let pairIdx = 0;
  const pairTotal = Math.min(subreddits.length * queries.length, caps.maxPairs);

  for (const sub of subreddits) {
    if (stats.collection_stopped || pairIdx >= caps.maxPairs) break;
    for (let j = 0; j < queries.length; j += 1) {
      if (stats.collection_stopped || pairIdx >= caps.maxPairs) break;
      const q = queries[j];
      if (!shouldRunSubredditQuery(sub, q, keywordSet)) {
        stats.skipped_food_sub_pairs = (stats.skipped_food_sub_pairs || 0) + 1;
        continue;
      }
      pairIdx += 1;
      await pushProgress({
        phase: 'subreddit',
        message: `r/${sub}: "${String(q).slice(0, 72)}" (${pairIdx}/${pairTotal})`,
        subreddit: sub,
        pair_index: pairIdx,
        pairs_total: pairTotal,
        collected_raw: collected.length,
        raw_seen_total: stats.raw_seen_total,
        ...stats,
      });
      appendCollectedItems(collected, await fetchSubreddit(sub, q, stats), stats);
    }
  }

  await onProgress({ phase: 'dedupe', message: `Final scoring on ${collected.length} raw…`, ...stats });

  if (!insertLeads || !pool) {
    await scoreAndQualify(collected, null, keywordSet, stats);
    return { stats, inserted: stats.inserted_count, queries, subreddits };
  }

  await pushProgress({
    phase: 'qualify',
    message: `Qualifying ${collected.length} candidates…`,
    collected_raw: collected.length,
  });

  const { survivors } = await scoreAndQualify(collected, pool, keywordSet, stats);

  await pushProgress({
    phase: 'persist',
    message: `Saving up to ${maxLeadsPerRun()} leads (${survivors.length} qualified)…`,
    collected_raw: collected.length,
    survivors_count: survivors.length,
  });

  if (stats.scan_run_id) {
    await purgeScanRunLeads(pool, stats.scan_run_id);
  }

  stats.inserted_count = 0;
  stats.attempted_inserts = 0;
  stats.updated_count = 0;
  stats.duplicate_count = 0;
  await insertFinalLeads(survivors, pool, keywordSet, stats);
  await syncInsertedCountFromDb(pool, stats);

  const cap = maxLeadsPerRun();
  if (stats.inserted_count > cap) {
    throw new Error(
      `Lead cap violated: inserted ${stats.inserted_count}, max ${cap}`
    );
  }

  const completeMsg =
    stats.inserted_count > 0
      ? `Scan complete — ${stats.inserted_count} lead${stats.inserted_count === 1 ? '' : 's'} saved.`
      : explainZeroLeads(stats);

  await pushProgress({
    phase: 'complete',
    message: completeMsg,
    diagnostic_summary: formatDiagnosticSummary(stats),
    rejection_summary: stats.rejection_summary,
    completed_at: new Date().toISOString(),
    leads_saved: stats.inserted_count,
    leads_found: stats.inserted_count,
  });

  return { stats, inserted: stats.inserted_count, queries, subreddits };
}

function buildCompleteProgress(stats, options = {}) {
  const diagnostics = statsToDiagnostics(stats, {
    strict: options.strict !== false,
    status: 'complete',
  });
  const inserted = diagnostics.inserted_count || 0;
  const summary = stats.diagnostic_summary || formatDiagnosticSummary(stats);
  return {
    phase: 'complete',
    message:
      inserted > 0
        ? `Scan complete — ${inserted} new lead${inserted === 1 ? '' : 's'} saved. ${summary}`
        : `${explainZeroLeads(stats)} ${summary}`,
    completed_at: new Date().toISOString(),
    leads_saved: inserted,
    leads_found: inserted,
    diagnostic_summary: summary,
    diagnostics,
    ...stats,
    ...diagnostics,
  };
}

module.exports = {
  runScanPipeline,
  prepareKeywordSetForScan,
  capScanLists,
  emptyStats,
  explainZeroLeads,
  buildCompleteProgress,
  formatDiagnosticSummary,
  buildSurvivors,
  isHnSearchEnabled,
  maxLeadsPerRun,
  scoreAndQualify,
  insertFinalLeads,
  syncInsertedCountFromDb,
};
