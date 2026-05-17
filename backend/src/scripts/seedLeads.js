require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const pool = require('../db/connection')
const { generateQueries } = require('../services/keywordProcessor')

const DEMO_EMAIL = 'demo@signal.app'

const KEYWORD_SETS = [
  'SEO tool for small businesses',
  'freelance invoicing software',
  'meal planning app for busy families',
]

const AUTHORS = [
  'throwaway_agency_owner',
  'solo_consultant_22',
  'LateNightSEO',
  'BusyDadMeals',
  'invoice_panic_mode',
  'RemotePM_404',
  'sidehustle_sarah',
  'tax_season_meltdown',
]

const SUBS = [
  'smallbusiness',
  'entrepreneur',
  'freelance',
  'SEO',
  'mealprep',
  'personalfinance',
  'startups',
]

/** Static example drafts (3–4 total across all seeded leads) */
const STATIC_DRAFTS = [
  `Totally get the spreadsheet spiral. We ended up wiring a lightweight stack: one place for proposals, recurring invoices, and “did they pay?” reminders. Nothing flashy—just fewer Sunday nights reconciling deposits.

If you want a sanity check, we use a small invoicing-focused tool (Signal) that doesn’t try to be a full ERP. Happy to share the exact flow if helpful.`,

  `This sounds less like “rankings” and more like “we broke something technical + the content map is fuzzy.” I’d start with: indexability (robots/noindex), canonicals, internal links, and a thin-page audit—usually that’s where redesigns hurt.

If you want a second pair of eyes, we leaned on a simple SEO workflow tool (Signal) mostly for checklists + exports so we weren’t guessing in GSC.`,

  `Meal prep with picky kids is basically logistics + repetition. What helped us was planning around what’s on sale + one “backup” meal that’s always freezer-friendly.

We use a meal-planning app (Signal) mostly for grocery lists tied to recipes—cuts waste a lot.`,

  `Async standups die when nobody owns blockers. We moved to a lightweight board + a single “top 3 risks” line each day—more boring, more effective.

We’re not huge-Jira people; a small PM-style tool (Signal) was enough to keep accountability without surveillance vibes.`,
]

const LEAD_TEMPLATES = [
  {
    title: 'Our traffic tanked after a redesign — what should I check first?',
    body:
      'We launched a new marketing site two weeks ago and organic sessions are down ~40%. GSC is messy and I’m not sure if it’s canonicals, internal links, or just thin pages. I’m not an SEO expert—just need a sane checklist before I panic-hire an agency.',
    scores: [82, 71, 18],
  },
  {
    title: 'Invoicing + reminders for 12 clients — what’s the minimum viable setup?',
    body:
      'I’m a solo consultant and I’m losing hours chasing payments. I need recurring invoices, auto reminders, and something that doesn’t embarrass me when clients see it. Budget is tight and I hate “enterprise” pricing for 12 clients.',
    scores: [91, 76, 94],
  },
  {
    title: 'Meal planning for picky kids + tight grocery budget — any apps that work?',
    body:
      'We meal prep Sundays but we waste produce and the kids reject half the meals. I’d love something that builds a week around what’s on sale and keeps grocery lists short. Bonus if it handles substitutions.',
    scores: [68, 63, 21],
  },
  {
    title: 'Async standups across timezones — how do you keep accountability?',
    body:
      'We’re 100% remote across US/EU. Slack threads aren’t cutting it and nobody feels ownership over blockers. I want something lightweight that shows risks without feeling like micromanagement.',
    scores: [88, 79, 20],
  },
  {
    title: 'Why does every “affordable” tool cap exports behind a paywall?',
    body:
      'I’m trying to keep ops simple: proposals → invoices → basic reporting. Every tool either feels toy-like or jumps to $200/mo once you need exports or permissions. Is there a boring middle ground?',
    scores: [74, 66, 19],
  },
  {
    title: 'Best way to audit a tiny site (<50 pages) without hiring an agency?',
    body:
      'Not trying to rank nationally—just want clean technical basics and a clear list of content gaps. I can follow a checklist if someone tells me what not to break in production.',
    scores: [86, 61, 18],
  },
  {
    title: 'Recurring billing for international clients — FX fees are killing me',
    body:
      'Half my clients pay in CAD/EUR and my bank fees eat the margin. I need invoicing that handles multi-currency without feeling like a forex product. What are freelancers actually using?',
    scores: [77, 69, 42],
  },
]

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString()
}

async function ensureUser(client) {
  let { rows } = await client.query(
    `SELECT id FROM users WHERE email = $1`,
    [DEMO_EMAIL]
  )

  if (rows.length) return rows[0].id

  const ins = await client.query(
    `INSERT INTO users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [DEMO_EMAIL]
  )

  return ins.rows[0].id
}

async function ensureKeywordSet(client, userId, productDescription) {
  const { rows } = await client.query(
    `SELECT id FROM keyword_sets WHERE user_id = $1 AND product_description = $2`,
    [userId, productDescription]
  )

  if (rows.length) return rows[0].id

  const { queries, subreddits } = await generateQueries(productDescription)

  const ins = await client.query(
    `INSERT INTO keyword_sets (id, user_id, product_description, queries, subreddits)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     RETURNING id`,
    [userId, productDescription, queries, subreddits]
  )

  return ins.rows[0].id
}

async function main() {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const userId = await ensureUser(client)

    const ksIds = []
    for (const desc of KEYWORD_SETS) {
      ksIds.push(await ensureKeywordSet(client, userId, desc))
    }

    // Re-seeding used to append rows (post_id included randomness), which looked like duplicate posts.
    await client.query(
      `DELETE FROM leads WHERE user_id = $1 AND post_id LIKE 'seed_%'`,
      [userId]
    )

    let draftBudget = 4
    let draftIdx = 0

    for (let ki = 0; ki < ksIds.length; ki++) {
      const ksId = ksIds[ki]
      const n = 6 + (ki % 2)

      for (let i = 0; i < n; i++) {
        const tpl = LEAD_TEMPLATES[(ki * 3 + i) % LEAD_TEMPLATES.length]
        const score = tpl.scores[i % tpl.scores.length]
        const seen = (ki + i) % 3 === 0
        const sub = SUBS[(ki + i) % SUBS.length]
        const author = AUTHORS[(ki * 2 + i) % AUTHORS.length]
        const postId = `seed_${ksId}_${i}`
        const slug = `fake_${ki}_${i}`
        const url = `https://reddit.com/r/${sub}/comments/abc123/${slug}`

        const hoursBack = 4 + (ki * 11 + i * 17) % (5 * 24 - 4)
        const createdAt = hoursAgo(hoursBack)

        let aiDraft = null
        if (draftBudget > 0 && (ki + i) % 2 === 0) {
          aiDraft = STATIC_DRAFTS[draftIdx % STATIC_DRAFTS.length]
          draftIdx += 1
          draftBudget -= 1
        }

        await client.query(
          `INSERT INTO leads (
            user_id,
            keyword_set_id,
            platform,
            post_id,
            title,
            body_snippet,
            url,
            author,
            subreddit,
            relevance_score,
            seen,
            ai_draft,
            score_reasons,
            created_at
          ) VALUES ($1,$2,'reddit',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (user_id, keyword_set_id, post_id) DO NOTHING`,
          [
            userId,
            ksId,
            postId,
            tpl.title,
            tpl.body.slice(0, 500),
            url,
            author,
            sub,
            score,
            seen,
            aiDraft,
            [],
            createdAt,
          ]
        )
      }
    }

    await client.query('COMMIT')

    console.log('✓ Seed complete for', DEMO_EMAIL)
    console.log('  keyword_sets:', KEYWORD_SETS.length)
    console.log('  leads per set: ~6–7 (re-seed replaces prior seed rows)')
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
