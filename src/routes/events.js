const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EVENT_TYPES = ['Born', 'Vaccinated', 'Sick / Treated', 'Fed', 'Sold', 'Died', 'Bought', 'Moved Farm', 'Other'];

// GET /api/v1/events?tag=&type=&from=&to=
router.get('/', async (req, res, next) => {
  try {
    const { tag, type, from, to } = req.query;
    const conditions = ['a.owner_id = $1'];
    const params = [req.auth.user_id];

    if (tag) { params.push(tag); conditions.push(`a.tag_number = $${params.length}`); }
    if (type) { params.push(type); conditions.push(`e.event_type = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`e.event_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`e.event_date <= $${params.length}`); }

    const result = await db.query(
      `SELECT e.*, a.tag_number FROM animal_event e
       JOIN animal a ON a.animal_id = e.animal_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.event_date DESC`,
      params
    );
    res.json({ events: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/events
router.post('/', async (req, res, next) => {
  try {
    const { animal_id, event_date, event_type, notes } = req.body;

    if (!animal_id || !event_date || !event_type) {
      return res.status(400).json({ error: 'animal_id, event_date and event_type are required' });
    }
    if (!EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` });
    }

    // Confirm the animal actually belongs to this farmer before logging anything against it
    const owned = await db.query('SELECT 1 FROM animal WHERE animal_id = $1 AND owner_id = $2', [animal_id, req.auth.user_id]);
    if (owned.rows.length === 0) {
      return res.status(404).json({ error: 'Animal not found' });
    }

    const result = await db.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [animal_id, event_date, event_type, notes || null, req.auth.user_id]
    );
    res.status(201).json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT e.*, a.tag_number FROM animal_event e
       JOIN animal a ON a.animal_id = e.animal_id
       WHERE e.event_id = $1 AND a.owner_id = $2`,
      [req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/events/:id - notes only; date/type/animal are never rewritten, only added to
router.patch('/:id', async (req, res, next) => {
  try {
    if (req.body.notes === undefined) {
      return res.status(400).json({ error: 'Only notes can be updated on an existing event' });
    }

    const result = await db.query(
      `UPDATE animal_event e SET notes = $1
       FROM animal a
       WHERE e.event_id = $2 AND e.animal_id = a.animal_id AND a.owner_id = $3
       RETURNING e.*`,
      [req.body.notes, req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/events/:id - admin only, for correcting genuine mistakes
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM animal_event WHERE event_id = $1 RETURNING event_id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
