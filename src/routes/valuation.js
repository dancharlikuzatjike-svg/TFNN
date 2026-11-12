const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { parsePriceRows, herdTotals } = require('../utils/herdValue');

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
         SELECT species, COALESCE(class, '') AS class, COUNT(*)::int AS animal_count,
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
              rp.price AS market_price, rp.source AS market_source, rp.updated_at AS market_updated_at
       FROM keys k
       LEFT JOIN herd h ON h.species = k.species AND h.class = k.class
       LEFT JOIN class_price cp ON cp.owner_id = $1 AND cp.species = k.species AND cp.class = k.class
       LEFT JOIN reference_price rp ON rp.species = k.species AND rp.class = k.class
       ORDER BY k.species, k.class`,
      [req.auth.user_id]
    );
    const num = (v) => (v == null ? null : Number(v));
    res.json({ prices: result.rows.map((p) => ({ ...p, price: num(p.price), market_price: num(p.market_price) })) });
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

module.exports = router;
