const VALID_SEARCH_FOCUS = new Set(['demand_side', 'supply_side', 'both']);

function normalizeSearchFocus(value, fallback = 'demand_side') {
  const raw = String(value || '').trim();
  if (VALID_SEARCH_FOCUS.has(raw)) return raw;
  const fb = String(fallback || '').trim();
  if (VALID_SEARCH_FOCUS.has(fb)) return fb;
  return 'demand_side';
}

module.exports = {
  VALID_SEARCH_FOCUS,
  normalizeSearchFocus,
};
