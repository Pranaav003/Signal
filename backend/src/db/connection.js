const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const needsSsl =
  process.env.DB_SSL === 'true' ||
  connectionString?.includes('neon.tech') ||
  connectionString?.includes('pooler.neon.tech') ||
  process.env.NODE_ENV === 'production';

const ssl = needsSsl ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString,
  ssl,
});

pool
  .query('SELECT 1')
  .then(() => {
    console.log('✓ Database connected');
  })
  .catch((err) => {
    console.error(err);
  });

module.exports = pool;
