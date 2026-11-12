const express = require('express');
const crypto = require('crypto');
const { sendTaskReminders } = require('../utils/reminders');
const { parsePriceRows, setReferencePrices } = require('../utils/herdValue');
const { submitProposals } = require('../utils/priceAgent');

const router = express.Router();

// Endpoints for an external scheduler (e.g. a Render Cron Job or cron-job.org).
// Protected by a shared secret in the CRON_SECRET env var, sent as the x-cron-secret header.
// If CRON_SECRET is not set, these endpoints are disabled.
function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'Scheduled jobs are not enabled (CRON_SECRET not set)' });
  const given = Buffer.from(String(req.get('x-cron-secret') || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  next();
}

// POST /api/v1/jobs/task-reminders  - emails each farmer a once-a-day digest of due tasks
router.post('/task-reminders', requireCronSecret, async (req, res, next) => {
  try {
    res.json({ result: await sendTaskReminders() });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/jobs/market-prices   body: { prices: [{ species, class, price, source }] }
// Lets a scheduled price checker update the TFNN market reference prices (N$ per head).
// price null removes that reference price.
router.post('/market-prices', requireCronSecret, async (req, res, next) => {
  try {
    const parsed = parsePriceRows(req.body && req.body.prices);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    res.json({ result: await setReferencePrices(parsed.rows) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/jobs/market-price-proposals
//   body: { source, items: [{ species, class, basis: 'kg' | 'head', price, note }] }
// Used by the weekly market price agent. Each quote becomes a price per head (per-kg quotes
// use the typical weight for the class) and waits on the admin Prices tab for approval.
// With PRICE_AGENT_AUTO_APPROVE=true, quotes that pass the checks go live straight away.
router.post('/market-price-proposals', requireCronSecret, async (req, res, next) => {
  try {
    const result = await submitProposals({ items: req.body && req.body.items, source: req.body && req.body.source });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
