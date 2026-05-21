/**
 * Lead type + visibility fixtures (no product/city hardcoding in runtime rules).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const {
  normalizeLeadType,
  resolveRecommendedVisibility,
  enrichQualification,
} = require('../utils/leadVisibility');
const { qualifyLeadFallback } = require('../services/leadQualifier');

const DEMAND_BRIEF = {
  search_focus: 'demand_side',
  lead_definition: 'Posts expressing unmet local food or business demand',
  required_evidence: ['want in your town', 'not there that should be'],
  positive_lead_patterns: ['what do you guys want in your town', 'not in your area yet'],
  disqualifying_evidence: ['recipe', 'meal prep', 'personal craving'],
};

const CLASS_BRIEF = {
  search_focus: 'demand_side',
  lead_definition: 'Students asking whether to take, drop, or choose classes',
  required_evidence: ['drop a class', 'should I drop'],
  positive_lead_patterns: ['drop a class', 'course requirement'],
};

const THERAPUP_BRIEF = {
  search_focus: 'demand_side',
  lead_definition: 'Organizations or families seeking therapy animal visits',
  required_evidence: ['dementia patient', 'come to her house'],
  positive_lead_patterns: ['therapy dog for dementia', 'handler willing to come'],
};

const VISIBILITY_FIXTURES = [
  {
    name: 'Fort Wayne culinary wants',
    lead_type: 'direct_demand',
    is_lead: true,
    confidence: 88,
    search_focus: 'demand_side',
    expect_visibility: 'show',
  },
  {
    name: 'Food delivery not in area',
    lead_type: 'direct_demand',
    is_lead: true,
    confidence: 85,
    search_focus: 'demand_side',
    expect_visibility: 'show',
  },
  {
    name: 'Cookie place nearby',
    lead_type: 'adjacent_demand',
    is_lead: true,
    confidence: 55,
    search_focus: 'demand_side',
    expect_visibility: 'show',
  },
  {
    name: 'Therapy dog Metro Detroit group',
    lead_type: 'supplier_side',
    is_lead: true,
    confidence: 70,
    search_focus: 'demand_side',
    expect_visibility: 'hide',
  },
  {
    name: 'Research study recruiting',
    lead_type: 'market_research',
    is_lead: true,
    confidence: 72,
    search_focus: 'demand_side',
    expect_visibility: 'hide',
  },
];

const FALLBACK_FIXTURES = [
  {
    brief: DEMAND_BRIEF,
    name: 'Cold portable lunch ideas',
    candidate: {
      title: 'Cold portable lunch ideas',
      body_snippet: 'Looking for meal prep lunch ideas I can pack for work',
      subreddit: 'mealprep',
    },
    expect_lead: false,
  },
  {
    brief: DEMAND_BRIEF,
    name: 'Fort Wayne what do you WANT',
    candidate: {
      title: "What's the culinary scene like in Fort Wayne",
      body_snippet:
        'What is not there that should be? what do you guys WANT in your town?',
      subreddit: 'fortwayne',
    },
    expect_lead: true,
    expect_type: 'direct_demand',
  },
  {
    brief: CLASS_BRIEF,
    name: 'Drop a class',
    candidate: {
      title: 'I think I might need to drop a class',
      body_snippet: 'Should I drop this course before the deadline?',
      subreddit: 'college',
    },
    expect_lead: true,
  },
  {
    brief: THERAPUP_BRIEF,
    name: 'Therapy dog dementia',
    candidate: {
      title: 'Therapy dog for dementia patient',
      body_snippet:
        'Looking for a dog and handler willing to come to her house weekly',
      subreddit: 'therapydogs',
    },
    expect_lead: true,
    expect_type: 'direct_demand',
  },
];

function main() {
  console.log('\n=== Lead type visibility ===\n');
  let failed = 0;

  for (const fx of VISIBILITY_FIXTURES) {
    const out = resolveRecommendedVisibility(fx);
    const ok = out.recommended_visibility === fx.expect_visibility;
    console.log(`${ok ? 'OK' : 'FAIL'} ${fx.name}: ${out.lead_type} → ${out.recommended_visibility}`);
    if (!ok) failed += 1;
  }

  const legacy = normalizeLeadType('competitor_market_signal');
  if (legacy !== 'market_research') {
    console.error('FAIL legacy type map');
    failed += 1;
  } else {
    console.log('OK legacy competitor_market_signal → market_research');
  }

  console.log('\n=== Fallback meal-prep / demand fixtures ===\n');

  for (const fx of FALLBACK_FIXTURES) {
    const q = qualifyLeadFallback(fx.candidate, fx.brief, { search_focus: fx.brief.search_focus });
    const leadOk = q.is_lead === fx.expect_lead;
    const typeOk = fx.expect_type ? q.lead_type === fx.expect_type : true;
    const visOk = fx.expect_lead
      ? q.recommended_visibility === 'show' || q.recommended_visibility === 'hide'
      : q.recommended_visibility === 'hide';
    const ok = leadOk && typeOk && visOk;
    console.log(
      `${ok ? 'OK' : 'FAIL'} ${fx.name}: is_lead=${q.is_lead} type=${q.lead_type} vis=${q.recommended_visibility}`
    );
    if (!ok) failed += 1;
  }

  const enriched = enrichQualification(
    { is_lead: true, confidence: 80, lead_type: 'supplier_side' },
    { search_focus: 'demand_side' }
  );
  if (enriched.recommended_visibility !== 'hide') {
    console.error('FAIL enrich supplier on demand monitor');
    failed += 1;
  } else {
    console.log('OK supplier_side hidden on demand_side monitor');
  }

  console.log(failed ? `\n${failed} failure(s)\n` : '\nAll lead type checks passed.\n');
  process.exit(failed ? 1 : 0);
}

main();
