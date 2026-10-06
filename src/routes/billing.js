const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PRICING, membershipFor } = require('../utils/pricing');

const router = express.Router();
router.use(requireAuth);

const instructions = () => process.env.PAYMENT_INSTRUCTIONS || '';

// GET /api/v1/billing/me - my membership status, what I owe, and how to pay
router.get('/me', async (req, res, next) => {
  try {
    const r = await db.query(
      'SELECT user_id, role, phone, paid_until, trial_ends, reg_fee_paid_on, payment_claimed_at FROM users WHERE user_id = $1',
      [req.auth.user_id]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const m = await membershipFor(u);
    res.json({
      membership: m,
      pricing: { marketplace_fee_percent: PRICING().marketplace_fee_percent },
      how_to_pay: { instructions: instructions() || null, reference: u.phone },
      payment_claimed_at: u.payment_claimed_at,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/billing/claim - "I've paid": flags the account for the admin to check
router.post('/claim', async (req, res, next) => {
  try {
    await db.query('UPDATE users SET payment_claimed_at = now() WHERE user_id = $1', [req.auth.user_id]);
    res.json({ ok: true, message: 'Thanks. We will confirm your payment shortly.' });
  } catch (err) { next(err); }
});

module.exports = router;
