require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { generateQueries } = require('../services/keywordProcessor');

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

async function main() {
  const description = parseArgs();
  console.log('\n=== Keyword / search brief test ===\n');
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'set' : 'missing');
  console.log('Description:', description.slice(0, 100) + '…\n');

  const plan = await generateQueries(description);

  const brief = plan.search_brief || {};
  const hasRubric =
    Boolean(brief.lead_definition || plan.lead_definition) &&
    (brief.required_evidence || []).length >= 2 &&
    (brief.disqualifying_evidence || brief.disqualifiers || []).length >= 1;

  const valid =
    Array.isArray(plan.queries) &&
    plan.queries.length >= 8 &&
    Array.isArray(plan.subreddits) &&
    plan.subreddits.length >= 5 &&
    hasRubric;

  console.log('planner_source:', plan.planner_source || plan.source);
  console.log('planner_model:', plan.planner_model || 'n/a');
  console.log('reddit_fit:', plan.reddit_fit);
  console.log('\nrewritten_prompt:\n', plan.rewritten_prompt);
  if (plan.product_summary) console.log('\nproduct_summary:', plan.product_summary);
  if (plan.target_customer?.length) console.log('\ntarget_customer:', plan.target_customer.join(', '));
  if (plan.pain_points?.length) console.log('pain_points:', plan.pain_points.join(', '));

  console.log(`\nqueries (${plan.queries.length}):`);
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

  console.log('\nvalidation:', valid ? 'PASS' : 'FAIL');
  process.exit(valid ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
