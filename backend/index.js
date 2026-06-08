require('./src/config/loadEnv');

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

if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const isDev = process.env.NODE_ENV !== 'production';

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function withWwwAliases(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  const aliases = new Set([normalized]);
  try {
    const url = new URL(normalized);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      aliases.add(url.toString().replace(/\/$/, ''));
    } else {
      url.hostname = `www.${url.hostname}`;
      aliases.add(url.toString().replace(/\/$/, ''));
    }
  } catch {
    /* ignore invalid URL */
  }
  return [...aliases];
}

const allowedOrigins = new Set(
  [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://signal-frontend-e4oa.onrender.com',
    process.env.FRONTEND_URL,
    ...(process.env.CORS_EXTRA_ORIGINS || '').split(','),
  ]
    .flatMap((entry) => withWwwAliases(entry))
    .filter(Boolean)
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const normalized = normalizeOrigin(origin);
    if (normalized && allowedOrigins.has(normalized)) {
      return callback(null, true);
    }

    if (/^https:\/\/signal-frontend-[a-z0-9-]+\.onrender\.com$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(helmet());
app.use(express.json());

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

app.use(selectRateLimiter);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'signal-backend',
    message: 'Signal backend is running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'signal-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    redisConfigured: Boolean(process.env.REDIS_URL),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    trustProxy: app.get('trust proxy'),
  });
});

app.use('/api', apiRouter);
app.use('/api/users', usersRouter);
app.use('/api/keyword-sets', keywordSetsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/tracked-replies', trackedRepliesRouter);
app.use('/api/debug', debugRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error('[backend] unhandled error:', err);

  if (err.message && err.message.startsWith('CORS blocked origin:')) {
    return res.status(403).json({
      error: 'cors_blocked',
      message: err.message,
    });
  }

  res.status(err.status || 500).json({
    error: err.code || 'internal_server_error',
    message:
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
});

const server = app.listen(port, () => {
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

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[api] Port ${port} is already in use. Stop the other process (lsof -i :${port}) or run only one API instance.`
    );
    process.exit(1);
  }
  console.error('[api] Server error:', err);
  process.exit(1);
});
