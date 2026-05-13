require('dotenv').config();

const { initWorker } = require('./scanJob');
const { initTrackerWorker } = require('./trackerJob');

/** Repeatable enqueue runs from the HTTP service (`index.js` → `startScheduler`). */

initWorker();
initTrackerWorker();

console.log('✓ Signal worker started');
