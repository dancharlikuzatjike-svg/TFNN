const db = require('../db');
const { generateAutoTasks } = require('../routes/tasks');

// Automatic WhatsApp reminders, sent with the WhatsApp Business Cloud API (Meta).
// Nothing is sent until these Render environment variables are set:
//   WHATSAPP_TOKEN            access token from Meta (a permanent system-user token)
//   WHATSAPP_PHONE_NUMBER_ID  the id of the business phone number (not the number itself)
//   WHATSAPP_TEMPLATE         name of the approved message template (default: tfnn_task_digest)
//   WHATSAPP_TEMPLATE_LANG    template language code (default: en)
// The template body must have three variables:
//   Hi {{1}}, you have {{2}} farm task(s) due on TFNN: {{3}}. Open the app to mark them done.
// A farmer only gets messages after turning on "WhatsApp reminders" in Settings.

const API_VERSION = 'v21.0';

const isConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0814254801, +264 81 425 4801 and 264814254801 all become 264814254801. Returns null if it
// does not look like a Namibian number.
function toIntl(phone) {
  let d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '264' + d.slice(1);
  return /^264\d{8,9}$/.test(d) ? d : null;
}

// Template variables may not contain new lines, so the tasks are joined on one line.
function summarise(titles, max = 600) {
  let out = titles.join(' | ').replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + '…';
  return out;
}

async function logWhatsApp({ userId, kind, to, status, error }) {
  try {
    await db.query(
      `INSERT INTO whatsapp_log (user_id, kind, to_number, status, error) VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, kind, to || null, status, error ? String(error).slice(0, 500) : null]
    );
  } catch (e) { console.error('[WHATSAPP LOG FAILED]', e.message); }
}

// Sends one approved template message. Returns { sent: true } or { sent: false, error }.
async function sendTemplate({ to, name, count, summary, userId, kind = 'task_digest' }) {
  if (!isConfigured()) return { sent: false, skipped: true, error: 'WhatsApp is not set up' };
  const number = toIntl(to);
  if (!number) {
    await logWhatsApp({ userId, kind, to, status: 'failed', error: 'phone number is not a valid Namibian number' });
    return { sent: false, error: 'invalid number' };
  }
  const fetchFn = globalThis.fetch;
  if (!fetchFn) return { sent: false, error: 'this server cannot make web requests' };
  try {
    const res = await fetchFn(`https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: number,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_TEMPLATE || 'tfnn_task_digest',
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{
            type: 'body',
            parameters: [name, String(count), summary].map((text) => ({ type: 'text', text: String(text) })),
          }],
        },
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* no body */ }
      const error = `WhatsApp said ${res.status}${detail ? ': ' + detail : ''}`;
      await logWhatsApp({ userId, kind, to: number, status: 'failed', error });
      return { sent: false, error };
    }
    await logWhatsApp({ userId, kind, to: number, status: 'sent' });
    return { sent: true };
  } catch (err) {
    await logWhatsApp({ userId, kind, to: number, status: 'failed', error: err.message });
    return { sent: false, error: err.message };
  }
}

// Sends each opted-in farmer ONE WhatsApp message a day listing their due and overdue tasks.
const DEFAULT_PACE_MS = process.env.WHATSAPP_PACE_MS !== undefined ? Number(process.env.WHATSAPP_PACE_MS) : 250;
async function sendWhatsAppReminders({ paceMs = DEFAULT_PACE_MS } = {}) {
  if (!isConfigured()) return { configured: false };

  const optedIn = await db.query(
    `SELECT user_id FROM users WHERE role = 'farmer' AND active = true AND approved = true AND whatsapp_opt_in = true`
  );
  for (const f of optedIn.rows) {
    try { await generateAutoTasks(f.user_id); } catch (e) { /* one farmer's data issue must not stop the run */ }
  }

  const due = await db.query(
    `SELECT u.user_id, u.name, u.phone,
            json_agg(t.title ORDER BY t.due_date, t.task_id) AS titles, COUNT(*)::int AS n
     FROM users u
     JOIN task t ON t.farmer_id = u.user_id AND t.done = false AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE
     WHERE u.role = 'farmer' AND u.active = true AND u.approved = true AND u.whatsapp_opt_in = true
       AND NOT EXISTS (
         SELECT 1 FROM whatsapp_log l
         WHERE l.user_id = u.user_id AND l.kind = 'task_digest' AND l.status = 'sent'
           AND l.created_at::date = CURRENT_DATE)
     GROUP BY u.user_id, u.name, u.phone`
  );

  const stats = { configured: true, opted_in: optedIn.rows.length, with_due_tasks: due.rows.length, sent: 0, failed: 0 };
  for (const row of due.rows) {
    const r = await sendTemplate({
      to: row.phone, name: row.name.split(' ')[0], count: row.n, summary: summarise(row.titles.slice(0, 8)), userId: row.user_id,
    });
    if (r.sent) stats.sent++; else stats.failed++;
    await sleep(paceMs);
  }
  return stats;
}

module.exports = { isConfigured, toIntl, summarise, sendTemplate, sendWhatsAppReminders };
