const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parsePriceRows, herdTotals, ADULT_CLASS, BREEDING_FEMALE, YOUNG_CLASS, adultOf } = require('../utils/herdValue');

// Turns a list of class names into SQL: 'Cow','Ewe',...
const sqlList = (names) => names.map((n) => `'${n}'`).join(',');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/valuation?from=&to=
// from/to filter the sales-income and expenses totals (a time window, e.g. this quarter).
// Live animal value is always the current snapshot, since it isn't a flow over time.
router.get('/', async (req, res, next) => {
  try {
    const { from, to } = req.query;

    // Each animal is valued by its own figure, else the farmer's class price, else the market reference price.
    const live = await herdTotals(req.auth.user_id);

    const salesConditions = ['seller_id = $1', 'deleted_at IS NULL', `payment_status != 'Cancelled'`];
    const salesParams = [req.auth.user_id];
    if (from) { salesParams.push(from); salesConditions.push(`sale_date >= $${salesParams.length}`); }
    if (to) { salesParams.push(to); salesConditions.push(`sale_date <= $${salesParams.length}`); }

    const salesIncome = await db.query(
      `SELECT COUNT(*)::int AS sale_count, COALESCE(SUM(price), 0)::numeric AS total_sales_income
       FROM sale WHERE ${salesConditions.join(' AND ')}`,
      salesParams
    );

    const expenseConditions = ['farmer_id = $1', 'deleted_at IS NULL'];
    const expenseParams = [req.auth.user_id];
    if (from) { expenseParams.push(from); expenseConditions.push(`expense_date >= $${expenseParams.length}`); }
    if (to) { expenseParams.push(to); expenseConditions.push(`expense_date <= $${expenseParams.length}`); }

    const expenses = await db.query(
      `SELECT COUNT(*)::int AS expense_count, COALESCE(SUM(amount), 0)::numeric AS total_expenses
       FROM expense WHERE ${expenseConditions.join(' AND ')}`,
      expenseParams
    );

    const totalSalesIncome = Number(salesIncome.rows[0].total_sales_income);
    const totalExpenses = Number(expenses.rows[0].total_expenses);

    res.json({
      live_herd: {
        animal_count: live.animal_count,
        total_estimated_value: Number(live.total),
        unpriced_count: live.unpriced_count,
        market_priced_count: live.market_priced_count,
        assumed_class_count: live.assumed_class_count,
      },
      period: { from: from || null, to: to || null },
      sales: {
        sale_count: salesIncome.rows[0].sale_count,
        total_sales_income: totalSalesIncome,
      },
      expenses: {
        expense_count: expenses.rows[0].expense_count,
        total_expenses: totalExpenses,
      },
      net_cash_position: totalSalesIncome - totalExpenses,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/valuation/prices
// One row per species + class in the farmer's active herd (plus any class they have
// already priced): how many animals, their own price per head, and the market reference price.
router.get('/prices', async (req, res, next) => {
  try {
    const result = await db.query(
      `WITH herd AS (
         SELECT species, COALESCE(class, '') AS class, COALESCE(SUM(head_count), 0)::int AS animal_count,
                COUNT(*) FILTER (WHERE estimated_value IS NOT NULL)::int AS own_value_count
         FROM animal WHERE owner_id = $1 AND status = 'Active'
         GROUP BY species, COALESCE(class, '')
       ),
       keys AS (
         SELECT species, class FROM herd
         UNION
         SELECT species, class FROM class_price WHERE owner_id = $1
       )
       SELECT k.species, k.class,
              COALESCE(h.animal_count, 0) AS animal_count,
              COALESCE(h.own_value_count, 0) AS own_value_count,
              cp.price AS price,
              cpa.price AS adult_price,
              rp.price AS market_price, rp.source AS market_source, rp.updated_at AS market_updated_at
       FROM keys k
       LEFT JOIN herd h ON h.species = k.species AND h.class = k.class
       LEFT JOIN class_price cp ON cp.owner_id = $1 AND cp.species = k.species AND cp.class = k.class
       LEFT JOIN class_price cpa ON k.class = '' AND cpa.owner_id = $1 AND cpa.species = k.species
            AND cpa.class = ${adultOf('k.species')}
       LEFT JOIN reference_price rp ON rp.species = k.species
            AND rp.class = COALESCE(NULLIF(k.class, ''), ${adultOf('k.species')})
       ORDER BY k.species, k.class`,
      [req.auth.user_id]
    );
    const num = (v) => (v == null ? null : Number(v));
    // For the "no class" row: assumed_class is the adult class it is valued as, and adult_price
    // is the farmer's own price for that class (used when they set no price for the row itself).
    res.json({ prices: result.rows.map((p) => ({
      ...p, price: num(p.price), market_price: num(p.market_price), adult_price: num(p.adult_price),
      assumed_class: p.class === '' ? ADULT_CLASS[p.species] : null,
    })) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/valuation/prices   body: { prices: [{ species, class, price }] }
// Sets the farmer's own price per head for a class. price null (or '') removes it,
// so that class falls back to the market reference price.
router.put('/prices', async (req, res, next) => {
  try {
    const parsed = parsePriceRows(req.body && req.body.prices);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    for (const p of parsed.rows) {
      if (p.price === null) {
        await db.query('DELETE FROM class_price WHERE owner_id = $1 AND species = $2 AND class = $3', [req.auth.user_id, p.species, p.class]);
      } else {
        await db.query(
          `INSERT INTO class_price (owner_id, species, class, price) VALUES ($1, $2, $3, $4)
           ON CONFLICT (owner_id, species, class) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
          [req.auth.user_id, p.species, p.class, p.price]);
      }
    }
    res.json({ saved: parsed.rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/valuation/performance?from=&to=
// A simple herd scorecard for a time window, built only from what TFNN already records:
// births and deaths (animal events), sales, expenses and the current herd.
// Breeding females are the animals classed Cow, Ewe or Doe. Animals with no class are
// not counted there, because they could be males.
router.get('/performance', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const owner = req.auth.user_id;

    const herd = await db.query(
      `SELECT
         COALESCE(SUM(head_count) FILTER (WHERE status = 'Active'), 0)::int AS active_count,
         COALESCE(SUM(head_count) FILTER (WHERE status = 'Active' AND class IN (${sqlList(BREEDING_FEMALE)})), 0)::int AS breeding_females,
         COALESCE(SUM(head_count) FILTER (WHERE status = 'Active' AND class IN (${sqlList(YOUNG_CLASS)})), 0)::int AS young_active
       FROM animal WHERE owner_id = $1`, [owner]);

    const eventWindow = ['e.deleted_at IS NULL', 'a.owner_id = $1'];
    const params = [owner];
    if (from) { params.push(from); eventWindow.push(`e.event_date >= $${params.length}`); }
    if (to) { params.push(to); eventWindow.push(`e.event_date <= $${params.length}`); }

    const events = await db.query(
      `SELECT
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Born'), 0)::int AS births,
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Died'), 0)::int AS deaths,
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Died' AND a.class IN (${sqlList(YOUNG_CLASS)})), 0)::int AS young_deaths
       FROM animal_event e JOIN animal a ON a.animal_id = e.animal_id
       WHERE ${eventWindow.join(' AND ')}`, params);

    // The same counts split by species, so one kind of animal does not hide another.
    const herdBySpecies = await db.query(
      `SELECT species,
         COALESCE(SUM(head_count) FILTER (WHERE status = 'Active'), 0)::int AS active,
         COALESCE(SUM(head_count) FILTER (WHERE status = 'Active' AND class IN (${sqlList(BREEDING_FEMALE)})), 0)::int AS breeding_females
       FROM animal WHERE owner_id = $1 GROUP BY species`, [owner]);
    const eventsBySpecies = await db.query(
      `SELECT a.species,
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Born'), 0)::int AS births,
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Died'), 0)::int AS deaths,
         COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)) FILTER (WHERE e.event_type = 'Died' AND a.class IN (${sqlList(YOUNG_CLASS)})), 0)::int AS young_deaths
       FROM animal_event e JOIN animal a ON a.animal_id = e.animal_id
       WHERE ${eventWindow.join(' AND ')} GROUP BY a.species`, params);

    const saleWindow = ['seller_id = $1', 'deleted_at IS NULL', `payment_status != 'Cancelled'`];
    const saleParams = [owner];
    if (from) { saleParams.push(from); saleWindow.push(`sale_date >= $${saleParams.length}`); }
    if (to) { saleParams.push(to); saleWindow.push(`sale_date <= $${saleParams.length}`); }
    const sales = await db.query(
      `SELECT COUNT(*)::int AS sale_count, COALESCE(SUM(price), 0)::numeric AS income
       FROM sale WHERE ${saleWindow.join(' AND ')}`, saleParams);

    const expWindow = ['farmer_id = $1', 'deleted_at IS NULL'];
    const expParams = [owner];
    if (from) { expParams.push(from); expWindow.push(`expense_date >= $${expParams.length}`); }
    if (to) { expParams.push(to); expWindow.push(`expense_date <= $${expParams.length}`); }
    const expenses = await db.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM expense WHERE ${expWindow.join(' AND ')}`, expParams);

    const h = herd.rows[0], e = events.rows[0], s = sales.rows[0];
    const spent = Number(expenses.rows[0].total);
    const income = Number(s.income);
    const net = income - spent;
    // Deaths are taken out of the herd, so the herd at the start of the window is roughly today's count plus the deaths.
    const startHerd = h.active_count + e.deaths;
    const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

    const bySpecies = {};
    const speciesNames = [...new Set([...herdBySpecies.rows, ...eventsBySpecies.rows].map((r) => r.species))].sort();
    for (const sp of speciesNames) {
      const hr = herdBySpecies.rows.find((r) => r.species === sp) || { active: 0, breeding_females: 0 };
      const er = eventsBySpecies.rows.find((r) => r.species === sp) || { births: 0, deaths: 0, young_deaths: 0 };
      bySpecies[sp] = {
        active: hr.active,
        breeding_females: hr.breeding_females,
        births: er.births,
        per_100_females: hr.breeding_females > 0 ? Math.round((er.births / hr.breeding_females) * 100) : null,
        deaths: er.deaths,
        young_deaths: er.young_deaths,
        percent_of_herd: pct(er.deaths, hr.active + er.deaths),
      };
    }

    res.json({
      from: from || null,
      to: to || null,
      herd: { active: h.active_count, breeding_females: h.breeding_females, young: h.young_active },
      by_species: bySpecies,
      births: {
        count: e.births,
        per_100_females: h.breeding_females > 0 ? Math.round((e.births / h.breeding_females) * 100) : null,
      },
      deaths: {
        count: e.deaths,
        young: e.young_deaths,
        adult: e.deaths - e.young_deaths,
        percent_of_herd: pct(e.deaths, startHerd),
      },
      money: {
        sales_count: s.sale_count,
        income,
        expenses: spent,
        net,
        net_per_animal: h.active_count > 0 ? Math.round((net / h.active_count) * 100) / 100 : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
