/**
 * AI-generated Reddit search plan for arbitrary product descriptions.
 */

async function openaiJsonChat(system, user, maxTokens = 1200) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[aiSearchPlanner] OpenAI error', response.status, data);
      return null;
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') return null;

    return JSON.parse(text);
  } catch (err) {
    console.error('[aiSearchPlanner] request failed', err?.message || err);
    return null;
  }
}

const SYSTEM_PROMPT = `You are generating Reddit and web-search discovery conditions for a lead-monitoring app.

Given a product/service description, infer:
1. Who would feel the pain this product solves.
2. What they would complain about online.
3. What exact phrases they would use naturally in Reddit posts/comments.
4. Which subreddits are likely to contain those people.
5. Which phrases should be avoided because they produce irrelevant results.

Return only valid JSON with this shape:
{
  "queries": ["..."],
  "subreddits": ["..."],
  "negative_keywords": ["..."],
  "ideal_post_patterns": ["..."],
  "reddit_fit": "good" | "medium" | "weak",
  "warning": null or "...",
  "suggestion": null or "...",
  "reasoning_summary": "one short sentence"
}

Rules:
- Do not use generic phrases like "pain help", "management help", "business problem", "software help".
- Queries should sound like real Reddit posts.
- Prefer buyer-pain language: "how do I…", "does anyone know…", "looking for…", "recommend…", "struggling with…", "need help with…", "is there a service for…"
- Generate 12–20 queries.
- Generate 8–15 subreddits.
- Subreddits must NOT include r/ prefix.
- Include both obvious and adjacent communities.
- Do not assume the product belongs to a predefined category.
- Make the result specific to the product.`;

/**
 * @param {string} productDescription
 * @returns {Promise<object|null>}
 */
async function generateAiSearchPlan(productDescription) {
  const desc = String(productDescription || '').trim();
  if (!desc) return null;

  const parsed = await openaiJsonChat(
    SYSTEM_PROMPT,
    `Product description:\n\n${desc}\n\nReturn the JSON search plan.`
  );

  if (!parsed || typeof parsed !== 'object') return null;

  return {
    ...parsed,
    _source: 'ai',
  };
}

module.exports = {
  generateAiSearchPlan,
};
