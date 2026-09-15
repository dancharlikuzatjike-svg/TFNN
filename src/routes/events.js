const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const EVENT_TYPES = ['Born', 'Vaccinated', 'Sick / Treated', 'Fed', 'Sold', 'Died', 'Bought', 'Moved Farm', 'Ownership Transferred', 'Other'];

// GET /api/v1/events?tag=&type=&from=&to=&include_deleted=
router.get('/', async (req, res, next) => {
  try {
    const { tag, type, from, to, include_deleted } = req.query;
    const conditions = ['a.owner_id = $1', 'e.superseded_by IS NULL'];
    const params = [req.auth.user_id];

    if (!(include_deleted === 'true' && req.auth.role === 'admin')) {
      conditions.push('e.deleted_at IS NULL');
    }

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
// client_id makes a retried offline write safe: if this exact event was already
// logged, the same row is returned instead of a duplicate being created.
router.post('/', async (req, res, next) => {
  try {
    const { animal_id, event_date, event_type, notes, metadata, client_id } = req.body;

    if (!animal_id || !event_date || !event_type) {
      return res.status(400).json({ error: 'animal_id, event_date and event_type are required' });
    }
    if (!EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` });
    }

    if (client_id) {
      const existing = await db.query('SELECT * FROM animal_event WHERE client_id = $1', [client_id]);
      if (existing.rows.length > 0) {
        return res.status(200).json({ event: existing.rows[0] });
      }
    }

    // Confirm the animal actually belongs to this farmer before logging anything against it
    const owned = await db.query('SELECT 1 FROM animal WHERE animal_id = $1 AND owner_id = $2', [animal_id, req.auth.user_id]);
    if (owned.rows.length === 0) {
      return res.status(404).json({ error: 'Animal not found' });
    }

    const result = await db.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [animal_id, event_date, event_type, notes || null, metadata ? JSON.stringify(metadata) : null, req.auth.user_id, client_id || null]
    );
    res.status(201).json({ event: result.rows[0] });
  } catch (err) {
    if (err.code === '23505' && req.body.client_id) {
      const existing = await db.query('SELECT * FROM animal_event WHERE client_id = $1', [req.body.client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ event: existing.rows[0] });
    }
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

// GET /api/v1/events/:id/history - full correction chain for an event, oldest first
router.get('/:id/history', async (req, res, next) => {
  try {
    const owned = await db.query(
      `SELECT e.event_id FROM animal_event e
       JOIN animal a ON a.animal_id = e.animal_id
       WHERE e.event_id = $1 AND a.owner_id = $2`,
      [req.params.id, req.auth.user_id]
    );
    if (owned.rows.length === 0) return res.status(404).json({ error: 'Event not found' });

    const result = await db.query(
      `WITH RECURSIVE chain AS (
         SELECT * FROM animal_event WHERE event_id = $1
         UNION
         SELECT e.* FROM animal_event e
           JOIN chain c ON e.event_id = c.superseded_by OR e.superseded_by = c.event_id
       )
       SELECT DISTINCT * FROM chain ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/events/:id - corrects an event non-destructively: the old row is
// marked superseded (never overwritten) and a new row is inserted with the fix.
// client_id makes a retried correction idempotent: if it already went through,
// this short-circuits and returns that same corrected event.
router.patch('/:id', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { event_date, event_type, notes, metadata, client_id } = req.body;
    if (event_type && !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` });
    }

    if (client_id) {
      const already = await client.query('SELECT * FROM animal_event WHERE client_id = $1', [client_id]);
      if (already.rows.length > 0) {
        return res.status(200).json({ event: already.rows[0] });
      }
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT e.* FROM animal_event e
       JOIN animal a ON a.animal_id = e.animal_id
       WHERE e.event_id = $1 AND a.owner_id = $2 AND e.deleted_at IS NULL AND e.superseded_by IS NULL
       FOR UPDATE`,
      [req.params.id, req.auth.user_id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found, already corrected, or deleted' });
    }
    const old = existing.rows[0];

    const inserted = await client.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        old.animal_id,
        event_date || old.event_date,
        event_type || old.event_type,
        notes !== undefined ? notes : old.notes,
        metadata !== undefined ? JSON.stringify(metadata) : old.metadata,
        req.auth.user_id,
        client_id || null,
      ]
    );

    await client.query('UPDATE animal_event SET superseded_by = $1 WHERE event_id = $2', [inserted.rows[0].event_id, old.event_id]);

    await client.query('COMMIT');
    res.json({ event: inserted.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && req.body.client_id) {
      const already = await client.query('SELECT * FROM animal_event WHERE client_id = $1', [req.body.client_id]);
      if (already.rows.length > 0) {
        return res.status(200).json({ event: already.rows[0] });
      }
    }
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/v1/events/:id - admin only, soft delete so the record is never truly lost
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.query(
      'UPDATE animal_event SET deleted_at = now() WHERE event_id = $1 AND deleted_at IS NULL RETURNING event_id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
