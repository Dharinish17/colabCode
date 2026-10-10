const mongoose = require('mongoose');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');
const { fileVersion, updateRoomFile } = require('../services/roomFiles');
const {
  emitRoomEvent,
  roomChannel,
  userChannel,
  voiceChannel,
} = require('./access');
const EVENTS = require('./events');

const MAX_VOICE_PARTICIPANTS = 6;

function memberRolePath(userId) {
  return `memberRoles.${userId}`;
}

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

function acknowledgeVoice(socket, callback, response) {
  if (typeof callback === 'function') {
    callback(response);
  } else if (!response.success) {
    socket.emit(EVENTS.VOICE_ERROR, response);
  }
}

function voiceRole(room, userId) {
  if (room.owner.toString() === userId) return 'owner';
  if (!(room.members || []).some((member) => member.toString() === userId)) return null;
  const roles = room.memberRoles instanceof Map ? room.memberRoles : room.memberRoles || {};
  const role = typeof roles.get === 'function' ? roles.get(userId) : roles[userId];
  return role === 'moderator' ? 'moderator' : 'member';
}

function canUserSpeak(room, userId) {
  const role = voiceRole(room, userId);
  if (!role) return false;
  if (role !== 'member') return true;

  const overrides = room.voicePermissions?.memberOverrides;
  const override = typeof overrides?.get === 'function'
    ? overrides.get(userId)
    : overrides?.[userId];
  return typeof override === 'boolean'
    ? override
    : room.voicePermissions?.membersCanSpeak !== false;
}

function publicVoiceParticipant(participant) {
  return {
    socketId: participant.socketId,
    userId: participant.userId,
    username: participant.username,
    canSpeak: participant.canSpeak,
    microphoneEnabled: participant.microphoneEnabled,
  };
}

function validVoiceSignal(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (type === 'offer' || type === 'answer') {
    const mediaSections = typeof data.sdp === 'string'
      ? data.sdp.match(/^m=.*$/gm) || []
      : [];
    return data.type === type &&
      typeof data.sdp === 'string' &&
      data.sdp.length > 0 &&
      Buffer.byteLength(data.sdp, 'utf8') <= 65536 &&
      mediaSections.length > 0 &&
      mediaSections.every((section) => /^m=audio\s/.test(section));
  }
  if (type === 'ice-candidate') {
    if (data.candidate === null) return true;
    return typeof data.candidate === 'string' &&
      data.candidate.length <= 4096 &&
      (data.sdpMid === null || typeof data.sdpMid === 'string') &&
      (data.sdpMid === null || data.sdpMid.length <= 256) &&
      (data.sdpMLineIndex === null ||
        (Number.isInteger(data.sdpMLineIndex) && data.sdpMLineIndex >= 0 && data.sdpMLineIndex <= 65535)) &&
      (data.usernameFragment === undefined ||
        (typeof data.usernameFragment === 'string' && data.usernameFragment.length <= 256));
  }
  return false;
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
  const voiceByRoom = new Map();

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
    await leaveVoiceRoom(socket, roomId);
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

  async function leaveVoiceRoom(socket, roomId) {
    if (!socket.data.voiceRooms?.has(roomId)) return false;

    socket.data.voiceRooms.delete(roomId);
    const participants = voiceByRoom.get(roomId);
    const participant = participants?.get(socket.id);
    participants?.delete(socket.id);
    await socket.leave(voiceChannel(roomId));
    if (participants?.size === 0) voiceByRoom.delete(roomId);
    if (participant) {
      socket.to(voiceChannel(roomId)).emit(EVENTS.VOICE_PARTICIPANT_LEFT, {
        roomId,
        socketId: socket.id,
        userId: participant.userId,
      });
    }
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
    socket.data.voiceRooms = new Set();
    socket.join(userChannel(socket.data.user.id));

    socket.on(EVENTS.VOICE_JOIN, async (payload, callback) => {
      const roomId = payload?.roomId;
      if (!mongoose.isObjectIdOrHexString(roomId)) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_ROOM_ID',
          message: 'A valid room ID is required to join voice chat.',
        });
      }

      try {
        const room = await Room.findById(roomId)
          .select('_id owner members memberRoles voicePermissions')
          .lean();
        const userId = socket.data.user.id;
        const role = room ? voiceRole(room, userId) : null;
        if (!room || !role) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_ACCESS_DENIED',
            message: 'Room membership is required to join voice chat.',
          });
        }

        if (socket.data.voiceRooms.has(roomId)) {
          const current = voiceByRoom.get(roomId);
          return acknowledgeVoice(socket, callback, {
            success: true,
            roomId,
            participants: [...(current?.values() || [])].map(publicVoiceParticipant),
            canSpeak: canUserSpeak(room, userId),
          });
        }

        let participants = voiceByRoom.get(roomId);
        if (!participants) {
          participants = new Map();
          voiceByRoom.set(roomId, participants);
        }
        if (participants.size >= MAX_VOICE_PARTICIPANTS) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_ROOM_FULL',
            message: `Voice chat is limited to ${MAX_VOICE_PARTICIPANTS} connections per room.`,
          });
        }

        const participant = {
          socketId: socket.id,
          userId,
          username: socket.data.user.username,
          canSpeak: canUserSpeak(room, userId),
          microphoneEnabled: false,
        };
        participants.set(socket.id, participant);
        socket.data.voiceRooms.add(roomId);
        await socket.join(voiceChannel(roomId));
        const snapshot = [...participants.values()].map(publicVoiceParticipant);
        socket.emit(EVENTS.VOICE_STATE, {
          roomId,
          participants: snapshot,
          canSpeak: participant.canSpeak,
        });
        socket.to(voiceChannel(roomId)).emit(EVENTS.VOICE_PARTICIPANT_JOINED, {
          roomId,
          participant: publicVoiceParticipant(participant),
        });
        return acknowledgeVoice(socket, callback, {
          success: true,
          roomId,
          participants: snapshot,
          canSpeak: participant.canSpeak,
        });
      } catch (error) {
        if (socket.data.voiceRooms.has(roomId)) {
          try {
            await leaveVoiceRoom(socket, roomId);
          } catch (cleanupError) {
            console.error('Socket voice join cleanup failed:', cleanupError);
          }
        }
        console.error('Socket voice join failed:', error);
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_JOIN_FAILED',
          message: 'Unable to join room voice chat.',
        });
      }
    });

    socket.on(EVENTS.VOICE_LEAVE, async (payload, callback) => {
      const roomId = payload?.roomId;
      if (!mongoose.isObjectIdOrHexString(roomId)) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_ROOM_ID',
          message: 'A valid room ID is required to leave voice chat.',
        });
      }
      try {
        await leaveVoiceRoom(socket, roomId);
        return acknowledgeVoice(socket, callback, { success: true, roomId });
      } catch (error) {
        console.error('Socket voice leave failed:', error);
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_LEAVE_FAILED',
          message: 'Unable to leave room voice chat cleanly.',
        });
      }
    });

    socket.on(EVENTS.VOICE_SIGNAL, async (payload, callback) => {
      const { roomId, targetSocketId, type, data } = payload || {};
      if (
        !mongoose.isObjectIdOrHexString(roomId) ||
        typeof targetSocketId !== 'string' ||
        targetSocketId.length > 64 ||
        !validVoiceSignal(type, data)
      ) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_VOICE_SIGNAL',
          message: 'The voice connection signal is invalid.',
        });
      }
      if (!socket.data.voiceRooms.has(roomId)) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_ROOM_NOT_JOINED',
          message: 'Join this room’s voice chat before sending connection signals.',
        });
      }
      if (targetSocketId === socket.id) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_VOICE_TARGET',
          message: 'A voice signal must target another room participant.',
        });
      }
      const now = Date.now();
      const recentSignals = (socket.data.voiceSignalTimes || [])
        .filter((timestamp) => now - timestamp < 10000);
      if (recentSignals.length >= 120) {
        socket.data.voiceSignalTimes = recentSignals;
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_SIGNAL_RATE_LIMITED',
          message: 'Too many voice connection updates. Please wait a moment.',
        });
      }
      socket.data.voiceSignalTimes = [...recentSignals, now];

      try {
        const participants = voiceByRoom.get(roomId);
        const sender = participants?.get(socket.id);
        const target = participants?.get(targetSocketId);
        if (!sender || !target) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_TARGET_NOT_PRESENT',
            message: 'The other participant is no longer in this room’s voice chat.',
          });
        }
        const sockets = await io.in(voiceChannel(roomId)).fetchSockets();
        const targetSocket = sockets.find((candidate) => candidate.id === targetSocketId);
        if (!targetSocket || targetSocket.data.user?.id !== target.userId) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_TARGET_NOT_PRESENT',
            message: 'The other participant is no longer connected.',
          });
        }
        targetSocket.emit(EVENTS.VOICE_SIGNAL, {
          roomId,
          from: publicVoiceParticipant(sender),
          type,
          data,
        });
        return acknowledgeVoice(socket, callback, { success: true });
      } catch (error) {
        console.error('Socket voice signal failed:', error);
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_SIGNAL_FAILED',
          message: 'Unable to relay the voice connection signal.',
        });
      }
    });

    socket.on(EVENTS.VOICE_MIC_STATE, async (payload, callback) => {
      const { roomId, enabled } = payload || {};
      if (!mongoose.isObjectIdOrHexString(roomId) || typeof enabled !== 'boolean') {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_VOICE_MIC_STATE',
          message: 'Provide a valid room and microphone state.',
        });
      }
      if (!socket.data.voiceRooms.has(roomId)) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_ROOM_NOT_JOINED',
          message: 'Join this room’s voice chat before changing microphone state.',
        });
      }

      try {
        const room = await Room.findById(roomId)
          .select('_id owner members memberRoles voicePermissions')
          .lean();
        const participant = voiceByRoom.get(roomId)?.get(socket.id);
        if (!room || !voiceRole(room, socket.data.user.id) || !participant) {
          await leaveVoiceRoom(socket, roomId);
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_ACCESS_REVOKED',
            message: 'Your room access no longer permits voice chat.',
          });
        }
        const canSpeak = canUserSpeak(room, socket.data.user.id);
        if (enabled && !canSpeak) {
          participant.canSpeak = false;
          participant.microphoneEnabled = false;
          socket.emit(EVENTS.VOICE_PARTICIPANT_UPDATED, {
            roomId,
            participant: publicVoiceParticipant(participant),
          });
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_MIC_NOT_ALLOWED',
            message: 'The room owner or a moderator has not enabled your microphone permission.',
          });
        }

        participant.canSpeak = canSpeak;
        participant.microphoneEnabled = enabled;
        const update = {
          roomId,
          participant: publicVoiceParticipant(participant),
        };
        io.to(voiceChannel(roomId)).emit(EVENTS.VOICE_PARTICIPANT_UPDATED, update);
        return acknowledgeVoice(socket, callback, { success: true, ...update });
      } catch (error) {
        console.error('Socket voice microphone state failed:', error);
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_MIC_STATE_FAILED',
          message: 'Unable to update room microphone state.',
        });
      }
    });

    socket.on(EVENTS.VOICE_PERMISSION_SET, async (payload, callback) => {
      const { roomId, targetUserId, allowed } = payload || {};
      if (
        !mongoose.isObjectIdOrHexString(roomId) ||
        typeof allowed !== 'boolean' ||
        (targetUserId !== undefined && targetUserId !== null &&
          !mongoose.isObjectIdOrHexString(targetUserId))
      ) {
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'INVALID_VOICE_PERMISSION',
          message: 'Provide a valid room, member, and microphone permission.',
        });
      }

      try {
        const room = await Room.findById(roomId)
          .select('_id owner members memberRoles voicePermissions')
          .lean();
        if (!room) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found.',
          });
        }
        const actorRole = voiceRole(room, socket.data.user.id);
        if (!['owner', 'moderator'].includes(actorRole)) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_PERMISSION_DENIED',
            message: 'Only the room owner or a moderator can manage microphone permissions.',
          });
        }

        const isIndividual = typeof targetUserId === 'string';
        if (isIndividual) {
          if (
            targetUserId === room.owner.toString() ||
            !room.members.some((member) => member.toString() === targetUserId) ||
            voiceRole(room, targetUserId) !== 'member'
          ) {
            return acknowledgeVoice(socket, callback, {
              success: false,
              code: 'INVALID_VOICE_PERMISSION_TARGET',
              message: 'Individual microphone permissions can only be changed for regular room members.',
            });
          }
        }

        const filter = actorRole === 'owner'
          ? { _id: roomId, owner: socket.data.user.id }
          : {
            _id: roomId,
            owner: room.owner,
            [memberRolePath(socket.data.user.id)]: 'moderator',
          };
        const update = isIndividual
          ? { $set: { [`voicePermissions.memberOverrides.${targetUserId}`]: allowed } }
          : {
            $set: { 'voicePermissions.membersCanSpeak': allowed },
            $unset: { 'voicePermissions.memberOverrides': '' },
          };
        const updated = await Room.findOneAndUpdate(filter, update, {
          returnDocument: 'after',
        }).select('_id owner members memberRoles voicePermissions').lean();
        if (!updated) {
          return acknowledgeVoice(socket, callback, {
            success: false,
            code: 'VOICE_PERMISSION_CHANGED',
            message: 'Room permissions changed before the update completed. Refresh and try again.',
          });
        }

        const participants = voiceByRoom.get(roomId);
        if (participants) {
          for (const participant of participants.values()) {
            participant.canSpeak = canUserSpeak(updated, participant.userId);
            if (!participant.canSpeak) participant.microphoneEnabled = false;
            io.to(voiceChannel(roomId)).emit(EVENTS.VOICE_PARTICIPANT_UPDATED, {
              roomId,
              participant: publicVoiceParticipant(participant),
            });
          }
        }
        const result = {
          roomId,
          scope: isIndividual ? 'member' : 'members',
          targetUserId: isIndividual ? targetUserId : null,
          allowed,
          updatedBy: {
            userId: socket.data.user.id,
            username: socket.data.user.username,
          },
        };
        io.to(voiceChannel(roomId)).emit(EVENTS.VOICE_PERMISSION_UPDATED, result);
        return acknowledgeVoice(socket, callback, { success: true, ...result });
      } catch (error) {
        console.error('Socket voice permission update failed:', error);
        return acknowledgeVoice(socket, callback, {
          success: false,
          code: 'VOICE_PERMISSION_UPDATE_FAILED',
          message: 'Unable to update room microphone permissions.',
        });
      }
    });

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

    socket.on(EVENTS.CHAT_SEND, async (payload, callback) => {
      const { roomId, body } = payload || {};
      const messageBody = typeof body === 'string' ? body.trim() : '';
      if (
        !mongoose.isObjectIdOrHexString(roomId) ||
        !messageBody ||
        messageBody.length > 2000 ||
        Buffer.byteLength(messageBody, 'utf8') > 8000
      ) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'INVALID_CHAT_MESSAGE',
          message: 'Messages must contain 1–2000 characters.',
        });
      }
      if (!socket.data.joinedRooms.has(roomId)) {
        return acknowledge(socket, callback, {
          success: false,
          code: 'ROOM_NOT_JOINED',
          message: 'Join the room before sending a chat message.',
        });
      }

      const now = Date.now();
      const recentMessages = (socket.data.chatMessageTimes || [])
        .filter((timestamp) => now - timestamp < 10000);
      if (recentMessages.length >= 10) {
        socket.data.chatMessageTimes = recentMessages;
        return acknowledge(socket, callback, {
          success: false,
          code: 'CHAT_RATE_LIMITED',
          message: 'You are sending messages too quickly. Please wait a few seconds.',
        });
      }
      socket.data.chatMessageTimes = [...recentMessages, now];

      try {
        const room = await Room.findOne({
          _id: roomId,
          $or: [{ owner: socket.data.user.id }, { members: socket.data.user.id }],
        }).select('_id');
        if (!room) {
          socket.emit(EVENTS.ROOM_ERROR, {
            code: 'ROOM_ACCESS_REVOKED',
            message: 'Your access to this room has changed.',
          });
          socket.disconnect(true);
          return;
        }

        const saved = await ChatMessage.create({
          room: room._id,
          sender: socket.data.user.id,
          senderUsername: socket.data.user.username,
          body: messageBody,
        });
        const message = {
          id: saved.id,
          sender: {
            id: socket.data.user.id,
            username: socket.data.user.username,
          },
          body: saved.body,
          createdAt: saved.createdAt,
        };
        await emitRoomEvent(io, roomId, EVENTS.CHAT_MESSAGE, { roomId, message });
        return acknowledge(socket, callback, { success: true, message });
      } catch (error) {
        console.error('Socket chat message failed:', error);
        return acknowledge(socket, callback, {
          success: false,
          code: 'CHAT_SEND_FAILED',
          message: 'Unable to send your message. Please try again.',
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
      for (const roomId of socket.data.voiceRooms) {
        try {
          await leaveVoiceRoom(socket, roomId);
        } catch (error) {
          console.error('Socket voice cleanup failed:', error);
        }
      }
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
