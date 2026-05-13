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

const { startScheduler } = require('./src/jobs/scheduler');
const { startTrackerScheduler } = require('./src/jobs/trackerJob');

const app = express();
const port = Number(process.env.PORT) || 3001;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
});

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
app.use(limiter);

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

app.use((err, req, res, _next) => {
  console.error(err && err.message ? err.message : err)
  res.status(500).json({ error: err && err.message ? err.message : 'Internal Server Error' })
})

app.listen(port, () => {
  console.log(`Signal backend running on port ${port}`);

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
