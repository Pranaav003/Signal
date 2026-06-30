/** Strip HTML / noisy Reddit errors before showing in the UI. */
export function sanitizeScanErrorMessage(raw) {
  const text = String(raw || '').trim()
  if (!text) return 'Scan failed. Check backend logs.'
  if (
    /SKIP_AI_LEAD_CLASSIFIER/i.test(text) &&
    /REQUIRE_AI_CLASSIFIER/i.test(text)
  ) {
    return (
      'AI classification is required but disabled. Remove the SKIP_AI_LEAD_CLASSIFIER env var ' +
      'to enable AI classification, then redeploy.'
    )
  }
  if (/SKIP_AI_LEAD_CLASSIFIER/i.test(text)) {
    return (
      'AI lead classification is turned off (SKIP_AI_LEAD_CLASSIFIER). Remove that variable, ' +
      'or set REQUIRE_AI_CLASSIFIER=false.'
    )
  }
  if (/OPENAI_API_KEY/i.test(text) && /missing|not set/i.test(text)) {
    return 'OPENAI_API_KEY is missing. Add it to your environment variables and redeploy.'
  }
  if (
    /blocked by network security/i.test(text) ||
    /<!doctype html|<html|<body class=/i.test(text)
  ) {
    return 'Reddit blocked this server (network security). Check PROXY_LIST and proxy credentials.'
  }
  if (/bandwidth limit reached|upgrade to continue using the proxy/i.test(text)) {
    return (
      'Webshare proxy bandwidth is used up. Upgrade your plan or add bandwidth at webshare.io, ' +
      'then retry the scan.'
    )
  }
  if (text.length > 320) return `${text.slice(0, 317)}...`
  return text
}

/** Build a user-facing line when a scan finished with few or zero leads. */
export function formatScanDiagnosticSummary(data) {
  const d = data?.diagnostics || data?.scan_progress || {}
  if (d.diagnostic_summary) return String(d.diagnostic_summary)

  const raw = Number(d.raw_candidates ?? d.collected_raw ?? 0)
  const rawSeen = Number(d.raw_seen_total ?? 0)
  const rawTruncated = Boolean(d.raw_truncated)
  const redditRaw = Number(
    d.reddit_raw_count ?? (Number(d.raw_global_count ?? 0) + Number(d.raw_subreddit_count ?? 0))
  )
  const hn = Number(d.hn_raw_count ?? d.raw_hn_count ?? 0)
  const ranked = Number(d.initially_scored_count ?? d.scored_count ?? 0)
  const qualified = Number(
    d.ai_qualified_count ?? d.rules_qualified_count ?? d.semantically_qualified ?? 0
  )
  const rejectedSemantic = Number(d.rejected_semantic_count ?? d.ai_rejected_count ?? 0)
  const rejectedNegative = Number(d.negative_filtered_count ?? d.skipped_negative_count ?? 0)
  const inserted = Number(d.inserted_count ?? d.leads_saved ?? data?.leads_found ?? 0)
  const duplicates = Number(d.duplicate_count ?? 0)
  const threshold = d.threshold_used ?? '?'
  const mode = d.reddit_mode || 'unknown'

  const planner =
    d.planner_source === 'ai'
      ? `Search plan: AI (${d.planner_model || 'model'})`
      : d.planner_source === 'fallback'
        ? 'Search plan: fallback'
        : null
  const classifier =
    d.classifier_source === 'ai'
      ? `Qualification: AI (${d.classifier_model || 'model'})`
      : d.classifier_source === 'fallback'
        ? 'Qualification: fallback'
        : null

  const consistency =
    inserted > 0 && raw === 0 ? ' [diagnostics inconsistency: saved leads but 0 raw]' : ''

  const rawLabel =
    rawTruncated && rawSeen > raw
      ? `${rawSeen} seen, capped to ${raw} for scoring`
      : `${raw} raw candidates`
  const focus = d.search_focus ? ` Focus: ${d.search_focus}.` : ''
  const parts = [
    `Found ${rawLabel}: ${redditRaw} Reddit, ${hn} HN.${focus}`,
    `${ranked} ranked, ${qualified} passed qualification, ${rejectedSemantic} rejected (semantic), ${rejectedNegative} filtered (negative).`,
    `${inserted} saved this scan, ${duplicates} duplicates. Mode: ${mode}, threshold ${threshold}.`,
  ]
  if (planner) parts.push(planner)
  if (classifier) parts.push(classifier)

  return parts.join(' ') + consistency
}

/** Build a user-facing line when a scan finished with 0 leads. */
export function formatZeroLeadsDiagnostic(data) {
  const d = data?.diagnostics || data?.scan_progress || {}
  const inserted = Number(d.inserted_count ?? d.leads_saved ?? data?.leads_found ?? 0)
  if (inserted > 0) return null

  const summary = formatScanDiagnosticSummary(data)
  if (summary && !summary.startsWith('Found 0 raw')) {
    return summary
  }

  if (d.reddit_auth_error) {
    return 'Reddit blocked or proxy failed. Set PROXY_LIST and proxy credentials in your environment.'
  }

  const raw = Number(d.raw_candidates ?? d.collected_raw ?? 0)
  const deduped = Number(d.deduped_count ?? 0)
  const survivors = Number(d.final_candidates_count ?? d.survivors_count ?? 0)
  const threshold = d.threshold_used ?? '?'
  const duplicates = Number(d.duplicate_count ?? 0)
  const hn = Number(d.hn_raw_count ?? d.raw_hn_count ?? 0)

  if (raw === 0) {
    if (Number(d.reddit_error_count || 0) > 0 || Number(d.hn_error_count || 0) > 0) {
      return `0 raw results (${d.reddit_error_count || 0} Reddit errors, ${d.hn_error_count || 0} HN errors). ${d.last_reddit_error || d.last_hn_error || ''}`
    }
    if (Number(d.reddit_empty_response_count || 0) > 0) {
      return (
        'Reddit returned empty through your proxies — no posts collected. ' +
        'Confirm PROXY_PASSWORD and PROXY_USERNAME are set correctly.'
      )
    }
    return '0 raw results — Reddit blocked or proxies returned blank. Check proxy credentials and backend logs.'
  }
  if (deduped === 0) {
    return 'Results returned but none had valid post IDs after dedupe.'
  }
  if (survivors === 0 && deduped > 0) {
    return `Found ${raw} raw (${hn} HN). ${deduped} deduped, 0 passed scoring threshold ${threshold}.`
  }
  if (survivors > 0 && duplicates > 0 && inserted === 0) {
    return `${survivors} passed scoring but all ${duplicates} were duplicates already in the database.`
  }
  if (d.last_reddit_error) {
    return `Reddit errors: ${d.last_reddit_error}`
  }
  if (data?.scan_progress?.message) {
    return String(data.scan_progress.message)
  }
  return summary || 'Scan finished with 0 new leads. Check backend logs.'
}

/** Show diagnostic summary when lead count is low (< 5). */
export function formatLowLeadsDiagnostic(data, leadsFound) {
  const n = Number(leadsFound ?? 0)
  if (n >= 5) return null
  return formatScanDiagnosticSummary(data)
}

/** One-line AI vs fallback visibility for scan complete UI. */
export function formatAiSourceSummary(data) {
  const d = data?.diagnostics || data?.scan_progress || data || {}
  const lines = []
  if (d.planner_source === 'ai') {
    lines.push(`Search plan: AI-generated using ${d.planner_model || 'OpenAI'}`)
  } else if (d.planner_source === 'fallback') {
    lines.push('Search plan: fallback — OPENAI_API_KEY missing or planner failed')
  }
  if (d.classifier_source === 'ai') {
    lines.push(`Lead qualification: AI using ${d.classifier_model || 'OpenAI'}`)
  } else if (d.classifier_source === 'fallback') {
    const err = d.classifier_error ? ` (${d.classifier_error})` : ''
    if (d.planner_source === 'ai') {
      lines.push(`AI classifier failed; fallback qualification used${err}`)
    } else {
      lines.push(`Lead qualification: fallback classifier${err}`)
    }
  }
  return lines.length ? lines.join('\n') : null
}
