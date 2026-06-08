/**
 * Dry-run scan pipeline checks: cap, classifier, diagnostics consistency.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const {
  runScanPipeline,
  maxLeadsPerRun,
  buildCompleteProgress,
} = require('../services/scanPipeline');
const { generateSearchBrief } = require('../services/searchBriefPlanner');
const { assertDiagnosticsConsistency } = require('../services/scanRunService');

const PRODUCT =
  process.argv.includes('--description')
    ? process.argv[process.argv.indexOf('--description') + 1]
    : 'App where it tracks what people want during certain times, and has a voting system where people vote for what food or business they want around their area (ex: insomnia cookies closer to the campus of pfw)';

async function main() {
  console.log('\n=== Scan pipeline once (no DB insert) ===\n');
  const cap = maxLeadsPerRun();
  const brief = await generateSearchBrief(PRODUCT);

  const keywordSet = {
    id: null,
    user_id: null,
    product_description: PRODUCT,
    search_brief: brief,
    queries: brief.search_queries || brief.queries,
    subreddits: brief.subreddits,
  };

  let stats;
  try {
    ({ stats } = await runScanPipeline(keywordSet, {
      pool: null,
      insertLeads: false,
      scanRunId: 'test-run',
    }));
  } catch (err) {
    const code = err?.redditError?.code;
    if (code === 'REDDIT_BLOCKED' || code === 'REDDIT_AUTH_FAILED' || code === 'REDDIT_RATE_LIMITED') {
      console.warn(
        `\nSKIP: Reddit unavailable during live pipeline test (${code || err.message}). ` +
          'Cap/classifier checks require a successful fetch — retry later or check PROXY_LIST.'
      );
      process.exit(0);
    }
    throw err;
  }

  let failed = 0;
  const fail = (msg) => {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  };

  if (stats.inserted_count > cap) {
    fail(`inserted_count ${stats.inserted_count} > cap ${cap}`);
  }
  if (stats.survivors_count > cap) {
    fail(`survivors_count ${stats.survivors_count} > cap ${cap}`);
  }

  const rawCap = Number(process.env.SCAN_MAX_RAW_TOTAL) > 0 ? Number(process.env.SCAN_MAX_RAW_TOTAL) : 500;
  const rawUsed = stats.raw_candidates ?? stats.collected_raw ?? 0;
  if (rawUsed > rawCap) {
    fail(`raw_candidates ${rawUsed} > SCAN_MAX_RAW_TOTAL ${rawCap}`);
  }
  if (!stats.search_focus) {
    fail('search_focus missing from pipeline stats');
  }

  if (process.env.REQUIRE_AI_CLASSIFIER === 'true' && stats.classifier_source === 'fallback') {
    fail(
      `classifier_source is fallback while REQUIRE_AI_CLASSIFIER=true (${stats.classifier_error || 'no error'})`
    );
  }

  try {
    const diag = buildCompleteProgress(stats).diagnostics;
    console.log('Diagnostics OK:', {
      inserted: diag.inserted_count,
      raw: diag.raw_candidates,
      classifier: diag.classifier_source,
      planner: diag.planner_source,
    });
  } catch (err) {
    fail(`diagnostics inconsistent: ${err.message}`);
  }

  try {
    assertDiagnosticsConsistency(
      {
        inserted_count: stats.inserted_count,
        raw_candidates: stats.raw_candidates,
        deduped_count: stats.deduped_count,
        initially_scored_count: stats.initially_scored,
        sent_to_ai_qualification_count: stats.sent_to_ai_qualification_count,
        final_candidates_count: stats.survivors_count,
        rules_qualified_count: stats.semantically_qualified,
        max_leads_per_run: cap,
      },
      { strict: true }
    );
  } catch (err) {
    fail(err.message);
  }

  console.log(
    `\nSummary: raw=${stats.collected_raw} inserted=${stats.inserted_count} classifier=${stats.classifier_source} survivors=${stats.survivors_count}`
  );

  if (!failed) console.log('\nPipeline checks passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
