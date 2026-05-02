require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })

const { generateQueries } = require('../services/keywordProcessor')
const { searchReddit, searchSubreddit } = require('../services/redditService')
const { scoreResult } = require('../services/relevanceScorer')

const PRODUCT = 'project management tool for remote teams'

async function main() {
  const keywordSetLike = { product_description: PRODUCT }
  const { queries, subreddits } = generateQueries(PRODUCT)

  const collected = []

  for (const q of queries) {
    collected.push(...(await searchReddit(q)))
  }

  for (const sub of subreddits) {
    for (const q of queries) {
      collected.push(...(await searchSubreddit(sub, q)))
    }
  }

  const dedup = new Map()

  for (const item of collected) {
    if (!item?.post_id) continue
    if (!dedup.has(item.post_id)) dedup.set(item.post_id, item)
  }

  const scored = [...dedup.values()].map((r) => ({
    ...r,
    _score: scoreResult(r, keywordSetLike),
  }))

  scored.sort((a, b) => b._score - a._score)

  const top = scored.slice(0, 5)

  console.log(`\nTop ${top.length} of ${scored.length} scored results`)
  console.log(`Product: ${PRODUCT}\n`)

  for (const r of top) {
    console.log('---')
    console.log('score:', r._score)
    console.log('type:', r.type)
    console.log('subreddit:', r.subreddit)
    console.log('title:', r.title || '(comment)')
    console.log('snippet:', (r.body_snippet || '').slice(0, 140))
    console.log('url:', r.url)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
