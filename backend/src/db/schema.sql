CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keyword_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id) ON DELETE CASCADE,
  product_description TEXT NOT NULL,
  queries TEXT[] NOT NULL DEFAULT '{}',
  subreddits TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  scan_interval_hours INTEGER DEFAULT 6,
  last_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
  seen BOOLEAN DEFAULT false,
  ai_draft TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, post_id)
);
