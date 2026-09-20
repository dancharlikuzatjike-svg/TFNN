// Thin wrapper around Resend's HTTP API - no SDK dependency needed, just fetch
// (Node 18+ has fetch built in). Requires RESEND_API_KEY in the environment.
// If it's not set, sends are skipped silently (logged, not thrown) so the app
// never breaks just because email isn't configured yet.

const RESEND_API_URL = 'https://api.resend.com/emails';
// Must be a domain verified in your Resend account, or Resend's sandbox address
// (onboarding@resend.dev) for testing before you've verified a real domain.
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'TFNN <onboarding@resend.dev>';

async function sendEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED - no RESEND_API_KEY set] To ${to}: ${subject}`);
    return { skipped: true };
  }
  if (!to) return { skipped: true };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, text }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[EMAIL FAILED] ${res.status} sending to ${to}: ${errBody}`);
      return { failed: true };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[EMAIL ERROR] sending to ${to}:`, err.message);
    return { failed: true };
  }
}

module.exports = { sendEmail };
