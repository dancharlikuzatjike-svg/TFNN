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
  const phones = [process.env.ADMIN_PHONES, process.env.ADMIN_PHONES_EXTRA].filter(Boolean).join(',').split(',').map((p) => p.replace(/\D/g, '').slice(-9)).filter((p) => p.length === 9);
  if (phones.length) {
    const r = await pool.query(
      `UPDATE users SET role = 'admin', approved = true, active = true
       WHERE right(regexp_replace(phone, '\\D', '', 'g'), 9) = ANY($1) AND role <> 'admin'
       RETURNING user_id`, [phones]);
    console.log(`ADMIN_PHONES: promoted ${r.rowCount} account(s) to admin (${phones.length} number(s) listed).`);
  }

  // One-time data loads. Each runs once per database and is then recorded in app_seed,
  // so prices an admin later changes or removes are never put back by a restart.
  await pool.query('CREATE TABLE IF NOT EXISTS app_seed (name VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMP DEFAULT now())');
  // Skipped under NODE_ENV=test so the automated tests always start with no market prices.
  for (const seed of process.env.NODE_ENV === 'test' ? [] : SEEDS) {
    const claimed = await pool.query('INSERT INTO app_seed (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name', [seed.name]);
    if (!claimed.rowCount) continue;
    const n = await seed.run(pool);
    console.log(`Seed ${seed.name}: ${n} row(s) added.`);
  }

  await pool.end();
}

// Starting market reference prices (N$ per head): LABTA auction averages from the LLPB weekly
// reports of August 2026, times a typical live weight. A class that already has a market
// price is left alone.
const MARKET_PRICES_AUG_2026 = [
  ['Cattle', 'Cow', 13667, 'Cows Medium N$30.37/kg x 450 kg, auctions 25-28 Aug 2026'],
  ['Cattle', 'Bull', 23436, 'Slaughter Bulls N$33.48/kg x 700 kg, auctions 25-28 Aug 2026'],
  ['Cattle', 'Heifer', 11295, 'Store Heifers N$32.27/kg x 350 kg, auctions 25-28 Aug 2026'],
  ['Cattle', 'Steer', 14612, 'Store Oxen N$36.53/kg x 400 kg, auctions 25-28 Aug 2026'],
  ['Cattle', 'Calf', 6941, 'Tollies/Heifers Mix N$31.55/kg x 220 kg, auctions 25-28 Aug 2026'],
  ['Sheep', 'Ewe', 1997, 'Slaughter Sheep Dorper N$39.93/kg x 50 kg, auctions 11-14 Aug 2026'],
  ['Sheep', 'Ram', 2795, 'Slaughter Sheep Dorper N$39.93/kg x 70 kg, auctions 11-14 Aug 2026'],
  ['Sheep', 'Wether', 1797, 'Slaughter Sheep Dorper N$39.93/kg x 45 kg, auctions 11-14 Aug 2026'],
  ['Sheep', 'Lamb', 1398, 'Slaughter Sheep Dorper N$39.93/kg x 35 kg, auctions 11-14 Aug 2026'],
  ['Goat', 'Doe', 1405, 'Goat N$1,405 per head, LLPB report 24 Aug 2026'],
  ['Goat', 'Buck', 1405, 'Goat N$1,405 per head, LLPB report 24 Aug 2026'],
  ['Goat', 'Wether', 1405, 'Goat N$1,405 per head, LLPB report 24 Aug 2026'],
];
const SEEDS = [
  {
    name: 'market-prices-aug-2026',
    run: async (pool) => {
      let added = 0;
      for (const [species, cls, price, source] of MARKET_PRICES_AUG_2026) {
        const r = await pool.query(
          'INSERT INTO reference_price (species, class, price, source) VALUES ($1, $2, $3, $4) ON CONFLICT (species, class) DO NOTHING',
          [species, cls, price, 'LLPB weekly report: ' + source]);
        added += r.rowCount;
      }
      return added;
    },
  },
];

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
