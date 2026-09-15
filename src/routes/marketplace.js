const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/marketplace?species=&max_price=
// Public browse across ALL farmers - unlike every other route in this system,
// this is deliberately cross-owner. Exposes seller name/phone/location so a
// buyer can actually contact them (a phone call beats in-app messaging here).
router.get('/', async (req, res, next) => {
  try {
    const { species, max_price } = req.query;
    const conditions = [`l.status = 'Open'`, `a.status = 'Active'`];
    const params = [];

    if (species) { params.push(species); conditions.push(`a.species = $${params.length}`); }
    if (max_price) { params.push(max_price); conditions.push(`l.asking_price <= $${params.length}`); }

    const result = await db.query(
      `SELECT l.listing_id, l.asking_price, l.description, l.created_at,
              a.tag_number, a.species, a.breed,
              u.name AS seller_name, u.phone AS seller_phone, u.farm_location
       FROM marketplace_listing l
       JOIN animal a ON a.animal_id = l.animal_id
       JOIN users u ON u.user_id = l.seller_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.created_at DESC`,
      params
    );
    res.json({ listings: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/marketplace/mine - the current farmer's own listings, any status
router.get('/mine', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.*, a.tag_number, a.species, a.breed
       FROM marketplace_listing l JOIN animal a ON a.animal_id = l.animal_id
       WHERE l.seller_id = $1 ORDER BY l.created_at DESC`,
      [req.auth.user_id]
    );
    res.json({ listings: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/marketplace/:id - single listing detail (public to any authenticated farmer)
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.listing_id, l.asking_price, l.description, l.status, l.created_at,
              a.tag_number, a.species, a.breed,
              u.name AS seller_name, u.phone AS seller_phone, u.farm_location
       FROM marketplace_listing l
       JOIN animal a ON a.animal_id = l.animal_id
       JOIN users u ON u.user_id = l.seller_id
       WHERE l.listing_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    res.json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/marketplace - list one of your own Active animals for sale
router.post('/', async (req, res, next) => {
  try {
    const { animal_id, asking_price, description, client_id } = req.body;
    if (!animal_id) return res.status(400).json({ error: 'animal_id is required' });

    if (client_id) {
      const existing = await db.query('SELECT * FROM marketplace_listing WHERE client_id = $1', [client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ listing: existing.rows[0] });
    }

    const animal = await db.query(
      `SELECT * FROM animal WHERE animal_id = $1 AND owner_id = $2 AND status = 'Active'`,
      [animal_id, req.auth.user_id]
    );
    if (animal.rows.length === 0) {
      return res.status(404).json({ error: 'Animal not found, not yours, or not Active' });
    }

    const alreadyListed = await db.query(
      `SELECT 1 FROM marketplace_listing WHERE animal_id = $1 AND status IN ('Open','Reserved')`,
      [animal_id]
    );
    if (alreadyListed.rows.length > 0) {
      return res.status(409).json({ error: 'This animal already has an open listing' });
    }

    const result = await db.query(
      `INSERT INTO marketplace_listing (animal_id, seller_id, asking_price, description, client_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [animal_id, req.auth.user_id, asking_price || null, description || null, client_id || null]
    );
    res.status(201).json({ listing: result.rows[0] });
  } catch (err) {
    if (err.code === '23505' && req.body.client_id) {
      const existing = await db.query('SELECT * FROM marketplace_listing WHERE client_id = $1', [req.body.client_id]);
      if (existing.rows.length > 0) return res.status(200).json({ listing: existing.rows[0] });
    }
    next(err);
  }
});

// PATCH /api/v1/marketplace/:id - owner only: price, description, or cancel
router.patch('/:id', async (req, res, next) => {
  try {
    const { asking_price, description, status } = req.body;
    if (status && !['Open', 'Reserved', 'Cancelled'].includes(status)) {
      return res.status(400).json({ error: "status must be one of: Open, Reserved, Cancelled (use /mark-sold to close as Sold)" });
    }

    const updates = [];
    const params = [];
    for (const [field, value] of Object.entries({ asking_price, description, status })) {
      if (value !== undefined) { params.push(value); updates.push(`${field} = $${params.length}`); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided to update' });
    updates.push('updated_at = now()');

    params.push(req.params.id, req.auth.user_id);
    const result = await db.query(
      `UPDATE marketplace_listing SET ${updates.join(', ')}
       WHERE listing_id = $${params.length - 1} AND seller_id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    res.json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/marketplace/:id/mark-sold
// Same transaction pattern as sales.js POST: creates a real sale row, marks the
// animal Sold, logs the event, and closes the listing - all atomically.
router.post('/:id/mark-sold', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { buyer_user_id, price, client_id } = req.body;
    if (!buyer_user_id || price === undefined) {
      return res.status(400).json({ error: 'buyer_user_id and price are required' });
    }

    if (client_id) {
      const already = await client.query('SELECT * FROM sale WHERE client_id = $1', [client_id]);
      if (already.rows.length > 0) return res.status(200).json({ sale: already.rows[0] });
    }

    await client.query('BEGIN');

    const listingQuery = await client.query(
      `SELECT * FROM marketplace_listing WHERE listing_id = $1 AND seller_id = $2 AND status IN ('Open','Reserved') FOR UPDATE`,
      [req.params.id, req.auth.user_id]
    );
    if (listingQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Listing not found or already closed' });
    }
    const listing = listingQuery.rows[0];

    if (Number(buyer_user_id) === req.auth.user_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'buyer_user_id cannot be your own account' });
    }

    const buyer = await client.query(
      `SELECT name FROM users WHERE user_id = $1 AND role = 'farmer' AND active = true`,
      [buyer_user_id]
    );
    if (buyer.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'buyer_user_id must be an active farmer account' });
    }

    const animalQuery = await client.query('SELECT * FROM animal WHERE animal_id = $1 FOR UPDATE', [listing.animal_id]);
    const animal = animalQuery.rows[0];
    if (animal.status !== 'Active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Animal is currently '${animal.status}' and cannot be sold` });
    }

    const sale = await client.query(
      `INSERT INTO sale (animal_id, seller_id, buyer_name, buyer_user_id, price, payment_status, notes, client_id)
       VALUES ($1, $2, $3, $4, $5, 'Pending', $6, $7) RETURNING *`,
      [animal.animal_id, req.auth.user_id, buyer.rows[0].name, buyer_user_id, price, `Sold via marketplace listing #${listing.listing_id}`, client_id || null]
    );

    await client.query(`UPDATE animal SET status = 'Sold' WHERE animal_id = $1`, [animal.animal_id]);

    await client.query(
      `INSERT INTO animal_event (animal_id, event_date, event_type, notes, metadata, created_by)
       VALUES ($1, CURRENT_DATE, 'Sold', $2, $3, $4)`,
      [
        animal.animal_id,
        `Sold via marketplace to ${buyer.rows[0].name}`,
        JSON.stringify({ sale_id: sale.rows[0].sale_id, listing_id: listing.listing_id, price }),
        req.auth.user_id,
      ]
    );

    await client.query(`UPDATE marketplace_listing SET status = 'Sold', updated_at = now() WHERE listing_id = $1`, [listing.listing_id]);

    await client.query('COMMIT');
    res.status(201).json({ sale: sale.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && req.body.client_id) {
      const already = await client.query('SELECT * FROM sale WHERE client_id = $1', [req.body.client_id]);
      if (already.rows.length > 0) return res.status(200).json({ sale: already.rows[0] });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
