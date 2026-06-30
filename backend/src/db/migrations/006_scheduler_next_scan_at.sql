-- 006_scheduler_next_scan_at.sql
-- Replace Bull repeatable job scheduling with Postgres-based next_scan_at.

ALTER TABLE keyword_sets ADD COLUMN IF NOT EXISTS next_scan_at TIMESTAMPTZ;

-- Backfill: set next_scan_at based on last scan time + interval
UPDATE keyword_sets
SET next_scan_at = COALESCE(last_scanned_at, created_at)
  + (COALESCE(scan_interval_hours, 6) * INTERVAL '1 hour')
WHERE active = true AND next_scan_at IS NULL;

-- Monitors never scanned should scan immediately on first boot
UPDATE keyword_sets
SET next_scan_at = NOW()
WHERE active = true AND last_scanned_at IS NULL AND next_scan_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_keyword_sets_next_scan ON keyword_sets (next_scan_at)
WHERE active = true;
