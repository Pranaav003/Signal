/**
 * Build compact search queries + subreddit targets from product text.
 */

const stopWords = new Set([
  'a', 'an', 'the', 'for', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'with',
  'my', 'i', 'is', 'are', 'we', 'us', 'looking', 'people', 'asking', 'about', 'run', 'running',
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

function extractKeywords(productDescription) {
  const cleaned = String(productDescription || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ');

  const tokens = cleaned.split(' ').filter((w) => w.length > 3 && !stopWords.has(w));
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word)
    .slice(0, 5);
}

function pickSubreddits(text) {
  const d = String(text || '').toLowerCase();

  if (/\b(bookkeeping|accounting|tax|taxes|invoicing|finance)\b/.test(d)) {
    return ['smallbusiness', 'freelance', 'personalfinance', 'Entrepreneur', 'accounting', 'taxadvice', 'freelancers'];
  }
  if (/\b(marketing|seo|growth|ads)\b/.test(d)) {
    return ['marketing', 'SEO', 'smallbusiness', 'Entrepreneur', 'digital_marketing', 'startups'];
  }
  if (/\b(productivity|tools|software|app)\b/.test(d)) {
    return ['productivity', 'Entrepreneur', 'startups', 'SideProject', 'smallbusiness', 'lifehacks'];
  }
  if (/\b(design|creative|brand)\b/.test(d)) {
    return ['graphic_design', 'web_design', 'freelance', 'Entrepreneur'];
  }
  if (/\b(fitness|health|wellness)\b/.test(d)) {
    return ['fitness', 'loseit', 'bodyweightfitness', 'selfimprovement'];
  }
  if (/\b(food|restaurant|bakery|catering)\b/.test(d)) {
    return ['restaurateur', 'smallbusiness', 'food', 'Entrepreneur'];
  }
  return ['smallbusiness', 'Entrepreneur', 'startups', 'SideProject', 'freelance'];
}

function generateQueries(productDescription) {
  const keywords = extractKeywords(productDescription);
  const kw1 = keywords[0] || 'customer';
  const kw2 = keywords[1] || keywords[0] || 'tool';

  const templates = [
    `${kw1} help`,
    `struggling with ${kw1}`,
    `anyone recommend ${kw1} ${kw2}`,
    `best ${kw1} for small business`,
    `how do I ${kw1}`,
    `${kw1} ${kw2} advice`,
    `need ${kw1} recommendation`,
    `${kw1} software recommendation`,
    `what do you use for ${kw1}`,
    `${kw1} vs alternatives`,
  ];

  return {
    queries: unique(templates),
    subreddits: unique(pickSubreddits(productDescription)),
  };
}

module.exports = { generateQueries };

/*
console.log(generateQueries('bookkeeping service for US freelancers messy books quarterly taxes'))
// expected: queries like "bookkeeping help", "struggling with bookkeeping", ...
// expected subreddits: ['smallbusiness','freelance','personalfinance','Entrepreneur','accounting','taxadvice','freelancers']

console.log(generateQueries('SEO tool for small business owners'))
// expected: queries like "seo help", "best seo for small business", ...
// expected subreddits: ['marketing','SEO','smallbusiness','Entrepreneur','digital_marketing','startups']

console.log(generateQueries('meal planning app for busy families'))
// expected: short query variants (not full description), productivity/food category subs
*/
