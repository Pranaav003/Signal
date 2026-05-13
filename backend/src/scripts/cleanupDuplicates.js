require('dotenv').config();
const pool = require('../db/connection');

async function cleanup() {
  const threshold = parseInt(process.env.LEAD_SCORE_THRESHOLD || '45', 10);

  const leadResult = await pool.query(
    'DELETE FROM leads WHERE relevance_score < $1 RETURNING id',
    [threshold]
  );
  console.log(`Deleted ${leadResult.rowCount} leads below score ${threshold}`);

  // Delete ALL leads from CRM monitors
  // (identified by their product_description containing 'CRM' or 'Notion')
  // We can't hardcode IDs but we can use the queries column to detect
  // CRM monitors: their queries contain 'crm' related terms

  const crmResult = await pool.query(`
    DELETE FROM leads
    WHERE keyword_set_id IN (
      SELECT id FROM keyword_sets
      WHERE queries && ARRAY['crm help', 'struggling with crm', 
                              'anyone recommend crm', 'best crm',
                              'crm alternative']::text[]
    )
    RETURNING id
  `);
  console.log(`Deleted ${crmResult.rowCount} CRM monitor leads`);

  // Only delete monitors that have NEVER been scanned (last_scanned_at IS NULL)
  // AND were created more than 30 minutes ago (not currently scanning)
  // AND have 0 leads
  const result = await pool.query(`
    DELETE FROM keyword_sets
    WHERE id IN (
      SELECT ks.id FROM keyword_sets ks
      LEFT JOIN leads l ON l.keyword_set_id = ks.id
      WHERE ks.last_scanned_at IS NULL
        AND ks.created_at < NOW() - INTERVAL '30 minutes'
      GROUP BY ks.id
      HAVING COUNT(l.id) = 0
    )
    RETURNING id, product_description
  `);

  console.log(`Deleted ${result.rowCount} empty monitors`);
  result.rows.forEach((r) =>
    console.log(' -', r.id, r.product_description?.slice(0, 50))
  );

  await pool.end();
  process.exit(0);
}

cleanup().catch((err) => {
  console.error(err);
  process.exit(1);
});
