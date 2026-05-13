-- Run manually if you maintain schema outside of migrate.js:
-- psql $DATABASE_URL -f backend/src/db/migrations/001_tracked_replies.sql

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
);

CREATE INDEX IF NOT EXISTS idx_tracked_replies_user ON tracked_replies (user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_replies_status ON tracked_replies (status);
