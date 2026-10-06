// Email via Resend's HTTP API (no SDK, just fetch). Needs RESEND_API_KEY.
// If the key isn't set, sends are skipped (and logged) instead of throwing, so
// the app never breaks just because email isn't configured.
//
// IMPORTANT: until a domain is verified in Resend, set RESEND_FROM_ADDRESS to
// nothing and Resend's sandbox sender is used - the sandbox can ONLY deliver to
// the Resend account owner's own address. To email farmers, verify a domain and
// set RESEND_FROM_ADDRESS (e.g. "TFNN <hello@yourdomain.com>").

const db = require('../db');

const RESEND_API_URL = 'https://api.resend.com/emails';
const fromAddress = () => process.env.RESEND_FROM_ADDRESS || 'TFNN <onboarding@resend.dev>';
const appUrl = () => process.env.APP_URL || 'https://tfnn-1.onrender.com';
const isSandbox = () => /resend\.dev/i.test(fromAddress());
const isConfigured = () => !!process.env.RESEND_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Builds a simple, branded, mobile-friendly email (HTML + plain-text twin).
// paragraphs: array of plain strings (newlines become line breaks). Everything is escaped.
function composeEmail({ heading, paragraphs = [], button }) {
  const body = paragraphs.filter(Boolean).map((p) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#262019;">${esc(p).replace(/\n/g, '<br>')}</p>`
  ).join('');
  const btn = button ? `<p style="margin:22px 0 6px;"><a href="${esc(button.url)}" style="display:inline-block;background:#262019;color:#EFEAD9;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">${esc(button.text)}</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#EFEAD9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEAD9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#F8F5EA;border:1px solid #CBC3AA;border-radius:10px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;">
<tr><td style="background:#0d2c1a;padding:14px 24px;color:#EFEAD9;font-size:18px;font-weight:700;letter-spacing:.04em;"><img src="${appUrl()}/emblem.png" width="44" height="44" alt="" style="vertical-align:middle;border-radius:50%;margin-right:10px;"> TFNN <span style="font-weight:400;font-size:12px;opacity:.8;">The Future of Namibian Farming</span></td></tr>
<tr><td style="padding:24px;">
<h1 style="margin:0 0 14px;font-size:19px;color:#262019;">${esc(heading)}</h1>${body}${btn}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #CBC3AA;font-size:12px;color:#6B6152;">You receive this because you have a TFNN account. To stop emails, open the app → ⚙️ Settings → untick “Email me notifications”.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, '', ...paragraphs.filter(Boolean), button ? `${button.text}: ${button.url}` : '', '',
    '— TFNN, The Future of Namibian Farming',
    'To stop emails: open the app > Settings > untick "Email me notifications".'].filter((l) => l !== undefined).join('\n');
  return { html, text };
}

async function logEmail({ userId, kind, to, subject, status, error }) {
  try {
    await db.query(
      `INSERT INTO email_log (user_id, kind, to_address, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, kind || null, to || null, String(subject || '').slice(0, 200), status, error ? String(error).slice(0, 500) : null]
    );
  } catch (e) { /* logging must never break sending */ }
}

// Returns { sent:true } | { skipped:true, reason } | { failed:true, error }. Never throws.
async function sendEmail({ to, subject, text, html, replyTo, kind, userId }) {
  if (!to) return { skipped: true, reason: 'no_recipient' };
  if (!isConfigured()) {
    console.log(`[EMAIL SKIPPED - no RESEND_API_KEY set] To ${to}: ${subject}`);
    await logEmail({ userId, kind, to, subject, status: 'skipped', error: 'RESEND_API_KEY not set' });
    return { skipped: true, reason: 'no_api_key' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const payload = { from: fromAddress(), to, subject, text: text || subject };
    if (html) payload.html = html;
    const reply = replyTo || process.env.RESEND_REPLY_TO;
    if (reply) payload.reply_to = reply;

    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = j.message || j.error || JSON.stringify(j); } catch (e) { msg = await res.text().catch(() => ''); }
      const error = `Resend ${res.status}: ${msg}`.slice(0, 400);
      console.error(`[EMAIL FAILED] ${error}`);
      await logEmail({ userId, kind, to, subject, status: 'failed', error });
      return { failed: true, error };
    }
    await logEmail({ userId, kind, to, subject, status: 'sent' });
    return { sent: true };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'Timed out talking to Resend' : err.message;
    console.error(`[EMAIL ERROR] ${error}`);
    await logEmail({ userId, kind, to, subject, status: 'failed', error });
    return { failed: true, error };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendEmail, composeEmail, esc, sleep, appUrl, fromAddress, isSandbox, isConfigured };
