const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { BREEDING_FEMALE, YOUNG_CLASS } = require('../utils/herdValue');

const sqlList = (names) => names.map((n) => `'${n}'`).join(',');

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

// POST /api/v1/tasks/weekly-round
// Adds this week's farm round (Monday to Sunday) from what is on the herd. It is safe to call
// any number of times: a task already added for this week is not added again.
router.post('/weekly-round', async (req, res, next) => {
  try {
    const owner = req.auth.user_id;
    const herd = await db.query(
      `SELECT
         COALESCE(SUM(head_count) FILTER (WHERE class IN (${sqlList(BREEDING_FEMALE)})), 0)::int AS females,
         COALESCE(SUM(head_count) FILTER (WHERE class IN (${sqlList(YOUNG_CLASS)})), 0)::int AS young
       FROM animal WHERE owner_id = $1 AND status = 'Active'`, [owner]);
    const unvaccinated = await db.query(
      `SELECT COALESCE(SUM(a.head_count), 0)::int AS n FROM animal a
       WHERE a.owner_id = $1 AND a.status = 'Active'
         AND NOT EXISTS (SELECT 1 FROM animal_event e
                         WHERE e.animal_id = a.animal_id AND e.event_type = 'Vaccinated'
                           AND e.deleted_at IS NULL AND e.event_date >= CURRENT_DATE - 180)`, [owner]);
    const week = await db.query(`SELECT (date_trunc('week', CURRENT_DATE) + INTERVAL '6 days')::date AS due`);
    const due = week.rows[0].due;

    const { females, young } = herd.rows[0];
    const vacc = unvaccinated.rows[0].n;
    const titles = [
      'Walk the herd: count the animals and look for any sick or injured',
      'Check water and feed for the week',
    ];
    if (females > 0) titles.push('Check females close to giving birth; have a clean, dry place ready');
    if (young > 0) titles.push('Check young animals are feeding and growing well');
    if (vacc > 0) titles.push(`Vaccinations due for ${vacc} animal${vacc === 1 ? '' : 's'} (none in the last 6 months)`);

    const added = [];
    for (const title of titles) {
      const r = await db.query(
        `INSERT INTO task (farmer_id, title, due_date, source)
         SELECT $1::int, $2::varchar, $3::date, 'weekly'
         WHERE NOT EXISTS (SELECT 1 FROM task WHERE farmer_id = $1::int AND source = 'weekly' AND title = $2::varchar AND due_date = $3::date)
         RETURNING task_id, title`,
        [owner, title.slice(0, 150), due]
      );
      if (r.rows.length) added.push(r.rows[0].title);
    }
    res.json({ due, added });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/tasks
// client_id makes a retried offline write safe: the same task is returned
// instead of being created twice. (Auto-generated tasks already dedupe via
// ref_type/ref_id in generateAutoTasks above, so they don't need this.)
router.post('/', async (req, res, next) => {
  try {
    const { title, due_date, client_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    if (client_id) {
      const existing = await db.query('SELECT * FROM task WHERE client_id = $1', [client_id]);
      if (existing.rows.length > 0) {
        return res.status(200).json({ task: existing.rows[0] });
      }
    }

    const result = await db.query(
      `INSERT INTO task (farmer_id, title, due_date, client_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.auth.user_id, title, due_date || null, client_id || null]
    );
    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    if (err.code === '23505' && req.body.client_id) {
      const existing = await db.query('SELECT * FROM task WHERE client_id = $1', [req.body.client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ task: existing.rows[0] });
    }
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
module.exports.generateAutoTasks = generateAutoTasks;
