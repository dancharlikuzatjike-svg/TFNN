const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const MAX_ATTEMPTS = 5;

const hashCode = (code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(code)).digest('hex');

// Makes a fresh 6-digit code for a user and cancels any earlier unused one.
async function createResetCode(userId, { ttlMinutes, createdBy = null }) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query('UPDATE password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const r = await db.query(
    `INSERT INTO password_reset (user_id, code_hash, expires_at, created_by)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4) RETURNING expires_at`,
    [userId, hashCode(code), String(ttlMinutes), createdBy]
  );
  return { code, expires_at: r.rows[0].expires_at };
}

// Sets a new password if the code is right. Returns true or false, and never says why it failed.
async function redeemResetCode(phone, code, newPassword) {
  const found = await db.query(
    `SELECT p.reset_id, p.code_hash, p.attempts, u.user_id
     FROM password_reset p JOIN users u ON u.user_id = p.user_id
     WHERE u.phone = $1 AND u.active = true AND p.used_at IS NULL AND p.expires_at > now()
     ORDER BY p.created_at DESC LIMIT 1`, [phone]);
  const row = found.rows[0];
  if (!row) return false;

  const given = Buffer.from(hashCode(String(code).trim()));
  const right = crypto.timingSafeEqual(given, Buffer.from(row.code_hash));
  if (!right) {
    // After too many wrong tries the code is dead and a new one must be requested
    await db.query(
      `UPDATE password_reset SET attempts = attempts + 1,
         used_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE used_at END
       WHERE reset_id = $1`, [row.reset_id, MAX_ATTEMPTS]);
    return false;
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE user_id = $2', [password_hash, row.user_id]);
  await db.query('UPDATE password_reset SET used_at = now() WHERE reset_id = $1', [row.reset_id]);
  return true;
}

module.exports = { createResetCode, redeemResetCode, MAX_ATTEMPTS };
