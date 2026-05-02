/**
 * Drop-in mock for redditService — no OAuth, no network.
 * Set USE_MOCK_REDDIT=true in the environment.
 */

const USERS = [
  'throwaway_pm_92',
  'anon_accountant',
  'seo_worrier',
  'busy_mom_meals',
  'gym_rat_404',
  'RemoteTeamLead',
  'freelance_chaos',
  'LateNightCoder',
  'SmallBizOwner42',
  'HealthyEatsDaily',
  'KanbanKaren',
  'AnalyticsAndy',
]

const SUBS = {
  seo: ['SEO', 'marketing', 'Entrepreneur', 'bigseo', 'PPC'],
  accounting: ['accounting', 'smallbusiness', 'Bookkeeping', 'taxpros', 'freelance'],
  pm: ['projectmanagement', 'remotework', 'startups', 'scrum', 'Notion'],
  meal: ['mealprep', 'EatCheapAndHealthy', 'nutrition', 'Cooking', 'loseit'],
  fitness: ['fitness', 'bodyweightfitness', 'running', 'loseit', 'xxfitness'],
  default: ['smallbusiness', 'Entrepreneur', 'SaaS', 'SideProject', 'startups'],
}

function detectBuckets(text) {
  const q = String(text || '').toLowerCase()
  const buckets = new Set()

  if (/\bseo\b|serp|backlink|ranking|google analytics|semrush|ahrefs/i.test(q))
    buckets.add('seo')
  if (/\baccount|invoice|tax|bookkeep|quickbooks|payroll|1099/i.test(q))
    buckets.add('accounting')
  if (/\bproject\b|pm\b|jira|asana|notion|sprint|kanban|roadmap/i.test(q))
    buckets.add('pm')
  if (/\bmeal|recipe|macro|diet|prep|cook|eat clean/i.test(q))
    buckets.add('meal')
  if (/\bfit|workout|gym|steps|calorie|bulk|cut\b|cardio/i.test(q))
    buckets.add('fitness')

  if (!buckets.size) buckets.add('default')

  return [...buckets]
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

function hoursAgoSec(rng, maxH) {
  const h = rng() * maxH
  return Math.floor(Date.now() / 1000 - h * 3600)
}

/** @param {string} query */
function templatesForQuery(query) {
  const buckets = detectBuckets(query)
  const out = []

  /** Questions */
  out.push(
    () => ({
      type: 'post',
      title: 'How do I pick the right stack without overpaying?',
      body:
        "We're a 6-person remote team and spreadsheets are falling apart. What do you actually use day-to-day?",
    }),
    () => ({
      type: 'comment',
      title: '',
      body:
        'Same boat — I tried three tools last year and the onboarding killed us. Anyone have a lightweight option that still does reporting?',
    }),
    () => ({
      type: 'post',
      title: 'Is there a sane workflow for recurring client billing?',
      body:
        'Invoices, reminders, and reconciling deposits is eating my weekends. What’s the minimum viable setup that won’t embarrass me in front of clients?',
    })
  )

  /** Complaints / pain */
  out.push(
    () => ({
      type: 'post',
      title: 'Why is everything either too simple or enterprise-priced?',
      body:
        'I just need reliable automations and permissions. Every “affordable” tool caps seats or hides exports behind a paywall.',
    }),
    () => ({
      type: 'comment',
      title: '',
      body:
        'Honestly tired of “AI features” that don’t work. I want boring software that saves 5 hours a week. Does that exist anymore?',
    })
  )

  /** Buying intent */
  out.push(
    () => ({
      type: 'post',
      title: 'Budget $50/mo — what would you buy first for a solo consultancy?',
      body:
        'I need something that handles proposals → invoices → light CRM. Prefer something I can cancel if it sucks.',
    }),
    () => ({
      type: 'post',
      title: 'Looking for recommendations: meal prep for high-protein lunches',
      body:
        'I meal prep Sundays but I’m bored of chicken/rice. Apps/plans that keep grocery lists tight would be amazing.',
    }),
    () => ({
      type: 'post',
      title: 'Best SEO audit workflow for a tiny site (under 50 pages)?',
      body:
        'I’m not trying to rank #1 nationally — just want clean technical basics + content gaps without hiring an agency yet.',
    })
  )

  /** Category-flavoured extras */
  if (buckets.includes('seo')) {
    out.push(() => ({
      type: 'post',
      title: 'Traffic dropped after a redesign — what should I check first?',
      body:
        'GSC looks messy, canonicals might be wrong. I need a checklist that a non-expert can follow without breaking production.',
    }))
  }

  if (buckets.includes('accounting')) {
    out.push(() => ({
      type: 'comment',
      title: '',
      body:
        'If you’re invoicing internationally watch FX fees — some “cheap” tools sting you on conversions. What do freelancers use?',
    }))
  }

  if (buckets.includes('pm')) {
    out.push(() => ({
      type: 'post',
      title: 'Standups are async now — how do you keep accountability?',
      body:
        'We moved timezones and Slack threads aren’t cutting it. Need something that shows blockers without feeling like surveillance.',
    }))
  }

  if (buckets.includes('meal')) {
    out.push(() => ({
      type: 'post',
      title: 'Meal planning app that handles picky kids + a tight grocery budget?',
      body:
        'We waste so much produce. I’d pay for something that builds a week plan around what’s on sale.',
    }))
  }

  if (buckets.includes('fitness')) {
    out.push(() => ({
      type: 'post',
      title: 'Best app for tracking workouts without gym bro UX?',
      body:
        'I just want progressive overload + rest timers. Bonus if it exports CSV.',
    }))
  }

  return out
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 48)
}

/**
 * @param {string} query
 * @param {Record<string, unknown>} [_options]
 */
async function searchReddit(query, _options = {}) {
  const buckets = detectBuckets(query)
  const rng = mulberry32(
    [...String(query)].reduce((n, ch) => (n + ch.charCodeAt(0)) | 0, 1)
  )

  const pool = templatesForQuery(query)
  const n = 8 + Math.floor(rng() * 5)
  const results = []

  for (let i = 0; i < n; i++) {
    const factory = pool[Math.floor(rng() * pool.length)]
    const tpl = factory()
    const bucket = pick(rng, buckets)
    const subList = SUBS[bucket] || SUBS.default
    const subreddit = pick(rng, subList)
    const author = pick(rng, USERS)
    const kind = tpl.type === 'comment' ? 't1' : 't3'
    const post_id = `${kind}_mock_${slug(query)}_${i}_${Math.floor(rng() * 1e6)}`
    const title = tpl.title || ''
    const body_snippet = String(tpl.body || '').slice(0, 500)
    const tslug = slug(title || body_snippet || 'thread')
    const url = `https://reddit.com/r/${subreddit}/comments/mock_${tslug}/signal_mock_${i}`

    results.push({
      post_id,
      title,
      body_snippet,
      url,
      author,
      subreddit,
      created_utc: hoursAgoSec(rng, 7 * 24),
      type: tpl.type,
    })
  }

  return results
}

/**
 * @param {string} subreddit
 * @param {string} query
 */
async function searchSubreddit(subreddit, query) {
  const clean = String(subreddit || 'smallbusiness').replace(/^r\//i, '')
  const rng = mulberry32(
    (clean.length + String(query).length) * 9973 + 1337
  )

  const pool = templatesForQuery(`${query} ${clean}`)
  const n = 8 + Math.floor(rng() * 5)
  const results = []

  for (let i = 0; i < n; i++) {
    const factory = pool[Math.floor(rng() * pool.length)]
    const tpl = factory()
    const author = pick(rng, USERS)
    const kind = tpl.type === 'comment' ? 't1' : 't3'
    const post_id = `${kind}_mock_${slug(clean)}_${slug(query)}_${i}_${Math.floor(rng() * 1e6)}`
    const title = tpl.title || ''
    const body_snippet = String(tpl.body || '').slice(0, 500)
    const tslug = slug(title || body_snippet || 'thread')
    const url = `https://reddit.com/r/${clean}/comments/mock_${tslug}/signal_mock_${i}`

    results.push({
      post_id,
      title,
      body_snippet,
      url,
      author,
      subreddit: clean,
      created_utc: hoursAgoSec(rng, 7 * 24),
      type: tpl.type,
    })
  }

  return results
}

module.exports = {
  searchReddit,
  searchSubreddit,
}
