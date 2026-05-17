/**
 * Build specific pain/search queries + subreddit targets from product text.
 */

const stopWords = new Set([
  'a', 'an', 'the', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'with',
  'my', 'i', 'is', 'are', 'we', 'us', 'that', 'this', 'who', 'what', 'how', 'do',
  'built', 'build', 'tool', 'app', 'software', 'platform', 'service', 'solution',
  'monitor', 'find', 'people', 'public', 'conversations', 'describing', 'helps',
  'help', 'using', 'use', 'their', 'your', 'our', 'they', 'them', 'when', 'where',
  'which', 'will', 'can', 'has', 'have', 'been', 'being', 'into', 'from', 'about',
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

const GENERIC_STEMS = new Set([
  'pain',
  'management',
  'customer',
  'product',
  'business',
  'software',
  'tool',
  'help',
  'questions',
]);

function isGenericQuery(q) {
  const w = String(q || '').toLowerCase().trim();
  if (wordCount(w) < 3) return true;
  if (/^(pain|management|customer|product|business|software|tool)\s+help$/i.test(w)) {
    return true;
  }
  if (/^struggling with (pain|management|customer|help|software|tool)\b/.test(w)) {
    return true;
  }
  if (/anyone recommend (pain|management|customer|tool)\b/.test(w)) {
    return true;
  }
  if (/^(best|need) (management|pain|customer|tool)\b/.test(w)) {
    return true;
  }
  const tokens = w.split(/\s+/).filter(Boolean);
  const stemHits = tokens.filter((t) => GENERIC_STEMS.has(t));
  if (stemHits.length >= 2 && tokens.length <= 4) return true;
  return false;
}

function shouldRegenerateQueries(queries, productDescription) {
  const list = Array.isArray(queries) ? queries.filter(Boolean) : [];
  if (list.length < 3) return true;

  const genericCount = list.filter((q) => isGenericQuery(q)).length;
  if (genericCount >= Math.ceil(list.length / 2)) return true;

  const domain = detectDomain(productDescription);
  const blob = list.join(' ').toLowerCase();

  if (domain === 'wealth' && !/\b(finance|wealth|invest|portfolio|tax|advisor|net worth)\b/.test(blob)) {
    return true;
  }
  if (domain === 'obituary' && !/\b(funeral|obituar|griev|memorial|bereave|genealog)\b/.test(blob)) {
    return true;
  }
  if (domain === 'hiring' && !/\b(hir|job|recruit|applicant|candidate|posting)\b/.test(blob)) {
    return true;
  }
  if (domain === 'accounting' && !/\b(bookkeep|account|tax|invoice)\b/.test(blob)) {
    return true;
  }

  return false;
}

function extractPhrases(productDescription, max = 6) {
  const text = String(productDescription || '');
  const phrases = [];

  const quoted = text.match(/"([^"]{8,80})"/g);
  if (quoted) {
    for (const q of quoted) {
      phrases.push(q.replace(/"/g, '').trim());
    }
  }

  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter((w) => w.length > 2 && !stopWords.has(w));

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const two = `${tokens[i]} ${tokens[i + 1]}`;
    if (two.length >= 6) phrases.push(two);
    if (i < tokens.length - 2) {
      const three = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (three.length >= 10) phrases.push(three);
    }
  }

  const freq = new Map();
  for (const t of tokens) {
    if (t.length > 3) freq.set(t, (freq.get(t) || 0) + 1);
  }

  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w)
    .slice(0, 8);

  return unique([...phrases, ...topWords]).slice(0, max);
}

function detectDomain(text) {
  const d = String(text || '').toLowerCase();

  if (/\b(hiring|recruit|recruiting|job post|job posting|applicant|candidate|hr\b|talent)\b/.test(d)) {
    return 'hiring';
  }
  if (
    /\b(wealth|financial|finance|investment|portfolio|advisor|tax|net worth|asset|estate)\b/.test(d)
  ) {
    return 'wealth';
  }
  if (/\b(asl|deaf|accessibility|assistive|sign language|translation)\b/.test(d)) {
    return 'accessibility';
  }
  if (
    /\b(obituary|obituaries|funeral|memorial|bereavement|grieving|funeral director|death notice|genealogy)\b/.test(
      d
    )
  ) {
    return 'obituary';
  }
  if (/\b(local service|local business leads|community outreach)\b/.test(d)) {
    return 'local_services';
  }
  if (/\b(productivity|meeting notes|notetaking|crm|pipeline|saas)\b/.test(d)) {
    return 'productivity';
  }
  if (/\b(bookkeeping|accounting|tax|invoicing)\b/.test(d)) {
    return 'accounting';
  }
  if (/\b(marketing|seo|growth|ads)\b/.test(d)) {
    return 'marketing';
  }
  return 'generic';
}

const DOMAIN_QUERIES = {
  hiring: [
    'how do I write a job post',
    'job posting not getting applicants',
    'where to post job openings',
    'hiring is taking too long',
    'finding candidates for small business',
    'applicants are unqualified',
    'best way to hire employees small business',
    'need help hiring',
    'recruiting software recommendation',
    'job board recommendation',
  ],
  wealth: [
    'personal finance advisor software',
    'tracking investments across accounts',
    'wealth management spreadsheet',
    'need help managing portfolio',
    'financial advisor alternative',
    'personal finance AI tool',
    'organize investments and taxes',
    'manage family wealth',
    'investment tracking tool recommendation',
    'how do I track net worth',
  ],
  accessibility: [
    'ASL translation app recommendation',
    'deaf community software tools',
    'accessibility tool for meetings',
    'real time captioning recommendation',
    'assistive technology for communication',
    'sign language learning resources',
    'need help with accessibility compliance',
    'captioning software for video calls',
    'deaf friendly workplace tools',
    'translation tool for sign language',
  ],
  obituary: [
    'help planning funeral service',
    'funeral director recommendation',
    'affordable funeral packages',
    'how to write an obituary',
    'infant funeral services help',
    'funeral home recommendations',
    'prepaid funeral services',
    'obituary writing help',
    'local business marketing services',
    'finding local service customers',
  ],
  local_services: [
    'how to find local business leads',
    'local service business marketing',
    'finding customers for local business',
    'small business lead generation',
    'recommend crm for local services',
    'how do I get more local clients',
    'community outreach for small business',
    'local advertising recommendations',
    'recommendations for local cleaners',
    'how to approach local businesses',
  ],
  productivity: [
    'project management tool recommendation',
    'crm for small business recommendation',
    'meeting notes software recommendation',
    'productivity app for remote team',
    'best tool for task management',
    'notetaking app for meetings',
    'how do you organize client pipeline',
    'software for tracking sales leads',
    'alternative to spreadsheets for projects',
    'what do you use for team workflow',
  ],
  accounting: [
    'bookkeeping software for freelancers',
    'messy books need help',
    'quarterly taxes small business',
    'accounting software recommendation',
    'how do I organize business expenses',
    'invoicing tool for small business',
    'need bookkeeper recommendation',
    'best accounting app for solopreneur',
    'tax prep software recommendation',
    'tracking receipts for taxes',
  ],
  marketing: [
    'SEO tool for small business',
    'how do I get more leads',
    'marketing automation recommendation',
    'best way to grow small business online',
    'facebook ads vs google ads small business',
    'content marketing for startups',
    'email marketing tool recommendation',
    'how to find customers online',
    'growth marketing for saas',
    'local seo recommendations',
  ],
};

const DOMAIN_SUBREDDITS = {
  hiring: [
    'smallbusiness',
    'Entrepreneur',
    'recruiting',
    'humanresources',
    'startups',
    'jobs',
  ],
  wealth: [
    'personalfinance',
    'financialplanning',
    'investing',
    'Bogleheads',
    'fatFIRE',
    'smallbusiness',
  ],
  accessibility: ['deaf', 'asl', 'accessibility', 'assistivetechnology', 'languagelearning'],
  obituary: [
    'funeral',
    'obituaries',
    'Grieving',
    'smallbusiness',
    'Entrepreneur',
    'LocalBusiness',
    'genealogy',
    'funeraldirectors',
    'marketing',
    'localseo',
    'business',
    'startups',
  ],
  local_services: [
    'smallbusiness',
    'Entrepreneur',
    'marketing',
    'genealogy',
    'funeraldirectors',
    'LocalBusiness',
  ],
  productivity: ['productivity', 'startups', 'SaaS', 'Entrepreneur', 'smallbusiness'],
  accounting: [
    'smallbusiness',
    'freelance',
    'personalfinance',
    'Entrepreneur',
    'accounting',
    'taxadvice',
  ],
  marketing: ['marketing', 'SEO', 'smallbusiness', 'Entrepreneur', 'digital_marketing', 'startups'],
  generic: ['smallbusiness', 'Entrepreneur', 'startups', 'SideProject', 'freelance'],
};

function buildQueryVariants(phrases) {
  const out = [];
  const stems = phrases.slice(0, 4);

  for (const phrase of stems) {
    if (wordCount(phrase) < 2) continue;
    out.push(`need help with ${phrase}`);
    out.push(`struggling with ${phrase}`);
    out.push(`how do I ${phrase}`);
    out.push(`best way to ${phrase}`);
    out.push(`software for ${phrase}`);
    out.push(`recommend ${phrase} tool`);
    out.push(`anyone recommend ${phrase}`);
    out.push(`${phrase} recommendation`);
  }

  return out;
}

function assessRedditFit(productDescription, domain) {
  const d = String(productDescription || '').toLowerCase();
  if (domain !== 'generic') {
    return { reddit_fit: 'good', warning: null, suggestion: null };
  }
  if (d.length < 40) {
    return {
      reddit_fit: 'weak',
      warning: 'Description is short — queries may be broad.',
      suggestion: 'Add who you help, their pain, and what outcome you provide.',
    };
  }
  return { reddit_fit: 'good', warning: null, suggestion: null };
}

function generateQueries(productDescription) {
  const desc = String(productDescription || '').trim();
  const domain = detectDomain(desc);
  const phrases = extractPhrases(desc, 6);
  const fit = assessRedditFit(desc, domain);

  const base = [...(DOMAIN_QUERIES[domain] || DOMAIN_QUERIES.generic)];
  const fromPhrases =
    domain === 'generic' ? buildQueryVariants(phrases) : buildQueryVariants(phrases).slice(0, 3);

  const queries = unique([...base, ...fromPhrases])
    .filter((q) => !isGenericQuery(q))
    .filter((q) => wordCount(q) >= 3 && wordCount(q) <= 12)
    .slice(0, 10);

  const subreddits = unique(DOMAIN_SUBREDDITS[domain] || DOMAIN_SUBREDDITS.generic).slice(0, 8);

  return {
    queries,
    subreddits,
    ...fit,
    domain,
    phrases,
  };
}

module.exports = {
  generateQueries,
  detectDomain,
  extractPhrases,
  isGenericQuery,
  shouldRegenerateQueries,
};
