const webpush = require('web-push');
const db = require('../db');
const { sendEmail } = require('./email');

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
async function notifyUser(userId, { title, body, ref_type, ref_id, email = true, push = true }) {
  await db.query(
    `INSERT INTO notification (user_id, title, body, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body || null, ref_type || null, ref_id || null]
  );

  const user = await db.query('SELECT email, phone FROM users WHERE user_id = $1', [userId]);
  if (email && user.rows[0]?.email) {
    await sendEmail({ to: user.rows[0].email, subject: title, text: body || title });
  }
  if (push) {
    await sendPushToUser(userId, { title, body });
  }
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

module.exports = { notifyUser, notifyOnCallVets };
