/**
 * Render free web service entrypoint — exposes /health while running the real Bull worker.
 * Not for local dev by default; use `npm run worker` or `npm run dev:worker` locally.
 */
const express = require('express');

require('./src/config/loadEnv');

const app = express();

let workerStarted = false;
let workerStartError = null;
let workerStartupPhase = 'pending';
const startedAt = new Date().toISOString();

app.get('/health', (req, res) => {
  res.json({
    ok: workerStarted && !workerStartError,
    service: 'signal-worker-web',
    mode: 'bull-worker-inside-render-web-service',
    workerStarted,
    workerStartupPhase,
    workerStartError: workerStartError
      ? String(workerStartError.message || workerStartError)
      : null,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    redisConfigured: Boolean(process.env.REDIS_URL),
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    upstashRestConfigured: Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    proxyConfigured: Boolean(
      process.env.PROXY_LIST &&
        (process.env.PROXY_USERNAMES || process.env.PROXY_USERNAME) &&
        process.env.PROXY_PASSWORD
    ),
  });
});

app.get('/', (req, res) => {
  res.send('Signal worker web service is running. See /health.');
});

// Render sets PORT per service. Locally, set WORKER_WEB_PORT=3002 if backend/.env defines PORT=3001.
const PORT = Number(process.env.WORKER_WEB_PORT || process.env.PORT || 3002);

app.listen(PORT, async () => {
  console.log(`[worker-web] health server listening on ${PORT}`);

  try {
    workerStartupPhase = 'starting';
    const { startWorker } = require('./src/jobs/worker');
    await startWorker();
    workerStarted = true;
    workerStartupPhase = 'ready';
    console.log('[worker-web] Bull worker started successfully');
  } catch (err) {
    workerStartError = err;
    workerStartupPhase = 'failed';
    console.error('[worker-web] failed to start worker:', err);
  }
});

process.on('SIGTERM', () => {
  console.log('[worker-web] SIGTERM received, shutting down');
  process.exit(0);
});
