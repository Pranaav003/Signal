/**
 * AI search + qualification rubric planner (monitor-specific, no runtime domain rules).
 */

async function openaiJsonChat(system, user, maxTokens = 3000) {
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
        temperature: 0.35,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[searchBriefPlanner] OpenAI error', response.status, data);
      return null;
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') return null;
    return JSON.parse(text);
  } catch (err) {
    console.error('[searchBriefPlanner] request failed', err?.message || err);
    return null;
  }
}

const { attachMarketplaceFields } = require('./marketplacePlan');

const SYSTEM_PROMPT = `You are creating a search and qualification plan for a lead-monitoring app.

Given a product description, infer the actual demand signal the user wants to track — not surface keywords.

If the product is a marketplace, rental platform, or two-sided service (providers + buyers/venues), identify BOTH sides and prioritize the demand side for lead generation unless the user clearly wants providers.

Return only valid JSON:
{
  "rewritten_monitor": "Clear description of what to find online",
  "product_type": "single_sided" | "marketplace" | "tool" | "service" | "unknown",
  "sides": [
    {
      "name": "demand_side",
      "description": "Who needs / buys / books the service",
      "likely_buyers_or_users": ["..."],
      "lead_definition": "What counts as a lead on this side",
      "search_queries": ["concise Reddit search terms for THIS side only"],
      "lead_patterns": ["example posts for qualification — not search queries"],
      "subreddits": [{ "name": "subredditName", "priority": "high|medium|low", "reason": "..." }],
      "required_evidence": ["..."],
      "disqualifying_evidence": ["..."]
    },
    {
      "name": "supply_side",
      "description": "Who provides / rents / offers the service",
      "likely_buyers_or_users": ["..."],
      "lead_definition": "...",
      "search_queries": ["..."],
      "lead_patterns": ["..."],
      "subreddits": [{ "name": "...", "priority": "high|medium|low", "reason": "..." }],
      "required_evidence": ["..."],
      "disqualifying_evidence": ["..."]
    }
  ],
  "primary_side": "demand_side" | "supply_side" | "both",
  "primary_side_reason": "Why this side is best for lead generation",
  "lead_definition": "What counts as a valid lead for THIS product (default: demand side)",
  "core_demand_signal": "Underlying pain/demand in one sentence",
  "customer_personas": ["who posts about this"],
  "jobs_to_be_done": ["what they are trying to accomplish when they post"],
  "positive_lead_patterns": ["situations/phrases indicating a good lead"],
  "negative_lead_patterns": ["false positive situations for THIS product"],
  "required_evidence": ["what must be present in a post to count as a lead"],
  "disqualifying_evidence": ["what disqualifies a post even if keywords match"],
  "acceptable_edge_cases": ["borderline cases and when to accept"],
  "competitor_or_market_research_rules": {
    "include_competitor_posts": false,
    "when_to_include": "string or null",
    "when_to_reject": "string or null"
  },
  "search_queries": ["12-20 concise Reddit search terms (3-10 words each, demand-signal focused, no placeholders)"],
  "lead_patterns": ["8-15 natural-language example posts that would count as leads — NOT used as Reddit search strings"],
  "queries": ["deprecated alias of search_queries — same rules as search_queries"],
  "subreddits": [
    { "name": "subredditName", "priority": "high|medium|low", "reason": "why this community fits" }
  ],
  "negative_keywords": ["words strongly indicating irrelevant posts"],
  "reddit_fit": "good" | "medium" | "weak",
  "confidence": 0-100,
  "warning": null or "string",
  "suggestion": null or "string",
  "reasoning_summary": "one short sentence"
}

Rules:
- For marketplaces: demand_side = venues, coordinators, parents, facilities, organizations, or people seeking the experience; supply_side = owners/providers monetizing an asset. Default primary_side to demand_side.
- demand_side search_queries must target buyer/venue/coordinator pain — senior centers, schools, care homes, therapy coordinators, people seeking visits. NOT provider monetization (no "rent my dog", "earn money with my pet", "list my pet" on demand_side).
- demand_side subreddits should favor communities where buyers/posters ask for programs or visits, not only generic pet-owner forums.
- supply_side queries may target providers but should be labeled under supply_side only.
- Do not use a predefined industry/domain list. Infer from the product description only.
- Do not merely extract nouns from the product description.
- lead_definition describes evidence visible in public posts (wishes, unmet needs, "I wish X existed here") — NOT whether the post mentions your app's internal features (e.g. voting UI) unless the product explicitly monitors discussion of that app.
- required_evidence must be observable in a Reddit/HN post without assuming the poster uses the user's product.
- search_queries are short search strings for Reddit (e.g. "wish more food options near campus") — NOT diary stories.
- lead_patterns are example posts for qualification only (e.g. "I'm craving tacos, but there's nowhere to get them around here") — do NOT put these in search_queries.
- Avoid generic help/recommendation queries unless that IS the product.
- NEVER use placeholders: X, Y, Z, [business], [city], <service>, "your city", or "a Y restaurant". Every query must use concrete words inferred from the product description.
- If the product gives an example (e.g. a brand or campus abbreviation), use it as a clue in queries only when context supports it — do not invent unrelated locations.
- Subreddits: rank by relevance (high/medium/low). Broad communities (AskReddit, food) should be low priority fallbacks unless the product is global.
- required_evidence and disqualifying_evidence must be specific to this product.
- positive/negative patterns must be product-specific, not generic spam filters.
- Return only valid JSON.`;

const {
  validateSearchPlan,
  applyValidatedPlan,
  normalizeSubredditEntries,
  subredditNamesOrdered,
  filterConcreteQueries,
  splitSearchQueriesFromPatterns,
} = require('./planValidator');

function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

function normalizeBrief(raw, desc) {
  const b = raw && typeof raw === 'object' ? raw : {};

  const split = splitSearchQueriesFromPatterns(b);
  let queries = split.search_queries;
  const lead_patterns = split.lead_patterns;
  const subredditEntries = normalizeSubredditEntries(b.subreddits);
  let subreddits = subredditNamesOrdered(subredditEntries);

  const requiredEvidence = arr(b.required_evidence).length
    ? arr(b.required_evidence)
    : arr(b.must_have_concepts);
  const disqualifyingEvidence = arr(b.disqualifying_evidence).length
    ? arr(b.disqualifying_evidence)
    : [...arr(b.disqualifiers), ...arr(b.negative_lead_patterns)];

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const base = {
    rewritten_monitor: String(b.rewritten_monitor || b.rewritten_prompt || desc).trim(),
    rewritten_prompt: String(b.rewritten_monitor || b.rewritten_prompt || desc).trim(),
    product_summary: String(b.product_summary || b.core_demand_signal || '').trim(),
    core_offer: String(b.core_demand_signal || b.core_offer || b.product_summary || '').trim(),
    lead_definition: String(
      b.lead_definition ||
        'Post expresses pain or demand that matches the product’s target use case.'
    ).trim(),
    core_demand_signal: String(b.core_demand_signal || b.lead_definition || '').trim(),
    target_customer: arr(b.customer_personas || b.target_customer),
    customer_personas: arr(b.customer_personas || b.target_customer),
    pain_points: arr(b.jobs_to_be_done || b.pain_points),
    jobs_to_be_done: arr(b.jobs_to_be_done || b.pain_points),
    positive_lead_patterns: arr(b.positive_lead_patterns),
    negative_lead_patterns: arr(b.negative_lead_patterns),
    required_evidence: requiredEvidence,
    disqualifying_evidence: disqualifyingEvidence,
    acceptable_edge_cases: arr(b.acceptable_edge_cases),
    competitor_or_market_research_rules:
      b.competitor_or_market_research_rules && typeof b.competitor_or_market_research_rules === 'object'
        ? b.competitor_or_market_research_rules
        : { include_competitor_posts: false, when_to_include: null, when_to_reject: null },
    search_queries: queries,
    lead_patterns,
    queries,
    subreddits,
    subreddit_entries: subredditEntries,
    negative_keywords: arr(b.negative_keywords).map((k) => k.toLowerCase()),
    must_have_concepts: requiredEvidence,
    should_have_concepts: arr(b.should_have_concepts || b.optional_concepts),
    required_concepts: requiredEvidence,
    optional_concepts: arr(b.should_have_concepts || b.optional_concepts),
    disqualifiers: disqualifyingEvidence,
    ideal_post_patterns: arr(b.ideal_post_patterns || b.positive_lead_patterns).slice(0, 8),
    reddit_fit: ['good', 'medium', 'weak'].includes(b.reddit_fit) ? b.reddit_fit : 'good',
    warning: b.warning || null,
    suggestion: b.suggestion || null,
    reasoning_summary: b.reasoning_summary || null,
    confidence: Number(b.confidence) || null,
    _source: 'ai',
    planner_source: 'ai',
    _planner_model: model,
    planner_model: model,
  };

  return attachMarketplaceFields(base, desc);
}

function buildFallbackBrief(desc) {
  const phrases = desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 8);

  const fallback = {
    rewritten_monitor: desc,
    rewritten_prompt: desc,
    lead_definition: `Posts that express pain, need, or demand aligned with: ${desc.slice(0, 120)}`,
    core_demand_signal: desc.slice(0, 160),
    customer_personas: ['people discussing this problem online'],
    jobs_to_be_done: ['find a solution', 'express frustration', 'ask for alternatives'],
    positive_lead_patterns: ['looking for', 'need help with', 'wish there was', 'frustrated with'],
    negative_lead_patterns: ['off-topic discussion unrelated to the product pain'],
    required_evidence: phrases.length ? phrases.slice(0, 4) : ['problem', 'need', 'looking'],
    disqualifying_evidence: ['completely unrelated topic'],
    acceptable_edge_cases: [],
    competitor_or_market_research_rules: {
      include_competitor_posts: false,
      when_to_include: null,
      when_to_reject: 'Generic recommendations with no product-relevant demand signal',
    },
    queries: [
      `how do people deal with ${phrases[0] || 'this problem'}`,
      `frustrated with ${phrases[0] || 'this issue'}`,
      `looking for help with ${phrases[0] || 'this'}`,
      `anyone else struggle with ${phrases[0] || 'this'}`,
      `what do you use for ${phrases[0] || 'this'}`,
      `recommendations for ${phrases[0] || 'this'}`,
      `need a solution for ${phrases[0] || 'this'}`,
      `is there a tool for ${phrases[0] || 'this'}`,
    ],
    subreddits: ['AskReddit', 'smallbusiness', 'Entrepreneur', 'SideProject', 'startup'],
    negative_keywords: [],
    reddit_fit: desc.length < 40 ? 'weak' : 'medium',
    warning: 'OPENAI_API_KEY missing or planner failed — using conservative fallback rubric.',
    suggestion: 'Add more detail about who the customer is and what pain you solve.',
    reasoning_summary: 'Deterministic fallback rubric',
    _source: 'fallback',
    planner_source: 'fallback',
    _planner_model: null,
    planner_model: null,
    product_type: 'unknown',
    sides: [],
    primary_side: 'demand_side',
    primary_side_reason: 'Fallback plan defaults to demand-side lead search.',
  };

  return attachMarketplaceFields(fallback, desc);
}

function repairBriefWithFallback(brief, desc) {
  const fb = buildFallbackBrief(desc);
  const merged = {
    ...brief,
    queries: filterConcreteQueries([...(brief.queries || []), ...(fb.queries || [])]),
    subreddits: subredditNamesOrdered(
      normalizeSubredditEntries([
        ...(brief.subreddit_entries || brief.subreddits || []),
        ...(fb.subreddits || []),
      ])
    ),
    lead_definition: brief.lead_definition || fb.lead_definition,
    required_evidence:
      (brief.required_evidence || []).length ? brief.required_evidence : fb.required_evidence,
    disqualifying_evidence:
      (brief.disqualifying_evidence || []).length
        ? brief.disqualifying_evidence
        : fb.disqualifying_evidence,
  };
  merged.subreddit_entries = normalizeSubredditEntries(merged.subreddits);
  return merged;
}

async function generateSearchBrief(productDescription, options = {}) {
  const desc = String(productDescription || '').replace(/\s+/g, ' ').trim();
  if (!desc) throw new Error('product_description is required');

  let brief = null;

  if (!options.skipAi && process.env.OPENAI_API_KEY) {
    const parsed = await openaiJsonChat(
      SYSTEM_PROMPT,
      `Product description:\n\n${desc}\n\nReturn the JSON search and qualification plan.`
    );
    if (parsed) {
      brief = normalizeBrief(parsed, desc);
    }
  }

  if (!brief) {
    brief = normalizeBrief(buildFallbackBrief(desc), desc);
  }

  let validation = validateSearchPlan(brief, desc);
  if (!validation.valid && !options.skipRepair && process.env.OPENAI_API_KEY) {
    const repairPrompt = `The previous plan had issues: ${validation.errors.join('; ')}.
Return a repaired JSON plan with concrete queries (no X/Y placeholders) and ranked subreddits.
Product:\n${desc}`;
    const repaired = await openaiJsonChat(SYSTEM_PROMPT, repairPrompt);
    if (repaired) {
      brief = normalizeBrief(repaired, desc);
      validation = validateSearchPlan(brief, desc);
    }
  }

  if (!validation.valid) {
    brief = repairBriefWithFallback(brief, desc);
    validation = validateSearchPlan(brief, desc);
    if (!brief.planner_source || brief.planner_source === 'ai') {
      brief.planner_source = validation.valid ? brief.planner_source : 'fallback';
      brief._source = brief.planner_source;
      brief.warning =
        brief.warning ||
        `Plan repaired after validation: ${validation.errors.join('; ')}`;
    }
  }

  return applyValidatedPlan(brief, validation);
}

module.exports = {
  generateSearchBrief,
  normalizeBrief,
  buildFallbackBrief,
};
