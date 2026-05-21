/**
 * AI search-brief-first query generation — no product-specific runtime routing.
 */

const { generateSearchBrief, buildFallbackBrief } = require('./searchBriefPlanner');
const { resolveScanStrategy } = require('./marketplacePlan');
const {
  isPlaceholderQuery,
  validateSearchPlan,
  subredditNamesOrdered,
  normalizeSubredditEntries,
} = require('./planValidator');

const stopWords = new Set([
  'a', 'an', 'the', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'with',
  'my', 'i', 'is', 'are', 'we', 'us', 'that', 'this', 'who', 'what', 'how', 'do',
  'built', 'build', 'tool', 'app', 'software', 'platform', 'service', 'solution',
  'monitor', 'find', 'people', 'help', 'using', 'use', 'their', 'your', 'our',
]);

const GENERIC_STEMS = new Set([
  'pain', 'management', 'customer', 'product', 'business', 'software', 'tool', 'help',
]);

function unique(list) {
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
}

function wordCount(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeDescription(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericQuery(q) {
  const w = String(q || '').toLowerCase().trim();
  if (wordCount(w) < 3) return true;
  if (/^(pain|management|customer|product|business|software|tool)\s+help$/i.test(w)) return true;
  if (/^food recommendation$/i.test(w)) return true;
  if (/^business help$/i.test(w)) return true;
  const tokens = w.split(/\s+/).filter(Boolean);
  const stemHits = tokens.filter((t) => GENERIC_STEMS.has(t));
  if (stemHits.length >= 2 && tokens.length <= 4) return true;
  return false;
}

function extractPhrases(productDescription, max = 10) {
  const text = String(productDescription || '').toLowerCase();
  const phrases = [];
  const cleaned = text.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter((w) => w.length > 2 && !stopWords.has(w));
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const two = `${tokens[i]} ${tokens[i + 1]}`;
    if (two.length >= 6) phrases.push(two);
  }
  return unique(phrases).slice(0, max);
}

function planFromBrief(brief, desc, options = {}) {
  const strategy = resolveScanStrategy(brief, options.search_focus);
  const activeBrief = strategy.search_brief;
  const querySource = strategy.queries.length
    ? strategy.queries
    : activeBrief.search_queries || activeBrief.queries || [];
  const queries = unique(querySource)
    .filter((q) => !isGenericQuery(q))
    .filter((q) => !isPlaceholderQuery(q))
    .filter((q) => wordCount(q) >= 3 && wordCount(q) <= 14)
    .slice(0, 20);

  const subredditEntries =
    activeBrief.subreddit_entries || normalizeSubredditEntries(strategy.subreddits || []);
  const subreddits = subredditNamesOrdered(subredditEntries).slice(0, 15);

  const avoid = new Set((brief.avoid_subreddits || []).map((s) => String(s).toLowerCase()));
  const filteredSubs = subreddits.filter((s) => !avoid.has(String(s).toLowerCase()));

  return {
    queries: queries.length >= 5 ? queries : buildFallbackBrief(desc).queries.slice(0, 20),
    subreddits: filteredSubs.length >= 3 ? filteredSubs : buildFallbackBrief(desc).subreddits.slice(0, 12),
    reddit_fit: brief.reddit_fit || 'good',
    warning: brief.warning || null,
    suggestion: brief.suggestion || null,
    domain: 'ai_generated',
    phrases: extractPhrases(desc, 8),
    negative_keywords: brief.negative_keywords || [],
    ideal_post_patterns: brief.ideal_post_patterns || [],
    required_concepts: brief.required_evidence || brief.required_concepts || [],
    optional_concepts: brief.should_have_concepts || brief.optional_concepts || [],
    disqualifiers: brief.disqualifying_evidence || brief.disqualifiers || [],
    rewritten_prompt: brief.rewritten_monitor || brief.rewritten_prompt || desc,
    search_brief: { ...activeBrief, search_focus: strategy.search_focus },
    search_focus: strategy.search_focus,
    product_type: activeBrief.product_type || brief.product_type || 'unknown',
    sides: activeBrief.sides || brief.sides || [],
    primary_side: activeBrief.primary_side || brief.primary_side || 'demand_side',
    primary_side_reason: activeBrief.primary_side_reason || brief.primary_side_reason || null,
    positive_lead_patterns: brief.positive_lead_patterns || [],
    negative_lead_patterns: brief.negative_lead_patterns || [],
    target_customer: brief.customer_personas || brief.target_customer || [],
    pain_points: brief.jobs_to_be_done || brief.pain_points || [],
    product_summary: brief.product_summary || brief.core_demand_signal || null,
    source: brief.planner_source || brief._source || 'ai',
    planner_source: brief.planner_source || brief._source || 'ai',
    planner_model: brief.planner_model || brief._planner_model || null,
    reasoning_summary: brief.reasoning_summary || null,
    lead_definition: brief.lead_definition,
    required_evidence: brief.required_evidence || [],
    disqualifying_evidence: brief.disqualifying_evidence || [],
  };
}

async function generateQueries(productDescription, options = {}) {
  const desc = normalizeDescription(productDescription);
  if (!desc) throw new Error('product_description is required');

  let brief = null;
  try {
    brief = await generateSearchBrief(desc, options);
  } catch (err) {
    console.warn('[keywordProcessor] search brief failed:', err?.message || err);
  }

  if (!brief) {
    brief = buildFallbackBrief(desc);
  }

  const validation = validateSearchPlan(brief, desc);
  if (!validation.valid) {
    const err = new Error(`invalid_search_plan: ${validation.errors.join('; ')}`);
    err.code = 'invalid_search_plan';
    err.validation = validation;
    throw err;
  }

  return planFromBrief(brief, desc, options);
}

function shouldRegenerateQueries(queries) {
  const list = Array.isArray(queries) ? queries.filter(Boolean) : [];
  if (list.length < 3) return true;
  const genericCount = list.filter((q) => isGenericQuery(q)).length;
  return genericCount >= Math.ceil(list.length / 2);
}

function getSearchStrategyFromKeywordSet(keywordSet) {
  const brief =
    keywordSet?.search_brief && typeof keywordSet.search_brief === 'object'
      ? keywordSet.search_brief
      : {};

  return {
    rewritten_prompt: brief.rewritten_monitor || brief.rewritten_prompt || keywordSet?.product_description || '',
    lead_definition: brief.lead_definition || '',
    search_focus: keywordSet?.search_focus || brief.search_focus || brief.primary_side || 'demand_side',
    product_type: brief.product_type || null,
    primary_side: brief.primary_side || null,
    planner_source: brief.planner_source || brief._source || null,
    classifier_source: brief.classifier_source || null,
    target_customer: brief.customer_personas || brief.target_customer || [],
    query_count: (keywordSet?.queries || []).length,
    subreddit_count: (keywordSet?.subreddits || []).length,
    priority_subreddits: keywordSet?.subreddits || [],
    negative_keywords: brief.negative_keywords || [],
    positive_lead_patterns: brief.positive_lead_patterns || [],
    disqualifiers: brief.disqualifying_evidence || brief.disqualifiers || [],
  };
}

function orderSubredditsByPriority(subreddits, keywordSet) {
  const list = Array.isArray(subreddits) ? [...subreddits] : [];
  const brief = keywordSet?.search_brief || {};
  const entries = brief.subreddit_entries || normalizeSubredditEntries(brief.subreddits || list);
  const ranked = subredditNamesOrdered(entries);
  const avoid = new Set(
    (brief.avoid_subreddits || []).map((s) => String(s).toLowerCase())
  );
  const rankedFiltered = ranked.filter((s) => !avoid.has(String(s).toLowerCase()));
  const rest = list.filter(
    (s) => !rankedFiltered.includes(s) && !avoid.has(String(s).toLowerCase())
  );
  return unique([...rankedFiltered, ...rest]);
}

function shouldRunSubredditQuery() {
  return true;
}

module.exports = {
  generateQueries,
  extractPhrases,
  isGenericQuery,
  shouldRegenerateQueries,
  getSearchStrategyFromKeywordSet,
  orderSubredditsByPriority,
  shouldRunSubredditQuery,
  resolveScanStrategy,
};
