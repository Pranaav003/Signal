function extractMessageText(body) {
  const block = body?.content?.[0];
  if (!block) return '';

  /** Anthropic Responses use `{ type:'text', text:'...' }` blocks */
  if (typeof block.text === 'string') return block.text;

  /** legacy / alternate payloads */
  if (block.content && typeof block.content[0]?.text === 'string')
    return block.content[0].text;

  return '';
}

/** @typedef {{ title?: string|null, body_snippet?: string|null, subreddit?: string|null }} LeadLike */

/**
 * Generates a humane Reddit-comment draft referencing the lead + product briefly.
 *
 * @param {LeadLike} lead
 * @param {string} productDescription
 */
async function generateDraft(lead, productDescription) {
  const subreddit = lead?.subreddit ?? '';
  const title = lead?.title ?? '';
  const snippet = lead?.body_snippet ?? '';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You help small business owners respond authentically to Reddit posts 
where someone needs their product. Write a genuine, helpful Reddit comment.
Rules:
- Lead with actually helping the person first
- Mention the product in 1 sentence maximum, naturally
- Never sound like an advertisement
- Match the casual tone of Reddit
- Maximum 4 sentences
- Do not use phrases like "I'd recommend" or "Check out"
- Sound like a real person who happens to have solved this problem`,
        messages: [
          {
            role: 'user',
            content: `Reddit post in r/${subreddit}:
Title: "${title}"
Body: "${snippet}"

The product I'm trying to mention naturally: ${productDescription}

Write a helpful reply comment.`,
          },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error('Failed to generate draft');
    }

    const text = extractMessageText(data);

    if (!text) throw new Error('Failed to generate draft');

    return text;
  } catch {
    /** Network / JSON errors also collapse to UX-safe message per spec */
    throw new Error('Failed to generate draft');
  }
}

module.exports = { generateDraft };
