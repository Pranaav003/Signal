require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const pool = require('./connection');

async function main() {
  const sqlPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  try {
    await pool.query(sql);
    console.log('✓ Migration complete');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
