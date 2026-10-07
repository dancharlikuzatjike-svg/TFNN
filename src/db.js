const { Pool, types } = require('pg');
// Return DATE columns as plain 'YYYY-MM-DD' text so a date never shifts by a day with the server's time zone
types.setTypeParser(1082, (v) => v);

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
