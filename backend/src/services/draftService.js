/**
 * @typedef {{
 *   title?: string|null,
 *   body_snippet?: string|null,
 *   subreddit?: string|null,
 *   product_description?: string|null
 * }} LeadLike
 */

/**
 * @typedef {{ product_description?: string|null, pitch_line?: string|null }} KeywordSetLike
 */

async function openaiChat(messages, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('[draftService] OPENAI_API_KEY missing')
    return null
  }

  const body = {
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages,
    ...options,
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      console.error('[draftService] OpenAI error', response.status, data)
      return null
    }

    const text =
      typeof data?.choices?.[0]?.message?.content === 'string'
        ? data.choices[0].message.content.trim()
        : ''

    return text || null
  } catch (err) {
    console.error('[draftService] OpenAI request failed', err)
    return null
  }
}

/**
 * @param {LeadLike} lead
 * @param {KeywordSetLike | null | undefined} keywordSet
 * @returns {Promise<string|null>}
 */
async function generateDraft(lead, keywordSet) {
  const ks = keywordSet ?? {}
  const productDesc =
    (typeof ks.product_description === 'string' && ks.product_description.trim()) || ''
  const pitchLine =
    typeof ks.pitch_line === 'string' && ks.pitch_line.trim() ? ks.pitch_line.trim() : ''

  const productContext = pitchLine
    ? `The product to mention: "${pitchLine}"`
    : `The product: ${productDesc}`

  const sub = lead?.subreddit ?? ''
  const title = lead?.title ?? ''
  const body = lead?.body_snippet ?? ''

  const system = `You are a real Reddit user who genuinely solved this problem using a specific product. Your job is to write a helpful comment that naturally mentions the product.

Rules:
- Lead with a genuine insight or observation about the problem
- Mention the product naturally in ONE sentence mid-comment
- Sound human, not like an ad
- Max 3-4 sentences
- Include the product name or URL from the product context if given
- Never start with 'I understand' or 'It sounds like'
- No exclamation marks`

  const user = `Subreddit: r/${sub}
Post: ${title}
Body: ${body}

${productContext}

Write a reply that helps them AND naturally mentions the product.`

  return openaiChat([
    { role: 'system', content: system.trim() },
    { role: 'user', content: user.trim() },
  ])
}

/**
 * @param {KeywordSetLike} keywordSet
 * @returns {Promise<{ title: string, body: string } | null>}
 */
async function generateExamplePost(keywordSet) {
  const desc = keywordSet?.product_description ?? ''

  const system =
    'You output JSON only. No markdown fences. Keys must be exactly "title" and "body".'

  const user = `Generate a realistic Reddit post (title + body) from someone who desperately
needs this product: ${desc}
Respond in JSON only: { "title": string, "body": string }`

  const raw = await openaiChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { response_format: { type: 'json_object' }, max_tokens: 500 }
  )

  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.title === 'string' && typeof parsed?.body === 'string') {
      return { title: parsed.title, body: parsed.body }
    }
  } catch {
    console.error('[draftService] Failed to parse example post JSON', raw.slice(0, 200))
  }

  return null
}

module.exports = { generateDraft, generateExamplePost }
