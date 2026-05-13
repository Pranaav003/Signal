const express = require('express');
const fs = require('fs');

const router = express.Router();

const RATE_LIMIT_FLAG = '/tmp/signal_rate_limited';

router.get('/reddit', (req, res) => {
  try {
    const raw = fs.readFileSync(RATE_LIMIT_FLAG, 'utf8');
    const ts = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(ts)) {
      const secondsAgo = (Date.now() - ts) / 1000;
      if (secondsAgo < 120) {
        return res.json({
          rate_limited: true,
          seconds_ago: Math.floor(secondsAgo),
        });
      }
    }
  } catch (_e) {
    // missing or unreadable file → not rate limited
  }
  return res.json({ rate_limited: false });
});

module.exports = router;
