require('../config/loadEnv');

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const needsSsl =
  process.env.DB_SSL === 'true' ||
  connectionString.includes('neon.tech') ||
  connectionString.includes('pooler.neon.tech') ||
  process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function main() {
  const { rows } = await pool.query('SELECT NOW() AS now');
  console.log('✓ Database connected');
  console.log('database time:', rows[0].now);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Database connection failed:', err.message || err);
  process.exit(1);
});
