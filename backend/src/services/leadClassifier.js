/**
 * AI batch lead classifier — uses monitor-specific search brief rubric only.
 */

const { normalizeLeadType, resolveRecommendedVisibility } = require('../utils/leadVisibility');

const DEFAULT_BATCH_SIZE = 18;

function classifierBatchSize() {
  const n = Number(process.env.CLASSIFIER_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : DEFAULT_BATCH_SIZE;
}

async function openaiJsonChat(system, user, maxTokens = 4000) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OPENAI_API_KEY missing', model: null, duration_ms: 0 };

  const model =
    process.env.OPENAI_CLASSIFIER_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const started = Date.now();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const duration_ms = Date.now() - started;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[leadClassifier] OpenAI error', response.status, data);
    return {
      error: data?.error?.message || `HTTP ${response.status}`,
      model,
      duration_ms,
    };
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { error: 'empty response', model, duration_ms };
  try {
    return { parsed: JSON.parse(text), model, duration_ms };
  } catch (e) {
    return { error: `invalid JSON: ${e.message}`, model, duration_ms, parse_error: e.message };
  }
}

function buildClassifierPrompt(searchBrief) {
  const system = `You are a strict lead qualification engine for a lead-monitoring app.

A real lead must match the product's lead_definition and required_evidence in the POST itself.
Reject candidates that match disqualifying_evidence — even if they share keywords, location, or subreddit.

Do not require mentions of the user's app features (e.g. voting, dashboards) unless the monitor explicitly tracks posts about that app.
Do not accept candidates only because they mention recommendations, a city, a food category, or a subreddit name.
The post must show evidence of the specific demand this monitor tracks.

Classify lead_type precisely:
- direct_demand: person/org clearly needs the product's solution now.
- adjacent_demand: related decision pain, useful but not a perfect buyer match.
- market_research: surveys, studies, org questions — useful intel, not an immediate buyer.
- supplier_side: providers, handlers, orgs offering services, groups recruiting handlers.
- competitor_signal: similar product, company, or competitor behavior.
- not_a_lead: recipes, personal cravings, one-off lookups, unrelated advice.

For demand-side monitors, supplier_side and market_research may still be is_lead=true but recommended_visibility=hide.

Return JSON: { "results": [ ... ] }`;

  const user = `Monitor rubric:
${JSON.stringify(
  {
    rewritten_monitor: searchBrief.rewritten_monitor || searchBrief.rewritten_prompt,
    lead_definition: searchBrief.lead_definition,
    core_demand_signal: searchBrief.core_demand_signal,
    customer_personas: searchBrief.customer_personas,
    jobs_to_be_done: searchBrief.jobs_to_be_done,
    positive_lead_patterns: searchBrief.positive_lead_patterns,
    negative_lead_patterns: searchBrief.negative_lead_patterns,
    lead_patterns: searchBrief.lead_patterns,
    required_evidence: searchBrief.required_evidence,
    disqualifying_evidence: searchBrief.disqualifying_evidence,
    acceptable_edge_cases: searchBrief.acceptable_edge_cases,
    competitor_or_market_research_rules: searchBrief.competitor_or_market_research_rules,
  },
  null,
  2
)}

For each candidate return:
{
  "candidate_id": "...",
  "is_lead": true|false,
  "confidence": 0-100,
  "lead_type": "direct_demand|adjacent_demand|market_research|supplier_side|competitor_signal|not_a_lead",
  "evidence": "one sentence citing post language",
  "recommended_visibility": "show|hide|debug",
  "matched_required_evidence": ["..."],
  "matched_positive_patterns": ["..."],
  "matched_disqualifying_evidence": ["..."],
  "reject_reason": "string or null"
}`;

  return { system, user };
}

function normalizeAiResults(list, searchFocus = 'demand_side') {
  return list.map((r) => {
    const confidence = Math.min(100, Math.max(0, Number(r.confidence) || 0));
    const lead_type = normalizeLeadType(
      r.lead_type || (r.is_lead ? 'direct_demand' : 'not_a_lead')
    );
    let is_lead = Boolean(r.is_lead);
    if (lead_type === 'not_a_lead') is_lead = false;

    const resolved = resolveRecommendedVisibility({
      lead_type,
      is_lead,
      confidence,
      search_focus: searchFocus,
      recommended_visibility: r.recommended_visibility,
    });

    return {
      candidate_id: String(r.candidate_id),
      is_lead: resolved.is_lead,
      confidence,
      lead_type: resolved.lead_type,
      recommended_visibility: resolved.recommended_visibility,
      evidence: r.evidence || '',
      matched_required_evidence: Array.isArray(r.matched_required_evidence)
        ? r.matched_required_evidence
        : [],
      matched_positive_patterns: Array.isArray(r.matched_positive_patterns)
        ? r.matched_positive_patterns
        : [],
      matched_disqualifying_evidence: Array.isArray(r.matched_disqualifying_evidence)
        ? r.matched_disqualifying_evidence
        : [],
      reject_reason: resolved.is_lead ? null : r.reject_reason || 'Rejected by AI classifier.',
    };
  });
}

async function classifyBatch(candidates, searchBrief, searchFocus = 'demand_side') {
  const payload = candidates.map((c) => ({
    candidate_id: c.post_id || c.candidate_id,
    title: (c.title || '').slice(0, 300),
    body_snippet: (c.body_snippet || '').slice(0, 500),
    subreddit: c.subreddit || '',
    initial_score: c.initial_score ?? 0,
    matched_query: c.matched_query || null,
  }));

  const { system, user } = buildClassifierPrompt(searchBrief);
  const userWithCandidates = `${user}\n\nCandidates:\n${JSON.stringify(payload, null, 2)}`;

  const out = await openaiJsonChat(system, userWithCandidates);
  if (out?.error) {
    return {
      results: null,
      error: out.error,
      model: out.model,
      duration_ms: out.duration_ms || 0,
      parse_error: out.parse_error || null,
    };
  }

  const list = out.parsed?.results || out.parsed?.classifications;
  if (!Array.isArray(list)) {
    return {
      results: null,
      error: 'missing results array',
      model: out.model,
      duration_ms: out.duration_ms || 0,
      parse_error: 'missing results array',
    };
  }

  return {
    results: normalizeAiResults(list, searchFocus),
    error: null,
    model: out.model,
    duration_ms: out.duration_ms || 0,
    parse_error: null,
  };
}

/**
 * @param {Array<object>} candidates
 * @param {object} searchBrief
 */
async function classifyCandidatesForLeadFit(candidates, searchBrief = {}, options = {}) {
  const searchFocus =
    options.search_focus || searchBrief.search_focus || 'demand_side';
  if (!process.env.OPENAI_API_KEY || !candidates?.length) {
    return {
      results: null,
      error: 'no_api_key_or_candidates',
      model: null,
      attempted: false,
      batch_count: 0,
      duration_ms: 0,
      parse_error: null,
    };
  }

  const batchSize = classifierBatchSize();
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  const allResults = [];
  let totalDuration = 0;
  let model = null;
  let lastError = null;
  let lastParseError = null;

  for (const batch of batches) {
    const out = await classifyBatch(batch, searchBrief, searchFocus);
    totalDuration += out.duration_ms || 0;
    if (out.model) model = out.model;
    if (out.error) {
      lastError = out.error;
      lastParseError = out.parse_error || lastParseError;
      return {
        results: null,
        error: lastError,
        model,
        attempted: true,
        batch_count: batches.length,
        duration_ms: totalDuration,
        parse_error: lastParseError,
      };
    }
    allResults.push(...(out.results || []));
  }

  return {
    results: allResults,
    error: null,
    model,
    attempted: true,
    batch_count: batches.length,
    duration_ms: totalDuration,
    parse_error: null,
  };
}

module.exports = {
  classifyCandidatesForLeadFit,
  classifierBatchSize,
};
