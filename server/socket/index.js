const mongoose = require('mongoose');
const Room = require('../models/Room');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');
const { fileVersion, updateRoomFile } = require('../services/roomFiles');
const { emitRoomEvent, roomChannel } = require('./access');
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

function validPosition(position) {
  return position &&
    Number.isInteger(position.lineNumber) &&
    position.lineNumber >= 1 &&
    position.lineNumber <= 100000 &&
    Number.isInteger(position.column) &&
    position.column >= 1 &&
    position.column <= 100000;
}

function validSelection(selection) {
  return selection === null || (
    selection &&
    validPosition({ lineNumber: selection.startLineNumber, column: selection.startColumn }) &&
    validPosition({ lineNumber: selection.endLineNumber, column: selection.endColumn })
  );
}

function configureSocket(io, { cookieName, jwtSecret, issuer }) {
  const presenceByRoom = new Map();
  const cursorsByRoom = new Map();

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
    await clearSocketCursor(socket, roomId);
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

  async function clearSocketCursor(socket, roomId, fileId = null) {
    const roomCursors = cursorsByRoom.get(roomId);
    const current = roomCursors?.get(socket.id);
    if (!current || (fileId && current.fileId !== fileId)) return false;
    roomCursors.delete(socket.id);
    if (roomCursors.size === 0) cursorsByRoom.delete(roomId);
    await emitRoomEvent(io, roomId, EVENTS.CURSOR_CLEAR, {
      roomId,
      cursorId: socket.id,
      userId: socket.data.user.id,
      fileId: current.fileId,
    }, socket.id);
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
        const room = await Room.findById(roomId).select('_id owner members files').lean();
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
        socket.emit(EVENTS.EDITOR_STATE, {
          roomId,
          files: room.files.map((file) => ({
            ...file,
            id: file._id.toString(),
            version: fileVersion(file),
          })),
        });
        socket.emit(EVENTS.CURSOR_STATE, {
          roomId,
          cursors: [...(cursorsByRoom.get(roomId)?.values() || [])],
        });
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

    socket.on(EVENTS.CURSOR_UPDATE, async (payload, callback) => {
      const { roomId, fileId, position, selection = null, sequence } = payload || {};
      if (
        !mongoose.isObjectIdOrHexString(roomId) ||
        !mongoose.isObjectIdOrHexString(fileId) ||
        !validPosition(position) ||
        !validSelection(selection) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1
      ) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_CURSOR',
          message: 'Provide valid file cursor coordinates.',
        });
      }
      if (!socket.data.joinedRooms.has(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_NOT_JOINED',
          message: 'Join the room before sharing a cursor.',
        });
      }
      const now = Date.now();
      if (now - (socket.data.lastCursorAt || 0) < 40) {
        return acknowledge(socket, callback, { success: true });
      }
      socket.data.lastCursorAt = now;

      try {
        const userId = socket.data.user.id;
        const room = await Room.findOne({
          _id: roomId,
          $or: [{ owner: userId }, { members: userId }],
          'files._id': fileId,
        })
          .select('_id')
          .lean();
        if (!room) {
          const isMember = await Room.exists({
            _id: roomId,
            $or: [{ owner: userId }, { members: userId }],
          });
          if (!isMember) {
            await clearSocketCursor(socket, roomId);
            socket.emit(EVENTS.ROOM_ERROR, {
              code: 'ROOM_ACCESS_REVOKED',
              message: 'Your access to this room has changed.',
            });
            socket.disconnect(true);
            return;
          }
          await clearSocketCursor(socket, roomId);
          return acknowledge(socket, callback, {
            success: false,
            code: 'FILE_NOT_FOUND',
            message: 'The room file no longer exists.',
          });
        }

        const cursor = {
          cursorId: socket.id,
          roomId,
          fileId,
          userId,
          username: socket.data.user.username,
          position: { lineNumber: position.lineNumber, column: position.column },
          selection: selection && {
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn,
          },
        };
        let roomCursors = cursorsByRoom.get(roomId);
        if (!roomCursors) {
          roomCursors = new Map();
          cursorsByRoom.set(roomId, roomCursors);
        }
        if ((roomCursors.get(socket.id)?.sequence || 0) >= sequence) {
          return acknowledge(socket, callback, { success: true });
        }
        cursor.sequence = sequence;
        roomCursors.set(socket.id, cursor);
        await emitRoomEvent(io, roomId, EVENTS.CURSOR_UPDATE, cursor, socket.id);
        return acknowledge(socket, callback, { success: true });
      } catch (error) {
        console.error('Socket cursor update failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'CURSOR_UPDATE_FAILED',
          message: 'Unable to share the editor cursor.',
        });
      }
    });

    socket.on(EVENTS.CURSOR_CLEAR, async (payload, callback) => {
      const { roomId, fileId } = payload || {};
      if (!mongoose.isObjectIdOrHexString(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_ROOM_ID',
          message: 'A valid room ID is required.',
        });
      }
      if (fileId !== undefined && !mongoose.isObjectIdOrHexString(fileId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_FILE_ID',
          message: 'A valid file ID is required.',
        });
      }
      if (!socket.data.joinedRooms.has(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_NOT_JOINED',
          message: 'Join the room before clearing a cursor.',
        });
      }

      try {
        await clearSocketCursor(socket, roomId, fileId || null);
        return acknowledge(socket, callback, { success: true });
      } catch (error) {
        console.error('Socket cursor clear failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'CURSOR_CLEAR_FAILED',
          message: 'Unable to clear the editor cursor.',
        });
      }
    });

    socket.on(EVENTS.EDITOR_CHANGE, async (payload, callback) => {
      const roomId = payload?.roomId;
      const fileId = payload?.fileId;
      const { content, version, clientChangeId } = payload || {};
      if (
        !mongoose.isObjectIdOrHexString(roomId) ||
        !mongoose.isObjectIdOrHexString(fileId) ||
        typeof content !== 'string' ||
        Buffer.byteLength(content, 'utf8') > 100000 ||
        !Number.isInteger(version) ||
        version < 0 ||
        typeof clientChangeId !== 'string' ||
        clientChangeId.length > 100
      ) {
        const response = {
          success: false,
          code: 'INVALID_EDITOR_CHANGE',
          message: 'Provide a valid room, file, content, version, and change ID.',
        };
        return acknowledge(socket, callback, response);
      }
      if (!socket.data.joinedRooms.has(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_NOT_JOINED',
          message: 'Join the room before editing its files.',
        });
      }

      try {
        const result = await updateRoomFile({
          roomId,
          fileId,
          userId: socket.data.user.id,
          content,
          version,
        });
        if (result.status === 'forbidden') {
          if (result.reason === 'not-member') {
            socket.emit(EVENTS.ROOM_ERROR, {
              code: 'ROOM_ACCESS_REVOKED',
              message: result.message,
            });
            socket.disconnect(true);
          }
          return acknowledge(socket, callback, {
            success: false,
            code: 'EDIT_NOT_ALLOWED',
            message: result.message,
          });
        }
        if (result.status === 'not-found') {
          return acknowledge(socket, callback, {
            success: false,
            code: 'FILE_NOT_FOUND',
            message: 'The room or file no longer exists.',
          });
        }
        if (result.status === 'stale') {
          const response = {
            success: false,
            code: 'STALE_FILE',
            message: 'This file changed elsewhere. Review the latest version before continuing.',
            file: result.file,
          };
          socket.emit(EVENTS.EDITOR_CONFLICT, { roomId, file: result.file });
          return acknowledge(socket, callback, response);
        }

        const update = {
          roomId,
          file: result.file,
          actor: socket.data.user,
          clientChangeId,
        };
        await emitRoomEvent(io, roomId, EVENTS.EDITOR_UPDATE, update, socket.id);
        return acknowledge(socket, callback, { success: true, ...update });
      } catch (error) {
        console.error('Socket editor update failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'EDITOR_UPDATE_FAILED',
          message: 'Unable to persist the editor change.',
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

    socket.on('disconnecting', async () => {
      for (const roomId of socket.data.joinedRooms) {
        try {
          await clearSocketCursor(socket, roomId);
        } catch (error) {
          console.error('Socket cursor cleanup failed:', error);
        }
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
