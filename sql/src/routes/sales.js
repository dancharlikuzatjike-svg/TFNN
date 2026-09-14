const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_STATUSES = ['Pending', 'Paid', 'Partial', 'Cancelled'];

// Shared helper: fetch a sale only if it belongs to the current farmer (as seller)
async function findOwnedSale(saleId, sellerId) {
  const result = await db.query(
    'SELECT * FROM sale WHERE sale_id = $1 AND seller_id = $2 AND deleted_at IS NULL',
    [saleId, sellerId]
  );
  return result.rows[0];
}

// GET /api/v1/sales?status=&from=&to=
router.get('/', async (req, res, next) => {
  try {
    const { status, from, to } = req.query;
    const conditions = ['seller_id = $1', 'deleted_at IS NULL'];
    const params = [req.auth.user_id];

    if (status) { params.push(status); conditions.push(`payment_status = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`sale_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`sale_date <= $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM sale WHERE ${conditions.join(' AND ')} ORDER BY sale_date DESC`,
      params
    );
    res.json({ sales: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/sales/:id
router.get('/:id', async (req, res, next) => {
  try {
    const sale = await findOwnedSale(req.params.id, req.auth.user_id);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    res.json({ sale });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/sales - records a sale, marks the animal Sold, and logs an animal_event,
// all in one transaction so the three can never drift out of sync.
router.post('/', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { animal_id, buyer_name, buyer_user_id, price, sale_date, payment_status, notes } = req.body;

    if (!animal_id || !buyer_name || price === undefined) {
      return res.status(400).json({ error: 'animal_id, buyer_name and price are required' });
    }
    if (payment_status && !PAYMENT_STATUSES.includes(payment_status)) {
      return res.status(400).json({ error: `payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}` });
    }

    await client.query('BEGIN');

    const animalQuery = await client.query(
      'SELECT * FROM animal WHERE animal_id = $1 AND owner_id = $2 FOR UPDATE',
      [animal_id, req.auth.user_id]
    );
    if (animalQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Animal not found' });
    }
    const animal = animalQuery.rows[0];
    if (animal.status !== 'Active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Animal is currently '${animal.status}' and cannot be sold` });
    }

    const sale = await client.query(
      `INSERT INTO sale (animal_id, seller_id, buyer_name, buyer_user_id, price, sale_date, payment_status, notes)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), COALESCE($7, 'Pending'), $8)
       RETURNING *`,
      [animal_id, req.auth.user_id, buyer_name, buyer_user_id || null, price, sale_date || null, payment_status || null, notes || null]
    );

    await client.query(`UPDATE animal SET status = 'Sold' WHERE animal_id = $1`, [animal_id]);

    await client.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by)
       VALUES ($1, $2, 'Sold', $3, $4, $5)`,
      [
        animal_id,
        sale.rows[0].sale_date,
        notes || null,
        JSON.stringify({ sale_id: sale.rows[0].sale_id, buyer_name, price }),
        req.auth.user_id,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ sale: sale.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/sales/:id - price, buyer, payment_status, notes only; never the animal_id
router.patch('/:id', async (req, res, next) => {
  try {
    const sale = await findOwnedSale(req.params.id, req.auth.user_id);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const { buyer_name, buyer_user_id, price, sale_date, payment_status, notes } = req.body;
    if (payment_status && !PAYMENT_STATUSES.includes(payment_status)) {
      return res.status(400).json({ error: `payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}` });
    }

    const allowed = { buyer_name, buyer_user_id, price, sale_date, payment_status, notes };
    const updates = [];
    const params = [];
    for (const [field, value] of Object.entries(allowed)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided to update' });
    }

    params.push(sale.sale_id);
    const result = await db.query(
      `UPDATE sale SET ${updates.join(', ')} WHERE sale_id = $${params.length} RETURNING *`,
      params
    );
    res.json({ sale: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/sales/:id - cancels the sale: soft-deletes the sale row and
// returns the animal to Active, with a note left on the animal's event history.
router.delete('/:id', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const saleQuery = await client.query(
      'SELECT * FROM sale WHERE sale_id = $1 AND seller_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [req.params.id, req.auth.user_id]
    );
    if (saleQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sale not found' });
    }
    const sale = saleQuery.rows[0];

    await client.query('UPDATE sale SET deleted_at = now() WHERE sale_id = $1', [sale.sale_id]);
    await client.query(`UPDATE animal SET status = 'Active' WHERE animal_id = $1`, [sale.animal_id]);
    await client.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by)
       VALUES ($1, CURRENT_DATE, 'Other', $2, $3, $4)`,
      [
        sale.animal_id,
        'Sale cancelled - animal returned to Active status',
        JSON.stringify({ cancelled_sale_id: sale.sale_id }),
        req.auth.user_id,
      ]
    );

    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
