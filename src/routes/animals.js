const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CLASS_OPTIONS = {
  Cattle: { Female: ['Cow', 'Heifer', 'Heifer calf', 'Calf'], Male: ['Bull', 'Bull calf', 'Steer', 'Ox', 'Calf'] },
  Sheep: { Female: ['Ewe', 'Ewe lamb', 'Lamb'], Male: ['Ram', 'Ram lamb', 'Wether', 'Lamb'] },
  Goat: { Female: ['Doe', 'Doe kid', 'Kid'], Male: ['Buck', 'Buck kid', 'Wether', 'Kid'] }
};
const BREEDING_CLASS = { Cattle: 'Bull', Sheep: 'Ram', Goat: 'Buck' };

function inferredSex(species, animalClass, suppliedSex) {
  if (suppliedSex) return suppliedSex;
  if (CLASS_OPTIONS[species]?.Male.includes(animalClass) && !CLASS_OPTIONS[species]?.Female.includes(animalClass)) return 'Male';
  if (CLASS_OPTIONS[species]?.Female.includes(animalClass) && !CLASS_OPTIONS[species]?.Male.includes(animalClass)) return 'Female';
  return null;
}

function validateAnimalFields(record) {
  if (!CLASS_OPTIONS[record.species]) throw Object.assign(new Error('species must be Cattle, Sheep or Goat'), { status: 400 });
  if (record.sex && !['Male', 'Female'].includes(record.sex)) throw Object.assign(new Error('sex must be Male or Female'), { status: 400 });
  const sex = inferredSex(record.species, record.class, record.sex);
  if (record.class && ![...CLASS_OPTIONS[record.species].Male, ...CLASS_OPTIONS[record.species].Female].includes(record.class)) {
    throw Object.assign(new Error(`${record.class} is not a valid ${record.species} class`), { status: 400 });
  }
  if (record.class && sex && !CLASS_OPTIONS[record.species][sex].includes(record.class)) {
    throw Object.assign(new Error(`${record.class} does not match ${record.species} and ${sex}`), { status: 400 });
  }
  if (record.class === BREEDING_CLASS[record.species] && sex !== 'Male') {
    throw Object.assign(new Error(`${record.class} must be recorded as Male`), { status: 400 });
  }
  if (record.condition_score != null && (Number(record.condition_score) < 1 || Number(record.condition_score) > 5)) {
    throw Object.assign(new Error('condition_score must be between 1 and 5'), { status: 400 });
  }
  if (record.date_of_birth && new Date(record.date_of_birth) > new Date()) {
    throw Object.assign(new Error('date_of_birth cannot be in the future'), { status: 400 });
  }
  return { ...record, sex };
}

async function validateParents({ ownerId, animalId, species, motherId, fatherId }) {
  const ids = [...new Set([motherId, fatherId].filter(Boolean).map(Number))];
  if (!ids.length) return;
  if (motherId && fatherId && Number(motherId) === Number(fatherId)) throw Object.assign(new Error('mother_id and father_id cannot be the same animal'), { status: 400 });
  if (animalId && ids.includes(Number(animalId))) throw Object.assign(new Error('An animal cannot be its own parent'), { status: 400 });

  const result = await db.query(
    'SELECT animal_id, species, sex, class, status FROM animal WHERE owner_id = $1 AND animal_id = ANY($2::int[])',
    [ownerId, ids]
  );
  if (result.rows.length !== ids.length) throw Object.assign(new Error('Every parent must belong to the signed-in farmer'), { status: 400 });

  const mother = result.rows.find((row) => Number(row.animal_id) === Number(motherId));
  const father = result.rows.find((row) => Number(row.animal_id) === Number(fatherId));
  if (mother && (mother.species !== species || inferredSex(mother.species, mother.class, mother.sex) !== 'Female')) {
    throw Object.assign(new Error('The dam must be a female of the same species'), { status: 400 });
  }
  if (father && (father.species !== species || father.class !== BREEDING_CLASS[species] || inferredSex(father.species, father.class, father.sex) !== 'Male')) {
    throw Object.assign(new Error('The sire must be a confirmed Bull, Ram or Buck of the same species'), { status: 400 });
  }
  if ((mother && mother.status !== 'Active') || (father && father.status !== 'Active')) {
    throw Object.assign(new Error('Only active animals can be selected as parents'), { status: 400 });
  }

  if (animalId) {
    for (const parentId of ids) {
      const circular = await db.query(
        `WITH RECURSIVE descendants AS (
           SELECT animal_id FROM animal WHERE mother_id = $1 OR father_id = $1
           UNION ALL
           SELECT a.animal_id FROM animal a JOIN descendants d ON a.mother_id = d.animal_id OR a.father_id = d.animal_id
         ) SELECT 1 FROM descendants WHERE animal_id = $2 LIMIT 1`,
        [animalId, parentId]
      );
      if (circular.rows.length) throw Object.assign(new Error('That parent choice would create a circular pedigree'), { status: 400 });
    }
  }
}

async function findOwnedAnimal(animalId, ownerId) {
  const result = await db.query('SELECT * FROM animal WHERE animal_id = $1 AND owner_id = $2', [animalId, ownerId]);
  return result.rows[0];
}

// GET /api/v1/animals?status=&species=&class=
router.get('/', async (req, res, next) => {
  try {
    const { status, species, class: animalClass } = req.query;
    const conditions = ['owner_id = $1'];
    const params = [req.auth.user_id];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (species) { params.push(species); conditions.push(`species = $${params.length}`); }
    if (animalClass) { params.push(animalClass); conditions.push(`class = $${params.length}`); }
    const result = await db.query(`SELECT * FROM animal WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ animals: result.rows });
  } catch (error) { next(error); }
});

// POST /api/v1/animals
router.post('/', async (req, res, next) => {
  try {
    if (!req.body.tag_number || !req.body.species) return res.status(400).json({ error: 'tag_number and species are required' });
    const record = validateAnimalFields(req.body);
    await validateParents({ ownerId: req.auth.user_id, species: record.species, motherId: record.mother_id, fatherId: record.father_id });
    const result = await db.query(
      `INSERT INTO animal
       (tag_number, name, species, sex, breed, class, date_of_birth, owner_id, mother_id, father_id, status, stock_brand, registration_status, health_status, condition_score, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [record.tag_number, record.name || null, record.species, record.sex, record.breed || null, record.class || null,
       record.date_of_birth || null, req.auth.user_id, record.mother_id || null, record.father_id || null,
       record.status || 'Active', record.stock_brand || null, record.registration_status || 'Registered',
       record.health_status || 'Healthy', record.condition_score || null, record.notes || null]
    );
    res.status(201).json({ animal: result.rows[0] });
  } catch (error) { next(error); }
});

// GET /api/v1/animals/:id
router.get('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });
    const eventStats = await db.query(
      `SELECT COUNT(*)::int AS event_count, MAX(event_date) FILTER (WHERE event_type = 'Vaccinated') AS last_vaccinated FROM animal_event WHERE animal_id = $1`,
      [animal.animal_id]
    );
    res.json({ animal, ...eventStats.rows[0] });
  } catch (error) { next(error); }
});

// PATCH /api/v1/animals/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });
    const combined = validateAnimalFields({ ...animal, ...req.body });
    await validateParents({ ownerId: req.auth.user_id, animalId: animal.animal_id, species: combined.species, motherId: combined.mother_id, fatherId: combined.father_id });

    const allowedFields = ['tag_number', 'name', 'species', 'sex', 'breed', 'class', 'date_of_birth', 'mother_id', 'father_id', 'status', 'stock_brand', 'registration_status', 'health_status', 'condition_score', 'notes'];
    const updates = [];
    const params = [];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined || (field === 'sex' && combined.sex !== animal.sex)) {
        params.push(field === 'sex' ? combined.sex : req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields provided to update' });
    params.push(animal.animal_id);
    const result = await db.query(`UPDATE animal SET ${updates.join(', ')}, updated_at = now() WHERE animal_id = $${params.length} RETURNING *`, params);
    res.json({ animal: result.rows[0] });
  } catch (error) { next(error); }
});

// DELETE /api/v1/animals/:id - soft delete only.
router.delete('/:id', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });
    await db.query(`UPDATE animal SET status = 'Deceased', updated_at = now() WHERE animal_id = $1`, [animal.animal_id]);
    res.status(204).send();
  } catch (error) { next(error); }
});

router.get('/:id/events', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });
    const result = await db.query('SELECT * FROM animal_event WHERE animal_id = $1 ORDER BY event_date DESC', [animal.animal_id]);
    res.json({ events: result.rows });
  } catch (error) { next(error); }
});

router.get('/:id/lineage', async (req, res, next) => {
  try {
    const animal = await findOwnedAnimal(req.params.id, req.auth.user_id);
    if (!animal) return res.status(404).json({ error: 'Animal not found' });
    const result = await db.query(
      `WITH RECURSIVE lineage AS (
         SELECT animal_id, tag_number, mother_id, father_id, 0 AS depth FROM animal WHERE animal_id = $1 AND owner_id = $2
         UNION ALL
         SELECT a.animal_id, a.tag_number, a.mother_id, a.father_id, l.depth + 1
         FROM animal a JOIN lineage l ON a.animal_id IN (l.mother_id, l.father_id)
         WHERE l.depth < 5 AND a.owner_id = $2
       ) SELECT * FROM lineage`,
      [animal.animal_id, req.auth.user_id]
    );
    res.json({ lineage: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
