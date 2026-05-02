/** @typedef {{ title?: string, body_snippet?: string, created_utc?: number }} RedditLikeResult */
/** @typedef {{ product_description?: string }} KeywordSetLike */

const PAIN_PHRASES = [
  'help',
  'looking for',
  'need',
  'recommend',
  'suggestion',
  'anyone know',
  'what do you use',
  'how do I',
  'how do i',
  'struggling',
  'frustrated',
  'tired of',
  'sick of',
  "can't find",
  'cant find',
  'any good',
  'worth it',
];

const QUESTION_PREFIX_RE =
  /^(how|what|anyone|does\s+anyone|is\s+there|can\s+anyone)\b/i;

/**
 * Normalize text snippets for heuristic scoring (lowercase collapses casing).
 */
function combinedText(title, body) {
  const t = (title ?? '').toString().trim().toLowerCase();
  const b = (body ?? '').toString().trim().toLowerCase();

  return { single: `${t}\n${b}`, title: t, body: b };
}

function painScore(textLc) {
  let pts = 0;

  for (const phrase of PAIN_PHRASES) {
    const needle = phrase.toLowerCase();
    let from = 0;

    while (from <= textLc.length) {
      const idx = textLc.indexOf(needle, from);

      if (idx === -1) break;

      pts += 5;

      if (pts >= 30) return 30;

      /** advance beyond this hit to reduce nested duplicate spam on overlapping needles */
      from = idx + Math.max(needle.length, 1);
    }
  }

  return Math.min(pts, 30);
}

function questionScore(titleLc, bodyLc) {
  let pts = 0;

  if (titleLc.includes('?') || bodyLc.includes('?')) pts += 10;

  /** leading question phrasing checks both fields independently */
  if (QUESTION_PREFIX_RE.test(titleLc) || QUESTION_PREFIX_RE.test(bodyLc)) pts += 10;

  return Math.min(pts, 20);
}

function densityScore(textLc, productDescription = '') {
  const rawToks = String(productDescription)
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    /** keep tokens like gmail if needed */
    .filter((w) => w && w.replace(/#/g, '').length >= 4);

  if (!rawToks.length || !textLc) return 0;

  /** count unique keywords appearing at least once (prevents duplication inflation) */
  const uniq = [...new Set(rawToks)];
  let matches = 0;

  for (const word of uniq) {
    /** word-boundary-lite */
    const re = new RegExp(`\\b${escapeForRegex(word)}\\b`, 'i');

    if (re.test(textLc)) matches++;
  }

  return Math.min(matches * 5, 30);
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recencyScore(createdUtc) {
  /** created_utc in seconds unless caller mistakes ms — guard */
  let tsSec = Number(createdUtc ?? 0);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return 0;

  /** if looks like millis, coerce */
  if (tsSec > 1e12) tsSec = Math.floor(tsSec / 1000);

  const ageHours = (Date.now() / 1000 - tsSec) / 3600;

  if (!Number.isFinite(ageHours) || ageHours < 0) return 20;

  if (ageHours < 6) return 20;

  if (ageHours < 24) return 15;

  if (ageHours < 72) return 10;

  if (ageHours < 168) return 5;

  return 0;
}

/**
 * @param {RedditLikeResult} result
 * @param {KeywordSetLike | null | undefined} keywordSet
 */
function scoreResult(result, keywordSet = {}) {
  const title = (result.title ?? '').toString();
  const body = (result.body_snippet ?? '').toString();
  const { single, title: tLc, body: bLc } = combinedText(title, body);

  const pain = painScore(single);

  /** question checks use trimmed leading lines-ish (fields already trimmed) */
  const q = questionScore(tLc, bLc);

  const density = densityScore(single, keywordSet.product_description);

  const rc = recencyScore(result.created_utc);

  /** category caps already enforced individually */
  return Math.min(Math.round(pain + q + density + rc), 100);
}

/**
 * Drops items scoring **below** 20. Supply `keywordSet` as the second argument,
 * otherwise each result may carry `{ keyword_set: {...} }` from storage.
 *
 * @param {Array<RedditLikeResult & { keyword_set?: KeywordSetLike }>} results
 * @param {KeywordSetLike | null | undefined} [keywordSet]
 */
function filterLowSignal(results, keywordSet) {
  if (!Array.isArray(results)) return [];

  return results.filter((r) => {
    const ks = keywordSet ?? r.keyword_set ?? {};
    /**
     * Passing `{}` gracefully yields baseline question/pain/recency hits only —
     * still useful early in pipeline stages before DB hydration.
     */
    return scoreResult(r, ks) >= 20;
  });
}

module.exports = {
  scoreResult,
  filterLowSignal,
};
