/**
 * Marketplace planner fixture — no runtime product hardcoding.
 */
require('../config/loadEnv');

const { generateSearchBrief } = require('../services/searchBriefPlanner');

const THERAPUP =
  'Therapup - service where dog/cat owners can rent their animals out to centers that people can come visit and spend time with the animals for a price (have toys and books and such)';

const SUPPLY_QUERY_RE =
  /\b(rent my (dog|cat|pet)|earn money with my pet|monetize my pet|offer my dog|list my pet)\b/i;

function sideByName(brief, name) {
  return (brief.sides || []).find((s) => s.name === name);
}

async function main() {
  console.log('\n=== Marketplace planner test ===\n');
  let failed = 0;
  const fail = (msg) => {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  };

  const brief = await generateSearchBrief(THERAPUP);
  console.log('planner_source:', brief.planner_source);
  console.log('product_type:', brief.product_type);
  console.log('primary_side:', brief.primary_side);
  console.log('sides:', (brief.sides || []).map((s) => s.name).join(', '));

  const isMarketplace =
    brief.product_type === 'marketplace' ||
    (brief.sides || []).length >= 2 ||
    brief.primary_side === 'both';
  if (!isMarketplace) {
    fail('expected marketplace or multi-sided plan');
  }

  const demand = sideByName(brief, 'demand_side');
  const supply = sideByName(brief, 'supply_side');
  if (!demand) fail('missing demand_side in plan');
  if (!supply) fail('missing supply_side in plan');

  if (brief.primary_side === 'supply_side') {
    fail('primary_side should not be supply_side only for Therapup-like marketplace');
  }

  const demandQueries = demand?.search_queries || demand?.queries || [];
  const supplyQueries = supply?.search_queries || supply?.queries || [];
  if (!demandQueries.length) fail('demand_side has no search_queries');

  const supplyHeavy = demandQueries.filter((q) => SUPPLY_QUERY_RE.test(q)).length;
  if (supplyHeavy >= Math.ceil(demandQueries.length / 2)) {
    fail(
      `demand_side queries look supply-heavy (${supplyHeavy}/${demandQueries.length} provider-style)`
    );
  }

  const topQueries = brief.search_queries || brief.queries || [];
  const topSupply = topQueries.filter((q) => SUPPLY_QUERY_RE.test(q)).length;
  if (topSupply > 0 && brief.primary_side !== 'supply_side') {
    fail('top-level search_queries should not be supply-side monetization queries');
  }

  console.log('\nDemand-side sample queries:');
  demandQueries.slice(0, 6).forEach((q) => console.log(`  → ${q}`));

  if (!failed) console.log('\nMarketplace planner checks passed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
