const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Scans for anything that should now have a task, and inserts one if it
// doesn't already exist for that exact trigger (ref_type + ref_id). Safe to
// call repeatedly - NOT EXISTS guards against duplicate inserts on refresh.
async function generateAutoTasks(farmerId) {
  // 1. Any event carrying a metadata.next_due_date that has now passed
  //    (works for vaccinations, dosing, checkups - anything recurring)
  await db.query(
    `INSERT INTO task (farmer_id, title, due_date, source, ref_type, ref_id)
     SELECT a.owner_id,
            e.event_type || ' follow-up due — ' || a.tag_number,
            (e.metadata->>'next_due_date')::date,
            'auto',
            'animal_event',
            e.event_id
     FROM animal_event e
     JOIN animal a ON a.animal_id = e.animal_id
     WHERE a.owner_id = $1
       AND a.status = 'Active'
       AND e.deleted_at IS NULL
       AND e.superseded_by IS NULL
       AND e.metadata->>'next_due_date' IS NOT NULL
       AND (e.metadata->>'next_due_date')::date <= CURRENT_DATE
       AND NOT EXISTS (
         SELECT 1 FROM task t WHERE t.ref_type = 'animal_event' AND t.ref_id = e.event_id
       )`,
    [farmerId]
  );

  // 2. Feed orders stuck in Requested for 5+ days
  await db.query(
    `INSERT INTO task (farmer_id, title, due_date, source, ref_type, ref_id)
     SELECT fo.farmer_id,
            'Feed order #' || fo.order_id || ' still Requested — follow up with supplier',
            CURRENT_DATE,
            'auto',
            'feed_order',
            fo.order_id
     FROM feed_order fo
     WHERE fo.farmer_id = $1
       AND fo.status = 'Requested'
       AND fo.created_at < now() - INTERVAL '5 days'
       AND NOT EXISTS (
         SELECT 1 FROM task t WHERE t.ref_type = 'feed_order' AND t.ref_id = fo.order_id
       )`,
    [farmerId]
  );

  // 3. Vet requests stuck Pending for 2+ days
  await db.query(
    `INSERT INTO task (farmer_id, title, due_date, source, ref_type, ref_id)
     SELECT vr.farmer_id,
            'Vet request still Pending — consider escalating',
            CURRENT_DATE,
            'auto',
            'vet_request',
            vr.request_id
     FROM vet_request vr
     WHERE vr.farmer_id = $1
       AND vr.status = 'Pending'
       AND vr.created_at < now() - INTERVAL '2 days'
       AND NOT EXISTS (
         SELECT 1 FROM task t WHERE t.ref_type = 'vet_request' AND t.ref_id = vr.request_id
       )`,
    [farmerId]
  );
}

// GET /api/v1/tasks?done=false
router.get('/', async (req, res, next) => {
  try {
    await generateAutoTasks(req.auth.user_id);

    const conditions = ['farmer_id = $1'];
    const params = [req.auth.user_id];

    if (req.query.done !== undefined) {
      params.push(req.query.done === 'true');
      conditions.push(`done = $${params.length}`);
    }

    const result = await db.query(
      `SELECT * FROM task WHERE ${conditions.join(' AND ')} ORDER BY due_date NULLS LAST, created_at DESC`,
      params
    );
    res.json({ tasks: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/tasks/suggested - computed, not stored: vaccinations overdue by 180+ days
router.get('/suggested', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT a.animal_id, a.tag_number,
              MAX(e.event_date) FILTER (WHERE e.event_type = 'Vaccinated') AS last_vaccinated
       FROM animal a
       LEFT JOIN animal_event e ON e.animal_id = a.animal_id
       WHERE a.owner_id = $1 AND a.status = 'Active'
       GROUP BY a.animal_id, a.tag_number
       HAVING MAX(e.event_date) FILTER (WHERE e.event_type = 'Vaccinated') IS NULL
           OR MAX(e.event_date) FILTER (WHERE e.event_type = 'Vaccinated') < (CURRENT_DATE - INTERVAL '180 days')`,
      [req.auth.user_id]
    );

    const suggestions = result.rows.map(r => ({
      tag_number: r.tag_number,
      message: r.last_vaccinated
        ? `Vaccination due (last: ${r.last_vaccinated.toISOString().slice(0, 10)})`
        : 'Never vaccinated on record',
    }));

    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/tasks
router.post('/', async (req, res, next) => {
  try {
    const { title, due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await db.query(
      `INSERT INTO task (farmer_id, title, due_date) VALUES ($1, $2, $3) RETURNING *`,
      [req.auth.user_id, title, due_date || null]
    );
    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/tasks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { title, due_date, done } = req.body;
    const result = await db.query(
      `UPDATE task SET
         title = COALESCE($1, title),
         due_date = COALESCE($2, due_date),
         done = COALESCE($3, done)
       WHERE task_id = $4 AND farmer_id = $5
       RETURNING *`,
      [title, due_date, done, req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM task WHERE task_id = $1 AND farmer_id = $2 RETURNING task_id',
      [req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
