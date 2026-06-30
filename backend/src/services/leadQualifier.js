/**
 * Brief-driven lead qualification. No product/city/domain hardcoded runtime rules.
 */

const { classifyCandidatesForLeadFit } = require('./leadClassifier');
const { enrichQualification } = require('../utils/leadVisibility');

const GENERIC_EVIDENCE_WORDS = new Set([
  'food',
  'restaurant',
  'business',
  'campus',
  'nearby',
  'local',
  'area',
  'recommend',
  'recommendation',
  'recommendations',
  'wish',
  'want',
  'need',
  'looking',
  'question',
  'help',
  'people',
  'students',
  'vote',
  'voting',
]);

function requireAiClassifier() {
  return process.env.REQUIRE_AI_CLASSIFIER === 'true';
}

function classifierUnavailableReason() {
  if (process.env.SKIP_AI_LEAD_CLASSIFIER === 'true') {
    if (requireAiClassifier()) {
      return (
        'AI lead classification is disabled (SKIP_AI_LEAD_CLASSIFIER) but scans require it ' +
        '(REQUIRE_AI_CLASSIFIER). Remove the SKIP_AI_LEAD_CLASSIFIER env var to enable AI classification.'
      );
    }
    return 'AI lead classification is disabled (SKIP_AI_LEAD_CLASSIFIER=true).';
  }
  if (!process.env.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY is not set on the worker service.';
  }
  return 'AI classifier is unavailable.';
}

function hasClassifierConfigConflict() {
  return requireAiClassifier() && process.env.SKIP_AI_LEAD_CLASSIFIER === 'true';
}

function getBrief(keywordSetOrBrief = {}) {
  if (keywordSetOrBrief.search_brief && typeof keywordSetOrBrief.search_brief === 'object') {
    return keywordSetOrBrief.search_brief;
  }
  return keywordSetOrBrief;
}

function fullText(result) {
  return `${result.title || ''} ${result.body_snippet || ''}`.toLowerCase();
}

function isGenericEvidenceTerm(word) {
  return GENERIC_EVIDENCE_WORDS.has(String(word || '').toLowerCase().trim());
}

function matchesPatternStrict(text, pattern) {
  const p = String(pattern || '').toLowerCase().trim();
  if (!p || p.length < 6) return false;
  if (text.includes(p)) return true;

  const words = p.split(/\s+/).filter((w) => w.length > 3 && !isGenericEvidenceTerm(w));
  if (words.length >= 3) {
    const hits = words.filter((w) => text.includes(w));
    return hits.length >= Math.ceil(words.length * 0.75);
  }
  if (words.length === 2) {
    return words.every((w) => text.includes(w));
  }
  return false;
}

function matchesAnyStrict(text, patterns) {
  const matched = [];
  for (const p of patterns || []) {
    if (matchesPatternStrict(text, p)) matched.push(p);
  }
  return matched;
}

function hitsNegativeKeyword(text, keywords) {
  for (const kw of keywords || []) {
    const k = String(kw || '').toLowerCase().trim();
    if (k.length >= 3 && text.includes(k)) return k;
  }
  return null;
}

/** Recipe / meal-prep threads — not local collective demand signals. */
function isMealPrepOrRecipeAdvice(text) {
  const t = String(text || '').toLowerCase();
  return /\b(recipe|meal prep|lunch ideas|dinner ideas|portable lunch|what should i (eat|make|cook)|packable lunch|meal ideas)\b/.test(
    t
  );
}

/** Personal craving/recommendation posts without unmet local/collective demand signals. */
function isPersonalRecommendationWithoutDemand(text) {
  const t = String(text || '').toLowerCase();
  const personalSignals =
    /\b(craving|crave|favorite|favourite|what are your favorite|recommendations?\?|recommend me|snack|treat)\b/.test(
      t
    );
  const demandSignals =
    /\b(wish|need more|missing|nowhere|should open|vote for|want.*near|near campus|on campus|in my area|near me|unmet|don't have|doesn't have|no .{0,20} near|students (want|need|ask)|what (food|restaurant|business|chain).{0,30}(open|near|campus|area))\b/.test(
      t
    );
  if (!personalSignals) return false;
  return !demandSignals;
}

function countRequiredEvidenceHits(text, required) {
  const list = (required || []).filter(Boolean);
  if (!list.length) return { matched: [], count: 0, required: 0 };

  const matched = matchesAnyStrict(text, list);
  const nonGenericMatched = matched.filter((m) => {
    const tokens = String(m)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    return tokens.some((t) => !isGenericEvidenceTerm(t));
  });

  return {
    matched,
    nonGenericMatched,
    count: matched.length,
    nonGenericCount: nonGenericMatched.length,
    required: list.length,
  };
}

/**
 * Conservative fallback when AI is unavailable — fail-closed.
 */
function qualifyLeadFallback(candidate, brief, keywordSetOrBrief = {}) {
  const text = fullText(candidate);
  const empty = {
    is_lead: false,
    confidence: 0,
    lead_type: 'not_a_lead',
    recommended_visibility: 'hide',
    matched_positive_patterns: [],
    matched_required_concepts: [],
    matched_negative_patterns: [],
    reject_reason: null,
    evidence: '',
    classifier: 'fallback',
    qualification_source: 'fallback',
    disqualifying_evidence_checked: [],
  };

  if (isMealPrepOrRecipeAdvice(text)) {
    return {
      ...empty,
      confidence: 6,
      reject_reason: 'Recipe or meal-prep advice — not evidence of local unmet business demand.',
    };
  }

  if (isPersonalRecommendationWithoutDemand(text)) {
    return {
      ...empty,
      confidence: 8,
      reject_reason:
        'Personal craving or recommendation thread — not evidence of unmet local/campus business demand.',
    };
  }

  const negKw = hitsNegativeKeyword(text, brief.negative_keywords);
  if (negKw) {
    return {
      ...empty,
      confidence: 10,
      reject_reason: `Matches monitor negative keyword: ${negKw}`,
      matched_negative_patterns: [negKw],
    };
  }

  const disq = matchesAnyStrict(text, brief.disqualifying_evidence);
  if (disq.length) {
    return {
      ...empty,
      confidence: 12,
      reject_reason: `Matches disqualifying evidence: ${disq[0]}`,
      matched_negative_patterns: disq,
      disqualifying_evidence_checked: disq,
    };
  }

  const negPatterns = matchesAnyStrict(text, brief.negative_lead_patterns);
  if (negPatterns.length) {
    return {
      ...empty,
      confidence: 15,
      reject_reason: `Matches negative lead pattern: ${negPatterns[0]}`,
      matched_negative_patterns: negPatterns,
    };
  }

  const positive = matchesAnyStrict(text, brief.positive_lead_patterns);
  const leadPatterns = matchesAnyStrict(text, brief.lead_patterns);
  const allPositive = [...positive, ...leadPatterns];

  const req = countRequiredEvidenceHits(text, brief.required_evidence);
  const requiredTotal = req.required;
  const minRequired =
    requiredTotal <= 2
      ? requiredTotal
      : Math.max(2, Math.ceil(requiredTotal * 0.75));

  const hasStrongPositive = allPositive.some((p) => {
    const words = String(p)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !isGenericEvidenceTerm(w));
    return words.length >= 2;
  });
  const hasNonGenericRequired = req.nonGenericCount >= minRequired;

  if (!hasStrongPositive && !hasNonGenericRequired) {
    return {
      ...empty,
      confidence: 18,
      reject_reason:
        requiredTotal > 0
          ? `Insufficient required evidence (${req.nonGenericCount}/${minRequired}) for: ${(brief.lead_definition || '').slice(0, 100)}`
          : `No strong match to lead definition: ${(brief.lead_definition || '').slice(0, 100)}`,
      matched_required_concepts: req.matched,
    };
  }

  if (req.count < minRequired && !hasStrongPositive) {
    return {
      ...empty,
      confidence: 20,
      reject_reason: `Insufficient required evidence (${req.count}/${minRequired})`,
      matched_required_concepts: req.matched,
    };
  }

  if (!hasStrongPositive || !hasNonGenericRequired) {
    return {
      ...empty,
      confidence: 16,
      reject_reason:
        'Fallback requires both strong positive pattern and non-generic required evidence.',
      matched_required_concepts: req.matched,
      matched_positive_patterns: allPositive,
    };
  }

  let confidence = 40 + req.nonGenericCount * 10 + allPositive.length * 8;
  confidence = Math.min(62, confidence);

  const base = {
    is_lead: true,
    confidence,
    lead_type: hasStrongPositive ? 'direct_demand' : 'adjacent_demand',
    matched_positive_patterns: allPositive,
    matched_required_concepts: req.matched,
    matched_negative_patterns: [],
    reject_reason: null,
    evidence: hasStrongPositive
      ? `Fallback (conservative): matched pattern "${allPositive[0]}"`
      : `Fallback (conservative): matched required evidence: ${req.nonGenericMatched.slice(0, 3).join(', ')}`,
    classifier: 'fallback',
    qualification_source: 'fallback',
    disqualifying_evidence_checked: disq,
  };
  return enrichQualification(base, {
    search_brief: brief,
    search_focus: keywordSetOrBrief.search_focus || brief.search_focus,
  });
}

function mapAiResult(ai, fallbackQual, keywordSetOrBrief = {}) {
  const base = {
    is_lead: Boolean(ai.is_lead),
    confidence: Number(ai.confidence) || 0,
    lead_type: ai.lead_type || (ai.is_lead ? 'direct_demand' : 'not_a_lead'),
    recommended_visibility: ai.recommended_visibility,
    matched_positive_patterns: ai.matched_positive_patterns || [],
    matched_required_concepts: ai.matched_required_evidence || [],
    matched_negative_patterns: ai.matched_disqualifying_evidence || [],
    reject_reason: ai.is_lead ? null : ai.reject_reason || fallbackQual.reject_reason,
    evidence: ai.evidence || fallbackQual.evidence,
    classifier: 'ai',
    qualification_source: 'ai',
    disqualifying_evidence_checked: ai.matched_disqualifying_evidence || [],
  };
  return enrichQualification(base, keywordSetOrBrief);
}

function rejectAllCandidates(candidates, reason) {
  return candidates.map((c) => ({
    ...c,
    qualification: {
      is_lead: false,
      confidence: 0,
      lead_type: 'not_a_lead',
      recommended_visibility: 'hide',
      matched_positive_patterns: [],
      matched_required_concepts: [],
      matched_negative_patterns: [],
      reject_reason: reason,
      evidence: '',
      classifier: 'fallback',
      qualification_source: 'fallback',
    },
  }));
}

/**
 * @param {object} candidate
 * @param {object} keywordSetOrBrief
 */
function qualifyLead(candidate, keywordSetOrBrief = {}) {
  const brief = getBrief(keywordSetOrBrief);
  return qualifyLeadFallback(candidate, brief, keywordSetOrBrief);
}

/**
 * AI-first batch qualification.
 */
async function qualifyCandidates(candidates, keywordSetOrBrief = {}, stats = {}) {
  const brief = getBrief(keywordSetOrBrief);
  const withFallback = candidates.map((c) => ({
    ...c,
    qualification: qualifyLeadFallback(c, brief, keywordSetOrBrief),
  }));

  const useAi = process.env.OPENAI_API_KEY && process.env.SKIP_AI_LEAD_CLASSIFIER !== 'true';
  const maxClassify =
    Number(process.env.MAX_QUALIFICATION_CANDIDATES) > 0
      ? Number(process.env.MAX_QUALIFICATION_CANDIDATES)
      : 60;

  if (stats) {
    stats.classifier_attempted = false;
    stats.classifier_batch_count = 0;
    stats.classifier_duration_ms = 0;
    stats.classifier_response_parse_error = null;
  }

  if (!candidates.length) {
    if (stats) {
      stats.classifier_source = useAi ? 'ai' : 'fallback';
      stats.classifier_model = null;
      stats.classifier_error = null;
      stats.classifier_attempted = false;
      stats.sent_to_ai_qualification_count = 0;
    }
    return withFallback;
  }

  if (!useAi) {
    const reason = classifierUnavailableReason();
    if (stats) {
      stats.classifier_source = 'fallback';
      stats.classifier_model = null;
      stats.classifier_error = reason;
      stats.classifier_attempted = false;
    }
    console.warn(`[leadQualifier] AI classifier unavailable: ${reason}`);
    if (requireAiClassifier()) {
      return rejectAllCandidates(
        withFallback,
        `AI classifier required but unavailable: ${reason}`
      );
    }
    return withFallback;
  }

  const toClassify = withFallback.slice(0, maxClassify);
  if (stats) {
    stats.sent_to_ai_qualification_count = toClassify.length;
    stats.classifier_attempted = true;
  }

  const {
    results,
    error,
    model,
    batch_count,
    duration_ms,
    parse_error,
    attempted,
  } = await classifyCandidatesForLeadFit(toClassify, brief, {
    search_focus: keywordSetOrBrief.search_focus || brief.search_focus,
  });

  if (stats) {
    stats.classifier_attempted = Boolean(attempted);
    stats.classifier_batch_count = batch_count || 0;
    stats.classifier_duration_ms = duration_ms || 0;
    stats.classifier_response_parse_error = parse_error || null;
    stats.classifier_model = model || null;
    stats.classifier_error = error || null;
    stats.classifier_source = results ? 'ai' : 'fallback';
  }

  if (!results) {
    console.warn(
      `[leadQualifier] AI classifier failed: ${error || 'unknown'} (batches=${batch_count || 0})`
    );
    if (requireAiClassifier()) {
      return rejectAllCandidates(
        withFallback,
        `AI classifier failed: ${error || 'unknown error'}`
      );
    }
    return withFallback.map((c) => {
      const fb = c.qualification;
      if (fb.is_lead) {
        return {
          ...c,
          qualification: {
            ...fb,
            is_lead: false,
            confidence: 0,
            reject_reason:
              fb.reject_reason ||
              `AI classifier failed (${error || 'unknown'}); fallback cannot save leads`,
            evidence: `Rejected: AI unavailable (${error || 'unknown'})`,
          },
        };
      }
      return c;
    });
  }

  const byId = new Map(results.map((r) => [r.candidate_id, r]));

  return withFallback.map((c) => {
    const ai = byId.get(c.post_id);
    if (!ai) {
      return {
        ...c,
        qualification: {
          ...c.qualification,
          is_lead: false,
          reject_reason: 'Not reviewed by AI classifier (outside batch limit).',
          classifier: 'ai',
          qualification_source: 'ai',
        },
      };
    }
    const q = mapAiResult(ai, c.qualification, keywordSetOrBrief);
    if (stats) {
      if (q.is_lead) stats.ai_qualified_count = (stats.ai_qualified_count || 0) + 1;
      else stats.ai_rejected_count = (stats.ai_rejected_count || 0) + 1;
    }
    return { ...c, qualification: q };
  });
}

function shouldSkipByNegativeFilter(result, briefInput) {
  const brief = getBrief(briefInput);
  const text = fullText(result);
  const kw = hitsNegativeKeyword(text, brief.negative_keywords);
  if (kw) return { skip: true, reason: `negative keyword: ${kw}` };
  const disq = matchesAnyStrict(text, brief.disqualifying_evidence);
  if (disq.length) return { skip: true, reason: `disqualifier: ${disq[0]}` };
  return { skip: false, reason: null };
}

/** @deprecated */
function qualifiesAsLead(result, keywordSetOrBrief = {}) {
  const q = qualifyLead(result, keywordSetOrBrief);
  return {
    is_lead: q.is_lead,
    confidence: q.confidence,
    lead_type: q.lead_type,
    evidence: q.evidence,
    reject_reason: q.reject_reason,
  };
}

module.exports = {
  qualifyLead,
  qualifyLeadFallback,
  qualifyCandidates,
  qualifiesAsLead,
  shouldSkipByNegativeFilter,
  getBrief,
  requireAiClassifier,
  classifierUnavailableReason,
  hasClassifierConfigConflict,
};
