/** @typedef {{ title?: string; body_snippet?: string; created_utc?: number; subreddit?: string; score?: number; relevance_score?: number; keyword_set?: { product_description?: string; subreddits?: string[]; queries?: string[] } }} ResultLike */
/** @typedef {{ product_description?: string; subreddits?: string[]; queries?: string[]; search_brief?: object }} KeywordSetLike */

const { extractPhrases } = require('./keywordProcessor');
const { qualifyLead, getBrief } = require('./leadQualifier');
const { LEAD_TYPE_LABELS } = require('../utils/leadVisibility');

const stopWords = new Set([
  'a', 'an', 'the', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'with',
  'my', 'i', 'is', 'are', 'we', 'us', 'built', 'build', 'looking', 'people', 'asking',
  'about', 'run', 'running', 'find', 'threads', 'where', 'that', 'this', 'who', 'what',
  'how', 'do', 'use', 'get', 'tool', 'app', 'software', 'help', 'monitor', 'product',
]);

const highIntentPhrases = [
  'what should open',
  'wish we had',
  'why is there no',
  'why don\'t we have',
  'missing',
  'need more',
  'students need',
  'students want',
  'late night food',
  'food options near',
  'what restaurant',
  'what business',
  'what chain',
  'looking for',
  'recommend',
];

const mediumIntentPhrases = [
  'how do i',
  'anyone else',
  'is there a',
  'does anyone',
  'struggling with',
  'need help',
];

const offTopicSignals = ['recipe', 'workout', 'skincare', 'dating', 'gaming'];

function leadScoreThreshold() {
  const raw = Number.parseInt(process.env.LEAD_SCORE_THRESHOLD ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return process.env.NODE_ENV === 'production' ? 35 : 30;
}

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

  return {
    product_terms: uniqueTerms(productTerms),
    problem_terms: uniqueTerms(problemTerms),
    query_terms: uniqueTerms(queryTerms),
    subreddit_targets: subredditTargets,
    all_terms: uniqueTerms([...productTerms, ...problemTerms, ...queryTerms]),
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
 * Cheap ranking score — does NOT grant subreddit-only or weak-intent boosts.
 */
function scoreInitialDetailed(result, keywordSet = {}) {
  const reasons = [];
  const title = (result.title || '').toLowerCase();
  const body = (result.body_snippet || '').toLowerCase();
  const fullText = `${title} ${body}`;
  const ctx = buildLeadContext(keywordSet);

  const matchedQueryTerms = ctx.query_terms.filter((w) => fullText.includes(w));
  const matchedProductTerms = ctx.product_terms.filter((w) => fullText.includes(w));

  let score = 0;

  if (matchedQueryTerms.length >= 2) {
    const pts = Math.min(matchedQueryTerms.length * 5, 18);
    score += pts;
    reasons.push(`Query overlap (+${pts}).`);
  } else if (matchedQueryTerms.length === 1) {
    score += 6;
    reasons.push('Partial query overlap (+6).');
  }

  if (matchedProductTerms.length >= 1) {
    const pts = Math.min(matchedProductTerms.length * 3, 10);
    score += pts;
    reasons.push(`Product terms (+${pts}).`);
  }

  const highHits = highIntentPhrases.filter((p) => fullText.includes(p));
  const medHits = mediumIntentPhrases.filter((p) => fullText.includes(p));
  if (highHits.length) {
    const pts = Math.min(highHits.length * 5, 15);
    score += pts;
    reasons.push(`Strong intent phrases (+${pts}).`);
  } else if (medHits.length) {
    score += Math.min(medHits.length * 2, 6);
    reasons.push('Weak intent (+≤6).');
  }

  if (title.includes('?')) score += 4;

  let offTopicPenalty = 0;
  offTopicSignals.forEach((s) => {
    if (fullText.includes(s)) offTopicPenalty += 5;
  });
  score -= offTopicPenalty;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    meta: { phase: 'initial' },
  };
}

function buildQualificationReasons(qualification, initialScore) {
  const reasons = [];
  const src = qualification.classifier || qualification.source || 'unknown';
  if (!qualification.is_lead) {
    reasons.push(qualification.reject_reason || 'Rejected by lead qualification.');
    reasons.push(`Initial rank score ${initialScore} — not saved (${src}).`);
    return reasons;
  }

  reasons.push(`Lead accepted (${src}, confidence ${qualification.confidence}).`);
  if (qualification.lead_type) {
    const label = LEAD_TYPE_LABELS[qualification.lead_type] || qualification.lead_type;
    reasons.push(`Lead type: ${label}`);
  }
  if (qualification.evidence) {
    reasons.push(`Evidence: ${qualification.evidence}`);
  }
  if (qualification.recommended_visibility && qualification.recommended_visibility !== 'show') {
    reasons.push(`Inbox visibility: ${qualification.recommended_visibility}`);
  }
  if (qualification.matched_positive_patterns?.length) {
    reasons.push(`Matched pattern: ${qualification.matched_positive_patterns[0]}`);
  }
  if (qualification.matched_required_concepts?.length) {
    reasons.push(
      `Required evidence: ${qualification.matched_required_concepts.slice(0, 5).join(', ')}`
    );
  }
  return reasons;
}

function computeFinalScore(initialScore, qualification) {
  if (!qualification?.is_lead) {
    if (process.env.SAVE_REJECTED_DEBUG === 'true') {
      return Math.min(initialScore, 25);
    }
    return Math.min(initialScore, 25);
  }
  const blended = Math.round(initialScore * 0.35 + (qualification.confidence || 50) * 0.65);
  return Math.max(leadScoreThreshold(), Math.min(100, blended));
}

/**
 * Full score path (used when qualification already attached on candidate).
 */
function scoreResultDetailed(result, keywordSet = {}) {
  const ks =
    keywordSet.product_description || keywordSet.search_brief ? keywordSet : result.keyword_set ?? {};
  const brief = getBrief(ks);

  const initial =
    typeof result.initial_score === 'number'
      ? { score: result.initial_score, reasons: result.initial_reasons || [] }
      : scoreInitialDetailed(result, ks);

  const qualification =
    result.qualification || qualifyLead(result, { ...brief, product_description: ks.product_description });

  const finalScore = computeFinalScore(initial.score, qualification);
  const reasons = [
    ...buildQualificationReasons(qualification, initial.score),
    `Final score: ${finalScore} (threshold ${leadScoreThreshold()}).`,
  ];

  return {
    score: finalScore,
    reasons,
    meta: {
      qualified: qualification.is_lead,
      phase: 'final',
      initial_score: initial.score,
      reject_reason: qualification.reject_reason,
      confidence: qualification.confidence,
      lead_type: qualification.lead_type,
      concept_groups: qualification.concept_groups,
      classifier: qualification.classifier || 'rules',
      source: String(result.platform || 'reddit').toLowerCase(),
    },
  };
}

function qualifiesAsLeadResult(result, keywordSet = {}) {
  return qualifyLead(result, keywordSet);
}

function scoreResult(result, keywordSet = {}) {
  return scoreResultDetailed(result, keywordSet).score;
}

function filterLowSignal(results, keywordSet) {
  if (!Array.isArray(results)) return [];
  const minScore = leadScoreThreshold();
  return results.filter((r) => {
    const s =
      typeof r.relevance_score === 'number' && !Number.isNaN(r.relevance_score)
        ? r.relevance_score
        : scoreResult(r, keywordSet);
    const qualified = r.qualification?.is_lead ?? r.score_meta?.qualified;
    return qualified !== false && s >= minScore;
  });
}

module.exports = {
  scoreResult,
  scoreResultDetailed,
  scoreInitialDetailed,
  computeFinalScore,
  buildQualificationReasons,
  filterLowSignal,
  leadScoreThreshold,
  buildLeadContext,
  qualifiesAsLeadResult,
};
