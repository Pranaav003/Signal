/** @typedef {{ title?: string|null, body_snippet?: string|null, subreddit?: string|null }} LeadLike */

/**
 * Generates a humane Reddit-comment draft referencing the lead + product briefly.
 * Uses OpenAI Chat Completions (`OPENAI_API_KEY`).
 *
 * @param {LeadLike} lead
 * @param {string} productDescription
 */
async function generateDraft(lead, productDescription) {
  const subreddit = lead?.subreddit ?? ''
  const title = lead?.title ?? ''
  const snippet = lead?.body_snippet ?? ''

  const system = `You help small business owners respond authentically to Reddit posts
where someone needs their product. Write a genuine, helpful Reddit comment.
Rules:
- Lead with actually helping the person first
- Mention the product in 1 sentence maximum, naturally
- Never sound like an advertisement
- Match the casual tone of Reddit
- Maximum 4 sentences
- Do not use phrases like "I'd recommend" or "Check out"
- Sound like a real person who happens to have solved this problem`

  const user = `Reddit post in r/${subreddit}:
Title: "${title}"
Body: "${snippet}"

The product I'm trying to mention naturally: ${productDescription}

Write a helpful reply comment.`

  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('Failed to generate draft')
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      throw new Error('Failed to generate draft')
    }

    const text =
      typeof data?.choices?.[0]?.message?.content === 'string'
        ? data.choices[0].message.content.trim()
        : ''

    if (!text) throw new Error('Failed to generate draft')

    return text
  } catch {
    throw new Error('Failed to generate draft')
  }
}

module.exports = { generateDraft }
