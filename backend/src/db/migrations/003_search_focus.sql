ALTER TABLE keyword_sets
ADD COLUMN IF NOT EXISTS search_focus TEXT DEFAULT 'demand_side';
