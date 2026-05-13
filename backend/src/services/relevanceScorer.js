/** @typedef {{ title?: string; body_snippet?: string; created_utc?: number; subreddit?: string; score?: number; relevance_score?: number; keyword_set?: { product_description?: string; subreddits?: string[] } }} ResultLike */
/** @typedef {{ product_description?: string; subreddits?: string[] }} KeywordSetLike */

const stopWords = new Set([
  'a',
  'an',
  'the',
  'for',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'of',
  'with',
  'my',
  'i',
  'is',
  'are',
  'we',
  'us',
  'built',
  'build',
  'looking',
  'people',
  'asking',
  'about',
  'run',
  'running',
  'find',
  'threads',
  'where',
  'that',
  'this',
  'who',
  'what',
  'how',
  'do',
  'use',
  'get',
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
  'hate that',
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
  'help',
  'confused',
  'lost',
  'not sure',
  'wondering',
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
  'food',
  'restaurant',
  'travel',
  'vacation',
];

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
  const subreddit = (result.subreddit || '').toLowerCase();

  const ks = keywordSet.product_description
    ? keywordSet
    : result.keyword_set ?? {};

  const description = String(ks.product_description || '');

  const productWords = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  const matchedWords = productWords.filter((w) => fullText.includes(w));
  const matchRatio =
    productWords.length > 0 ? matchedWords.length / productWords.length : 0;

  if (matchRatio < 0.15 && matchedWords.length < 2) {
    return {
      score: 8,
      reasons: [
        'Low overlap with your monitor description keywords — likely off-topic for this product.',
      ],
    };
  }

  let score = 0;

  const titleMatches = productWords.filter((w) => title.includes(w));
  const bodyMatches = productWords.filter((w) => body.includes(w));

  const titlePts = Math.min(titleMatches.length * 8, 24);
  score += titlePts;
  if (titlePts > 0) {
    reasons.push(
      `Title matches ${titleMatches.length} product keyword(s) (+${titlePts} pts).`
    );
  }

  const bodyPts = Math.min(bodyMatches.length * 4, 16);
  score += bodyPts;
  if (bodyPts > 0) {
    reasons.push(
      `Body matches ${bodyMatches.length} product keyword(s) (+${bodyPts} pts).`
    );
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
    reasons.push(
      `Help-seeking / buying-intent language (+${intentCapped} pts, capped at 30).`
    );
  }

  if (title.includes('?')) {
    score += 6;
    reasons.push('Title asks a question (+6 pts).');
  }
  if (body.includes('?')) {
    score += 4;
    reasons.push('Body includes a question (+4 pts).');
  }

  const targetSubreddits = (ks.subreddits || []).map((s) =>
    String(s || '').toLowerCase()
  );

  if (
    targetSubreddits.length &&
    targetSubreddits.some(
      (ts) => subreddit === ts || subreddit.includes(ts) || ts.includes(subreddit)
    )
  ) {
    score += 15;
    reasons.push('Posted in one of your monitor target subreddits (+15 pts).');
  } else if (businessSubreddits.some((s) => subreddit.includes(s))) {
    score += 8;
    reasons.push('Posted in a related business/builder subreddit (+8 pts).');
  } else {
    score -= 10;
    reasons.push('Subreddit is not in your targets or common builder subs (−10 pts).');
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
      if (ageHours < 1) {
        recencyPts = 25;
        recencyLabel = 'under 1 hour old';
      } else if (ageHours < 6) {
        recencyPts = 19;
        recencyLabel = 'under 6 hours old';
      } else if (ageHours < 24) {
        recencyPts = 14;
        recencyLabel = 'under 24 hours old';
      } else if (ageHours < 72) {
        recencyPts = 8;
        recencyLabel = 'under 3 days old';
      } else if (ageHours < 168) {
        recencyPts = 4;
        recencyLabel = 'under 1 week old';
      } else if (ageHours < 336) {
        recencyPts = 1;
        recencyLabel = '1–2 weeks old';
      }
    }
  }
  score += recencyPts;
  if (recencyPts > 0) {
    reasons.push(`Recency: post is ${recencyLabel} (+${recencyPts} pts).`);
  } else if (!Number.isNaN(tsSec)) {
    reasons.push('Recency: older than 2 weeks — no freshness bonus.');
  }

  let offTopicPenalty = 0;
  offTopicSignals.forEach((s) => {
    if (fullText.includes(s)) offTopicPenalty += 8;
  });
  if (offTopicPenalty > 0) {
    score -= offTopicPenalty;
    reasons.push(
      `Possible off-topic signals in text (−${offTopicPenalty} pts).`
    );
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  reasons.push(`Total clamped to 0–100 → ${finalScore}.`);

  return { score: finalScore, reasons };
}

/**
 * @param {ResultLike} result
 * @param {KeywordSetLike | null | undefined} keywordSet
 */
function scoreResult(result, keywordSet = {}) {
  return scoreResultDetailed(result, keywordSet).score;
}

function leadScoreThreshold() {
  const raw = Number.parseInt(process.env.LEAD_SCORE_THRESHOLD ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30;
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
      typeof r.score === 'number' && !Number.isNaN(r.score)
        ? r.score
        : typeof r.relevance_score === 'number' && !Number.isNaN(r.relevance_score)
          ? r.relevance_score
          : scoreResult(r, ks.keyword_set ?? ks);
    return s >= minScore;
  });
}

module.exports = {
  scoreResult,
  scoreResultDetailed,
  filterLowSignal,
  leadScoreThreshold,
};
