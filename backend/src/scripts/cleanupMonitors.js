require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = require('../db/connection');

async function cleanup() {
  const result = await pool.query(
    `
    DELETE FROM keyword_sets
    WHERE id IN (
      SELECT ks.id
      FROM keyword_sets ks
      LEFT JOIN leads l ON l.keyword_set_id = ks.id
      GROUP BY ks.id
      HAVING COUNT(l.id) = 0
    )
    RETURNING id, product_description
    `
  );

  console.log(`Deleted ${result.rowCount} empty monitors:`);
  result.rows.forEach((r) =>
    console.log(' -', (r.product_description || '').slice(0, 60))
  );

  const remaining = await pool.query(`
    SELECT ks.product_description, COUNT(l.id)::int AS leads
    FROM keyword_sets ks
    LEFT JOIN leads l ON l.keyword_set_id = ks.id
    GROUP BY ks.id, ks.product_description
    ORDER BY leads DESC
  `);

  console.log('\nRemaining monitors:');
  remaining.rows.forEach((r) =>
    console.log(` ${r.leads} leads — ${(r.product_description || '').slice(0, 60)}`)
  );

  await pool.end();
  process.exit(0);
}

cleanup().catch((err) => {
  console.error(err);
  process.exit(1);
});
