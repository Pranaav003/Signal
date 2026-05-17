/** Build a user-facing line when a scan finished with 0 leads. */
export function formatZeroLeadsDiagnostic(data) {
  const d = data?.diagnostics || data?.scan_progress || {};
  const inserted = Number(d.inserted_count ?? d.leads_saved ?? data?.leads_found ?? 0);
  if (inserted > 0) return null;

  if (d.reddit_auth_error) {
    return 'Reddit blocked or rate-limited requests. Set REDDIT_USER_AGENT in backend/.env (public JSON API, no OAuth).';
  }

  const raw = Number(d.collected_raw ?? 0);
  const deduped = Number(d.deduped_count ?? 0);
  const survivors = Number(d.survivors_count ?? 0);
  const threshold = d.threshold_used ?? '?';
  const duplicates = Number(d.duplicate_count ?? 0);

  if (raw === 0) {
    if (Number(d.reddit_error_count || 0) > 0) {
      return `Reddit returned 0 raw results (${d.reddit_error_count} errors). ${d.last_reddit_error || 'Set REDDIT_USER_AGENT and restart the worker.'}`;
    }
    return 'Reddit returned 0 raw results. Restart backend worker and run: cd backend && npm run test:reddit';
  }
  if (deduped === 0) {
    return 'Reddit returned results but none had valid post IDs after dedupe.';
  }
  if (survivors === 0 && deduped > 0) {
    return `Reddit returned ${raw} raw / ${deduped} deduped, but 0 passed scoring threshold ${threshold}.`;
  }
  if (survivors > 0 && duplicates > 0 && inserted === 0) {
    return `${survivors} passed scoring but all were duplicates already in the database.`;
  }
  if (d.last_reddit_error) {
    return `Reddit errors occurred: ${d.last_reddit_error}`;
  }
  if (data?.scan_progress?.message) {
    return String(data.scan_progress.message);
  }
  return 'Scan finished with 0 new leads. Check worker logs for details.';
}
