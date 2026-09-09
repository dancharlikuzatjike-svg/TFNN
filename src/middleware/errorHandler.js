// Catches errors passed via next(err) from any route and returns a clean JSON response.
// Never leak raw DB/stack details to the client - log them, respond generically.
function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === '23505') {
    // Postgres unique_violation - e.g. duplicate tag_number for the same farmer
    return res.status(409).json({ error: 'That record already exists.' });
  }
  if (err.code === '23503') {
    // Postgres foreign_key_violation - referenced row doesn't exist
    return res.status(400).json({ error: 'Referenced record was not found.' });
  }

  const status = err.status || 500;
  const message = status === 500 ? 'Something went wrong on our end.' : err.message;
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
