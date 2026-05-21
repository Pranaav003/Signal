/**
 * Validates AI search plans — no product-specific runtime rules.
 */

function isPlaceholderQuery(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 8) return true;

  if (/\b[XxYyZz]\b/.test(q)) return true;
  if (/\bsells\s+[XYZ]\b/i.test(q)) return true;
  if (/\bget\s+a\s+[XYZ]\b/i.test(q)) return true;
  if (/\b(place|spot)\s+that\s+sells\s+[XYZ]/i.test(q)) return true;
  if (/\[[^\]]+\]/.test(q)) return true;
  if (/\{[^}]+\}/.test(q)) return true;
  if (/<[^>]+>/.test(q)) return true;
  if (/\b(insert|placeholder|example|tbd|todo)\b/i.test(q)) return true;
  if (/\ba\s+[A-Z]\s+(restaurant|business|place|shop|store)\b/i.test(q)) return true;
  if (/\bsells\s+[A-Z]\b/i.test(q)) return true;
  if (/\bget\s+a\s+[A-Z]\s+/i.test(q)) return true;
  if (/\byour\s+city\b/i.test(q)) return true;

  return false;
}

function normalizeSubredditEntries(raw) {
  if (!Array.isArray(raw)) return [];

  const out = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && item.name) {
      const name = String(item.name).replace(/^r\//i, '').replace(/\s+/g, '');
      if (!name) continue;
      const priority = ['high', 'medium', 'low'].includes(item.priority)
        ? item.priority
        : 'medium';
      out.push({ name, priority, reason: String(item.reason || '').trim() });
    } else if (typeof item === 'string' && item.trim()) {
      const name = item.replace(/^r\//i, '').replace(/\s+/g, '');
      if (name) out.push({ name, priority: 'medium', reason: '' });
    }
  }

  const seen = new Set();
  return out.filter((s) => {
    const k = s.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function subredditNamesOrdered(entries) {
  const order = { high: 0, medium: 1, low: 2 };
  return [...entries]
    .sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1))
    .map((s) => s.name);
}

function isDiaryStyleQuery(query) {
  const q = String(query || '').trim();
  if (!q) return true;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 14) return true;
  if (/^i\s+(am|m|wish|crave|need|want)\b/i.test(q)) return true;
  if (/^i'm\b/i.test(q)) return true;
  if (/but there('s| is) nowhere/i.test(q)) return true;
  if (/!/.test(q) && words.length > 10) return true;
  if (/\bfood recommendation\b/i.test(q)) return true;
  return false;
}

function splitSearchQueriesFromPatterns(brief = {}) {
  const rawQueries = [
    ...(Array.isArray(brief.search_queries) ? brief.search_queries : []),
    ...(Array.isArray(brief.queries) ? brief.queries : []),
  ];
  const rawPatterns = Array.isArray(brief.lead_patterns) ? [...brief.lead_patterns] : [];

  const search_queries = [];
  const lead_patterns = [...rawPatterns];

  for (const item of rawQueries) {
    const q = String(item || '').trim();
    if (!q) continue;
    if (isDiaryStyleQuery(q)) {
      lead_patterns.push(q);
    } else {
      search_queries.push(q);
    }
  }

  return {
    search_queries: filterConcreteQueries(search_queries),
    lead_patterns: uniqueStrings(lead_patterns),
  };
}

function uniqueStrings(list) {
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

function filterConcreteQueries(queries) {
  return (queries || [])
    .map((q) => String(q || '').trim())
    .filter((q) => q.length >= 8 && !isPlaceholderQuery(q) && !isDiaryStyleQuery(q));
}

function validateSearchPlan(brief, desc = '') {
  const errors = [];
  const queries = filterConcreteQueries(brief?.search_queries || brief?.queries);
  const subredditEntries = normalizeSubredditEntries(brief?.subreddits);
  const subreddits = subredditNamesOrdered(subredditEntries);

  if (!brief?.lead_definition?.trim()) {
    errors.push('missing lead_definition');
  }
  if (!(brief?.required_evidence || []).length) {
    errors.push('missing required_evidence');
  }
  if (!(brief?.disqualifying_evidence || brief?.disqualifiers || []).length) {
    errors.push('missing disqualifying_evidence');
  }
  if (queries.length < 8) {
    errors.push(`too few concrete queries (${queries.length}, need at least 8)`);
  }
  if (subreddits.length < 5) {
    errors.push(`too few subreddits (${subreddits.length}, need at least 5)`);
  }

  const placeholderRemoved = (brief?.queries || []).length - queries.length;
  if (placeholderRemoved > 0) {
    errors.push(`removed ${placeholderRemoved} placeholder queries`);
  }

  return {
    valid: errors.length === 0,
    errors,
    queries,
    subreddits,
    subreddit_entries: subredditEntries,
  };
}

function applyValidatedPlan(brief, validation) {
  const next = { ...brief };
  next.queries = validation.queries;
  next.subreddits = validation.subreddits;
  next.subreddit_entries = validation.subreddit_entries;
  return next;
}

module.exports = {
  isPlaceholderQuery,
  isDiaryStyleQuery,
  splitSearchQueriesFromPatterns,
  normalizeSubredditEntries,
  subredditNamesOrdered,
  filterConcreteQueries,
  validateSearchPlan,
  applyValidatedPlan,
};
