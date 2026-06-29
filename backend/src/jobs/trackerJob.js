/**
 * Reply tracker scheduler — simplified from Bull queue to setInterval.
 */
const { refreshAllTrackedReplies } = require('../services/redditTracker');

const TRACKER_INTERVAL_MS = 2 * 3600 * 1000; // 2 hours

let trackerTimer = null;

async function startTrackerScheduler() {
  try {
    await refreshAllTrackedReplies();
  } catch (err) {
    console.error('[tracker] initial refresh failed:', err?.message || err);
  }

  trackerTimer = setInterval(async () => {
    try {
      await refreshAllTrackedReplies();
    } catch (err) {
      console.error('[tracker] refresh failed:', err?.message || err);
    }
  }, TRACKER_INTERVAL_MS);

  if (trackerTimer.unref) trackerTimer.unref();

  console.log('✓ Reply tracker scheduler: every 2 hours');
}

function stopTrackerScheduler() {
  if (trackerTimer) {
    clearInterval(trackerTimer);
    trackerTimer = null;
  }
}

module.exports = {
  startTrackerScheduler,
  stopTrackerScheduler,
};
