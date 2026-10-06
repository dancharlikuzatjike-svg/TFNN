const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const DISTRICTS = require('../utils/districts');
const { notifyMany, farmerIds, countAudience, inBackground, sendApproved } = require('../utils/notify');
const { sendEmail, composeEmail, appUrl, fromAddress, isSandbox, isConfigured } = require('../utils/email');
const { sendTaskReminders } = require('../utils/reminders');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const VALID_ROLES = ['farmer', 'admin', 'supplier', 'vet'];

// GET /api/v1/admin/animals?farmer_id=&species=
router.get('/animals', async (req, res, next) => {
  try {
    const { farmer_id, species } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (farmer_id) { params.push(farmer_id); conditions.push(`owner_id = $${params.length}`); }
    if (species) { params.push(species); conditions.push(`species = $${params.length}`); }

    const result = await db.query(
      `SELECT * FROM animal WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ animals: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/stats - aggregate counts only, never individual farmer detail here
router.get('/stats', async (req, res, next) => {
  try {
    const [herd, orders, requests] = await Promise.all([
      db.query(`SELECT species, COUNT(*)::int AS count FROM animal WHERE status = 'Active' GROUP BY species`),
      db.query(`SELECT status, COUNT(*)::int AS count FROM feed_order GROUP BY status`),
      db.query(`SELECT urgency, status, COUNT(*)::int AS count FROM vet_request GROUP BY urgency, status`),
    ]);
    res.json({
      herd_by_species: herd.rows,
      orders_by_status: orders.rows,
      vet_requests_by_urgency_and_status: requests.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, phone, role, farm_location, district, active, approved, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/users/pending - accounts awaiting approval (supplier/vet signups)
router.get('/users/pending', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT user_id, name, phone, role, farm_location, created_at
       FROM users WHERE approved = false ORDER BY created_at ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/admin/users/:id - suspend/reactivate, approve, or change role
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { active, approved, role } = req.body;
    if (active === undefined && approved === undefined && role === undefined) {
      return res.status(400).json({ error: 'At least one of active, approved, or role is required' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const prev = await db.query('SELECT approved FROM users WHERE user_id = $1', [req.params.id]);

    const result = await db.query(
      `UPDATE users SET
         active = COALESCE($1, active),
         approved = COALESCE($2, approved),
         role = COALESCE($3, role)
       WHERE user_id = $4
       RETURNING user_id, name, phone, email, role, farm_location, active, approved`,
      [active, approved, role, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    // Just approved (was waiting before)? Let them know they can log in.
    if (approved === true && prev.rows[0] && prev.rows[0].approved === false) {
      inBackground('APPROVAL EMAIL', () => sendApproved(user));
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/broadcast - message every farmer (optionally one district): in-app + push + email
router.post('/broadcast', async (req, res, next) => {
  try {
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    const district = req.body.district ? String(req.body.district) : undefined;
    if (!subject || !message) return res.status(400).json({ error: 'subject and message are required' });
    if (subject.length > 120) return res.status(400).json({ error: 'subject must be 120 characters or fewer' });
    if (message.length > 5000) return res.status(400).json({ error: 'message must be 5000 characters or fewer' });
    if (district && !DISTRICTS.includes(district)) {
      return res.status(400).json({ error: `district must be one of: ${DISTRICTS.join(', ')}` });
    }

    const audience = await countAudience({ district });
    if (audience.recipients === 0) return res.status(400).json({ error: 'No farmers match that audience' });

    inBackground('BROADCAST', async () => {
      const ids = await farmerIds({ district });
      const stats = await notifyMany(ids, { title: subject, body: message, kind: 'broadcast' });
      console.log('[BROADCAST DONE]', JSON.stringify(stats));
    });

    res.status(202).json({ ...audience, district: district || null, note: 'Sending in the background.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/test-email - send a test message so you can confirm email really works.
// Sends to { to } or, if omitted, the admin's own saved email. Reports the exact error on failure.
router.post('/test-email', async (req, res, next) => {
  try {
    let to = typeof req.body.to === 'string' ? req.body.to.trim() : '';
    if (!to) {
      const me = await db.query('SELECT email FROM users WHERE user_id = $1', [req.auth.user_id]);
      to = (me.rows[0] && me.rows[0].email) || '';
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Add your email in Settings first (or pass a valid "to" address).' });
    }
    const { html, text } = composeEmail({
      heading: 'TFNN test email',
      paragraphs: ['If you can read this, email sending from your TFNN server is working.'],
      button: { text: 'Open TFNN', url: appUrl() },
    });
    const result = await sendEmail({ to, subject: 'TFNN test email', text, html, kind: 'test', userId: req.auth.user_id });
    res.status(result.sent ? 200 : 502).json({ to, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/admin/email-status - is email configured, and what happened recently?
router.get('/email-status', async (req, res, next) => {
  try {
    const [recent, audience] = await Promise.all([
      db.query(`SELECT kind, to_address, subject, status, error, created_at FROM email_log ORDER BY log_id DESC LIMIT 20`),
      countAudience({}),
    ]);
    res.json({
      configured: isConfigured(),
      from: fromAddress(),
      sandbox: isSandbox(),
      sandbox_note: isSandbox()
        ? 'Using Resend\'s test sender: emails can only be delivered to the Resend account owner. Verify a domain in Resend and set RESEND_FROM_ADDRESS to email farmers.'
        : null,
      audience,
      recent: recent.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/admin/task-reminders - send the due-task digest now (also runs on a schedule via /jobs)
router.post('/task-reminders', async (req, res, next) => {
  try {
    res.json({ result: await sendTaskReminders() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
