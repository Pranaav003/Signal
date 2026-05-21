require('../config/loadEnv');

const pool = require('../db/connection');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inactiveKs = await client.query(
      `SELECT id, user_id, product_description
       FROM keyword_sets
       WHERE COALESCE(active, false) = false OR deleted_at IS NOT NULL`
    );

    let hiddenLeads = 0;
    let cancelledRuns = 0;

    for (const ks of inactiveKs.rows) {
      const leads = await client.query(
        `UPDATE leads
         SET is_active = false,
             deleted_at = COALESCE(deleted_at, NOW())
         WHERE keyword_set_id = $1
           AND COALESCE(is_active, true) = true
         RETURNING id`,
        [ks.id]
      );
      hiddenLeads += leads.rowCount || 0;

      const runs = await client.query(
        `UPDATE scan_runs
         SET status = 'cancelled',
             completed_at = COALESCE(completed_at, NOW()),
             error_message = COALESCE(error_message, 'Monitor deleted (cleanup)')
         WHERE keyword_set_id = $1
           AND status NOT IN ('complete', 'failed', 'cancelled')
         RETURNING id`,
        [ks.id]
      );
      cancelledRuns += runs.rowCount || 0;
    }

    const orphanLeads = await client.query(
      `UPDATE leads l
       SET is_active = false,
           deleted_at = COALESCE(l.deleted_at, NOW())
       FROM keyword_sets ks
       WHERE l.keyword_set_id = ks.id
         AND (COALESCE(ks.active, false) = false OR ks.deleted_at IS NOT NULL)
         AND COALESCE(l.is_active, true) = true
       RETURNING l.id`
    );

    await client.query('COMMIT');

    console.log('\n=== cleanup:deleted-monitors ===\n');
    console.log(`Inactive monitors: ${inactiveKs.rows.length}`);
    console.log(`Leads hidden (by monitor): ${hiddenLeads}`);
    console.log(`Leads hidden (orphan pass): ${orphanLeads.rowCount || 0}`);
    console.log(`Scan runs cancelled: ${cancelledRuns}`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
