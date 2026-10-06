const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const DISTRICTS = require('../utils/districts');
const { sendEmailConfirmation, inBackground } = require('../utils/notify');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/users/me
router.get('/me', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, phone, email, email_opt_out, role, farm_location, district FROM users WHERE user_id = $1',
      [req.auth.user_id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/users/me - self-service profile update, including district, email and email opt-out.
// Send email: "" to remove the address.
router.patch('/me', async (req, res, next) => {
  try {
    const { name, farm_location, district, email_opt_out } = req.body;
    const rawEmail = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : undefined;
    if (district && !DISTRICTS.includes(district)) {
      return res.status(400).json({ error: `district must be one of: ${DISTRICTS.join(', ')}` });
    }
    if (rawEmail && (rawEmail.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))) {
      return res.status(400).json({ error: 'email does not look valid' });
    }
    if (email_opt_out !== undefined && typeof email_opt_out !== 'boolean') {
      return res.status(400).json({ error: 'email_opt_out must be true or false' });
    }

    const before = await db.query('SELECT email FROM users WHERE user_id = $1', [req.auth.user_id]);
    const clearEmail = rawEmail === '';

    const result = await db.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         farm_location = COALESCE($2, farm_location),
         district = COALESCE($3, district),
         email = CASE WHEN $6 THEN NULL ELSE COALESCE($4, email) END,
         email_opt_out = COALESCE($7, email_opt_out)
       WHERE user_id = $5
       RETURNING user_id, name, phone, email, email_opt_out, role, farm_location, district`,
      [name || null, farm_location || null, district || null, rawEmail || null, req.auth.user_id, clearEmail, email_opt_out === undefined ? null : email_opt_out]
    );
    const user = result.rows[0];

    // New or changed address -> send a confirmation so the farmer knows it works
    if (user.email && user.email !== (before.rows[0] && before.rows[0].email)) {
      inBackground('EMAIL CONFIRM', () => sendEmailConfirmation(user));
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/users/lookup?phone= - find another farmer's user_id by phone number.
// Used for marketplace: a seller calls the buyer, then looks them up to record the sale.
// Deliberately returns only what's needed to complete that - no other profile data.
router.get('/lookup', async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const result = await db.query(
      `SELECT user_id, name FROM users WHERE phone = $1 AND role = 'farmer' AND active = true AND approved = true`,
      [phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No active farmer found with that phone number' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
