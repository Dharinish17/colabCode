const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const Room = require('../models/Room');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const { LANGUAGE_EXTENSIONS, SUPPORTED_LANGUAGES } = require('../constants/languages');
const { requireAuth } = require('../middleware/auth');
const { executeCode, MAX_CODE_BYTES } = require('../services/codeExecution');
const {
  createRoomFile,
  deleteRoomFile,
  renameRoomFile,
  updateRoomFile,
} = require('../services/roomFiles');
const {
  disconnectRoom,
  disconnectRoomUser,
  emitRoomEvent,
  emitUserEvent,
} = require('../socket/access');
const SOCKET_EVENTS = require('../socket/events');

const router = express.Router();
const executionRequestsByUser = new Map();

router.use(requireAuth);

function serializeRoom(room, userId) {
  const ownerId = room.owner._id ? room.owner._id.toString() : room.owner.toString();
  const members = room.members || [];
  const isOwner = ownerId === userId;
  const isMember = members.some((member) => memberId(member) === userId);
  const roles = room.memberRoles instanceof Map
    ? Object.fromEntries(room.memberRoles)
    : room.memberRoles || {};
  const currentRequest = (room.accessRequests || []).find((request) => {
    const requestUserId = request.user._id ? request.user._id.toString() : request.user.toString();
    return requestUserId === userId;
  });

  return {
    id: room.id,
    title: room.title,
    description: room.description,
    visibility: room.visibility,
    owner: room.owner.username
      ? { id: ownerId, username: room.owner.username }
      : { id: ownerId },
    memberCount: members.length + 1,
    maxMembers: room.maxMembers,
    members: [
      { id: ownerId, username: room.owner.username || 'Owner', role: 'owner' },
      ...members.map((member) => {
        const id = memberId(member);
        return {
          id,
          username: member.username || 'Member',
          role: roles[id] || 'member',
        };
      }),
    ],
    settings: {
      defaultLanguage: room.settings?.defaultLanguage || 'javascript',
      allowGuests: room.settings?.allowGuests === true,
      allowMemberEdits: room.settings?.allowMemberEdits !== false,
    },
    files: (room.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      language: file.language,
      content: file.content,
      version: Number.isInteger(file.version) ? file.version : 0,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    })),
    accessRequestStatus: currentRequest?.status || null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    isOwner,
    isMember,
    currentRole: isOwner ? 'owner' : isMember ? roleFor(room, userId) : null,
  };
}

function memberId(member) {
  return member._id ? member._id.toString() : member.toString();
}

function roleFor(room, userId) {
  if ((room.owner._id ? room.owner._id.toString() : room.owner.toString()) === userId.toString()) {
    return 'owner';
  }
  const roles = room.memberRoles instanceof Map
    ? room.memberRoles
    : new Map(Object.entries(room.memberRoles || {}));
  return roles.get(userId.toString()) || 'member';
}

function canManageMembers(room, userId) {
  return ['owner', 'moderator'].includes(roleFor(room, userId));
}

function roomManagerIds(room) {
  const ownerId = memberId(room.owner);
  const roles = room.memberRoles instanceof Map
    ? room.memberRoles
    : new Map(Object.entries(room.memberRoles || {}));
  return [
    ownerId,
    ...(room.members || [])
      .filter((member) => roles.get(memberId(member)) === 'moderator')
      .map(memberId),
  ];
}

function notifyRoomManagers(io, room, event, payload, additionalUserIds = []) {
  const recipients = new Set([...roomManagerIds(room), ...additionalUserIds.map(String)]);
  for (const userId of recipients) {
    emitUserEvent(io, userId, event, payload);
  }
}

function memberRolePath(userId) {
  return `memberRoles.${userId.toString()}`;
}

function checkExecutionRateLimit(userId) {
  const now = Date.now();
  if (executionRequestsByUser.size > 5000) {
    for (const [id, timestamps] of executionRequestsByUser) {
      if (timestamps.every((timestamp) => now - timestamp >= 60000)) {
        executionRequestsByUser.delete(id);
      }
    }
  }
  const recent = (executionRequestsByUser.get(userId) || [])
    .filter((timestamp) => now - timestamp < 60000);
  if (recent.length >= 5) {
    executionRequestsByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  executionRequestsByUser.set(userId, recent);
  return true;
}

function validateFileInput(body) {
  const { name, language } = body || {};
  if (
    typeof name !== 'string' ||
    typeof language !== 'string' ||
    !SUPPORTED_LANGUAGES.includes(language)
  ) {
    return { error: 'Provide a file name and a supported language.' };
  }

  const normalizedName = name.trim();
  if (
    normalizedName.length > 100 ||
    !normalizedName ||
    normalizedName === '.' ||
    normalizedName === '..' ||
    /[<>:"|?*/\\\u0000-\u001F\u007F]/.test(normalizedName)
  ) {
    return { error: 'File names must be 1–100 characters and cannot contain path separators or reserved characters.' };
  }

  const extension = LANGUAGE_EXTENSIONS[language];
  if (
    !normalizedName.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ||
    normalizedName.length <= extension.length + 1
  ) {
    return { error: `Choose a file name ending in .${extension} for ${language}.` };
  }
  return { name: normalizedName, language };
}

async function sendFileOperationResult(req, res, roomId, result, action) {
  if (result.status !== 'updated') {
    const status = {
      'not-found': 404,
      forbidden: 403,
      duplicate: 409,
      conflict: 409,
    }[result.status] || 500;
    const message = {
      'not-found': 'Room or file not found.',
      forbidden: 'Only the room owner or a moderator can manage files.',
      duplicate: 'A file with that name already exists.',
      conflict: 'The file changed before this operation completed. Please try again.',
    }[result.status] || 'Unable to update the room files.';
    return res.status(status).json({ success: false, message });
  }

  const populated = await roomById(roomId);
  if (!populated) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  const room = serializeRoom(populated, req.user.id);
  await emitRoomEvent(req.app.get('io'), roomId, SOCKET_EVENTS.FILES_UPDATE, {
    roomId,
    files: room.files,
    action,
    actor: { id: req.user.id, username: req.user.username },
  });
  return res.json({
    success: true,
    room,
    ...(result.file ? { file: result.file } : {}),
  });
}

function roomQuery() {
  return Room.find()
    .populate('owner', '_id username')
    .populate('members', '_id username');
}

function roomById(id) {
  return Room.findById(id)
    .populate('owner', '_id username')
    .populate('members', '_id username');
}

async function loadRoom(roomId, userId) {
  const room = await roomById(roomId);
  if (!room) return null;
  const isOwner = room.owner._id.toString() === userId.toString();
  const isMember = room.members.some((member) => member._id.toString() === userId.toString());
  if (room.visibility === 'private' && !isOwner && !isMember) {
    const request = room.accessRequests.find(
      (item) => item.user.toString() === userId.toString(),
    );
    if (!request) {
      return { room, canViewDetails: false, accessRequestStatus: null };
    }
    return { room, canViewDetails: false, accessRequestStatus: request.status };
  }
  return { room, canViewDetails: true, accessRequestStatus: null };
}

router.post('/', async (req, res, next) => {
  const {
    title,
    description = '',
    visibility = 'public',
    maxMembers = 10,
    defaultLanguage = 'javascript',
    allowMemberEdits = true,
  } = req.body || {};
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  const normalizedDescription = typeof description === 'string' ? description.trim() : null;

  if (
    normalizedTitle.length < 3 ||
    normalizedTitle.length > 60 ||
    normalizedDescription === null ||
    normalizedDescription.length > 500 ||
    !['public', 'private'].includes(visibility) ||
    !Number.isInteger(maxMembers) ||
    maxMembers < 2 ||
    maxMembers > 50 ||
    !SUPPORTED_LANGUAGES.includes(defaultLanguage) ||
    typeof allowMemberEdits !== 'boolean'
  ) {
    return res.status(400).json({
      success: false,
      message: 'Provide a 3–60 character title, a description up to 500 characters, public or private visibility, a capacity from 2 to 50, and a supported default language.',
    });
  }

  try {
    const room = await Room.create({
      title: normalizedTitle,
      description: normalizedDescription,
      visibility,
      maxMembers,
      settings: { defaultLanguage, allowGuests: false, allowMemberEdits },
      files: [{
        name: `main.${LANGUAGE_EXTENSIONS[defaultLanguage]}`,
        language: defaultLanguage,
        content: '',
      }],
      owner: req.user._id,
    });
    const populated = await roomById(room._id);
    return res.status(201).json({
      success: true,
      room: serializeRoom(populated, req.user.id),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/mine', async (req, res, next) => {
  try {
    const rooms = await roomQuery()
      .or([{ owner: req.user._id }, { members: req.user._id }])
      .sort({ updatedAt: -1 })
      .limit(50);
    return res.json({
      success: true,
      rooms: rooms.map((room) => serializeRoom(room, req.user.id)),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/', async (req, res, next) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
  const filter = {
    visibility: 'public',
    owner: { $ne: req.user._id },
    members: { $ne: req.user._id },
    $expr: {
      $lt: [
        { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] },
        '$maxMembers',
      ],
    },
  };

  if (search) {
    const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { title: { $regex: safeSearch, $options: 'i' } },
      { description: { $regex: safeSearch, $options: 'i' } },
    ];
  }

  try {
    const rooms = await roomQuery()
      .where(filter)
      .sort({ createdAt: -1 })
      .limit(30);
    return res.json({
      success: true,
      rooms: rooms.map((room) => serializeRoom(room, req.user.id)),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:roomId/join', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const roomId = new mongoose.Types.ObjectId(req.params.roomId);
    const existing = await roomById(roomId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const userId = req.user._id;
    const alreadyMember =
      existing.owner._id.toString() === userId.toString() ||
      existing.members.some((member) => member._id.toString() === userId.toString());
    if (alreadyMember) {
      return res.json({
        success: true,
        room: serializeRoom(existing, req.user.id),
      });
    }
    if (existing.visibility !== 'public') {
      return res.status(403).json({
        success: false,
        message: 'This room is private and is not open for joining.',
      });
    }

    const joined = await Room.findOneAndUpdate(
      {
        _id: roomId,
        visibility: 'public',
        owner: { $ne: userId },
        members: { $ne: userId },
        $expr: {
          $lt: [
            { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] },
            '$maxMembers',
          ],
        },
      },
      {
        $addToSet: { members: userId },
        $set: { [`memberRoles.${userId}`]: 'member' },
      },
      { returnDocument: 'after' },
    );

    if (!joined) {
      const latest = await roomById(roomId);
      if (!latest) {
        return res.status(404).json({ success: false, message: 'Room not found.' });
      }
      if (latest.members.some((member) => member._id.toString() === userId.toString())) {
        return res.json({
          success: true,
          room: serializeRoom(latest, req.user.id),
        });
      }
      return res.status(409).json({ success: false, message: 'This room is full.' });
    }

    const populated = await roomById(joined._id);
    return res.json({
      success: true,
      room: serializeRoom(populated, req.user.id),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:roomId/request-access', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const roomId = new mongoose.Types.ObjectId(req.params.roomId);
    const userId = req.user._id;
    const room = await Room.findOneAndUpdate(
      {
        _id: roomId,
        visibility: 'private',
        owner: { $ne: userId },
        members: { $ne: userId },
        'accessRequests.user': { $ne: userId },
      },
      { $push: { accessRequests: { user: userId, status: 'pending' } } },
      { returnDocument: 'after' },
    );

    if (room) {
      const accessRequest = room.accessRequests.find(
        (request) => request.user.toString() === userId.toString(),
      );
      notifyRoomManagers(
        req.app.get('io'),
        room,
        SOCKET_EVENTS.ACCESS_REQUEST_CREATED,
        {
          roomId: room.id,
          roomTitle: room.title,
          request: {
            user: { id: userId.toString(), username: req.user.username, email: req.user.email },
            status: 'pending',
            createdAt: accessRequest?.createdAt || new Date(),
          },
        },
      );
      return res.status(201).json({ success: true, status: 'pending' });
    }

    const existing = await Room.findById(roomId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    if (existing.visibility !== 'private') {
      return res.status(409).json({ success: false, message: 'This room is public; join it from discovery.' });
    }
    if (existing.owner.toString() === userId.toString() || existing.members.some((member) => member.toString() === userId.toString())) {
      return res.status(409).json({ success: false, message: 'You already have access to this room.' });
    }

    const accessRequest = existing.accessRequests.find((item) => item.user.toString() === userId.toString());
    if (accessRequest?.status === 'pending') {
      return res.json({ success: true, status: 'pending' });
    }
    if (accessRequest?.status === 'approved') {
      return res.status(409).json({ success: false, message: 'You already have access to this room.' });
    }

    if (accessRequest) {
      accessRequest.status = 'pending';
      accessRequest.createdAt = new Date();
      accessRequest.resolvedAt = null;
      await existing.save();
    }
    if (accessRequest) {
      notifyRoomManagers(
        req.app.get('io'),
        existing,
        SOCKET_EVENTS.ACCESS_REQUEST_CREATED,
        {
          roomId: existing.id,
          roomTitle: existing.title,
          request: {
            user: { id: userId.toString(), username: req.user.username, email: req.user.email },
            status: 'pending',
            createdAt: accessRequest.createdAt,
          },
        },
      );
    }
    return res.status(accessRequest ? 200 : 500).json(
      accessRequest
        ? { success: true, status: 'pending' }
        : { success: false, message: 'Unable to create the access request.' },
    );
  } catch (err) {
    return next(err);
  }
});

router.get('/:roomId/access-requests', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const room = await Room.findById(req.params.roomId)
      .populate('accessRequests.user', '_id username email');
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    const populatedRoom = await roomById(room._id);
    if (!canManageMembers(populatedRoom, req.user.id)) {
      return res.status(403).json({ success: false, message: 'Only the owner or a moderator can review access requests.' });
    }

    return res.json({
      success: true,
      requests: room.accessRequests.map((request) => ({
        user: {
          id: request.user.id,
          username: request.user.username,
          email: request.user.email,
        },
        status: request.status,
        createdAt: request.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:roomId/access-requests/:requesterId', async (req, res, next) => {
  const { roomId, requesterId } = req.params;
  const { decision } = req.body || {};
  if (
    !mongoose.isObjectIdOrHexString(roomId) ||
    !mongoose.isObjectIdOrHexString(requesterId)
  ) {
    return res.status(404).json({ success: false, message: 'Room or request not found.' });
  }
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
  }

  try {
    const room = await roomById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room or request not found.' });
    }
    if (!canManageMembers(room, req.user.id)) {
      return res.status(403).json({ success: false, message: 'Only the owner or a moderator can review access requests.' });
    }
    const actorRole = roleFor(room, req.user.id);
    const managerFilter = room.owner._id
      ? { _id: roomId, owner: room.owner._id }
      : { _id: roomId, owner: room.owner };
    const accessFilter = actorRole === 'moderator'
      ? { ...managerFilter, [memberRolePath(req.user._id)]: 'moderator' }
      : managerFilter;
    if (decision === 'approve') {
      const room = await Room.findOneAndUpdate(
        {
          ...accessFilter,
          'accessRequests': { $elemMatch: { user: requesterId, status: 'pending' } },
          members: { $ne: requesterId },
          $expr: {
            $lt: [
              { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] },
              '$maxMembers',
            ],
          },
        },
        {
          $addToSet: { members: requesterId },
          $set: {
            [`memberRoles.${requesterId}`]: 'member',
            'accessRequests.$[request].status': 'approved',
            'accessRequests.$[request].resolvedAt': new Date(),
          },
        },
        {
          returnDocument: 'after',
          arrayFilters: [{ 'request.user': requesterId, 'request.status': 'pending' }],
        },
      );
      if (room) {
        notifyRoomManagers(
          req.app.get('io'),
          room,
          SOCKET_EVENTS.ACCESS_REQUEST_RESOLVED,
          {
            roomId: room.id,
            roomTitle: room.title,
            requesterId,
            decision,
            actor: { id: req.user.id, username: req.user.username },
          },
          [requesterId],
        );
        return res.json({ success: true, decision, roomId: room.id });
      }
    } else {
      const room = await Room.findOneAndUpdate(
        {
          ...accessFilter,
          'accessRequests': { $elemMatch: { user: requesterId, status: 'pending' } },
        },
        {
          $set: {
            'accessRequests.$[request].status': 'rejected',
            'accessRequests.$[request].resolvedAt': new Date(),
          },
        },
        {
          returnDocument: 'after',
          arrayFilters: [{ 'request.user': requesterId, 'request.status': 'pending' }],
        },
      );
      if (room) {
        notifyRoomManagers(
          req.app.get('io'),
          room,
          SOCKET_EVENTS.ACCESS_REQUEST_RESOLVED,
          {
            roomId: room.id,
            roomTitle: room.title,
            requesterId,
            decision,
            actor: { id: req.user.id, username: req.user.username },
          },
          [requesterId],
        );
        return res.json({ success: true, decision, roomId: room.id });
      }
    }

    const latestRoom = await Room.findById(roomId).select('owner members maxMembers accessRequests');
    if (!latestRoom || !canManageMembers(await roomById(roomId), req.user.id)) {
      return res.status(latestRoom ? 403 : 404).json({
        success: false,
        message: latestRoom ? 'Only the owner or a moderator can review access requests.' : 'Room or request not found.',
      });
    }
    if (
      decision === 'approve' &&
      latestRoom.accessRequests.some((request) => request.user.toString() === requesterId && request.status === 'pending') &&
      latestRoom.members.length + 1 >= latestRoom.maxMembers
    ) {
      return res.status(409).json({ success: false, message: 'The room is full; increase its capacity before approving this request.' });
    }
    return res.status(409).json({ success: false, message: 'No pending request exists for this user.' });
  } catch (err) {
    return next(err);
  }
});

router.get('/:roomId/messages', async (req, res, next) => {
  const { roomId } = req.params;
  const { before } = req.query;
  if (!mongoose.isObjectIdOrHexString(roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  if (before !== undefined && !mongoose.isObjectIdOrHexString(before)) {
    return res.status(400).json({ success: false, message: 'The message history cursor is invalid.' });
  }

  try {
    const room = await Room.findOne({
      _id: roomId,
      $or: [{ owner: req.user._id }, { members: req.user._id }],
    }).select('_id');
    if (!room) {
      const exists = await Room.exists({ _id: roomId });
      return res.status(exists ? 403 : 404).json({
        success: false,
        message: exists ? 'Room membership is required to view chat history.' : 'Room not found.',
      });
    }

    const filter = { room: room._id };
    if (before) filter._id = { $lt: new mongoose.Types.ObjectId(before) };
    const results = await ChatMessage.find(filter)
      .sort({ _id: -1 })
      .limit(51)
      .lean();
    const hasMore = results.length > 50;
    const messages = results.slice(0, 50).reverse().map((message) => ({
      id: message._id.toString(),
      sender: {
        id: message.sender.toString(),
        username: message.senderUsername,
      },
      body: message.body,
      createdAt: message.createdAt,
    }));
    return res.json({
      success: true,
      messages,
      hasMore,
      nextBefore: hasMore ? messages[0].id : null,
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:roomId', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  const {
    title,
    description,
    visibility,
    maxMembers,
    defaultLanguage,
    allowMemberEdits,
  } = req.body || {};
  const bodyFields = Object.keys(req.body || {});
  const allowedFields = ['title', 'description', 'visibility', 'maxMembers', 'defaultLanguage', 'allowMemberEdits'];
  if (bodyFields.some((field) => !allowedFields.includes(field))) {
    return res.status(400).json({ success: false, message: 'Unsupported room setting.' });
  }
  const updates = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 60) {
      return res.status(400).json({ success: false, message: 'Room title must be 3–60 characters.' });
    }
    updates.title = title.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || description.trim().length > 500) {
      return res.status(400).json({ success: false, message: 'Room description must be 500 characters or fewer.' });
    }
    updates.description = description.trim();
  }
  if (visibility !== undefined) {
    if (!['public', 'private'].includes(visibility)) {
      return res.status(400).json({ success: false, message: 'Visibility must be public or private.' });
    }
    updates.visibility = visibility;
  }
  if (maxMembers !== undefined) {
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 50) {
      return res.status(400).json({ success: false, message: 'Room capacity must be between 2 and 50.' });
    }
    updates.maxMembers = maxMembers;
  }
  if (defaultLanguage !== undefined) {
    if (!SUPPORTED_LANGUAGES.includes(defaultLanguage)) {
      return res.status(400).json({ success: false, message: 'Choose a supported default language.' });
    }
    updates['settings.defaultLanguage'] = defaultLanguage;
  }
  if (allowMemberEdits !== undefined) {
    if (typeof allowMemberEdits !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Member edit permission must be true or false.' });
    }
    updates['settings.allowMemberEdits'] = allowMemberEdits;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, message: 'Provide at least one room setting to update.' });
  }

  try {
    const existingRoom = await roomById(req.params.roomId);
    if (!existingRoom) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    const actorRole = roleFor(existingRoom, req.user.id);
    if (!['owner', 'moderator'].includes(actorRole)) {
      return res.status(403).json({ success: false, message: 'Only the owner or a moderator can update room settings.' });
    }
    if (
      actorRole === 'moderator' &&
      bodyFields.some((field) => !['description', 'defaultLanguage', 'allowMemberEdits'].includes(field))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Moderators may update the description, default language, and member edit permission only.',
      });
    }
    const filter = actorRole === 'owner'
      ? { _id: req.params.roomId, owner: req.user._id }
      : { _id: req.params.roomId, [memberRolePath(req.user._id)]: 'moderator' };
    if (maxMembers !== undefined) {
      filter.$expr = {
        $lte: [
          { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] },
          maxMembers,
        ],
      };
    }
    const room = await Room.findOneAndUpdate(
      filter,
      { $set: updates },
      { returnDocument: 'after', runValidators: true },
    );
    if (room) {
      const populated = await roomById(room._id);
      return res.json({ success: true, room: serializeRoom(populated, req.user.id) });
    }
    if (maxMembers !== undefined) {
      const currentRoom = await Room.findById(req.params.roomId).select('members owner');
      if (currentRoom && currentRoom.owner.toString() === req.user.id && currentRoom.members.length + 1 > maxMembers) {
        return res.status(409).json({
          success: false,
          message: 'Capacity cannot be lower than the current number of members.',
        });
      }
    }
    const exists = await Room.exists({ _id: req.params.roomId });
    return res.status(exists ? 403 : 404).json({
      success: false,
      message: exists ? 'Your role does not permit this room setting change.' : 'Room not found.',
    });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'The room settings are invalid.' });
    }
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A room with those settings already exists.' });
    }
    return next(err);
  }
});

router.patch('/:roomId/members/:memberId/role', async (req, res, next) => {
  const { roomId, memberId: targetId } = req.params;
  const { role } = req.body || {};
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(targetId)) {
    return res.status(404).json({ success: false, message: 'Room or member not found.' });
  }
  if (!['moderator', 'member'].includes(role)) {
    return res.status(400).json({ success: false, message: 'Role must be moderator or member.' });
  }

  try {
    const room = await Room.findOneAndUpdate(
      {
        _id: roomId,
        owner: req.user._id,
        members: targetId,
      },
      { $set: { [memberRolePath(targetId)]: role } },
      { returnDocument: 'after', runValidators: true },
    );
    if (room) {
      return res.json({ success: true, role, memberId: targetId });
    }
    const existing = await Room.findById(roomId).select('owner members');
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    if (existing.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the owner can promote or demote moderators.' });
    }
    return res.status(404).json({ success: false, message: 'Only room members can be assigned a member role.' });
  } catch (err) {
    return next(err);
  }
});

router.post('/:roomId/transfer-ownership', async (req, res, next) => {
  const { roomId } = req.params;
  const { memberId: targetId } = req.body || {};
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(targetId)) {
    return res.status(400).json({ success: false, message: 'Choose a valid room member to receive ownership.' });
  }

  try {
    const room = await Room.findOne({ _id: roomId, owner: req.user._id }).select('members');
    if (!room) {
      const exists = await Room.exists({ _id: roomId });
      return res.status(exists ? 403 : 404).json({
        success: false,
        message: exists ? 'Only the owner can transfer room ownership.' : 'Room not found.',
      });
    }
    if (!room.members.some((member) => member.toString() === targetId)) {
      return res.status(400).json({ success: false, message: 'Ownership can only be transferred to a current room member.' });
    }

    const previousOwnerId = req.user._id.toString();
    const members = room.members
      .filter((member) => member.toString() !== targetId)
      .concat(req.user._id);
    const updated = await Room.findOneAndUpdate(
      { _id: roomId, owner: req.user._id, members: targetId },
      {
        $set: {
          owner: targetId,
          members,
          [memberRolePath(req.user._id)]: 'member',
        },
        $unset: { [memberRolePath(targetId)]: '' },
      },
      { returnDocument: 'after', runValidators: true },
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Room ownership changed before the transfer completed.' });
    }
    return res.json({ success: true, ownerId: targetId });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:roomId/members/:memberId', async (req, res, next) => {
  const { roomId, memberId: targetId } = req.params;
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(targetId)) {
    return res.status(404).json({ success: false, message: 'Room or member not found.' });
  }

  try {
    const room = await roomById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    const actorRole = roleFor(room, req.user.id);
    const targetRole = roleFor(room, targetId);
    if (!['owner', 'moderator'].includes(actorRole)) {
      return res.status(403).json({ success: false, message: 'Only the owner or a moderator can remove members.' });
    }
    if (!room.members.some((member) => member._id.toString() === targetId)) {
      return res.status(404).json({ success: false, message: 'Room member not found.' });
    }
    if (actorRole === 'moderator' && targetRole !== 'member') {
      return res.status(403).json({ success: false, message: 'Moderators can remove members but not other moderators or the owner.' });
    }

    const filter = {
      _id: roomId,
      owner: room.owner._id,
      members: targetId,
    };
    if (actorRole === 'moderator') {
      filter[memberRolePath(req.user._id)] = 'moderator';
      filter[memberRolePath(targetId)] = { $nin: ['moderator', 'owner'] };
    }
    const updated = await Room.findOneAndUpdate(
      filter,
      {
        $pull: {
          members: targetId,
          accessRequests: { user: targetId },
        },
        $unset: { [memberRolePath(targetId)]: '' },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      return res.status(403).json({ success: false, message: 'Your role does not permit removing this member.' });
    }
    await disconnectRoomUser(req.app.get('io'), roomId, targetId);
    return res.json({ success: true, message: 'Member removed.' });
  } catch (err) {
    return next(err);
  }
});

router.put('/:roomId/files/:fileId', async (req, res, next) => {
  const { roomId, fileId } = req.params;
  const { content, version } = req.body || {};
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(fileId)) {
    return res.status(404).json({ success: false, message: 'Room or file not found.' });
  }
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 100000) {
    return res.status(400).json({ success: false, message: 'File content must be text no larger than 100 KB.' });
  }
  if (!Number.isInteger(version) || version < 0) {
    return res.status(400).json({ success: false, message: 'Provide the current non-negative file version.' });
  }

  try {
    const result = await updateRoomFile({
      roomId,
      fileId,
      userId: req.user._id,
      content,
      version,
    });
    if (result.status === 'forbidden') {
      return res.status(403).json({ success: false, message: result.message });
    }
    if (result.status === 'not-found') {
      return res.status(404).json({ success: false, message: 'Room or file not found.' });
    }
    if (result.status === 'stale') {
      return res.status(409).json({
        success: false,
        message: 'This file changed elsewhere. Review the latest version before continuing.',
        file: result.file,
      });
    }
    return res.json({ success: true, file: result.file });
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/:roomId/files/:fileId/run',
  express.text({ type: 'text/plain', limit: MAX_CODE_BYTES }),
  async (req, res, next) => {
    const { roomId, fileId } = req.params;
    if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(fileId)) {
      return res.status(404).json({ success: false, message: 'Room or file not found.' });
    }
    if (
      typeof req.body !== 'string' ||
      Buffer.byteLength(req.body, 'utf8') > MAX_CODE_BYTES
    ) {
      return res.status(400).json({ success: false, message: 'Code must be text no larger than 100 KB.' });
    }

    try {
      const room = await Room.findOne({
        _id: roomId,
        $or: [{ owner: req.user._id }, { members: req.user._id }],
      })
        .select('owner members memberRoles settings.allowMemberEdits files')
        .lean();
      if (!room) {
        const exists = await Room.exists({ _id: roomId });
        return res.status(exists ? 403 : 404).json({
          success: false,
          message: exists
            ? 'Room membership is required to run code.'
            : 'Room not found.',
        });
      }

      const role = roleFor(room, req.user.id);
      if (!role) {
        return res.status(403).json({ success: false, message: 'Room membership is required to run code.' });
      }
      if (role === 'member' && room.settings?.allowMemberEdits === false) {
        return res.status(403).json({ success: false, message: 'The owner has disabled code execution for members.' });
      }
      const file = room.files.find((item) => item._id.toString() === fileId);
      if (!file) {
        return res.status(404).json({ success: false, message: 'Room file not found.' });
      }
      if (!checkExecutionRateLimit(req.user.id)) {
        return res.status(429).json({ success: false, message: 'You can run code up to five times per minute.' });
      }

      const result = await executeCode({ code: req.body, language: file.language });
      const currentRoom = await Room.findOne({
        _id: roomId,
        $or: [{ owner: req.user._id }, { members: req.user._id }],
      })
        .select('owner members memberRoles settings.allowMemberEdits files._id')
        .lean();
      if (!currentRoom) {
        return res.status(403).json({ success: false, message: 'Room membership is required to receive execution results.' });
      }
      if (!currentRoom.files.some((item) => item._id.toString() === fileId)) {
        return res.status(404).json({ success: false, message: 'Room file was removed before execution completed.' });
      }
      const currentRole = roleFor(currentRoom, req.user.id);
      if (!currentRole || (currentRole === 'member' && currentRoom.settings?.allowMemberEdits === false)) {
        return res.status(403).json({ success: false, message: 'Your room permissions changed before execution completed.' });
      }
      const execution = {
        executionId: randomUUID(),
        roomId,
        fileId,
        fileName: file.name,
        language: file.language,
        actor: { id: req.user.id, username: req.user.username },
        ...result,
        createdAt: new Date().toISOString(),
      };
      await emitRoomEvent(req.app.get('io'), roomId, SOCKET_EVENTS.EXECUTION_RESULT, execution);
      return res.json({ success: true, execution });
    } catch (err) {
      if (Number.isInteger(err.status)) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      return next(err);
    }
  },
);

router.get('/:roomId/download', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  try {
    const room = await roomById(req.params.roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }
    const isMember = room.members.some((member) => member._id.toString() === req.user.id);
    if (room.owner._id.toString() !== req.user.id && !isMember) {
      return res.status(403).json({ success: false, message: 'Only room members can download the workspace.' });
    }
    const workspace = {
      title: room.title,
      description: room.description,
      defaultLanguage: room.settings?.defaultLanguage || 'javascript',
      files: room.files.map((file) => ({ name: file.name, language: file.language, content: file.content })),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${room.id}-workspace.json"`);
    return res.send(JSON.stringify(workspace, null, 2));
  } catch (err) {
    return next(err);
  }
});

router.post('/:roomId/leave', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.roomId, owner: { $ne: req.user._id }, members: req.user._id },
      {
        $pull: {
          members: req.user._id,
          accessRequests: { user: req.user._id },
        },
        $unset: { [`memberRoles.${req.user.id}`]: '' },
      },
      { returnDocument: 'after' },
    );
    if (!room) {
      const existing = await Room.exists({ _id: req.params.roomId });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing ? 'You are not a member of this room, or owners cannot leave their own room.' : 'Room not found.',
      });
    }
    await disconnectRoomUser(req.app.get('io'), req.params.roomId, req.user.id);
    return res.json({ success: true, message: 'You left the room.' });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:roomId', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const room = await Room.findOneAndDelete({ _id: req.params.roomId, owner: req.user._id });
    if (!room) {
      const exists = await Room.exists({ _id: req.params.roomId });
      return res.status(exists ? 403 : 404).json({
        success: false,
        message: exists ? 'Only the room owner can delete this room.' : 'Room not found.',
      });
    }
    await ChatMessage.deleteMany({ room: room._id });
    await disconnectRoom(req.app.get('io'), req.params.roomId);
    return res.json({ success: true, message: 'Room deleted.' });
  } catch (err) {
    return next(err);
  }
});

router.get('/:roomId', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const access = await loadRoom(req.params.roomId, req.user._id);
    if (!access) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    if (!access.canViewDetails) {
      const owner = await User.findById(access.room.owner._id).select('_id username');
      return res.json({
        success: true,
        room: {
          id: access.room.id,
          title: access.room.title,
          visibility: access.room.visibility,
          owner: { id: owner.id, username: owner.username },
          accessRequestStatus: access.accessRequestStatus,
          isOwner: false,
          isMember: false,
        },
      });
    }

    return res.json({ success: true, room: serializeRoom(access.room, req.user.id) });
  } catch (err) {
    return next(err);
  }
});

router.post('/:roomId/files', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  if (Object.keys(req.body || {}).some((field) => !['name', 'language'].includes(field))) {
    return res.status(400).json({ success: false, message: 'Unsupported file property.' });
  }
  const file = validateFileInput(req.body);
  if (file.error) return res.status(400).json({ success: false, message: file.error });

  try {
    const result = await createRoomFile({
      roomId: req.params.roomId,
      userId: req.user._id,
      ...file,
    });
    return sendFileOperationResult(req, res, req.params.roomId, result, 'created');
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'The file details are invalid.' });
    }
    return next(err);
  }
});

router.patch('/:roomId/files/:fileId', async (req, res, next) => {
  const { roomId, fileId } = req.params;
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(fileId)) {
    return res.status(404).json({ success: false, message: 'Room or file not found.' });
  }
  if (Object.keys(req.body || {}).some((field) => !['name', 'language'].includes(field))) {
    return res.status(400).json({ success: false, message: 'Unsupported file property.' });
  }
  const file = validateFileInput(req.body);
  if (file.error) return res.status(400).json({ success: false, message: file.error });

  try {
    const result = await renameRoomFile({
      roomId,
      fileId,
      userId: req.user._id,
      ...file,
    });
    return sendFileOperationResult(req, res, roomId, result, 'renamed');
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'The file details are invalid.' });
    }
    return next(err);
  }
});

router.delete('/:roomId/files/:fileId', async (req, res, next) => {
  const { roomId, fileId } = req.params;
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(fileId)) {
    return res.status(404).json({ success: false, message: 'Room or file not found.' });
  }

  try {
    const result = await deleteRoomFile({
      roomId,
      fileId,
      userId: req.user._id,
    });
    return sendFileOperationResult(req, res, roomId, result, 'deleted');
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'The file ID is invalid.' });
    }
    return next(err);
  }
});

module.exports = router;
