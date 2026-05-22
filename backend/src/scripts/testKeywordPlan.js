require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { generateQueries } = require('../services/keywordProcessor');
const { isPlaceholderQuery } = require('../services/planValidator');
const { normalizeSearchFocus, VALID_SEARCH_FOCUS } = require('../utils/searchFocus');

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
    console.error('Usage: npm run test:keyword-plan -- --description "your product"');
    process.exit(1);
  }
  return description;
}

function isMarketplaceLikeDescription(desc) {
  return /\b(rent|rental|marketplace|owners?|providers?|buyers?|both sides|two-sided|supply|demand)\b/i.test(
    desc
  );
}

function hasMarketplaceSides(plan, brief) {
  if (brief.product_type === 'marketplace' || plan.product_type === 'marketplace') return true;
  const sides = Array.isArray(brief.sides) ? brief.sides : Array.isArray(plan.sides) ? plan.sides : [];
  if (sides.length >= 2) return true;
  if (plan.search_focus === 'both') return true;
  return false;
}

function collectQualityWarnings(plan, brief, description) {
  const warnings = [];
  const queries = Array.isArray(plan.queries) ? plan.queries : [];
  const evidence = [
    ...(brief.required_evidence || []),
    ...(plan.required_concepts || []),
  ].filter(Boolean);

  if (queries.length < 8) {
    warnings.push(`fewer than 8 search queries (${queries.length}); planValidator prefers 8+ for repair paths`);
  }
  if (evidence.length < 2) {
    warnings.push(
      `fewer than 2 required_evidence items (${evidence.length}); richer rubrics improve classification`
    );
  }

  const source = String(plan.planner_source || plan.source || '').toLowerCase();
  if (source && source !== 'ai') {
    warnings.push(`planner_source is "${plan.planner_source || plan.source}" (expected "ai" for full quality)`);
  }

  if (isMarketplaceLikeDescription(description) && !hasMarketplaceSides(plan, brief)) {
    warnings.push(
      'marketplace-like description but no multi-sided brief (sides.length < 2, product_type not marketplace, search_focus not both)'
    );
  }

  return warnings;
}

function evaluateProductionMinimum(plan, brief) {
  const failures = [];
  const queries = (Array.isArray(plan.queries) ? plan.queries : []).map((q) => String(q || '').trim());
  const validQueries = queries.filter((q) => q && !isPlaceholderQuery(q));
  const placeholderQueries = queries.filter((q) => q && isPlaceholderQuery(q));

  if (validQueries.length < 5) {
    failures.push(`need at least 5 valid search queries (got ${validQueries.length})`);
  }
  if (placeholderQueries.length > 0) {
    failures.push(`placeholder queries detected: ${placeholderQueries.slice(0, 3).join(' | ')}`);
  }

  const evidence = [
    ...(brief.required_evidence || []),
    ...(plan.required_concepts || []),
  ].filter(Boolean);
  if (evidence.length < 1) {
    failures.push('need at least 1 required_evidence item');
  }

  const focusRaw = plan.search_focus || brief.search_focus || brief.primary_side;
  const focus = normalizeSearchFocus(focusRaw);
  if (focusRaw && !VALID_SEARCH_FOCUS.has(String(focusRaw).trim())) {
    failures.push(`invalid search_focus "${focusRaw}" (normalized to "${focus}")`);
  }

  if (!Array.isArray(plan.subreddits) || plan.subreddits.length < 5) {
    failures.push(`need at least 5 subreddits (got ${plan.subreddits?.length || 0})`);
  }

  const hasRubric =
    Boolean(brief.lead_definition || plan.lead_definition) &&
    (brief.disqualifying_evidence || brief.disqualifiers || plan.disqualifiers || []).length >= 1;
  if (!hasRubric) {
    failures.push('missing lead_definition or disqualifiers');
  }

  return { failures, focus, validQueries, evidence };
}

async function main() {
  const description = parseArgs();
  console.log('\n=== Keyword / search brief test ===\n');
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'set' : 'missing');
  console.log('Description:', description.slice(0, 100) + '…\n');

  const plan = await generateQueries(description);
  const brief = plan.search_brief || {};

  const { failures, focus, validQueries } = evaluateProductionMinimum(plan, brief);
  const qualityWarnings = collectQualityWarnings(plan, brief, description);
  const pass = failures.length === 0;

  console.log('planner_source:', plan.planner_source || plan.source);
  console.log('planner_model:', plan.planner_model || 'n/a');
  console.log('reddit_fit:', plan.reddit_fit);
  console.log('search_focus:', focus);
  console.log('\nrewritten_prompt:\n', plan.rewritten_prompt);
  if (plan.product_summary) console.log('\nproduct_summary:', plan.product_summary);
  if (plan.target_customer?.length) console.log('\ntarget_customer:', plan.target_customer.join(', '));
  if (plan.pain_points?.length) console.log('pain_points:', plan.pain_points.join(', '));

  console.log(`\nqueries (${plan.queries.length}, ${validQueries.length} pass placeholder filter):`);
  plan.queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  console.log(`\nsubreddits (${plan.subreddits.length}):`);
  plan.subreddits.forEach((s) => console.log(`  r/${s}`));

  if (plan.positive_lead_patterns?.length) {
    console.log('\npositive_lead_patterns:');
    plan.positive_lead_patterns.slice(0, 8).forEach((p) => console.log(`  - ${p}`));
  }

  if (plan.negative_keywords?.length) {
    console.log('\nnegative_keywords:', plan.negative_keywords.join(', '));
  }

  if (plan.disqualifiers?.length) {
    console.log('\ndisqualifiers:', plan.disqualifiers.slice(0, 8).join(', '));
  }

  if (brief.lead_definition) console.log('\nlead_definition:', brief.lead_definition);
  if (brief.required_evidence?.length) {
    console.log('\nrequired_evidence:', brief.required_evidence.slice(0, 6).join(' | '));
  }

  if (qualityWarnings.length) {
    console.log('\n--- QUALITY WARNINGS (non-blocking) ---');
    qualityWarnings.forEach((w) => console.log(`  ⚠ ${w}`));
  } else {
    console.log('\n--- QUALITY WARNINGS (non-blocking) ---');
    console.log('  (none)');
  }

  console.log('\n--- PRODUCTION MINIMUM (blocking) ---');
  if (failures.length) {
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  } else {
    console.log('  ✓ at least 5 valid queries');
    console.log('  ✓ at least 1 required_evidence');
    console.log('  ✓ no placeholder queries');
    console.log(`  ✓ valid search_focus (${focus})`);
    console.log('  ✓ rubric present');
  }

  console.log('\nvalidation:', pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
