require('dotenv').config();

const { initWorker } = require('./scanJob');

/** Repeatable enqueue runs from the HTTP service (`index.js` → `startScheduler`). */

initWorker();

console.log('✓ Signal worker started');
