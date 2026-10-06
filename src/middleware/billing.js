const db = require('../db');
const { verifyAccessToken } = require('../utils/jwt');
const { membershipFor, enforced } = require('../utils/pricing');

// Only blocks *changes* (POST/PUT/PATCH/DELETE) for accounts whose membership has lapsed.
// Reading and exporting your own data always keeps working, and nothing is ever deleted.
const OPEN_PREFIXES = ['/auth', '/billing', '/users/me', '/notifications', '/jobs', '/admin'];

module.exports = async function billingGate(req, res, next) {
  try {
    if (!enforced()) return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (OPEN_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) return next();
    let payload;
    try { payload = verifyAccessToken(token); } catch (e) { return next(); }
    const r = await db.query('SELECT user_id, role, paid_until, trial_ends, reg_fee_paid_on FROM users WHERE user_id = $1', [payload.sub]);
    if (!r.rows[0]) return next();
    const m = await membershipFor(r.rows[0]);
    if (m.status === 'expired') {
      return res.status(402).json({
        error: 'Your membership has expired. You can still view and export your records. Open Settings → Membership to renew.',
        code: 'membership_required',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};
