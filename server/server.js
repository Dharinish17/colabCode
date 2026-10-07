const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const User = require('./models/User');
const { verifyToken } = require('./middleware/auth');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.SERVER_PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const COOKIE_NAME = 'auth_token';
const JWT_ISSUER = 'colabCode';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('JWT_SECRET must be set to a secret of at least 32 bytes.');
  }
  return secret;
}

const jwtSecret = getJwtSecret();
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    credentials: true,
  },
});

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.set('jwtSecret', jwtSecret);
app.set('cookieName', COOKIE_NAME);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    mongoConfigured: Boolean(process.env.MONGODB_URI),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'Collaborative editor API is running.',
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid JSON request body.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body is too large.' });
  }

  console.error('Request failed:', err);
  return res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
});

io.use(async (socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const cookies = cookieHeader.split(';').reduce((parsed, part) => {
    const separator = part.indexOf('=');
    if (separator > -1) {
      try {
        parsed[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        parsed[part.slice(0, separator).trim()] = '';
      }
    }
    return parsed;
  }, {});
  const token = cookies[COOKIE_NAME];

  if (!token) {
    return next(new Error('Authentication required.'));
  }

  let payload;
  try {
    payload = verifyToken(token, jwtSecret, JWT_ISSUER);
  } catch {
    return next(new Error('Authentication required.'));
  }

  try {
    const user = await User.findById(payload.sub).select('_id username email');
    if (!user) {
      return next(new Error('Authentication required.'));
    }

    socket.data.user = {
      id: user.id,
      username: user.username,
      email: user.email,
    };
    return next();
  } catch (err) {
    return next(err);
  }
});

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI must be configured before starting the server.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Unable to start server:', err);
  process.exitCode = 1;
});

module.exports = { app, io, server };
