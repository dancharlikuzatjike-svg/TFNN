const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/animals?status=&species=&class=
router.get('/', async (req, res, next) => {
  try {
    const { status, species, class: cls } = req.query;
    const conditions = ['owner_id = $1'];
    const params = [req.auth.user_id];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (species) { params.push(species); conditions.push(`species = $${params.length}`); }
    if (cls) { params.push(cls); conditions.push(`class = $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM animal WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ animals: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/animals
// Accepts an optional client_id (UUID generated on-device) so a retried offline
// write never creates a duplicate animal - it just returns the one already made.
router.post('/', async (req, res, next) => {
  try {
    const { tag_number, species, breed, class: cls, date_of_birth, mother_id, father_id, client_id } = req.body;

    if (!tag_number || !species) {
      return res.status(400).json({ error: 'tag_number and species are required' });
    }

    if (client_id) {
      const existing = await db.query('SELECT * FROM animal WHERE client_id = $1', [client_id]);
      if (existing.rows.length > 0) {
        return res.status(200).json({ animal: existing.rows[0] });
      }
    }

    const result = await db.query(
      `INSERT INTO animal (tag_number, species, breed, class, date_of_birth, owner_id, mother_id, father_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [tag_number, species, breed || null, cls || null, date_of_birth || null,
       req.auth.user_id, mother_id || null, father_id || null, client_id || null]
    );
    res.status(201).json({ animal: result.rows[0] });
  } catch (err) {
    // A racing duplicate retry can hit the unique index instead of the check above
    if (err.code === '23505' && req.body.client_id) {
      const existing = await db.query('SELECT * FROM animal WHERE client_id = $1', [req.body.client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ animal: existing.rows[0] });
    }
    next(err);
  }
});

// Shared helper: fetch an animal only if it belongs to the current farmer
async function findOwnedAnimal(animalId, ownerId) {
  const result = await db.query('SELECT * FROM animal WHERE animal_id = $1 AND owner_id = $2', [animalId, ownerId]);
  return result.rows[0];
}

// GET /api/v1/animals/:id
router.get('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });

    const eventStats = await db.query(
      `SELECT COUNT(*)::int AS event_count,
              MAX(event_date) FILTER (WHERE event_type = 'Vaccinated') AS last_vaccinated
       FROM animal_event WHERE animal_id = $1`,
      [animal.animal_id]
    );

    res.json({ animal, ...eventStats.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/animals/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });

    const allowedFields = ['tag_number', 'species', 'breed', 'class', 'date_of_birth', 'mother_id', 'father_id', 'status', 'estimated_value'];
    const updates = [];
    const params = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' });
    }

    params.push(animal.animal_id);
    const result = await db.query(
      `UPDATE animal SET ${updates.join(', ')} WHERE animal_id = $${params.length} RETURNING *`,
      params
    );
    res.json({ animal: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/animals/:id  - soft delete only, history is never erased
router.delete('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });

    await db.query(`UPDATE animal SET status = 'Deceased' WHERE animal_id = $1`, [animal.animal_id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/animals/:id/events
router.get('/:id/events', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });

    const result = await db.query(
      'SELECT * FROM animal_event WHERE animal_id = $1 ORDER BY event_date DESC',
      [animal.animal_id]
    );
    res.json({ events: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/animals/:id/lineage - walks mother/father chain up to 5 generations
router.get('/:id/lineage', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });

    const result = await db.query(
      `WITH RECURSIVE lineage AS (
         SELECT animal_id, tag_number, mother_id, father_id, 0 AS depth FROM animal WHERE animal_id = $1
         UNION ALL
         SELECT a.animal_id, a.tag_number, a.mother_id, a.father_id, l.depth + 1
         FROM animal a
         JOIN lineage l ON a.animal_id IN (l.mother_id, l.father_id)
         WHERE l.depth < 5
       )
       SELECT * FROM lineage`,
      [animal.animal_id]
    );
    res.json({ lineage: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/animals/:id/transfer-ownership
// Moves an animal to a new farmer and logs it as an Ownership Transferred event
// in the same transaction, so the animal row and the event history can never disagree.
// client_id covers the whole action: retrying with the same client_id after a
// dropped connection just returns the transfer that already happened.
router.post('/:id/transfer-ownership', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { new_owner_id, notes, client_id } = req.body;
    if (!new_owner_id) {
      return res.status(400).json({ error: 'new_owner_id is required' });
    }

    if (client_id) {
      const already = await client.query('SELECT animal_id FROM animal_event WHERE client_id = $1', [client_id]);
      if (already.rows.length > 0) {
        const animalNow = await client.query('SELECT * FROM animal WHERE animal_id = $1', [already.rows[0].animal_id]);
        return res.status(200).json({ animal: animalNow.rows[0] });
      }
    }

    await client.query('BEGIN');

    // Admins can transfer any animal; farmers can only transfer animals they currently own
    const animalQuery = req.auth.role === 'admin'
      ? await client.query('SELECT * FROM animal WHERE animal_id = $1 FOR UPDATE', [req.params.id])
      : await client.query('SELECT * FROM animal WHERE animal_id = $1 AND owner_id = $2 FOR UPDATE', [req.params.id, req.auth.user_id]);

    if (animalQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Animal not found' });
    }
    const animal = animalQuery.rows[0];

    if (animal.owner_id === Number(new_owner_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Animal already belongs to that owner' });
    }

    const newOwner = await client.query(
      `SELECT user_id FROM users WHERE user_id = $1 AND role = 'farmer' AND active = true`,
      [new_owner_id]
    );
    if (newOwner.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'new_owner_id must be an active farmer account' });
    }

    const oldOwnerId = animal.owner_id;

    const updated = await client.query(
      `UPDATE animal SET owner_id = $1 WHERE animal_id = $2 RETURNING *`,
      [new_owner_id, animal.animal_id]
    );

    await client.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by, client_id)
       VALUES ($1, CURRENT_DATE, 'Ownership Transferred', $2, $3, $4, $5)`,
      [
        animal.animal_id,
        notes || null,
        JSON.stringify({ from_owner_id: oldOwnerId, to_owner_id: Number(new_owner_id) }),
        req.auth.user_id,
        client_id || null,
      ]
    );

    await client.query('COMMIT');
    res.json({ animal: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && err.constraint === 'idx_event_client_id' && req.body.client_id) {
      const already = await client.query('SELECT animal_id FROM animal_event WHERE client_id = $1', [req.body.client_id]);
      if (already.rows.length > 0) {
        const animalNow = await client.query('SELECT * FROM animal WHERE animal_id = $1', [already.rows[0].animal_id]);
        return res.status(200).json({ animal: animalNow.rows[0] });
      }
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'The new owner already has an animal with this tag number' });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
