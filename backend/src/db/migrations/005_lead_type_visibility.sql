-- Lead type + recommended inbox visibility (also stored in qualification JSONB)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recommended_visibility TEXT DEFAULT 'show';

CREATE INDEX IF NOT EXISTS idx_leads_recommended_visibility
  ON leads (user_id, recommended_visibility)
  WHERE COALESCE(is_active, true) = true AND deleted_at IS NULL;

UPDATE leads
SET
  lead_type = COALESCE(lead_type, qualification->>'lead_type', 'direct_demand'),
  recommended_visibility = COALESCE(
    recommended_visibility,
    qualification->>'recommended_visibility',
    CASE
      WHEN COALESCE(qualification->>'lead_type', '') IN ('not_a_lead', '') THEN 'hide'
      WHEN qualification->>'lead_type' IN ('market_research', 'competitor_market_signal', 'competitor_signal')
        THEN 'hide'
      WHEN qualification->>'lead_type' = 'supplier_side' THEN 'hide'
      ELSE 'show'
    END
  )
WHERE lead_type IS NULL OR recommended_visibility IS NULL;
