require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { generateQueries } = require('../services/keywordProcessor');
const {
  searchRedditPublicStructured,
  searchSubredditPublicStructured,
  searchRedditOAuthStructured,
  searchSubredditOAuthStructured,
  oauthCredentialsPresent,
  getActiveRedditMode,
} = require('../services/redditService');
const { searchHNStructured } = require('../services/hnService');
const { scoreResultDetailed, leadScoreThreshold } = require('../services/relevanceScorer');
const { capScanLists, buildSurvivors } = require('../services/scanPipeline');

function parseArgs() {
  const args = process.argv.slice(2);
  let description = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--description' && args[i + 1]) {
      description = args[i + 1];
      i += 1;
    }
  }
  if (!description) {
    console.error('Usage: npm run compare:scan -- --description "your product description"');
    process.exit(1);
  }
  return description;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.post_id) continue;
    if (seen.has(item.post_id)) continue;
    seen.add(item.post_id);
    out.push(item);
  }
  return out;
}

function filterReason(candidate, keywordSet, threshold, scoreFloor) {
  const score = candidate.relevance_score;
  const reasons = [];

  if (!candidate.post_id) reasons.push('missing post_id');
  if (!candidate.url) reasons.push('missing url');

  if (score < scoreFloor) {
    reasons.push(`score ${score} below floor ${scoreFloor}`);
  } else if (score < threshold) {
    reasons.push(`score ${score} below threshold ${threshold} (may still rank in top-N)`);
  }

  if (reasons.length === 0) return 'passed threshold';
  return reasons.join('; ');
}

async function main() {
  const description = parseArgs();
  // generateQueries is async
  const generated = await generateQueries(description);

  const compareMaxQ =
    Number(process.env.COMPARE_MAX_QUERIES) > 0
      ? Number(process.env.COMPARE_MAX_QUERIES)
      : Number(process.env.SCAN_MAX_QUERIES) > 0
        ? Number(process.env.SCAN_MAX_QUERIES)
        : 5;
  const compareMaxS =
    Number(process.env.COMPARE_MAX_SUBREDDITS) > 0
      ? Number(process.env.COMPARE_MAX_SUBREDDITS)
      : Number(process.env.SCAN_MAX_SUBREDDITS) > 0
        ? Number(process.env.SCAN_MAX_SUBREDDITS)
        : 3;

  const queries = generated.queries.slice(0, compareMaxQ);
  const subreddits = generated.subreddits.slice(0, compareMaxS);

  if (queries.length < generated.queries.length || subreddits.length < generated.subreddits.length) {
    console.log(
      `\n(Using first ${queries.length}/${generated.queries.length} queries, ${subreddits.length}/${generated.subreddits.length} subs — set COMPARE_MAX_QUERIES for full sweep)\n`
    );
  }

  const keywordSet = {
    product_description: description,
    queries,
    subreddits,
  };

  console.log('\n=== Scan source comparison ===\n');
  console.log('Domain:', generated.domain);
  console.log('Active worker REDDIT_MODE:', getActiveRedditMode());
  console.log('OAuth credentials present:', oauthCredentialsPresent());
  console.log('\nGenerated queries (' + queries.length + '):');
  queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log('\nGenerated subreddits (' + subreddits.length + '):');
  subreddits.forEach((s) => console.log(`  r/${s}`));

  let rawGlobal = 0;
  let rawSubreddit = 0;
  let rawHn = 0;
  let hnStoryCount = 0;
  let hnCommentCount = 0;
  let rawOauthGlobal = 0;
  let redditPostCount = 0;
  let redditCommentCount = 0;
  const collected = [];

  for (const q of queries) {
    const pub = await searchRedditPublicStructured(q);
    if (pub.ok) {
      rawGlobal += pub.items.length;
      collected.push(...pub.items.map((i) => ({ ...i, _source: 'reddit_public_global' })));
      redditPostCount += Number(pub.meta?.post_count || 0);
      redditCommentCount += Number(pub.meta?.comment_count || 0);
    } else {
      console.warn(`[public global] "${q}":`, pub.error?.message);
    }

    if (oauthCredentialsPresent()) {
      const oauth = await searchRedditOAuthStructured(q);
      if (oauth.ok) rawOauthGlobal += oauth.items.length;
    }

    const hn = await searchHNStructured(q);
    if (hn.ok) {
      rawHn += hn.items.length;
      hnStoryCount += Number(hn.meta?.story_count || 0);
      hnCommentCount += Number(hn.meta?.comment_count || 0);
      collected.push(...hn.items.map((i) => ({ ...i, _source: 'hackernews' })));
    }
  }

  for (const sub of subreddits) {
    for (const q of queries) {
      const pub = await searchSubredditPublicStructured(sub, q);
      if (pub.ok) {
        rawSubreddit += pub.items.length;
        collected.push(...pub.items.map((i) => ({ ...i, _source: `reddit_public_r/${sub}` })));
        redditPostCount += Number(pub.meta?.post_count || 0);
        redditCommentCount += Number(pub.meta?.comment_count || 0);
      }
    }
  }

  const deduped = dedupeItems(collected);
  const threshold = leadScoreThreshold();
  const scoreFloor = Number(process.env.SCAN_SCORE_FLOOR) > 0 ? Number(process.env.SCAN_SCORE_FLOOR) : 5;

  const scored = deduped
    .map((r) => {
      const detail = scoreResultDetailed(r, keywordSet);
      return {
        ...r,
        relevance_score: detail.score,
        score_reasons: detail.reasons,
        score_meta: detail.meta,
      };
    })
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const stats = {
    threshold_used: threshold,
    collected_raw: collected.length,
    deduped_count: deduped.length,
    scored_count: scored.length,
    inserted_count: 0,
    duplicate_count: 0,
    filtered_out_count: 0,
    survivors_count: 0,
  };

  const survivors = buildSurvivors(scored, keywordSet, stats);

  const wouldInsert = survivors.filter(
    (r) => r.post_id && r.url && r.relevance_score >= scoreFloor
  );

  console.log('\n--- Counts ---');
  console.log('raw_global_count (public JSON):', rawGlobal);
  console.log('raw_subreddit_count (public JSON):', rawSubreddit);
  console.log('raw_oauth_global_count (if creds):', oauthCredentialsPresent() ? rawOauthGlobal : 'n/a');
  console.log('hn_count:', rawHn, `(stories: ${hnStoryCount}, comments: ${hnCommentCount})`);
  console.log('reddit_post_count:', redditPostCount);
  console.log('reddit_comment_count:', redditCommentCount);
  console.log('collected_raw (all sources, with dupes):', collected.length);
  console.log('deduped_count:', deduped.length);
  console.log('scored_count:', scored.length);
  console.log('survivors_count (threshold/top-N/candidate mode):', stats.survivors_count);
  console.log('would_insert_count (has url+post_id, score>=floor):', wouldInsert.length);
  console.log('filtered_out_count:', stats.filtered_out_count);
  console.log('threshold:', threshold, '| score_floor:', scoreFloor);

  if (oauthCredentialsPresent() && rawOauthGlobal < rawGlobal) {
    console.log('\nNote: OAuth global returned FEWER than public JSON for these queries.');
  } else if (oauthCredentialsPresent() && rawOauthGlobal > rawGlobal) {
    console.log('\nNote: OAuth global returned MORE than public JSON for these queries.');
  }

  if (rawHn === 0) {
    console.log('\nNote: HN returned 0 — ENABLE_HN_SEARCH or Algolia may be empty for these queries.');
  }

  console.log('\n--- Top 15 scored candidates ---');
  scored.slice(0, 15).forEach((c, i) => {
    const snippet = (c.title || c.body_snippet || '').slice(0, 100).replace(/\s+/g, ' ');
    console.log(`\n#${i + 1} score=${c.relevance_score} source=${c.platform || c._source}`);
    console.log(`   subreddit=${c.subreddit || '—'} post_id=${c.post_id}`);
    console.log(`   ${snippet}`);
    console.log(`   filter: ${filterReason(c, keywordSet, threshold, scoreFloor)}`);
    if (c.score_meta) {
      console.log(
        `   meta: query_terms=[${(c.score_meta.matched_query_terms || []).join(', ')}] intent=[${(c.score_meta.intent_hits || []).slice(0, 3).join(', ')}]`
      );
    }
  });

  console.log('\n--- Bottleneck hint ---');
  if (collected.length === 0) {
    console.log('Drop is at RAW COLLECTION (0 results from all sources).');
  } else if (deduped.length < collected.length * 0.5) {
    console.log('Many duplicates before scoring — dedupe removed', collected.length - deduped.length, 'items.');
  } else if (stats.survivors_count === 0 && scored.length > 0) {
    console.log('Drop is at SCORING/FILTERING — candidates exist but none passed threshold', threshold);
  } else if (wouldInsert.length > 0) {
    console.log('Pipeline would save', wouldInsert.length, 'leads (DB duplicates not measured here).');
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
