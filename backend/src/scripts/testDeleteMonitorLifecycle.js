require('../config/loadEnv');

const pool = require('../db/connection');
const { deleteMonitorForUser } = require('../services/monitorLifecycle');

async function main() {
  let failed = 0;
  const fail = (msg) => {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  };

  const email = `test-delete-monitor-${Date.now()}@signal.local`;
  const { rows: users } = await pool.query(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [email]
  );
  const userId = users[0].id;

  const { rows: ksRows } = await pool.query(
    `INSERT INTO keyword_sets (user_id, product_description, queries, subreddits, active, search_focus)
     VALUES ($1, 'Test delete monitor', ARRAY['test query one'], ARRAY['AskReddit'], true, 'demand_side')
     RETURNING id`,
    [userId]
  );
  const ksId = ksRows[0].id;

  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      `INSERT INTO leads (user_id, keyword_set_id, platform, post_id, title, url, is_active)
       VALUES ($1, $2, 'reddit', $3, $4, $5, true)`,
      [userId, ksId, `post-${i}-${Date.now()}`, `Lead ${i}`, `https://reddit.com/${i}`]
    );
  }

  const before = await pool.query(
    `SELECT COUNT(*)::int AS c FROM leads l
     JOIN keyword_sets ks ON ks.id = l.keyword_set_id
     WHERE l.user_id = $1
       AND COALESCE(l.is_active, true) = true
       AND COALESCE(ks.active, true) = true
       AND ks.deleted_at IS NULL
       AND l.deleted_at IS NULL`,
    [userId]
  );
  if (before.rows[0].c < 3) fail(`expected 3 visible leads before delete, got ${before.rows[0].c}`);

  const del = await deleteMonitorForUser(ksId, userId);
  if (!del.ok) fail('deleteMonitorForUser returned not ok');

  const ksAfter = await pool.query(`SELECT active, deleted_at FROM keyword_sets WHERE id = $1`, [
    ksId,
  ]);
  if (ksAfter.rows[0].active !== false) fail('keyword_sets.active should be false');
  if (!ksAfter.rows[0].deleted_at) fail('keyword_sets.deleted_at should be set');

  const activeLeads = await pool.query(
    `SELECT COUNT(*)::int AS c FROM leads l
     JOIN keyword_sets ks ON ks.id = l.keyword_set_id
     WHERE l.user_id = $1
       AND COALESCE(l.is_active, true) = true
       AND COALESCE(ks.active, true) = true
       AND ks.deleted_at IS NULL
       AND l.deleted_at IS NULL`,
    [userId]
  );
  if (activeLeads.rows[0].c !== 0) {
    fail(`expected 0 visible leads after delete, got ${activeLeads.rows[0].c}`);
  }

  const hidden = await pool.query(
    `SELECT COUNT(*)::int AS c FROM leads WHERE keyword_set_id = $1 AND is_active = false`,
    [ksId]
  );
  if (hidden.rows[0].c < 3) fail(`expected 3 hidden leads, got ${hidden.rows[0].c}`);

  console.log(
    del.ok
      ? `PASS delete lifecycle hidden=${del.hidden_leads_count} runs=${del.cancelled_scan_runs_count}`
      : ''
  );

  await pool.end().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
