/**
 * Scan run lifecycle — single source of truth for per-scan diagnostics.
 */

function maxLeadsPerRun() {
  const raw = Number(process.env.SCAN_MAX_LEADS_PER_RUN);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 40;
}

function createEmptyDiagnostics(scanRunId, brief = {}) {
  return {
    scan_run_id: scanRunId,
    planner_source: brief._source || brief.planner_source || null,
    planner_model: brief._planner_model || null,
    classifier_source: null,
    classifier_model: null,
    classifier_error: null,
    classifier_attempted: null,
    classifier_batch_count: null,
    classifier_response_parse_error: null,
    classifier_duration_ms: null,
    max_leads_per_run: maxLeadsPerRun(),
    query_count: 0,
    subreddit_count: 0,
    reddit_raw_count: 0,
    hn_raw_count: 0,
    raw_candidates: 0,
    deduped_count: 0,
    negative_filtered_count: 0,
    initially_scored_count: 0,
    sent_to_ai_qualification_count: 0,
    ai_qualified_count: 0,
    ai_rejected_count: 0,
    rules_qualified_count: 0,
    rejected_semantic_count: 0,
    final_candidates_count: 0,
    attempted_inserts: 0,
    inserted_count: 0,
    duplicate_count: 0,
    skipped_missing_required_fields_count: 0,
    threshold_used: null,
    reddit_mode: null,
    errors: [],
    rejected_examples: [],
    saved_examples: [],
    leads_found: 0,
  };
}

function assertDiagnosticsConsistency(diagnostics, options = {}) {
  const d = { ...(diagnostics || {}) };
  const errors = Array.isArray(d.errors) ? [...d.errors] : [];
  const cap = Number(d.max_leads_per_run) > 0 ? Number(d.max_leads_per_run) : maxLeadsPerRun();

  const inserted = Number(d.inserted_count) || 0;
  const raw = Number(d.raw_candidates) || 0;
  const deduped = Number(d.deduped_count) || 0;
  const initiallyScored = Number(d.initially_scored_count) || 0;
  const sentAi = Number(d.sent_to_ai_qualification_count) || 0;
  const qualified = Number(d.rules_qualified_count) || Number(d.ai_qualified_count) || 0;
  const finalCandidates = Number(d.final_candidates_count) || 0;

  if (inserted > cap) {
    errors.push(`Lead cap violated: inserted ${inserted}, max ${cap}`);
  }
  if (inserted > finalCandidates && finalCandidates > 0) {
    errors.push(`inserted_count (${inserted}) > final_candidates_count (${finalCandidates})`);
  }
  if (finalCandidates > qualified && qualified > 0) {
    errors.push(`final_candidates_count (${finalCandidates}) > qualified_count (${qualified})`);
  }
  if (sentAi > initiallyScored && initiallyScored > 0) {
    errors.push(
      `sent_to_ai_qualification_count (${sentAi}) > initially_scored_count (${initiallyScored})`
    );
  }
  if (initiallyScored > deduped && deduped > 0) {
    errors.push(`initially_scored_count (${initiallyScored}) > deduped_count (${deduped})`);
  }
  if (deduped > raw && raw > 0) {
    errors.push(`deduped_count (${deduped}) > raw_candidates (${raw})`);
  }
  if (inserted > 0 && raw === 0) {
    errors.push('inserted_count > 0 while raw_candidates is 0');
  }

  if (options.job_active && options.status === 'complete') {
    d.job_cleanup_warning =
      'Bull job was still marked active during worker completion (expected; cleaned up after).';
  }

  if (errors.length) {
    d.diagnostics_consistency_errors = errors;
    d.diagnostics_consistency_error = errors.join('; ');
  }

  d.leads_found = inserted;
  d.max_leads_per_run = cap;

  if (options.strict && errors.length) {
    throw new Error(errors.join('; '));
  }

  return d;
}

async function createScanRun(pool, keywordSet, searchBrief = {}, status = 'running') {
  const runStatus = ['queued', 'running', 'complete', 'failed'].includes(status)
    ? status
    : 'running';
  const { rows } = await pool.query(
    `INSERT INTO scan_runs (keyword_set_id, user_id, status, search_brief, diagnostics)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [
      keywordSet.id,
      keywordSet.user_id,
      runStatus,
      JSON.stringify(searchBrief || {}),
      JSON.stringify(createEmptyDiagnostics(null, searchBrief)),
    ]
  );
  const run = rows[0];
  const diagnostics = createEmptyDiagnostics(run.id, searchBrief);
  diagnostics.query_count = (searchBrief?.queries || keywordSet?.queries || []).length;
  diagnostics.subreddit_count = (searchBrief?.subreddits || keywordSet?.subreddits || []).length;
  await pool.query(
    `UPDATE scan_runs SET diagnostics = $2::jsonb WHERE id = $1`,
    [run.id, JSON.stringify(diagnostics)]
  );
  await pool.query(`UPDATE keyword_sets SET current_scan_run_id = $2 WHERE id = $1`, [
    keywordSet.id,
    run.id,
  ]);
  return { ...run, diagnostics };
}

async function deactivateStaleLeads(pool, keywordSetId, userId) {
  await pool.query(
    `UPDATE leads
     SET is_active = false
     WHERE keyword_set_id = $1
       AND user_id = $2
       AND COALESCE(is_active, true) = true
       AND seen = false`,
    [keywordSetId, userId]
  );
}

/** Remove partial leads for a scan run before the single final insert pass. */
async function purgeScanRunLeads(pool, scanRunId) {
  if (!pool || !scanRunId) return 0;
  const { rowCount } = await pool.query(`DELETE FROM leads WHERE scan_run_id = $1`, [scanRunId]);
  return rowCount || 0;
}

async function countActiveLeadsForScanRun(pool, scanRunId) {
  if (!pool || !scanRunId) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM leads
     WHERE scan_run_id = $1 AND COALESCE(is_active, true) = true`,
    [scanRunId]
  );
  return rows[0]?.c ?? 0;
}

async function updateScanRunDiagnostics(pool, scanRunId, patch) {
  if (!pool || !scanRunId) return;
  const { rows } = await pool.query(`SELECT diagnostics FROM scan_runs WHERE id = $1`, [
    scanRunId,
  ]);
  const current = rows[0]?.diagnostics || {};
  const merged = assertDiagnosticsConsistency({ ...current, ...patch, scan_run_id: scanRunId });
  await pool.query(`UPDATE scan_runs SET diagnostics = $2::jsonb WHERE id = $1`, [
    scanRunId,
    JSON.stringify(merged),
  ]);
  return merged;
}

async function finishScanRun(pool, scanRunId, status, diagnostics, errorMessage = null) {
  if (!pool || !scanRunId) return;
  const finalDiag = assertDiagnosticsConsistency(
    diagnostics || {},
    status === 'complete' ? { strict: true } : {}
  );
  await pool.query(
    `UPDATE scan_runs
     SET status = $2,
         completed_at = NOW(),
         diagnostics = $3::jsonb,
         error_message = $4
     WHERE id = $1`,
    [scanRunId, status, JSON.stringify(finalDiag), errorMessage]
  );
}

async function getScanRunForStatus(pool, keywordSet) {
  const runId = keywordSet?.current_scan_run_id;
  if (!runId || !pool) return null;
  const { rows } = await pool.query(`SELECT * FROM scan_runs WHERE id = $1`, [runId]);
  return rows[0] || null;
}

module.exports = {
  createEmptyDiagnostics,
  assertDiagnosticsConsistency,
  createScanRun,
  deactivateStaleLeads,
  purgeScanRunLeads,
  countActiveLeadsForScanRun,
  updateScanRunDiagnostics,
  finishScanRun,
  getScanRunForStatus,
};
