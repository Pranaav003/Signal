require('../config/loadEnv');

const pool = require('../db/connection');
const { generateQueries } = require('../services/keywordProcessor');
const { normalizeSearchFocus } = require('../utils/searchFocus');

const DESC = 'Test monitor for create keyword set regression';

async function ensureUser() {
  const email = `test-create-ks-${Date.now()}@signal.local`;
  const { rows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [email]
  );
  return rows[0].id;
}

async function createMonitor(userId, searchFocusInput) {
  const plan = await generateQueries(DESC, { search_focus: searchFocusInput });
  const searchFocus = normalizeSearchFocus(
    searchFocusInput,
    plan.primary_side || plan.search_focus
  );
  const { rows } = await pool.query(
    `INSERT INTO keyword_sets (
       user_id, product_description, queries, subreddits, search_brief, search_focus, active
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, true)
     RETURNING *`,
    [
      userId,
      DESC,
      plan.queries,
      plan.subreddits,
      JSON.stringify({ ...(plan.search_brief || {}), search_focus: searchFocus }),
      searchFocus,
    ]
  );
  return rows[0];
}

async function main() {
  let failed = 0;
  const userId = await ensureUser();

  const cases = [
    { label: 'missing', input: undefined, expect: 'demand_side' },
    { label: 'demand_side', input: 'demand_side', expect: 'demand_side' },
    { label: 'supply_side', input: 'supply_side', expect: 'supply_side' },
    { label: 'both', input: 'both', expect: 'both' },
    { label: 'invalid', input: 'invalid_side', expect: 'demand_side' },
  ];

  for (const c of cases) {
    try {
      const row = await createMonitor(userId, c.input);
      if (row.search_focus !== c.expect) {
        console.error(`FAIL ${c.label}: got ${row.search_focus}, expected ${c.expect}`);
        failed += 1;
      } else {
        console.log(`PASS ${c.label}: search_focus=${row.search_focus}`);
      }
      await pool.query(
        `UPDATE keyword_sets SET active = false, deleted_at = NOW() WHERE id = $1`,
        [row.id]
      );
    } catch (err) {
      console.error(`FAIL ${c.label}:`, err.message);
      failed += 1;
    }
  }

  await pool.end().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
