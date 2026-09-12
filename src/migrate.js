require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sqlDirectory = path.join(__dirname, '..', 'sql');
  const migrationFiles = fs.readdirSync(sqlDirectory)
    .filter(file => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(sqlDirectory, file), 'utf8');
    console.log(`Applying ${file}...`);
    await pool.query(sql);
  }

  console.log(`Done. Applied ${migrationFiles.length} SQL file(s).`);
  await pool.end();
}

migrate().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
