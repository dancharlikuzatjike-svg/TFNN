const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/tasks?done=false
router.get('/', async (req, res, next) => {
  try {
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
