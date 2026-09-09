const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyOnCallVets } = require('../utils/notify');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/vets?service_area=&specialty=&on_call=true
router.get('/vets', async (req, res, next) => {
  try {
    const { service_area, specialty, on_call } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (service_area) { params.push(`%${service_area}%`); conditions.push(`v.service_area ILIKE $${params.length}`); }
    if (specialty) { params.push(specialty); conditions.push(`v.specialty = $${params.length}`); }
    if (on_call !== undefined) { params.push(on_call === 'true'); conditions.push(`v.on_call = $${params.length}`); }

    const result = await db.query(
      `SELECT u.user_id, u.name, u.phone, v.service_area, v.specialty, v.on_call
       FROM vet_profile v JOIN users u ON u.user_id = v.vet_id
       WHERE ${conditions.join(' AND ')}`,
      params
    );
    res.json({ vets: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/vets/me/availability - vet only
router.patch('/vets/me/availability', requireRole('vet'), async (req, res, next) => {
  try {
    const { on_call } = req.body;
    if (on_call === undefined) return res.status(400).json({ error: 'on_call is required' });

    const result = await db.query(
      `INSERT INTO vet_profile (vet_id, on_call) VALUES ($1, $2)
       ON CONFLICT (vet_id) DO UPDATE SET on_call = $2
       RETURNING *`,
      [req.auth.user_id, on_call]
    );
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------- Requests ----------

// POST /api/v1/vet-requests
router.post('/vet-requests', requireRole('farmer'), async (req, res, next) => {
  try {
    const { animal_id, urgency, phone, notes } = req.body;
    if (!urgency || !phone) {
      return res.status(400).json({ error: 'urgency and phone are required' });
    }
    if (!['Routine', 'Urgent', 'Emergency'].includes(urgency)) {
      return res.status(400).json({ error: 'urgency must be Routine, Urgent or Emergency' });
    }

    const result = await db.query(
      `INSERT INTO vet_request (farmer_id, animal_id, urgency, phone, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.auth.user_id, animal_id || null, urgency, phone, notes || null]
    );
    const request = result.rows[0];

    // Fire-and-forget: page every on-call vet matching the farmer's area/species.
    // Failure here should never block the request from being created.
    notifyOnCallVets(request).catch(err => console.error('notifyOnCallVets failed', err));

    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/vet-requests - farmer: own requests; vet: pending + assigned-to-them
router.get('/vet-requests', async (req, res, next) => {
  try {
    let result;
    if (req.auth.role === 'vet') {
      result = await db.query(
        `SELECT * FROM vet_request WHERE status = 'Pending' OR vet_id = $1 ORDER BY created_at DESC`,
        [req.auth.user_id]
      );
    } else {
      result = await db.query(
        `SELECT * FROM vet_request WHERE farmer_id = $1 ORDER BY created_at DESC`,
        [req.auth.user_id]
      );
    }
    res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/vet-requests/:id
// vet: claim with { status: "Assigned" }, then resolve with { status: "Resolved", resolution_notes }
router.patch('/vet-requests/:id', requireRole('vet'), async (req, res, next) => {
  try {
    const { status, resolution_notes } = req.body;
    const existing = await db.query('SELECT * FROM vet_request WHERE request_id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = existing.rows[0];

    if (status === 'Assigned') {
      if (request.status !== 'Pending') {
        return res.status(409).json({ error: 'This request has already been claimed' });
      }
      const result = await db.query(
        `UPDATE vet_request SET status = 'Assigned', vet_id = $1 WHERE request_id = $2 RETURNING *`,
        [req.auth.user_id, request.request_id]
      );
      return res.json({ request: result.rows[0] });
    }

    if (status === 'Resolved') {
      if (request.vet_id !== req.auth.user_id) {
        return res.status(403).json({ error: 'Only the assigned vet can resolve this request' });
      }
      const result = await db.query(
        `UPDATE vet_request SET status = 'Resolved', resolution_notes = $1, resolved_at = now()
         WHERE request_id = $2 RETURNING *`,
        [resolution_notes || null, request.request_id]
      );

      // Side-effect: auto-log a "Sick / Treated" event on the animal's diary, if one was named
      if (request.animal_id) {
        await db.query(
          `INSERT INTO animal_event (animal_id, event_date, event_type, notes, created_by)
           VALUES ($1, CURRENT_DATE, 'Sick / Treated', $2, $3)`,
          [request.animal_id, resolution_notes || 'Resolved via vet on-call request', req.auth.user_id]
        );
      }

      return res.json({ request: result.rows[0] });
    }

    return res.status(400).json({ error: 'status must be Assigned or Resolved' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
