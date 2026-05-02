/**
 * Builds Reddit search queries and target subreddit names from a product description.
 */

const STOP_WORDS = new Set(['for', 'that', 'which', 'to', 'and']);

/** Thematic boosts; always union with REQUIRED_SUBS (deduped). */
const SUBREDDIT_RULES = [
  {
    test: /\bfreelancer(?:s)?\b|\bfreelanc(?:e|ing)\b|\bdigital\s*nomads?\b/i,
    subs: ['freelance', 'digitalnomad', 'freelancewriters'],
  },
  {
    test:
      /\baccounting\b|\bbookkeeping\b|\btaxes?\b|\btax\b|\bpersonal\s*(?:finance|financial)\b|\bfina(?:nce|ncial)s?\b/i,
    subs: ['personalfinance', 'accounting', 'smallbusiness'],
  },
  {
    test:
      /\bproject[\s_-]*management\b|\bworkflow\b|\bkanban\b|\bscrum\b|\bteams?\b.*(?:collaborat|manag)|\bteam\s+tracking\b/i,
    subs: ['projectmanagement', 'remotework', 'startups'],
  },
  {
    test: /\bfood\b|\bmeal(?:s)?\b|\brecipes?\b|\bcooking\b|\bmeal\s*prep\b|\bmealprep\b/i,
    subs: ['mealprep', 'EatCheapAndHealthy', 'Cooking'],
  },
  {
    test:
      /\bmarketing\b|\bseo\b|\bcontent\s+marketing\b|\bmarketing\s+agency\b|\bsearch\s+(?:engines?)?\s*optimization\b/i,
    subs: ['marketing', 'SEO', 'Entrepreneur'],
  },
  {
    test:
      /\bresumes?\b|\bcv\b|\bcareers?\b|\bhiring\b|\binterviews?\b|\bjobs\b/i,
    subs: ['jobs', 'resumes', 'cscareerquestions'],
  },
  {
    test:
      /\bfitness\b|\bworkouts?\b|\bgyms?\b|\bweight\s+loss\b|\blose\s+weight\b|\bbodyweight\b/i,
    subs: ['fitness', 'loseit', 'bodyweightfitness'],
  },
];

const REQUIRED_SUBS = ['smallbusiness', 'Entrepreneur'];
const NO_MATCH_SUBS = ['startups'];

function normalizePhrase(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function normalizeToken(t) {
  return String(t || '')
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '')
    .toLowerCase();
}

function trimLeadingTrailingStops(tokens) {
  const out = [...tokens];

  while (out.length && STOP_WORDS.has(normalizeToken(out[0]))) {
    out.shift();
  }

  while (out.length && STOP_WORDS.has(normalizeToken(out[out.length - 1]))) {
    out.pop();
  }

  return out;
}

function uniquePreserveOrder(strings, keyFn = (x) => x) {
  const seen = new Set();
  const out = [];

  for (const raw of strings) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const k = keyFn(s);
    if (seen.has(k)) continue;

    seen.add(k);
    out.push(s);
  }

  return out;
}

/**
 * Take the last 2–3 words *before* the final stop word (for/that/which/to/and).
 * If there is no stop word, use the last 2–3 words of the whole description.
 */
function extractCorePhrase(description) {
  const trimmed = normalizePhrase(description.replace(/,/g, ' '));
  if (!trimmed) return 'your product';

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return 'your product';

  let lastStopIdx = -1;

  for (let i = 0; i < words.length; i++) {
    if (STOP_WORDS.has(normalizeToken(words[i]))) lastStopIdx = i;
  }

  let head;
  if (lastStopIdx <= 0) {
    head = words;
  } else {
    head = words.slice(0, lastStopIdx);
  }

  if (!head.length) head = words;

  let slice;
  if (head.length <= 3) slice = head;
  else slice = head.slice(-3);

  slice = trimLeadingTrailingStops(slice);

  if (!slice.length) {
    slice = trimLeadingTrailingStops(head.slice(-3));
  }

  return normalizePhrase(slice.join(' ') || trimmed.slice(0, 48));
}

function deriveVerbStem(description, corePhrase) {
  const d = normalizePhrase(description).toLowerCase();

  const howMatch = d.match(/\bhow\s+(?:do\s+i|does\s+one|should\s+i|can\s+i)\s+([a-z0-9-]+)\b/);
  if (howMatch && howMatch[1] && howMatch[1].length > 2) {
    return howMatch[1].replace(/-+ing$/i, '').replace(/-/g, ' ');
  }

  const needWant = d.match(/\b(?:need|want|try)\s+to\s+([a-z0-9]{3,})\b/);
  if (needWant && needWant[1]) return needWant[1];

  const helpMe = d.match(/\bhelp\s+(?:me|us)\s+([a-z0-9]{3,})\b/);
  if (helpMe && helpMe[1]) return helpMe[1];

  /** Lightweight finite-verb skim (common SaaS wording) */
  const finiteVerbMatch = d.match(
    /\b(keeps|keep|tracks|track|captures|capture|helps|help|plans|plan|manages|manage|automates|automate|organizes|organize|runs|run|handles|handle|writes|write|reports|report)\b/i
  );
  if (finiteVerbMatch && finiteVerbMatch[1]) {
    const canon = finiteVerbMatch[1].toLowerCase();
    const map = {
      keeps: 'keep',
      tracks: 'track',
      captures: 'capture',
      plans: 'plan',
      manages: 'manage',
      automates: 'automate',
      organizes: 'organize',
      runs: 'run',
      handles: 'handle',
      writes: 'write',
      reports: 'report',
    };
    return map[canon] || canon;
  }

  /** Gerund-ish head term */
  const gerundish = d.match(/\b([a-z]{4,}(?:ing|ize|fy))\b/i);
  if (gerundish && gerundish[1]) return gerundish[1];

  const coreToks = normalizePhrase(corePhrase).toLowerCase().split(/\s+/).filter(Boolean);
  /** Pick strongest token from noun phrase fallback */
  return coreToks.find((w) => w.length >= 5 && !STOP_WORDS.has(w)) ||
    coreToks.find((w) => w.length >= 3 && !STOP_WORDS.has(w)) ||
    coreToks[0] ||
    'use';
}

/** @returns { string[] } */
function deriveSubreddits(description) {
  const thematic = [];
  let matched = false;

  if (normalizePhrase(description)) {
    for (const rule of SUBREDDIT_RULES) {
      if (rule.test.test(description)) {
        matched = true;
        thematic.push(...rule.subs);
      }
    }
  }

  return uniquePreserveOrder(
    [...REQUIRED_SUBS, ...thematic, ...(matched ? [] : NO_MATCH_SUBS)],
    (s) => s.toLowerCase()
  );
}

/** @returns {{ queries: string[], subreddits: string[] }} */
function generateQueries(productDescription) {
  const description = normalizePhrase(productDescription);
  const core = extractCorePhrase(description);
  const verb = deriveVerbStem(description, core);

  const queries = uniquePreserveOrder(
    [
      description,
      `need help with ${core}`,
      `looking for ${core}`,
      `how do i ${verb}`,
      `anyone recommend ${core}`,
      `struggling with ${core}`,
      `frustrated with ${core}`,
      `best ${core}`,
      `recommend ${core} tool`,
      `${core} alternative`,
    ],
    /** fold near-dup casing */
    (q) => q.toLowerCase()
  );

  return {
    queries,
    subreddits: deriveSubreddits(description),
  };
}

module.exports = { generateQueries };

/*
 * ------ Example-shaped outputs (deterministic snippets differ by verb stemming) ------
 *
 * // generateQueries(
 * //   'Invoicing and accounting software for freelancers who bill monthly clients'
 * // )
 * // → {
 * //   queries: string[10],
 * //   subreddits: ['smallbusiness','Entrepreneur', ... 'personalfinance','accounting',...,'freelance',... ]
 * //     // merges freelancing + finance signals, deduped; skips generic startups because something matched
 * // }
 *
 * // generateQueries('Meal planning app for picky eaters')
 * // → {
 * //   queries: string[10], // cores drawn from wording before trailing “for …” clause
 * //   subreddits: ['smallbusiness','Entrepreneur','mealprep','EatCheapAndHealthy','Cooking', …]
 * // }
 *
 * // generateQueries('Chrome extension keeps my tabs organized')
 * // → {
 * //   queries: string[10], // lacks stop words ⇒ core ≈ final three tokens of description
 * //   subreddits: ['smallbusiness','Entrepreneur','startups'] // no thematic synonym hit
 * // }
 */
