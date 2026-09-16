const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const VALID_ROLES = ['farmer', 'admin', 'supplier', 'vet'];

// GET /api/v1/admin/animals?farmer_id=&species=
router.get('/animals', async (req, res, next) => {
  try {
    const { farmer_id, species } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (farmer_id) { params.push(farmer_id); conditions.push(`owner_id = $${params.length}`); }
    if (species) { params.push(species); conditions.push(`species = $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM animal WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ animals: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/stats - aggregate counts only, never individual farmer detail here
router.get('/stats', async (req, res, next) => {
  try {
    const [herd, orders, requests] = await Promise.all([
      db.query(`SELECT species, COUNT(*)::int AS count FROM animal WHERE status = 'Active' GROUP BY species`),
      db.query(`SELECT status, COUNT(*)::int AS count FROM feed_order GROUP BY status`),
      db.query(`SELECT urgency, status, COUNT(*)::int AS count FROM vet_request GROUP BY urgency, status`),
    ]);
    res.json({
      herd_by_species: herd.rows,
      orders_by_status: orders.rows,
      vet_requests_by_urgency_and_status: requests.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, phone, role, farm_location, district, active, approved, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/users/pending - accounts awaiting approval (supplier/vet signups)
router.get('/users/pending', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT user_id, name, phone, role, farm_location, created_at
       FROM users WHERE approved = false ORDER BY created_at ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/admin/users/:id - suspend/reactivate, approve, or change role
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { active, approved, role } = req.body;
    if (active === undefined && approved === undefined && role === undefined) {
      return res.status(400).json({ error: 'At least one of active, approved, or role is required' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const result = await db.query(
      `UPDATE users SET
         active = COALESCE($1, active),
         approved = COALESCE($2, approved),
         role = COALESCE($3, role)
       WHERE user_id = $4
       RETURNING user_id, name, phone, role, farm_location, active, approved`,
      [active, approved, role, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
