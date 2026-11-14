const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const { sendWelcome, inBackground } = require('../utils/notify');
const { sendEmail, composeEmail, isConfigured } = require('../utils/email');
const { createLimiter, waitText } = require('../utils/rateLimit');
const { createResetCode, redeemResetCode } = require('../utils/passwordReset');

// Password guessing protection: 10 wrong passwords for one phone number, or 60 from
// one internet address, locks sign-in for 15 minutes. A correct sign-in clears the count.
const loginByPhone = createLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const loginByIp = createLimiter({ windowMs: 15 * 60 * 1000, max: 60 });
const forgotByPhone = createLimiter({ windowMs: 60 * 60 * 1000, max: 3 });
const resetByIp = createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
// The automated tests all come from one address, so the per-address limits are off there
const ipKey = (req) => (process.env.NODE_ENV === 'test' ? null : req.ip);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// 'admin' is deliberately excluded - it can never be self-selected at signup.
// Admin accounts can only be created by an existing admin.
const PUBLIC_ROLES = ['farmer', 'supplier', 'vet'];

// POST /api/v1/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, phone, password, role, farm_location } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';

    if (!name || !phone || !password || !role) {
      return res.status(400).json({ error: 'name, phone, password and role are required' });
    }
    if (!PUBLIC_ROLES.includes(role)) {
      return res.status(400).json({
        error: `role must be one of: ${PUBLIC_ROLES.join(', ')}. Admin accounts can only be created by an existing admin.`,
      });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (email && (email.length > 150 || !EMAIL_RE.test(email))) {
      return res.status(400).json({ error: 'email does not look valid' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    // Farmers are usable right away. Supplier/vet claims need a human to check
    // before that account can act as one - it's created but can't log in yet.
    const approved = role === 'farmer';

    const result = await db.query(
      `INSERT INTO users (name, phone, password_hash, role, farm_location, approved, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING user_id, name, phone, email, role, farm_location, approved, created_at`,
      [name, phone, password_hash, role, farm_location || null, approved, email || null]
    );

    const user = result.rows[0];

    // Welcome / pending-approval email - in the background so sign-up stays fast
    inBackground('WELCOME EMAIL', () => sendWelcome(user));

    if (!approved) {
      return res.status(201).json({
        user,
        message: 'Account created. Supplier and vet accounts are approved by an admin after the registration fee is paid and checked. We will contact you with the payment details.',
      });
    }

    const token = signAccessToken(user);
    const refresh_token = signRefreshToken(user);
    res.status(201).json({ user, token, refresh_token });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'phone and password are required' });
    }

    const phoneKey = String(phone).trim();
    const ip = ipKey(req);
    const wait = Math.max(loginByPhone.blockedFor(phoneKey), ip ? loginByIp.blockedFor(ip) : 0);
    if (wait) {
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${waitText(wait)}, or use "Forgot password?".` });
    }
    const failed = () => {
      loginByPhone.hit(phoneKey);
      if (ip) loginByIp.hit(ip);
      return res.status(401).json({ error: 'Invalid phone or password' });
    };

    const result = await db.query('SELECT * FROM users WHERE phone = $1 AND active = true', [phone]);
    const user = result.rows[0];

    // Same generic error whether the phone doesn't exist or the password is wrong -
    // never reveal which one it was, that helps account enumeration attacks.
    if (!user) return failed();

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) return failed();
    loginByPhone.clear(phoneKey);

    if (!user.approved) {
      return res.status(403).json({ error: 'Your account is pending admin approval' });
    }

    const token = signAccessToken(user);
    const refresh_token = signRefreshToken(user);
    delete user.password_hash;

    res.json({ user, token, refresh_token });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    let payload;
    try {
      payload = verifyRefreshToken(refresh_token);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // A sign-in from before the last password change no longer counts
    const result = await db.query(
      `SELECT user_id, role FROM users WHERE user_id = $1 AND active = true AND approved = true
         AND (password_changed_at IS NULL OR to_timestamp($2) >= date_trunc('second', password_changed_at))`,
      [payload.sub, payload.iat]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists, is inactive, or is not yet approved' });
    }

    const token = signAccessToken(user);
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/forgot - ask for a reset code. The answer is the same whether or not
// the number has an account, so nobody can use this to find out who is registered.
router.post('/forgot', async (req, res, next) => {
  try {
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const wait = forgotByPhone.blockedFor(phone);
    if (wait) return res.status(429).json({ error: `Too many requests for this number. Try again in ${waitText(wait)}.` });
    forgotByPhone.hit(phone);

    const found = await db.query('SELECT user_id, name, email FROM users WHERE phone = $1 AND active = true', [phone]);
    const user = found.rows[0];
    if (user && user.email && isConfigured()) {
      inBackground('RESET EMAIL', async () => {
        const { code } = await createResetCode(user.user_id, { ttlMinutes: 60 });
        const { html, text } = composeEmail({
          heading: 'Your TFNN password reset code',
          paragraphs: [`Hi ${user.name}, your reset code is ${code}.`, 'Type it into TFNN with your new password. It works once and expires in 1 hour.', 'If you did not ask for this, ignore this email. Your password stays the same.'],
        });
        await sendEmail({ to: user.email, subject: 'Your TFNN password reset code', text, html, kind: 'password_reset', userId: user.user_id });
      });
    }
    res.json({
      message: 'If this number has an email address saved, a reset code is on its way to it. If no email arrives, ask TFNN support for a reset code.',
      support: process.env.SUPPORT_CONTACT || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/reset - set a new password with a reset code
router.post('/reset', async (req, res, next) => {
  try {
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const code = typeof req.body.code === 'string' || typeof req.body.code === 'number' ? String(req.body.code).trim() : '';
    const { new_password } = req.body;
    if (!phone || !code || typeof new_password !== 'string') {
      return res.status(400).json({ error: 'phone, code and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const ip = ipKey(req);
    const wait = ip ? resetByIp.blockedFor(ip) : 0;
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${waitText(wait)}.` });

    const ok = await redeemResetCode(phone, code, new_password);
    if (!ok) {
      if (ip) resetByIp.hit(ip);
      return res.status(400).json({ error: 'That code is wrong or has expired. Check it, or ask for a new one.' });
    }
    loginByPhone.clear(phone);
    res.json({ message: 'Password changed. You can log in with the new password now.' });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT user_id, name, phone, role, farm_location, approved, created_at FROM users WHERE user_id = $1',
      [req.auth.user_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
