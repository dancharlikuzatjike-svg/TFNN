const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // A stray idle-client error should never crash the whole process
  console.error('Unexpected database error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
