require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { generateSearchBrief } = require('../services/searchBriefPlanner');
const { qualifyLeadFallback } = require('../services/leadQualifier');
const { classifyCandidatesForLeadFit } = require('../services/leadClassifier');

const PRODUCT =
  'App where it tracks what people want during certain times, and has a voting system where people vote for what food or business they want around their area (ex: insomnia cookies closer to the campus of pfw)';

const FIXTURES = [
  { name: 'Favorite Fort Wayne Recommendations', expect: false, candidate: { title: 'Favorite Fort Wayne Recommendations?', body_snippet: 'What are your favorite spots in Fort Wayne?', subreddit: 'fortwayne' } },
  { name: 'Moving to Fort Wayne advice', expect: false, candidate: { title: "We're moving to Fort Wayne. Advice needed!", body_snippet: 'Relocating soon, what should we know?', subreddit: 'fortwayne' } },
  { name: 'Best burger Fort Wayne', expect: false, candidate: { title: 'Best burger in Fort Wayne?', body_snippet: 'Where is the best burger?', subreddit: 'fortwayne' } },
  { name: 'Brewery with playground wish', expect: true, candidate: { title: 'Brewery with playground', body_snippet: 'I wish Fort Wayne had a brewery with a playground like other cities', subreddit: 'fortwayne' } },
  { name: 'What should open near campus', expect: true, candidate: { title: 'What restaurants should open near campus?', body_snippet: 'Students keep asking what food places are missing near PFW', subreddit: 'college' } },
];

async function main() {
  console.log('\n=== Dynamic lead qualification test ===\n');
  const brief = await generateSearchBrief(PRODUCT);
  console.log('Planner:', brief.planner_source, brief.planner_model || '');
  console.log('Lead definition:', (brief.lead_definition || '').slice(0, 120), '…\n');

  let failed = 0;

  for (const fx of FIXTURES) {
    const fallback = qualifyLeadFallback(fx.candidate, brief);
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
      }
    }

    const pass = isLead === fx.expect;
    if (!pass) failed += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} [${fx.expect ? 'ACCEPT' : 'REJECT'}] ${fx.name}\n` +
        `       source=${source} is_lead=${isLead}\n` +
        `       ${evidence || ''}\n`
    );
  }

  console.log(failed ? `\n${failed} fixture(s) failed` : '\nAll fixtures passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
