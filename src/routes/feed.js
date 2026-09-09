const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---------- Listings (supplier catalog) ----------

// GET /api/v1/feed-listings?supplier_id=&feed_type=
router.get('/feed-listings', async (req, res, next) => {
  try {
    const { supplier_id, feed_type } = req.query;
    const conditions = ['available = true'];
    const params = [];

    if (supplier_id) { params.push(supplier_id); conditions.push(`supplier_id = $${params.length}`); }
    if (feed_type) { params.push(`%${feed_type}%`); conditions.push(`feed_type ILIKE $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM feed_listing WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ listings: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/feed-listings - supplier only
router.post('/feed-listings', requireRole('supplier'), async (req, res, next) => {
  try {
    const { feed_type, unit, price } = req.body;
    if (!feed_type) return res.status(400).json({ error: 'feed_type is required' });

    const result = await db.query(
      `INSERT INTO feed_listing (supplier_id, feed_type, unit, price) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.auth.user_id, feed_type, unit || null, price || null]
    );
    res.status(201).json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/feed-listings/:id - supplier only, and only their own listing
router.patch('/feed-listings/:id', requireRole('supplier'), async (req, res, next) => {
  try {
    const { price, available } = req.body;
    const result = await db.query(
      `UPDATE feed_listing SET price = COALESCE($1, price), available = COALESCE($2, available)
       WHERE listing_id = $3 AND supplier_id = $4 RETURNING *`,
      [price, available, req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    res.json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------- Orders ----------

// GET /api/v1/feed-orders - farmer sees their own orders; supplier sees orders addressed to them
router.get('/feed-orders', async (req, res, next) => {
  try {
    const column = req.auth.role === 'supplier' ? 'supplier_id' : 'farmer_id';
    const result = await db.query(
      `SELECT * FROM feed_order WHERE ${column} = $1 ORDER BY created_at DESC`,
      [req.auth.user_id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/feed-orders
router.post('/feed-orders', requireRole('farmer'), async (req, res, next) => {
  try {
    const { listing_id, quantity, need_by, notes } = req.body;
    if (!listing_id || !quantity) {
      return res.status(400).json({ error: 'listing_id and quantity are required' });
    }

    const listing = await db.query('SELECT * FROM feed_listing WHERE listing_id = $1', [listing_id]);
    if (listing.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });

    const result = await db.query(
      `INSERT INTO feed_order (farmer_id, supplier_id, listing_id, quantity, need_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.auth.user_id, listing.rows[0].supplier_id, listing_id, quantity, need_by || null, notes || null]
    );
    res.status(201).json({ order: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/feed-orders/:id
// - supplier: can set status to Confirmed / Delivered
// - farmer: can only cancel, and only while still Requested
router.patch('/feed-orders/:id', async (req, res, next) => {
  try {
    const { status } = req.body;
    const order = await db.query('SELECT * FROM feed_order WHERE order_id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const existing = order.rows[0];

    if (req.auth.role === 'supplier') {
      if (existing.supplier_id !== req.auth.user_id) return res.status(403).json({ error: 'Not your order' });
      if (!['Confirmed', 'Delivered'].includes(status)) {
        return res.status(400).json({ error: 'Supplier may only set status to Confirmed or Delivered' });
      }
    } else if (req.auth.role === 'farmer') {
      if (existing.farmer_id !== req.auth.user_id) return res.status(403).json({ error: 'Not your order' });
      if (status !== 'Cancelled' || existing.status !== 'Requested') {
        return res.status(400).json({ error: 'Farmers may only cancel an order while it is still Requested' });
      }
    } else {
      return res.status(403).json({ error: 'Not permitted' });
    }

    const result = await db.query(
      `UPDATE feed_order SET status = $1, updated_at = now() WHERE order_id = $2 RETURNING *`,
      [status, existing.order_id]
    );

    // Side-effect: a delivered order automatically logs a farm expense, so the farmer
    // never has to enter the cost twice.
    if (status === 'Delivered') {
      const listing = existing.listing_id
        ? await db.query('SELECT * FROM feed_listing WHERE listing_id = $1', [existing.listing_id])
        : { rows: [] };
      const unitPrice = listing.rows[0]?.price || 0;
      const total = unitPrice * existing.quantity;

      await db.query(
        `INSERT INTO expense (farmer_id, amount, category, description, ref_type, ref_id)
         VALUES ($1, $2, 'Feed', $3, 'feed_order', $4)`,
        [existing.farmer_id, total, `Feed order #${existing.order_id} delivered`, existing.order_id]
      );
    }

    res.json({ order: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
