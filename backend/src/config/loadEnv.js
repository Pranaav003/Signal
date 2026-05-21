const path = require('path');

/** Load backend/.env regardless of process cwd (API, worker, scripts). */
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {};
