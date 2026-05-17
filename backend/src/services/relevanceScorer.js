/** @typedef {{ title?: string; body_snippet?: string; created_utc?: number; subreddit?: string; score?: number; relevance_score?: number; keyword_set?: { product_description?: string; subreddits?: string[]; queries?: string[] } }} ResultLike */
/** @typedef {{ product_description?: string; subreddits?: string[]; queries?: string[] }} KeywordSetLike */

const { extractPhrases } = require('./keywordProcessor');

const stopWords = new Set([
  'a', 'an', 'the', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'with',
  'my', 'i', 'is', 'are', 'we', 'us', 'built', 'build', 'looking', 'people', 'asking',
  'about', 'run', 'running', 'find', 'threads', 'where', 'that', 'this', 'who', 'what',
  'how', 'do', 'use', 'get', 'tool', 'app', 'software', 'help', 'monitor', 'product',
]);

const highIntentPhrases = [
  'looking for',
  'need a',
  'need something',
  'recommend',
  'recommendation',
  'suggestions',
  'anyone use',
  'what do you use',
  'what crm',
  'what tool',
  'which tool',
  'which software',
  'which app',
  'best tool',
  'best software',
  'tired of',
  'sick of',
  'frustrated with',
  'switching from',
  'alternative to',
  'alternatives to',
  'instead of',
  'replacing',
  'help me find',
  'help me choose',
  'can anyone suggest',
  'does anyone know',
  'not getting applicants',
  'hiring is',
  'job posting',
  'track net worth',
  'portfolio',
];

const mediumIntentPhrases = [
  'how do i',
  'how do you',
  'anyone else',
  'is there a',
  'does anyone',
  'any advice',
  'any tips',
  'struggling with',
  'issue with',
  'problem with',
  'confused',
  'lost',
  'not sure',
  'wondering',
  'need help',
];

const businessSubreddits = [
  'entrepreneur',
  'smallbusiness',
  'startups',
  'freelance',
  'sideproject',
  'saas',
  'indiehackers',
  'productivity',
  'recruiting',
  'humanresources',
  'personalfinance',
  'financialplanning',
  'investing',
];

const offTopicSignals = [
  'recipe',
  'workout',
  'skincare',
  'makeup',
  'fashion',
  'dating',
  'relationship',
  'movie',
  'music',
  'gaming',
  'phone',
  'android',
  'iphone',
  'sunscreen',
];

function leadScoreThreshold() {
  const raw = Number.parseInt(process.env.LEAD_SCORE_THRESHOLD ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return process.env.NODE_ENV === 'production' ? 20 : 12;
}

/**
 * @param {KeywordSetLike | null | undefined} keywordSet
 */
function buildLeadContext(keywordSet = {}) {
  const description = String(keywordSet.product_description || '');
  const queryTerms = Array.isArray(keywordSet.queries)
    ? keywordSet.queries.flatMap((q) =>
        String(q || '')
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3 && !stopWords.has(w))
      )
    : [];

  const productTerms = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  const problemTerms = extractPhrases(description, 8).flatMap((p) =>
    String(p)
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !stopWords.has(w))
  );

  const subredditTargets = (keywordSet.subreddits || []).map((s) =>
    String(s || '').toLowerCase().replace(/^r\//, '')
  );

  const allTerms = uniqueTerms([...productTerms, ...problemTerms, ...queryTerms]);

  return {
    product_terms: uniqueTerms(productTerms),
    problem_terms: uniqueTerms(problemTerms),
    query_terms: uniqueTerms(queryTerms),
    subreddit_targets: subredditTargets,
    all_terms: allTerms,
  };
}

function uniqueTerms(list) {
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const k = String(w || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * @param {ResultLike} result
 * @param {KeywordSetLike | null | undefined} keywordSet
 * @returns {{ score: number; reasons: string[] }}
 */
function scoreResultDetailed(result, keywordSet = {}) {
  const reasons = [];

  const title = (result.title || '').toLowerCase();
  const body = (result.body_snippet || '').toLowerCase();
  const fullText = `${title} ${body}`;
  const subreddit = (result.subreddit || '').toLowerCase().replace(/^r\//, '');

  const ks = keywordSet.product_description ? keywordSet : result.keyword_set ?? {};
  const ctx = buildLeadContext(ks);

  const matchedTerms = ctx.all_terms.filter((w) => fullText.includes(w));
  const matchRatio = ctx.all_terms.length > 0 ? matchedTerms.length / ctx.all_terms.length : 0;

  let score = 0;

  if (matchedTerms.length >= 2) {
    const pts = Math.min(matchedTerms.length * 5, 20);
    score += pts;
    reasons.push(`Matches ${matchedTerms.length} monitor term(s) (+${pts} pts).`);
  } else if (matchedTerms.length === 1) {
    score += 6;
    reasons.push('Matches 1 monitor term (+6 pts).');
  } else if (matchRatio < 0.1 && ctx.all_terms.length > 0) {
    score -= 5;
    reasons.push('Low keyword overlap (−5 pts) — still scored on intent/subreddit.');
  }

  let intentScore = 0;
  const highHits = highIntentPhrases.filter((p) => fullText.includes(p));
  const medHits = mediumIntentPhrases.filter((p) => fullText.includes(p));
  highHits.forEach(() => {
    intentScore += 6;
  });
  medHits.forEach(() => {
    intentScore += 3;
  });
  const intentCapped = Math.min(intentScore, 30);
  score += intentCapped;
  if (intentCapped > 0) {
    reasons.push(`Intent language (+${intentCapped} pts, capped at 30).`);
  }

  if (title.includes('?')) {
    score += 6;
    reasons.push('Title asks a question (+6 pts).');
  }
  if (body.includes('?')) {
    score += 4;
    reasons.push('Body includes a question (+4 pts).');
  }

  const targetSubreddits = ctx.subreddit_targets;

  if (
    targetSubreddits.length &&
    targetSubreddits.some(
      (ts) => subreddit === ts || subreddit.includes(ts) || ts.includes(subreddit)
    )
  ) {
    score += 15;
    reasons.push('Posted in a target subreddit (+15 pts).');
  } else if (businessSubreddits.some((s) => subreddit.includes(s))) {
    score += 8;
    reasons.push('Posted in a related business subreddit (+8 pts).');
  } else if (targetSubreddits.length) {
    score -= 4;
    reasons.push('Subreddit not in target list (−4 pts).');
  }

  let tsSec = Number(result.created_utc ?? 0);
  if (!Number.isFinite(tsSec) || tsSec <= 0) {
    tsSec = NaN;
  } else if (tsSec > 1e12) {
    tsSec = Math.floor(tsSec / 1000);
  }

  let recencyPts = 0;
  let recencyLabel = '';
  if (!Number.isNaN(tsSec)) {
    const ageHours = (Date.now() / 1000 - tsSec) / 3600;
    if (ageHours >= 0) {
      if (ageHours < 24) {
        recencyPts = 14;
        recencyLabel = 'under 24 hours old';
      } else if (ageHours < 72) {
        recencyPts = 8;
        recencyLabel = 'under 3 days old';
      } else if (ageHours < 168) {
        recencyPts = 4;
        recencyLabel = 'under 1 week old';
      }
    }
  }
  score += recencyPts;
  if (recencyPts > 0) {
    reasons.push(`Recency: ${recencyLabel} (+${recencyPts} pts).`);
  }

  let offTopicPenalty = 0;
  offTopicSignals.forEach((s) => {
    if (fullText.includes(s)) offTopicPenalty += 6;
  });
  if (offTopicPenalty > 0) {
    score -= offTopicPenalty;
    reasons.push(`Possible off-topic signals (−${offTopicPenalty} pts).`);
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  reasons.push(`Total → ${finalScore} (threshold ${leadScoreThreshold()}).`);

  return { score: finalScore, reasons };
}

function scoreResult(result, keywordSet = {}) {
  return scoreResultDetailed(result, keywordSet).score;
}

/**
 * @param {Array<ResultLike>} results
 * @param {KeywordSetLike | null | undefined} [keywordSet]
 */
function filterLowSignal(results, keywordSet) {
  if (!Array.isArray(results)) return [];

  const ks = keywordSet ?? {};
  const minScore = leadScoreThreshold();

  return results.filter((r) => {
    const s =
      typeof r.relevance_score === 'number' && !Number.isNaN(r.relevance_score)
        ? r.relevance_score
        : scoreResult(r, ks);
    return s >= minScore;
  });
}

module.exports = {
  scoreResult,
  scoreResultDetailed,
  filterLowSignal,
  leadScoreThreshold,
  buildLeadContext,
};
