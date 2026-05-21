/**
 * Marketplace / multi-sided search brief helpers — no product-specific runtime rules.
 */

const {
  filterConcreteQueries,
  normalizeSubredditEntries,
  subredditNamesOrdered,
  splitSearchQueriesFromPatterns,
} = require('./planValidator');

function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

function normalizeSide(raw, defaultName) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const split = splitSearchQueriesFromPatterns(s);
  const entries = normalizeSubredditEntries(s.subreddits);
  const queries = filterConcreteQueries(
    split.search_queries.length ? split.search_queries : arr(s.search_queries || s.queries)
  );

  return {
    name: String(s.name || defaultName).trim() || defaultName,
    description: String(s.description || '').trim(),
    likely_buyers_or_users: arr(s.likely_buyers_or_users),
    lead_definition: String(s.lead_definition || '').trim(),
    search_queries: queries,
    lead_patterns: split.lead_patterns,
    queries,
    subreddits: subredditNamesOrdered(entries),
    subreddit_entries: entries,
    required_evidence: arr(s.required_evidence),
    disqualifying_evidence: arr(s.disqualifying_evidence),
    positive_lead_patterns: arr(s.positive_lead_patterns),
    negative_lead_patterns: arr(s.negative_lead_patterns),
  };
}

function inferProductType(raw) {
  const t = String(raw || '').toLowerCase();
  if (['single_sided', 'marketplace', 'tool', 'service', 'unknown'].includes(t)) return t;
  if (t.includes('market')) return 'marketplace';
  return 'unknown';
}

function normalizeSidesFromBrief(b, desc) {
  let sides = (Array.isArray(b.sides) ? b.sides : []).map((s, i) =>
    normalizeSide(s, i === 0 ? 'demand_side' : i === 1 ? 'supply_side' : `side_${i + 1}`)
  );

  const hasMultiSidedLanguage =
    /\b(rent|rental|marketplace|owners?|providers?|buyers?|both sides|two-sided|supply|demand)\b/i.test(
      desc
    );

  if (sides.length < 2 && (b.product_type === 'marketplace' || hasMultiSidedLanguage)) {
    const topQueries = filterConcreteQueries(b.search_queries || b.queries || []);
    const topSubs = subredditNamesOrdered(normalizeSubredditEntries(b.subreddits || []));
    const baseDef = String(b.lead_definition || '').trim();
    sides = [
      normalizeSide(
        {
          name: 'demand_side',
          description: 'Organizations or people seeking the service or experience',
          likely_buyers_or_users: b.customer_personas || [],
          lead_definition:
            baseDef || 'Posts from buyers, venues, or coordinators expressing need for the service',
          search_queries: topQueries,
          subreddits: topSubs,
          required_evidence: b.required_evidence,
          disqualifying_evidence: b.disqualifying_evidence,
        },
        'demand_side'
      ),
      normalizeSide(
        {
          name: 'supply_side',
          description: 'People offering to provide the service or asset',
          likely_buyers_or_users: ['providers', 'owners', 'freelancers'],
          lead_definition: 'Posts from people offering to provide the service or rent out an asset',
          search_queries: [],
          subreddits: topSubs.slice(0, 4),
          required_evidence: [],
          disqualifying_evidence: b.disqualifying_evidence,
        },
        'supply_side'
      ),
    ];
  }

  return sides;
}

function pickPrimarySide(b, sides) {
  const requested = String(b.primary_side || '').trim();
  if (['demand_side', 'supply_side', 'both'].includes(requested)) return requested;
  if (sides.length >= 2) return 'demand_side';
  return 'demand_side';
}

/**
 * Apply monitor search_focus to queries, subreddits, and qualification rubric.
 */
function resolveScanStrategy(brief = {}, searchFocus) {
  const sides = Array.isArray(brief.sides) ? brief.sides : [];
  const pick = (name) => sides.find((s) => s.name === name);
  const { normalizeSearchFocus } = require('../utils/searchFocus');
  const focus = normalizeSearchFocus(
    searchFocus || brief.search_focus,
    brief.primary_side || 'demand_side'
  );

  let queries = [];
  let subreddits = [];
  let activeBrief = { ...brief, search_focus: focus };

  const mergeSideIntoBrief = (side) => {
    if (!side) return;
    if (side.lead_definition) activeBrief.lead_definition = side.lead_definition;
    if (side.required_evidence?.length) activeBrief.required_evidence = side.required_evidence;
    if (side.disqualifying_evidence?.length) {
      activeBrief.disqualifying_evidence = side.disqualifying_evidence;
    }
    if (side.positive_lead_patterns?.length) {
      activeBrief.positive_lead_patterns = side.positive_lead_patterns;
    }
    if (side.negative_lead_patterns?.length) {
      activeBrief.negative_lead_patterns = side.negative_lead_patterns;
    }
    if (side.lead_patterns?.length) activeBrief.lead_patterns = side.lead_patterns;
    activeBrief.active_side = side.name;
  };

  if (focus === 'both' && sides.length >= 2) {
    const demand = pick('demand_side');
    const supply = pick('supply_side');
    queries = [
      ...(demand?.search_queries || []),
      ...(supply?.search_queries || []),
    ];
    subreddits = [...(demand?.subreddits || []), ...(supply?.subreddits || [])];
    mergeSideIntoBrief(demand);
    activeBrief.scanning_sides = ['demand_side', 'supply_side'];
  } else if (focus === 'supply_side') {
    const supply = pick('supply_side') || sides.find((s) => s.name !== 'demand_side');
    queries = supply?.search_queries || [];
    subreddits = supply?.subreddits || [];
    mergeSideIntoBrief(supply);
    activeBrief.scanning_sides = ['supply_side'];
  } else {
    const demand = pick('demand_side') || sides[0];
    queries = demand?.search_queries || [];
    subreddits = demand?.subreddits || [];
    mergeSideIntoBrief(demand);
    activeBrief.scanning_sides = ['demand_side'];
  }

  const unique = (list) => {
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const v = String(raw || '').trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  };

  queries = unique(queries.length ? queries : brief.search_queries || brief.queries || []);
  subreddits = unique(
    subreddits.length
      ? subreddits
      : subredditNamesOrdered(normalizeSubredditEntries(brief.subreddits || []))
  );

  return {
    search_focus: focus,
    queries,
    subreddits,
    search_brief: activeBrief,
  };
}

function attachMarketplaceFields(brief, desc) {
  const sides = normalizeSidesFromBrief(brief, desc);
  const product_type =
    sides.length >= 2 ? 'marketplace' : inferProductType(brief.product_type);
  const primary_side = pickPrimarySide(brief, sides);
  const primarySideObj =
    sides.find((s) => s.name === primary_side) ||
    sides.find((s) => s.name === 'demand_side') ||
    sides[0];

  const merged = {
    ...brief,
    product_type,
    sides,
    primary_side,
    primary_side_reason:
      String(brief.primary_side_reason || '').trim() ||
      (sides.length >= 2
        ? 'Lead monitoring usually finds better opportunities on the demand side (buyers, venues, coordinators) unless you are recruiting providers.'
        : ''),
    search_focus: brief.search_focus || primary_side,
  };

  if (primarySideObj?.search_queries?.length) {
    merged.search_queries = primarySideObj.search_queries;
    merged.queries = primarySideObj.search_queries;
  }
  if (primarySideObj?.subreddits?.length) {
    merged.subreddits = primarySideObj.subreddits;
    merged.subreddit_entries = primarySideObj.subreddit_entries;
  }
  if (primarySideObj?.lead_definition) merged.lead_definition = primarySideObj.lead_definition;

  return merged;
}

module.exports = {
  normalizeSide,
  normalizeSidesFromBrief,
  resolveScanStrategy,
  attachMarketplaceFields,
  inferProductType,
};
