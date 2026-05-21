/**
 * Lead qualification fixtures — brief-driven, no runtime product hardcoding.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { generateSearchBrief } = require('../services/searchBriefPlanner');
const { qualifyLeadFallback } = require('../services/leadQualifier');
const { classifyCandidatesForLeadFit } = require('../services/leadClassifier');

const PRODUCT =
  'App where it tracks what people want during certain times, and has a voting system where people vote for what food or business they want around their area (ex: insomnia cookies closer to the campus of pfw)';

const FIXTURES = [
  {
    name: 'Sour extreme foods (personal craving)',
    expect: false,
    candidate: {
      title: 'Sour (extreme) foods.',
      body_snippet:
        'I have been craving really sour foods lately — candy, pickles, citrus. What are your favorite extreme sour snacks?',
      subreddit: 'food',
    },
  },
  {
    name: 'Favorite Fort Wayne Recommendations',
    expect: false,
    candidate: {
      title: 'Favorite Fort Wayne Recommendations?',
      body_snippet: 'What are your favorite spots in Fort Wayne?',
      subreddit: 'fortwayne',
    },
  },
  {
    name: 'Cold portable lunch ideas (meal prep)',
    expect: false,
    candidate: {
      title: 'Cold portable lunch ideas',
      body_snippet: 'Need meal prep lunch ideas I can pack for work',
      subreddit: 'mealprep',
    },
  },
  {
    name: 'What should open near campus',
    expect: true,
    candidate: {
      title: 'What restaurants should open near campus?',
      body_snippet: 'Students keep asking what food places are missing near PFW',
      subreddit: 'college',
    },
  },
];

async function main() {
  console.log('\n=== Lead qualification test ===\n');
  const brief = await generateSearchBrief(PRODUCT);
  console.log('Planner:', brief.planner_source, brief.planner_model || '');
  console.log('Lead definition:', (brief.lead_definition || '').slice(0, 120), '…\n');

  let failed = 0;
  const requireAi = process.env.REQUIRE_AI_CLASSIFIER === 'true';

  for (const fx of FIXTURES) {
    const fallback = qualifyLeadFallback(fx.candidate, brief);
    if (fx.name.includes('Sour extreme') && fallback.is_lead) {
      console.error('FAIL: fallback must reject personal sour-food craving fixture');
      failed += 1;
      continue;
    }
    let isLead = fallback.is_lead;
    let source = 'fallback';
    let evidence = fallback.evidence || fallback.reject_reason;

    if (process.env.OPENAI_API_KEY) {
      const batch = await classifyCandidatesForLeadFit(
        [{ ...fx.candidate, post_id: fx.name }],
        brief
      );
      const ai = batch.results?.[0];
      if (ai) {
        isLead = ai.is_lead;
        source = 'ai';
        evidence = ai.evidence || ai.reject_reason;
      } else if (requireAi) {
        isLead = false;
        source = 'ai-required-failed';
        evidence = batch.error || 'AI classifier failed';
      }
    } else if (requireAi) {
      isLead = false;
      source = 'ai-required-missing-key';
      evidence = 'OPENAI_API_KEY missing';
    }

    const pass = isLead === fx.expect;
    if (!pass) failed += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} [${fx.expect ? 'ACCEPT' : 'REJECT'}] ${fx.name}\n` +
        `       source=${source} is_lead=${isLead}\n` +
        `       ${evidence || ''}\n`
    );
  }

  if (requireAi && !process.env.OPENAI_API_KEY) {
    console.error('REQUIRE_AI_CLASSIFIER=true but OPENAI_API_KEY is missing');
    process.exit(1);
  }

  console.log(failed ? `\n${failed} fixture(s) failed` : '\nAll fixtures passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
