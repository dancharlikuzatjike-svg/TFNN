const express = require('express');
const crypto = require('crypto');
const { sendTaskReminders } = require('../utils/reminders');

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

module.exports = router;
