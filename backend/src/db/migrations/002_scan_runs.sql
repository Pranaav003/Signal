CREATE TABLE IF NOT EXISTS scan_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_set_id UUID NOT NULL REFERENCES keyword_sets (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  diagnostics JSONB DEFAULT '{}'::jsonb,
  search_brief JSONB DEFAULT '{}'::jsonb,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_keyword_set ON scan_runs (keyword_set_id, started_at DESC);

ALTER TABLE keyword_sets
ADD COLUMN IF NOT EXISTS current_scan_run_id UUID REFERENCES scan_runs (id) ON DELETE SET NULL;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS scan_run_id UUID REFERENCES scan_runs (id) ON DELETE SET NULL;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS qualification JSONB DEFAULT '{}'::jsonb;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_leads_active_user ON leads (user_id, is_active, relevance_score DESC);
