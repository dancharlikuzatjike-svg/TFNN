const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const DISTRICTS = require('../utils/districts');
const { notifyMany, farmerIds, countAudience, inBackground, sendApproved } = require('../utils/notify');
const { sendEmail, composeEmail, appUrl, fromAddress, isSandbox, isConfigured } = require('../utils/email');
const { sendTaskReminders } = require('../utils/reminders');
const { PRICING, membershipFor } = require('../utils/pricing');
const { parsePriceRows, setReferencePrices, listReferencePrices } = require('../utils/herdValue');
const { getWeights, setWeights, listPending, decideProposals } = require('../utils/priceAgent');

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

// ---- Membership payments ----
async function findUser(body) {
  if (body.user_id) {
    return (await db.query('SELECT * FROM users WHERE user_id = $1', [Number(body.user_id)])).rows[0];
  }
  const last9 = String(body.phone || '').replace(/\D/g, '').slice(-9);
  if (last9.length < 9) return null;
  return (await db.query(
    `SELECT * FROM users WHERE right(regexp_replace(phone, '\\D', '', 'g'), 9) = $1 LIMIT 1`, [last9])).rows[0];
}

// POST /api/v1/admin/payments - record money you received. { user_id | phone, kind: 'registration' | 'membership', months?, amount?, note? }
router.post('/payments', async (req, res, next) => {
  try {
    const { kind, note } = req.body;
    if (!['registration', 'membership'].includes(kind)) return res.status(400).json({ error: "kind must be 'registration' or 'membership'" });
    const u = await findUser(req.body);
    if (!u) return res.status(404).json({ error: 'No user found with that phone number or id' });
    if (u.role === 'admin') return res.status(400).json({ error: 'Admins are not charged' });
    const m = await membershipFor(u);
    let months = null;
    let amount = req.body.amount != null ? Number(req.body.amount) : null;
    if (kind === 'membership') {
      months = req.body.months != null ? Number(req.body.months) : 1;
      if (!Number.isInteger(months) || months < 1 || months > 24) return res.status(400).json({ error: 'months must be a whole number from 1 to 24' });
      if (amount == null) amount = m.monthly_fee * months;
    } else if (amount == null) {
      amount = m.registration_fee;
    }
    if (!(amount >= 0) || amount > 1000000) return res.status(400).json({ error: 'amount is not valid' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO payment (user_id, kind, amount, months, recorded_by, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [u.user_id, kind, amount, months, req.auth.user_id, note ? String(note).slice(0, 200) : null]);
      if (kind === 'registration') {
        await client.query('UPDATE users SET reg_fee_paid_on = CURRENT_DATE, payment_claimed_at = NULL WHERE user_id = $1', [u.user_id]);
      } else {
        await client.query(
          `UPDATE users SET paid_until = (GREATEST(COALESCE(paid_until, CURRENT_DATE), CURRENT_DATE) + ($2 || ' months')::interval)::date,
                  payment_claimed_at = NULL WHERE user_id = $1`, [u.user_id, String(months)]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const fresh = (await db.query('SELECT * FROM users WHERE user_id = $1', [u.user_id])).rows[0];
    res.status(201).json({ user: { user_id: fresh.user_id, name: fresh.name, phone: fresh.phone }, membership: await membershipFor(fresh) });
  } catch (err) { next(err); }
});

// GET /api/v1/admin/billing - who says they paid, who is about to lapse, and what came in
router.get('/billing', async (req, res, next) => {
  try {
    const claims = await db.query(
      `SELECT user_id, name, phone, role, payment_claimed_at, paid_until, reg_fee_paid_on FROM users
       WHERE payment_claimed_at IS NOT NULL ORDER BY payment_claimed_at`);
    const expiring = await db.query(
      `SELECT user_id, name, phone, role, paid_until FROM users
       WHERE role IN ('farmer','vet','supplier') AND paid_until IS NOT NULL AND paid_until <= CURRENT_DATE + 7
       ORDER BY paid_until LIMIT 50`);
    const totals = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', paid_on) = date_trunc('month', CURRENT_DATE)), 0)::float AS this_month,
              COALESCE(SUM(amount) FILTER (WHERE paid_on >= CURRENT_DATE - 365), 0)::float AS last_12_months,
              COALESCE(SUM(amount), 0)::float AS all_time
       FROM payment`);
    const recent = await db.query(
      `SELECT p.payment_id, p.kind, p.amount::float AS amount, p.months, p.paid_on, u.name, u.phone
       FROM payment p JOIN users u ON u.user_id = p.user_id ORDER BY p.payment_id DESC LIMIT 15`);
    res.json({ claims: claims.rows, expiring: expiring.rows, totals: totals.rows[0], recent: recent.rows, pricing: PRICING() });
  } catch (err) { next(err); }
});

// GET /api/v1/admin/market-prices - the TFNN market reference prices (N$ per head, by species + class)
router.get('/market-prices', async (req, res, next) => {
  try {
    res.json({ prices: await listReferencePrices() });
  } catch (err) { next(err); }
});

// PUT /api/v1/admin/market-prices   body: { prices: [{ species, class, price, source }] }
// price null removes that reference price. Farmers who have not set their own price use these.
router.put('/market-prices', async (req, res, next) => {
  try {
    const parsed = parsePriceRows(req.body && req.body.prices);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const result = await setReferencePrices(parsed.rows);
    res.json({ result, prices: await listReferencePrices() });
  } catch (err) { next(err); }
});

// GET /api/v1/admin/price-proposals - prices found by the market price agent, waiting for approval
router.get('/price-proposals', async (req, res, next) => {
  try {
    res.json({ proposals: await listPending(), auto_approve: String(process.env.PRICE_AGENT_AUTO_APPROVE || '').toLowerCase() === 'true' });
  } catch (err) { next(err); }
});

// POST /api/v1/admin/price-proposals/decide   body: { ids: [..], action: 'approve' | 'reject' }
router.post('/price-proposals/decide', async (req, res, next) => {
  try {
    const result = await decideProposals(req.body && req.body.ids, req.body && req.body.action);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ result, proposals: await listPending(), prices: await listReferencePrices() });
  } catch (err) { next(err); }
});

// GET /api/v1/admin/class-weights - typical live weight (kg) per class, used for per-kg prices
router.get('/class-weights', async (req, res, next) => {
  try {
    res.json({ weights: await getWeights() });
  } catch (err) { next(err); }
});

// PUT /api/v1/admin/class-weights   body: { weights: [{ species, class, weight_kg }] }
router.put('/class-weights', async (req, res, next) => {
  try {
    const result = await setWeights(req.body && req.body.weights);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ result, weights: await getWeights() });
  } catch (err) { next(err); }
});

module.exports = router;
