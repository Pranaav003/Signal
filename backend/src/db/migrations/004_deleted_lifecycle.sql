ALTER TABLE keyword_sets
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_keyword_sets_user_active
ON keyword_sets (user_id, active)
WHERE active = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_user_active_monitor
ON leads (user_id, is_active, keyword_set_id)
WHERE is_active = true AND deleted_at IS NULL;
