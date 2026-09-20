const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/notifications?unread=true
router.get('/', async (req, res, next) => {
  try {
    const conditions = ['user_id = $1'];
    const params = [req.auth.user_id];
    if (req.query.unread === 'true') conditions.push('read_at IS NULL');

    const result = await db.query(
      `SELECT * FROM notification WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    const unreadCount = await db.query(
      'SELECT COUNT(*)::int AS count FROM notification WHERE user_id = $1 AND read_at IS NULL',
      [req.auth.user_id]
    );
    res.json({ notifications: result.rows, unread_count: unreadCount.rows[0].count });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/notifications/:id - mark one as read
router.patch('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'UPDATE notification SET read_at = now() WHERE notification_id = $1 AND user_id = $2 AND read_at IS NULL RETURNING *',
      [req.params.id, req.auth.user_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/notifications/read-all
router.post('/read-all', async (req, res, next) => {
  try {
    await db.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.auth.user_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/notifications/push/vapid-public-key - the frontend needs this to subscribe
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/v1/notifications/push/subscribe - register this device for push
router.post('/push/subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint and keys.p256dh/keys.auth are required' });
    }

    await db.query(
      `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.auth.user_id, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/notifications/push/unsubscribe
router.post('/push/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    await db.query('DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2', [endpoint, req.auth.user_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
