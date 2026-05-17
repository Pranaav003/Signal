require('dotenv').config();

require('./src/db/connection');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const apiRouter = require('./src/routes');
const usersRouter = require('./src/routes/users');
const keywordSetsRouter = require('./src/routes/keywordSets');
const leadsRouter = require('./src/routes/leads');
const trackedRepliesRouter = require('./src/routes/trackedReplies');
const debugRouter = require('./src/routes/debug');

const { startScheduler } = require('./src/jobs/scheduler');
const { initWorker } = require('./src/jobs/scanJob');
const { startTrackerScheduler, initTrackerWorker } = require('./src/jobs/trackerJob');

const app = express();
const port = Number(process.env.PORT) || 3001;

const isDev = process.env.NODE_ENV !== 'production';

function rateLimitJsonHandler(message = 'Too many requests. Please wait and try again.') {
  return (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message,
      retryAfter: req.rateLimit?.resetTime ?? null,
    });
  };
}

function isPollingReadRoute(req) {
  if (req.method !== 'GET') return false;
  const path = req.path || '';
  return (
    /^\/api\/keyword-sets\/[^/]+\/scan-status$/.test(path) ||
    /^\/api\/leads\/user\/[^/]+$/.test(path)
  );
}

const pollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isDev ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  handler: rateLimitJsonHandler('Polling too frequently. Please wait and try again.'),
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isDev ? 2000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isPollingReadRoute(req),
  handler: rateLimitJsonHandler(),
});

function selectRateLimiter(req, res, next) {
  if (isPollingReadRoute(req)) {
    return pollingLimiter(req, res, next);
  }
  return globalLimiter(req, res, next);
}

app.use(helmet());
app.use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? true
        : process.env.FRONTEND_URL || 'http://localhost:5173',
  })
);
app.use(express.json());
app.use(selectRateLimiter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'signal',
    timestamp: new Date(),
  });
});

app.use('/api', apiRouter);
app.use('/api/users', usersRouter);
app.use('/api/keyword-sets', keywordSetsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/tracked-replies', trackedRepliesRouter);
app.use('/api/debug', debugRouter);

app.use((err, req, res, _next) => {
  console.error(err && err.message ? err.message : err);
  res.status(500).json({ error: err && err.message ? err.message : 'Internal Server Error' });
});

app.listen(port, () => {
  console.log(`Signal backend running on port ${port}`);

  if (process.env.SKIP_EMBEDDED_WORKERS !== 'true') {
    initWorker();
    initTrackerWorker();
    console.log('✓ Embedded queue workers (scan + reply tracker)');
  }

  startScheduler().catch((err) => {
    console.error(
      'Scheduler bootstrap failed:',
      err && err.message ? err.message : err
    );
  });

  startTrackerScheduler().catch((err) => {
    console.error(
      'Reply tracker scheduler failed:',
      err && err.message ? err.message : err
    );
  });
});
