require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const pool = require('./connection');

async function main() {
  const sqlPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  try {
    await pool.query(sql);
    await pool.query(
      `ALTER TABLE keyword_sets ADD COLUMN IF NOT EXISTS pitch_line TEXT`
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracked_replies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        lead_id UUID NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
        comment_url TEXT NOT NULL,
        reddit_comment_id TEXT,
        posted_at TIMESTAMPTZ DEFAULT NOW(),
        last_checked_at TIMESTAMPTZ,
        upvotes INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        thread_upvotes INTEGER DEFAULT 0,
        thread_reply_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tracked_replies_user ON tracked_replies (user_id)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tracked_replies_status ON tracked_replies (status)`
    );

    await pool.query(
      `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_reasons TEXT[] NOT NULL DEFAULT '{}'::text[]`
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS thread_suppressions (
        user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        post_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('mute', 'snooze')),
        snooze_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, post_id),
        CHECK (kind = 'mute' OR snooze_until IS NOT NULL)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_thread_suppressions_user ON thread_suppressions (user_id)`
    );

    await pool.query(`DROP TABLE IF EXISTS saved_searches`);

    console.log('✓ Migration complete');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
