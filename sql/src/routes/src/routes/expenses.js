const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Shared helper: fetch an expense only if it belongs to the current farmer
async function findOwnedExpense(expenseId, farmerId) {
  const result = await db.query(
    'SELECT * FROM expense WHERE expense_id = $1 AND farmer_id = $2 AND deleted_at IS NULL',
    [expenseId, farmerId]
  );
  return result.rows[0];
}

// GET /api/v1/expenses?category=&from=&to=
router.get('/', async (req, res, next) => {
  try {
    const { category, from, to } = req.query;
    const conditions = ['farmer_id = $1', 'deleted_at IS NULL'];
    const params = [req.auth.user_id];

    if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`expense_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`expense_date <= $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM expense WHERE ${conditions.join(' AND ')} ORDER BY expense_date DESC`,
      params
    );
    res.json({ expenses: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/expenses
router.post('/', async (req, res, next) => {
  try {
    const { amount, category, description, expense_date, ref_type, ref_id } = req.body;

    if (amount === undefined) {
      return res.status(400).json({ error: 'amount is required' });
    }

    const result = await db.query(
      `INSERT INTO expense (farmer_id, amount, category, description, expense_date, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7)
       RETURNING *`,
      [req.auth.user_id, amount, category || null, description || null, expense_date || null, ref_type || null, ref_id || null]
    );
    res.status(201).json({ expense: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/expenses/:id
router.get('/:id', async (req, res, next) => {
  try {
    const expense = await findOwnedExpense(req.params.id, req.auth.user_id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    res.json({ expense });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/expenses/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const expense = await findOwnedExpense(req.params.id, req.auth.user_id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const allowedFields = ['amount', 'category', 'description', 'expense_date', 'ref_type', 'ref_id'];
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

    params.push(expense.expense_id);
    const result = await db.query(
      `UPDATE expense SET ${updates.join(', ')} WHERE expense_id = $${params.length} RETURNING *`,
      params
    );
    res.json({ expense: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/expenses/:id - soft delete only
router.delete('/:id', async (req, res, next) => {
  try {
    const expense = await findOwnedExpense(req.params.id, req.auth.user_id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    await db.query('UPDATE expense SET deleted_at = now() WHERE expense_id = $1', [expense.expense_id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
