const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 'admin' is deliberately excluded - it can never be self-selected at signup.
// Admin accounts can only be created by an existing admin.
const PUBLIC_ROLES = ['farmer', 'supplier', 'vet'];

// POST /api/v1/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, phone, password, role, farm_location } = req.body;

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

    const password_hash = await bcrypt.hash(password, 10);
    // Farmers are usable right away. Supplier/vet claims need a human to check
    // before that account can act as one - it's created but can't log in yet.
    const approved = role === 'farmer';

    const result = await db.query(
      `INSERT INTO users (name, phone, password_hash, role, farm_location, approved)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING user_id, name, phone, role, farm_location, approved, created_at`,
      [name, phone, password_hash, role, farm_location || null, approved]
    );

    const user = result.rows[0];

    if (!approved) {
      return res.status(201).json({
        user,
        message: 'Account created. Supplier and vet accounts must be approved by an admin before you can log in.',
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

    const result = await db.query('SELECT * FROM users WHERE phone = $1 AND active = true', [phone]);
    const user = result.rows[0];

    // Same generic error whether the phone doesn't exist or the password is wrong -
    // never reveal which one it was, that helps account enumeration attacks.
    if (!user) {
      return res.status(401).json({ error: 'Invalid phone or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid phone or password' });
    }

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

    const result = await db.query(
      'SELECT user_id, role FROM users WHERE user_id = $1 AND active = true AND approved = true',
      [payload.sub]
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
