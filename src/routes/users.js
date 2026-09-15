const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Namibia's 14 regions - kept as a fixed list so district-based grouping
// (market prices, alerts) stays reliable rather than matching free text.
const DISTRICTS = [
  'Erongo', 'Hardap', 'ǁKaras', 'Kavango East', 'Kavango West', 'Khomas',
  'Kunene', 'Ohangwena', 'Omaheke', 'Omusati', 'Oshana', 'Oshikoto',
  'Otjozondjupa', 'Zambezi'
];

// GET /api/v1/users/me
router.get('/me', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, phone, role, farm_location, district FROM users WHERE user_id = $1',
      [req.auth.user_id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/users/me - self-service profile update, including district
router.patch('/me', async (req, res, next) => {
  try {
    const { name, farm_location, district } = req.body;
    if (district && !DISTRICTS.includes(district)) {
      return res.status(400).json({ error: `district must be one of: ${DISTRICTS.join(', ')}` });
    }

    const result = await db.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         farm_location = COALESCE($2, farm_location),
         district = COALESCE($3, district)
       WHERE user_id = $4
       RETURNING user_id, name, phone, role, farm_location, district`,
      [name || null, farm_location || null, district || null, req.auth.user_id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
