const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const configureSocket = require('./socket');

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
configureSocket(io, { cookieName: COOKIE_NAME, jwtSecret, issuer: JWT_ISSUER });
app.set('io', io);

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  if (req.get('origin') !== CLIENT_URL) {
    return res.status(403).json({
      success: false,
      message: 'Request origin is not allowed.',
    });
  }
  return next();
});
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
app.use('/api/rooms', roomRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'Collaborative editor API is running.',
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found.' });
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

  if (err.name === 'CastError' || err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: 'The request contains invalid data.' });
  }
  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'The request conflicts with existing data.' });
  }
  if (
    [
      'MongoNetworkError',
      'MongoNetworkTimeoutError',
      'MongoServerSelectionError',
      'MongooseServerSelectionError',
      'MongoTopologyClosedError',
      'MongoNotConnectedError',
    ]
      .includes(err.name)
  ) {
    console.error('Database operation unavailable:', {
      errorName: err.name,
      method: req.method,
      path: req.path,
    });
    return res.status(503).json({
      success: false,
      message: 'The database is temporarily unavailable. Please try again later.',
    });
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('Request failed:', {
      errorName: err.name || 'Error',
      method: req.method,
      path: req.path,
    });
  } else {
    console.error('Request failed:', err);
  }
  return res.status(500).json({ success: false, message: 'An unexpected server error occurred.' });
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
