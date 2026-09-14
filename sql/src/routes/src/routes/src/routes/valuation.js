const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/valuation?from=&to=
// from/to filter the sales-income and expenses totals (a time window, e.g. this quarter).
// Live animal value is always the current snapshot, since it isn't a flow over time.
router.get('/', async (req, res, next) => {
  try {
    const { from, to } = req.query;

    const liveValue = await db.query(
      `SELECT COUNT(*)::int AS animal_count,
              COALESCE(SUM(estimated_value), 0)::numeric AS total_estimated_value
       FROM animal
       WHERE owner_id = $1 AND status = 'Active'`,
      [req.auth.user_id]
    );

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
        animal_count: liveValue.rows[0].animal_count,
        total_estimated_value: Number(liveValue.rows[0].total_estimated_value),
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

module.exports = router;
