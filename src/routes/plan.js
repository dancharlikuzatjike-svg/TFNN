const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normaliseSpecies } = require('../utils/herdValue');
const { SPECIES, planForMonth, planForYear } = require('../utils/yearPlan');

const router = express.Router();
router.use(requireAuth);

// The species this farmer keeps that the year plan covers (Cattle, Sheep, Goat).
async function farmerSpecies(farmerId) {
  const r = await db.query(
    `SELECT DISTINCT species FROM animal WHERE owner_id = $1 AND status = 'Active' AND species IS NOT NULL`,
    [farmerId]
  );
  const found = new Set(r.rows.map((x) => normaliseSpecies(x.species)).filter((s) => SPECIES.includes(s)));
  return { species: SPECIES.filter((s) => found.has(s)), hasAnimals: r.rows.length > 0 };
}

// GET /api/v1/plan
// The whole year for the species on this farm. A farm with no animals yet gets the plan for all
// three species, so a new farmer can see what TFNN offers before adding the herd.
router.get('/', async (req, res, next) => {
  try {
    const { species, hasAnimals } = await farmerSpecies(req.auth.user_id);
    const use = species.length ? species : (hasAnimals ? [] : SPECIES);
    res.json({
      species,
      has_herd: hasAnimals,
      showing_all: species.length === 0 && !hasAnimals,
      months: planForYear(use),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/plan/add-month   body: { month?: 1-12 }  (default: this month)
// Puts that month's jobs for this farm's species into the Tasks list, due on the last day of the
// month. Safe to repeat: a job already added for that month is not added again.
router.post('/add-month', async (req, res, next) => {
  try {
    const nowMonth = new Date().getUTCMonth() + 1;
    const month = req.body && req.body.month !== undefined ? Number(req.body.month) : nowMonth;
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be a number from 1 to 12' });
    }
    const { species } = await farmerSpecies(req.auth.user_id);
    if (!species.length) {
      return res.json({ month, added: [], note: 'Add cattle, sheep or goats to your herd to get your plan.' });
    }

    // A month already past means next year
    const year = new Date().getUTCFullYear() + (month < nowMonth ? 1 : 0);
    const due = await db.query(`SELECT (make_date($1::int, $2::int, 1) + INTERVAL '1 month - 1 day')::date AS due`, [year, month]);
    const dueDate = due.rows[0].due;

    const added = [];
    for (const item of planForMonth(month, species)) {
      const title = item.title.slice(0, 150);
      const r = await db.query(
        `INSERT INTO task (farmer_id, title, due_date, source)
         SELECT $1::int, $2::varchar, $3::date, 'plan'
         WHERE NOT EXISTS (SELECT 1 FROM task WHERE farmer_id = $1::int AND source = 'plan' AND title = $2::varchar AND due_date = $3::date)
         RETURNING task_id, title`,
        [req.auth.user_id, title, dueDate]
      );
      if (r.rows.length) added.push(r.rows[0].title);
    }
    res.json({ month, due: dueDate, added });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
