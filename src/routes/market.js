const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Never show a price grouping backed by fewer than this many sales - with only
// 1-2 sales, an "average" is effectively revealing one farmer's exact price.
const MIN_SAMPLE_SIZE = 3;

// GET /api/v1/market-prices?species=&district=&days=90
// Aggregated real sale prices, grouped by species + district. Always a group
// average/range, never a single farmer's individual sale.
router.get('/', async (req, res, next) => {
  try {
    const { species, district } = req.query;
    const days = Number(req.query.days) || 90;

    const conditions = [
      's.deleted_at IS NULL',
      `s.payment_status != 'Cancelled'`,
      `s.sale_date >= CURRENT_DATE - ($1 || ' days')::interval`,
    ];
    const params = [days];

    if (species) { params.push(species); conditions.push(`a.species = $${params.length}`); }
    if (district) { params.push(district); conditions.push(`u.district = $${params.length}`); }

    params.push(MIN_SAMPLE_SIZE);

    const result = await db.query(
      `SELECT a.species, u.district,
              COUNT(*)::int AS sale_count,
              ROUND(AVG(s.price))::numeric AS avg_price,
              MIN(s.price) AS min_price,
              MAX(s.price) AS max_price
       FROM sale s
       JOIN animal a ON a.animal_id = s.animal_id
       JOIN users u ON u.user_id = s.seller_id
       WHERE ${conditions.join(' AND ')} AND u.district IS NOT NULL
       GROUP BY a.species, u.district
       HAVING COUNT(*) >= $${params.length}
       ORDER BY a.species, u.district`,
      params
    );

    res.json({ prices: result.rows, window_days: days, min_sample_size: MIN_SAMPLE_SIZE });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
