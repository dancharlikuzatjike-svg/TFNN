require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');

  console.log('Applying schema.sql...');
  await pool.query(sql);
  console.log('Done. Tables created (or already existed).');

  // Owner accounts: phone numbers listed in ADMIN_PHONES (comma separated) become admins.
  // Matched on the last 9 digits so 0814254801 and +264814254801 are the same person.
  const phones = (process.env.ADMIN_PHONES || '').split(',').map((p) => p.replace(/\D/g, '').slice(-9)).filter((p) => p.length === 9);
  if (phones.length) {
    const r = await pool.query(
      `UPDATE users SET role = 'admin', approved = true, active = true
       WHERE right(regexp_replace(phone, '\\D', '', 'g'), 9) = ANY($1) AND role <> 'admin'
       RETURNING user_id`, [phones]);
    console.log(`ADMIN_PHONES: promoted ${r.rowCount} account(s) to admin (${phones.length} number(s) listed).`);
  }

  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
