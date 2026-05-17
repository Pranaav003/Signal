require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { runScanPipeline, explainZeroLeads } = require('../services/scanPipeline');
const { validateRedditCredentials } = require('../services/redditService');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { keywordSetId: null, description: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--keyword-set-id' && args[i + 1]) {
      out.keywordSetId = args[i + 1];
      i += 1;
    } else if (args[i] === '--description' && args[i + 1]) {
      out.description = args[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const { keywordSetId, description } = parseArgs();

  const auth = await validateRedditCredentials();
  if (!auth.ok) {
    console.error('Reddit auth failed:', auth.error?.message);
    process.exit(1);
  }

  let keywordSet;
  if (keywordSetId) {
    const { rows } = await pool.query('SELECT * FROM keyword_sets WHERE id = $1', [
      keywordSetId,
    ]);
    if (!rows.length) {
      console.error('keyword_set not found:', keywordSetId);
      process.exit(1);
    }
    keywordSet = rows[0];
  } else if (description) {
    const g = generateQueries(description);
    keywordSet = {
      id: '00000000-0000-0000-0000-000000000001',
      user_id: null,
      product_description: description,
      queries: g.queries,
      subreddits: g.subreddits,
    };
  } else {
    console.error(
      'Usage: npm run test:scan -- --description "..." OR --keyword-set-id <uuid>'
    );
    process.exit(1);
  }

  console.log('\n=== Scan pipeline test ===\n');
  console.log('Product:', keywordSet.product_description?.slice(0, 120), '...\n');

  const prepared = await require('../services/scanPipeline').prepareKeywordSetForScan(
    pool,
    keywordSet
  );
  const { queries, subreddits } = require('../services/scanPipeline').capScanLists(
    prepared.queries || [],
    prepared.subreddits || []
  );

  console.log('Queries:');
  queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  console.log('\nSubreddits:');
  subreddits.forEach((s, i) => console.log(`  ${i + 1}. r/${s}`));

  const { stats } = await runScanPipeline(keywordSet, {
    pool: keywordSet.user_id ? pool : null,
    insertLeads: Boolean(keywordSet.user_id),
    onProgress: async (p) => {
      if (p.phase === 'reddit_global' || p.phase === 'subreddit' || p.phase === 'score') {
        console.log(`  [${p.phase}] ${p.message}`);
      }
    },
  });

  console.log('\n--- Reddit ---');
  console.log('global results:', stats.raw_global_count);
  console.log('subreddit results:', stats.raw_subreddit_count);
  console.log('raw total:', stats.collected_raw);

  console.log('\n--- Dedupe ---');
  console.log('deduped:', stats.deduped_count);
  console.log('suppressed:', stats.suppressed_count);

  console.log('\n--- Scoring ---');
  console.log('threshold:', stats.threshold_used);
  console.log('scored:', stats.scored_count);
  console.log('survivors:', stats.survivors_count);
  console.log('filtered_out:', stats.filtered_out_count);

  if (stats.low_confidence_candidates?.length) {
    console.log('\nTop candidates:');
    stats.low_confidence_candidates.forEach((c, i) => {
      console.log(
        `  ${i + 1}. score ${c.relevance_score} | r/${c.subreddit} | ${c.title}`
      );
    });
  }

  console.log('\n--- Saving ---');
  console.log('attempted:', stats.attempted_inserts);
  console.log('inserted:', stats.inserted_count);
  console.log('duplicates:', stats.duplicate_count);
  console.log('skipped missing url:', stats.skipped_missing_url_count);
  console.log('reddit errors:', stats.reddit_error_count);
  if (stats.last_reddit_error) console.log('last reddit error:', stats.last_reddit_error);

  if (stats.inserted_count === 0) {
    console.log('\nWhy 0 leads:', explainZeroLeads(stats));
  }

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch (_e) {
    /* ignore */
  }
  process.exit(1);
});
