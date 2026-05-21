/**
 * Lead type + inbox visibility — driven by classifier output and monitor search_focus.
 * No product/city/domain hardcoding.
 */

const { normalizeSearchFocus } = require('./searchFocus');

const LEAD_TYPES = new Set([
  'direct_demand',
  'adjacent_demand',
  'market_research',
  'supplier_side',
  'competitor_signal',
  'not_a_lead',
]);

const LEGACY_TYPE_MAP = {
  competitor_market_signal: 'market_research',
  weak_signal: 'adjacent_demand',
  market_signal: 'market_research',
  supplier: 'supplier_side',
  competitor: 'competitor_signal',
  research: 'market_research',
};

const LEAD_TYPE_LABELS = {
  direct_demand: 'Direct demand',
  adjacent_demand: 'Adjacent',
  market_research: 'Market research',
  supplier_side: 'Supplier',
  competitor_signal: 'Competitor',
  not_a_lead: 'Not a lead',
};

function adjacentMinConfidence() {
  const n = Number(process.env.ADJACENT_DEMAND_MIN_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 ? n : 45;
}

function normalizeLeadType(raw) {
  const key = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  const mapped = LEGACY_TYPE_MAP[key] || key;
  return LEAD_TYPES.has(mapped) ? mapped : 'not_a_lead';
}

/**
 * Resolve inbox visibility from lead_type, confidence, and monitor focus.
 * @returns {'show'|'hide'|'debug'}
 */
function resolveRecommendedVisibility(input = {}) {
  const lead_type = normalizeLeadType(input.lead_type);
  const confidence = Math.min(100, Math.max(0, Number(input.confidence) || 0));
  const search_focus = normalizeSearchFocus(input.search_focus);
  let is_lead = Boolean(input.is_lead);

  if (lead_type === 'not_a_lead') {
    return { lead_type, is_lead: false, recommended_visibility: 'hide' };
  }

  if (!is_lead) {
    return { lead_type, is_lead: false, recommended_visibility: 'hide' };
  }

  const aiVis = String(input.recommended_visibility || '').toLowerCase();
  if (aiVis === 'debug') {
    return { lead_type, is_lead: true, recommended_visibility: 'debug' };
  }

  switch (lead_type) {
    case 'direct_demand':
      return { lead_type, is_lead: true, recommended_visibility: 'show' };
    case 'adjacent_demand':
      return {
        lead_type,
        is_lead: true,
        recommended_visibility:
          confidence >= adjacentMinConfidence() ? 'show' : 'hide',
      };
    case 'market_research':
      return { lead_type, is_lead: true, recommended_visibility: 'hide' };
    case 'supplier_side':
      return {
        lead_type,
        is_lead: true,
        recommended_visibility:
          search_focus === 'supply_side' || search_focus === 'both' ? 'show' : 'hide',
      };
    case 'competitor_signal':
      return { lead_type, is_lead: true, recommended_visibility: 'hide' };
    default:
      return { lead_type: 'not_a_lead', is_lead: false, recommended_visibility: 'hide' };
  }
}

function enrichQualification(qualification, keywordSetOrBrief = {}) {
  const brief =
    keywordSetOrBrief?.search_brief && typeof keywordSetOrBrief.search_brief === 'object'
      ? keywordSetOrBrief.search_brief
      : keywordSetOrBrief;
  const search_focus =
    keywordSetOrBrief?.search_focus || brief?.search_focus || 'demand_side';

  const lead_type = normalizeLeadType(qualification?.lead_type);
  let is_lead = Boolean(qualification?.is_lead);
  if (lead_type === 'not_a_lead') is_lead = false;

  const resolved = resolveRecommendedVisibility({
    lead_type,
    is_lead,
    confidence: qualification?.confidence,
    search_focus,
    recommended_visibility: qualification?.recommended_visibility,
  });

  return {
    ...qualification,
    lead_type: resolved.lead_type,
    is_lead: resolved.is_lead,
    recommended_visibility: resolved.recommended_visibility,
  };
}

/**
 * Parse `include` query: default inbox only; `all` or comma-separated lead types.
 */
function parseIncludeParam(includeRaw) {
  const raw = String(includeRaw || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return { mode: 'inbox', leadTypes: null };
  }
  if (raw === 'all') {
    return { mode: 'all', leadTypes: null };
  }
  const types = raw
    .split(',')
    .map((t) => normalizeLeadType(t.trim()))
    .filter((t) => t !== 'not_a_lead');
  if (!types.length) {
    return { mode: 'inbox', leadTypes: null };
  }
  return { mode: 'types', leadTypes: [...new Set(types)] };
}

function buildVisibilitySql(includeParsed, params) {
  const col = `COALESCE(l.recommended_visibility, l.qualification->>'recommended_visibility', 'show')`;
  const typeCol = `COALESCE(l.lead_type, l.qualification->>'lead_type', 'direct_demand')`;

  if (includeParsed.mode === 'all') {
    return {
      clause: `${typeCol} <> 'not_a_lead'`,
      typeCol,
      visCol: col,
    };
  }

  if (includeParsed.mode === 'types' && includeParsed.leadTypes?.length) {
    params.push(includeParsed.leadTypes);
    const idx = params.length;
    return {
      clause: `${typeCol} = ANY($${idx}::text[])`,
      typeCol,
      visCol: col,
    };
  }

  params.push('show');
  const idx = params.length;
  return {
    clause: `${col} = $${idx}`,
    typeCol,
    visCol: col,
  };
}

module.exports = {
  LEAD_TYPES,
  LEAD_TYPE_LABELS,
  normalizeLeadType,
  resolveRecommendedVisibility,
  enrichQualification,
  parseIncludeParam,
  buildVisibilitySql,
  adjacentMinConfidence,
};
