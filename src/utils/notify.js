const webpush = require('web-push');
const db = require('../db');
const { sendEmail, composeEmail, sleep, appUrl } = require('./email');

// Configure web-push once, at module load, if keys are present. If they're
// not set yet, push sends are skipped silently rather than crashing the app.
const pushConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPushToUser(userId, { title, body }) {
  if (!pushConfigured) return;

  const subs = await db.query('SELECT * FROM push_subscription WHERE user_id = $1', [userId]);
  const payload = JSON.stringify({ title, body });

  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      // 404/410 means the browser unsubscribed or the subscription expired -
      // clean it up so we stop trying. Any other error, just log and move on.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.query('DELETE FROM push_subscription WHERE subscription_id = $1', [sub.subscription_id]);
      } else {
        console.error('[PUSH FAILED]', err.message);
      }
    }
  }
}

// The single entry point every other part of the app should call. Always
// records an in-app notification; email/push are best-effort extras on top.
// options: { email: boolean, push: boolean } - both default to true, since
// most things worth notifying about are worth reaching someone however you can.
// Returns { email: 'sent' | 'failed' | 'no_email' | 'opted_out' | 'skipped' | 'off', error? }
async function notifyUser(userId, { title, body, ref_type, ref_id, email = true, push = true, kind = 'notification' }) {
  await db.query(
    `INSERT INTO notification (user_id, title, body, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body || null, ref_type || null, ref_id || null]
  );

  let emailStatus = 'off';
  if (email) {
    const user = await db.query('SELECT email, email_opt_out FROM users WHERE user_id = $1', [userId]);
    const u = user.rows[0];
    if (!u || !u.email) emailStatus = 'no_email';
    else if (u.email_opt_out) emailStatus = 'opted_out';
    else {
      const { html, text } = composeEmail({
        heading: title,
        paragraphs: [body],
        button: { text: 'Open TFNN', url: appUrl() },
      });
      const r = await sendEmail({ to: u.email, subject: title, text, html, kind, userId });
      emailStatus = r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed';
      if (r.error) return { email: emailStatus, error: r.error };
    }
  }
  if (push) {
    await sendPushToUser(userId, { title, body });
  }
  return { email: emailStatus };
}

// Notifies many users, one at a time, pausing between emails so we stay well
// inside Resend's rate limit (10 requests/second). Returns tallies.
const DEFAULT_PACE_MS = process.env.EMAIL_PACE_MS !== undefined ? Number(process.env.EMAIL_PACE_MS) : 150;
async function notifyMany(userIds, payload, { paceMs = DEFAULT_PACE_MS } = {}) {
  const stats = { recipients: userIds.length, emailed: 0, no_email: 0, opted_out: 0, failed: 0, skipped: 0 };
  for (const id of userIds) {
    try {
      const r = await notifyUser(id, payload);
      if (r.email === 'sent') { stats.emailed++; await sleep(paceMs); }
      else if (r.email === 'no_email') stats.no_email++;
      else if (r.email === 'opted_out') stats.opted_out++;
      else if (r.email === 'skipped') stats.skipped++;
      else if (r.email === 'failed') { stats.failed++; await sleep(paceMs); }
    } catch (err) {
      stats.failed++;
      console.error('[NOTIFY FAILED]', id, err.message);
    }
  }
  return stats;
}

// Ids of active, approved farmers - optionally limited to one district.
async function farmerIds({ district } = {}) {
  const params = [];
  let where = `role = 'farmer' AND active = true AND approved = true`;
  if (district) { params.push(district); where += ` AND district = $1`; }
  const r = await db.query(`SELECT user_id FROM users WHERE ${where} ORDER BY user_id`, params);
  return r.rows.map((x) => x.user_id);
}

// Counts how many farmers a broadcast would reach, and how many by email.
async function countAudience({ district } = {}) {
  const params = [];
  let where = `role = 'farmer' AND active = true AND approved = true`;
  if (district) { params.push(district); where += ` AND district = $1`; }
  const r = await db.query(
    `SELECT COUNT(*)::int AS recipients,
            COUNT(*) FILTER (WHERE email IS NOT NULL AND email_opt_out = false)::int AS with_email
     FROM users WHERE ${where}`, params);
  return r.rows[0];
}

// Fire-and-forget wrapper: run in the background, never crash the request.
function inBackground(label, fn) {
  setImmediate(() => { Promise.resolve().then(fn).catch((err) => console.error(`[${label} FAILED]`, err.message)); });
}

// --- Account emails -------------------------------------------------------
async function sendWelcome(user) {
  if (user.role === 'farmer') {
    // In-app record + email (no push - they have not enabled it yet)
    return notifyUser(user.user_id, {
      title: 'Welcome to TFNN',
      body: `Hi ${user.name}, your account is ready. Add your animals, log vaccinations and feeding, track sales and expenses, and see your herd's value - all in one place.`,
      push: false, kind: 'welcome',
    });
  }
  // Supplier / vet accounts cannot log in until approved, so email only.
  if (!user.email) return { email: 'no_email' };
  const { html, text } = composeEmail({
    heading: 'We received your sign-up',
    paragraphs: [`Hi ${user.name}, thanks for registering as a ${user.role} on TFNN.`, 'An administrator needs to approve your account before you can log in. We will email you as soon as that is done.'],
  });
  return sendEmail({ to: user.email, subject: 'We received your TFNN sign-up', text, html, kind: 'signup_pending', userId: user.user_id });
}

async function sendApproved(user) {
  if (!user.email) return { email: 'no_email' };
  const { html, text } = composeEmail({
    heading: 'Your TFNN account is approved',
    paragraphs: [`Hi ${user.name}, your ${user.role} account has been approved. You can log in now.`],
    button: { text: 'Open TFNN', url: appUrl() },
  });
  return sendEmail({ to: user.email, subject: 'Your TFNN account is approved', text, html, kind: 'approved', userId: user.user_id });
}

async function sendEmailConfirmation(user) {
  if (!user.email || user.email_opt_out) return { email: 'skipped' };
  const { html, text } = composeEmail({
    heading: 'Email notifications are on',
    paragraphs: [`Hi ${user.name}, this address is now linked to your TFNN account. We will use it for district alerts, task reminders and messages from TFNN.`, 'You can turn emails off any time in Settings.'],
  });
  return sendEmail({ to: user.email, subject: 'Email notifications are on - TFNN', text, html, kind: 'email_confirm', userId: user.user_id });
}

// Finds on-call vets and notifies them about a new request, across every channel.
async function notifyOnCallVets(request) {
  const result = await db.query(
    `SELECT u.user_id, u.name, u.phone FROM vet_profile v
     JOIN users u ON u.user_id = v.vet_id
     WHERE v.on_call = true`
  );

  for (const vet of result.rows) {
    await notifyUser(vet.user_id, {
      title: `New ${request.urgency} vet request`,
      body: `From farmer #${request.farmer_id}. Call ${request.phone} to respond.`,
      ref_type: 'vet_request',
      ref_id: request.request_id,
    });
  }

  return result.rows.length;
}

module.exports = { notifyUser, notifyMany, notifyOnCallVets, farmerIds, countAudience, inBackground, sendWelcome, sendApproved, sendEmailConfirmation };
