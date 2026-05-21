const pool = require('../db/connection');
const {
  manualScanQueue,
  scanQueue,
  manualScanJobId,
} = require('../jobs/scanJob');

async function cancelJobsForKeywordSet(keywordSetId) {
  const jobId = manualScanJobId(keywordSetId);
  let removed = 0;

  for (const queue of [manualScanQueue, scanQueue]) {
    try {
      const job = await queue.getJob(jobId);
      if (job) {
        await job.remove();
        removed += 1;
      }
    } catch (_e) {
      /* ignore */
    }
  }

  try {
    const repeatable = await scanQueue.getRepeatableJobs();
    const repeatId = `scan-${keywordSetId}`;
    for (const rj of repeatable) {
      if (rj.id === repeatId) {
        await scanQueue.removeRepeatableByKey(rj.key);
        removed += 1;
      }
    }
  } catch (_e) {
    /* ignore */
  }

  return removed;
}

/**
 * Soft-delete monitor and hide associated leads (transaction).
 */
async function deleteMonitorForUser(keywordSetId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ks = await client.query(
      `SELECT id, user_id FROM keyword_sets WHERE id = $1 AND user_id = $2`,
      [keywordSetId, userId]
    );
    if (!ks.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404 };
    }

    await client.query(
      `UPDATE keyword_sets
       SET active = false,
           deleted_at = NOW(),
           scan_progress = COALESCE(scan_progress, '{}'::jsonb) || $3::jsonb
       WHERE id = $1 AND user_id = $2`,
      [
        keywordSetId,
        userId,
        JSON.stringify({
          phase: 'cancelled',
          message: 'Monitor deleted',
          completed_at: new Date().toISOString(),
        }),
      ]
    );

    const leadsResult = await client.query(
      `UPDATE leads
       SET is_active = false,
           deleted_at = NOW()
       WHERE keyword_set_id = $1 AND user_id = $2
         AND COALESCE(is_active, true) = true
       RETURNING id`,
      [keywordSetId, userId]
    );

    const runsResult = await client.query(
      `UPDATE scan_runs
       SET status = 'cancelled',
           completed_at = COALESCE(completed_at, NOW()),
           error_message = 'Monitor deleted'
       WHERE keyword_set_id = $1
         AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING id`,
      [keywordSetId]
    );

    await client.query('COMMIT');

    const jobsRemoved = await cancelJobsForKeywordSet(keywordSetId);

    return {
      ok: true,
      deleted_monitor_id: keywordSetId,
      hidden_leads_count: leadsResult.rowCount || 0,
      cancelled_scan_runs_count: runsResult.rowCount || 0,
      jobs_removed: jobsRemoved,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  deleteMonitorForUser,
  cancelJobsForKeywordSet,
};
