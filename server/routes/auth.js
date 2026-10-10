const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function cookieAttributes() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  };
}

function cookieOptions() {
  return {
    ...cookieAttributes(),
    maxAge: TOKEN_LIFETIME_MS,
  };
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
  };
}

function isValidEmail(email) {
  return typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/register', async (req, res, next) => {
  const { username, email, password, confirmPassword } = req.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (
    !/^[a-zA-Z0-9_-]{3,30}$/.test(normalizedUsername) ||
    !isValidEmail(normalizedEmail) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    typeof confirmPassword !== 'string' ||
    password !== confirmPassword
  ) {
    return res.status(400).json({
      success: false,
      message: 'Provide a valid username and email, a password of 8–72 bytes, and matching confirmation.',
    });
  }

  try {
    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
    }).select('_id');
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email or username already exists.',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      username: normalizedUsername,
      email: normalizedEmail,
      passwordHash,
    });
    return res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email or username already exists.',
      });
    }
    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (
    !isValidEmail(email) ||
    typeof password !== 'string' ||
    !password ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and password.' });
  }

  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
    }

    const token = jwt.sign({}, req.app.get('jwtSecret'), {
      subject: user.id,
      issuer: 'colabCode',
      expiresIn: '7d',
    });
    res.cookie(req.app.get('cookieName'), token, cookieOptions());
    return res.json({ success: true, user: safeUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(req.app.get('cookieName'), cookieAttributes());
  return res.json({ success: true, message: 'Logged out.' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: safeUser(req.user) });
});

module.exports = router;