const jwt = require('jsonwebtoken');
const User = require('../models/User');

function verifyToken(token, secret, issuer) {
  const payload = jwt.verify(token, secret, { issuer });
  if (!payload || typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('Invalid authentication token.');
  }
  return payload;
}

function requireAuth(req, res, next) {
  const token = req.cookies[req.app.get('cookieName')];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  let payload;
  try {
    payload = verifyToken(token, req.app.get('jwtSecret'), 'colabCode');
  } catch {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  User.findById(payload.sub)
    .select('_id username email')
    .then((user) => {
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }
      req.user = user;
      return next();
    })
    .catch(next);
}

module.exports = { requireAuth, verifyToken };
