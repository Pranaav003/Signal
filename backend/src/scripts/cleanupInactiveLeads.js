require('../config/loadEnv');

const pool = require('../db/connection');

async function main() {
  const { rowCount } = await pool.query(
    `UPDATE leads l
     SET is_active = false,
         deleted_at = COALESCE(l.deleted_at, NOW())
     FROM keyword_sets ks
     WHERE l.keyword_set_id = ks.id
       AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)
       AND COALESCE(l.is_active, true) = true`
  );

  console.log(`Hidden ${rowCount || 0} leads tied to inactive/deleted monitors.`);
  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
