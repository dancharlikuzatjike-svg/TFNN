const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SEVERITIES = ['Advisory', 'Warning', 'Emergency'];

// GET /api/v1/alerts?district= - any authenticated user, active alerts only
router.get('/', async (req, res, next) => {
  try {
    const { district } = req.query;
    const conditions = [`status = 'Active'`, `(expires_at IS NULL OR expires_at > now())`];
    const params = [];

    if (district) { params.push(district); conditions.push(`district = $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM district_alert WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/alerts - vet or admin only
router.post('/', requireRole('vet', 'admin'), async (req, res, next) => {
  try {
    const { district, title, description, severity, expires_at } = req.body;
    if (!district || !title) {
      return res.status(400).json({ error: 'district and title are required' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }

    const result = await db.query(
      `INSERT INTO district_alert (district, title, description, severity, expires_at, posted_by)
       VALUES ($1, $2, $3, COALESCE($4, 'Advisory'), $5, $6) RETURNING *`,
      [district, title, description || null, severity || null, expires_at || null, req.auth.user_id]
    );
    res.status(201).json({ alert: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/alerts/:id - original poster or an admin can edit/resolve early
router.patch('/:id', requireRole('vet', 'admin'), async (req, res, next) => {
  try {
    const { title, description, severity, status, expires_at } = req.body;
    if (status && !['Active', 'Resolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be Active or Resolved' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }

    const existing = await db.query('SELECT * FROM district_alert WHERE alert_id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });
    if (existing.rows[0].posted_by !== req.auth.user_id && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'Only the original poster or an admin can edit this alert' });
    }

    const result = await db.query(
      `UPDATE district_alert SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         severity = COALESCE($3, severity),
         status = COALESCE($4, status),
         expires_at = COALESCE($5, expires_at)
       WHERE alert_id = $6 RETURNING *`,
      [title, description, severity, status, expires_at, req.params.id]
    );
    res.json({ alert: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
