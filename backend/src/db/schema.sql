CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keyword_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id) ON DELETE CASCADE,
  product_description TEXT NOT NULL,
  pitch_line TEXT,
  queries TEXT[] NOT NULL DEFAULT '{}',
  subreddits TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  scan_interval_hours INTEGER DEFAULT 6,
  last_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reddit_fit TEXT DEFAULT 'good',
  fit_warning TEXT,
  fit_suggestion TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id) ON DELETE CASCADE,
  keyword_set_id UUID REFERENCES keyword_sets (id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'reddit',
  post_id TEXT NOT NULL,
  title TEXT,
  body_snippet TEXT,
  url TEXT NOT NULL,
  author TEXT,
  subreddit TEXT,
  relevance_score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  seen BOOLEAN DEFAULT false,
  ai_draft TEXT,
  score_reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS thread_suppressions (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mute', 'snooze')),
  snooze_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id),
  CHECK (kind = 'mute' OR snooze_until IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_thread_suppressions_user ON thread_suppressions (user_id);

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
