const mongoose = require('mongoose');
const Room = require('../models/Room');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');
const EVENTS = require('./events');

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return cookies;
}

function roomChannel(roomId) {
  return `room:${roomId}`;
}

function listPresence(roomPresence) {
  return [...roomPresence.values()]
    .map(({ user }) => user)
    .sort((left, right) => left.username.localeCompare(right.username));
}

function acknowledge(socket, callback, response) {
  if (typeof callback === 'function') {
    callback(response);
  } else if (!response.success) {
    socket.emit(EVENTS.ROOM_ERROR, response);
  }
}

function configureSocket(io, { cookieName, jwtSecret, issuer }) {
  const presenceByRoom = new Map();

  io.use(async (socket, next) => {
    const token = parseCookies(socket.handshake.headers.cookie || '')[cookieName];
    if (!token) return next(new Error('Authentication required.'));

    let payload;
    try {
      payload = verifyToken(token, jwtSecret, issuer);
    } catch {
      return next(new Error('Authentication required.'));
    }

    try {
      const user = await User.findById(payload.sub).select('_id username');
      if (!user) return next(new Error('Authentication required.'));
      socket.data.user = { id: user.id, username: user.username };
      return next();
    } catch (error) {
      return next(error);
    }
  });

  async function leaveRoom(socket, roomId) {
    const joinedRooms = socket.data.joinedRooms;
    if (!joinedRooms?.has(roomId)) return false;

    const roomPresence = presenceByRoom.get(roomId);
    const userPresence = roomPresence?.get(socket.data.user.id);
    joinedRooms.delete(roomId);
    await socket.leave(roomChannel(roomId));

    if (!userPresence) return true;
    userPresence.sockets.delete(socket.id);
    if (userPresence.sockets.size === 0) {
      roomPresence.delete(socket.data.user.id);
      socket.to(roomChannel(roomId)).emit(EVENTS.PRESENCE_USER_OFFLINE, {
        roomId,
        user: userPresence.user,
      });
    }
    if (roomPresence.size === 0) presenceByRoom.delete(roomId);
    return true;
  }

  io.on('connection', (socket) => {
    socket.data.joinedRooms = new Set();

    socket.on(EVENTS.ROOM_JOIN, async (payload, callback) => {
      const roomId = typeof payload === 'string' ? payload : payload?.roomId;
      if (!mongoose.isObjectIdOrHexString(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_ROOM_ID',
          message: 'A valid room ID is required.',
        });
      }

      try {
        const room = await Room.findById(roomId).select('_id owner members').lean();
        const userId = socket.data.user.id;
        const isOwner = room?.owner.toString() === userId;
        const isMember = room?.members?.some((member) => member.toString() === userId) === true;
        if (!room || (!isOwner && !isMember)) {
          return acknowledge(socket, callback, {
            success: false,
            code: 'ROOM_ACCESS_DENIED',
            message: 'Room membership is required to join its live presence.',
          });
        }

        if (socket.data.joinedRooms.has(roomId)) {
          const currentPresence = presenceByRoom.get(roomId);
          return acknowledge(socket, callback, {
            success: true,
            roomId,
            users: listPresence(currentPresence || new Map()),
          });
        }

        await socket.join(roomChannel(roomId));
        socket.data.joinedRooms.add(roomId);
        let roomPresence = presenceByRoom.get(roomId);
        if (!roomPresence) {
          roomPresence = new Map();
          presenceByRoom.set(roomId, roomPresence);
        }

        let userPresence = roomPresence.get(userId);
        const becameOnline = !userPresence;
        if (!userPresence) {
          userPresence = {
            user: { id: userId, username: socket.data.user.username },
            sockets: new Set(),
          };
          roomPresence.set(userId, userPresence);
        }
        userPresence.sockets.add(socket.id);

        const users = listPresence(roomPresence);
        socket.emit(EVENTS.PRESENCE_SNAPSHOT, { roomId, users });
        if (becameOnline) {
          socket.to(roomChannel(roomId)).emit(EVENTS.PRESENCE_USER_ONLINE, {
            roomId,
            user: userPresence.user,
          });
        }
        return acknowledge(socket, callback, { success: true, roomId, users });
      } catch (error) {
        console.error('Socket room join failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_JOIN_FAILED',
          message: 'Unable to join live room presence.',
        });
      }
    });

    socket.on(EVENTS.ROOM_LEAVE, async (payload, callback) => {
      const roomId = typeof payload === 'string' ? payload : payload?.roomId;
      if (!mongoose.isObjectIdOrHexString(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_ROOM_ID',
          message: 'A valid room ID is required.',
        });
      }

      try {
        await leaveRoom(socket, roomId);
        return acknowledge(socket, callback, { success: true, roomId });
      } catch (error) {
        console.error('Socket room leave failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_LEAVE_FAILED',
          message: 'Unable to leave live room presence.',
        });
      }
    });

    socket.on('disconnecting', () => {
      for (const roomId of socket.data.joinedRooms) {
        const roomPresence = presenceByRoom.get(roomId);
        const userPresence = roomPresence?.get(socket.data.user.id);
        if (!userPresence) continue;
        userPresence.sockets.delete(socket.id);
        if (userPresence.sockets.size === 0) {
          roomPresence.delete(socket.data.user.id);
          socket.to(roomChannel(roomId)).emit(EVENTS.PRESENCE_USER_OFFLINE, {
            roomId,
            user: userPresence.user,
          });
        }
        if (roomPresence.size === 0) presenceByRoom.delete(roomId);
      }
      socket.data.joinedRooms.clear();
    });
  });
}

module.exports = configureSocket;
