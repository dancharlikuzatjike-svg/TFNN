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
router.post('/', async (req, res, next) => {
  try {
    const { tag_number, species, breed, class: cls, date_of_birth, mother_id, father_id } = req.body;

    if (!tag_number || !species) {
      return res.status(400).json({ error: 'tag_number and species are required' });
    }

    const result = await db.query(
      `INSERT INTO animal (tag_number, species, breed, class, date_of_birth, owner_id, mother_id, father_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tag_number, species, breed || null, cls || null, date_of_birth || null,
       req.auth.user_id, mother_id || null, father_id || null]
    );
    res.status(201).json({ animal: result.rows[0] });
  } catch (err) {
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

    const allowedFields = ['tag_number', 'species', 'breed', 'class', 'date_of_birth', 'mother_id', 'father_id', 'status'];
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

module.exports = router;
