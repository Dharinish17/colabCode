const express = require('express');
const mongoose = require('mongoose');
const Room = require('../models/Room');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
    },
    files: (room.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      language: file.language,
      content: file.content,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    })),
    accessRequestStatus: currentRequest?.status || null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    isOwner,
    isMember,
  };
}

function memberId(member) {
  return member._id ? member._id.toString() : member.toString();
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
    !['javascript', 'typescript', 'python'].includes(defaultLanguage)
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
      settings: { defaultLanguage, allowGuests: false },
      files: [{ name: `main.${defaultLanguage === 'python' ? 'py' : defaultLanguage === 'typescript' ? 'ts' : 'js'}`, language: defaultLanguage, content: '' }],
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
    if (room.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the room owner can review access requests.' });
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
    const ownerFilter = { _id: roomId, owner: req.user._id };
    if (decision === 'approve') {
      const room = await Room.findOneAndUpdate(
        {
          ...ownerFilter,
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
        return res.json({ success: true, decision, roomId: room.id });
      }
    } else {
      const room = await Room.findOneAndUpdate(
        {
          ...ownerFilter,
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
        return res.json({ success: true, decision, roomId: room.id });
      }
    }

    const room = await Room.findById(roomId).select('owner members maxMembers accessRequests');
    if (!room || room.owner.toString() !== req.user.id) {
      return res.status(room ? 403 : 404).json({
        success: false,
        message: room ? 'Only the room owner can review access requests.' : 'Room or request not found.',
      });
    }
    if (
      decision === 'approve' &&
      room.accessRequests.some((request) => request.user.toString() === requesterId && request.status === 'pending') &&
      room.members.length + 1 >= room.maxMembers
    ) {
      return res.status(409).json({ success: false, message: 'The room is full; increase its capacity before approving this request.' });
    }
    return res.status(409).json({ success: false, message: 'No pending request exists for this user.' });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:roomId', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  const { title, description, visibility, maxMembers, defaultLanguage } = req.body || {};
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
    if (!['javascript', 'typescript', 'python'].includes(defaultLanguage)) {
      return res.status(400).json({ success: false, message: 'Choose a supported default language.' });
    }
    updates['settings.defaultLanguage'] = defaultLanguage;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, message: 'Provide at least one room setting to update.' });
  }

  try {
    const filter = { _id: req.params.roomId, owner: req.user._id };
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
      const ownedRoom = await Room.findOne({ _id: req.params.roomId, owner: req.user._id }).select('members');
      if (ownedRoom && ownedRoom.members.length + 1 > maxMembers) {
        return res.status(409).json({
          success: false,
          message: 'Capacity cannot be lower than the current number of members.',
        });
      }
    }
    const exists = await Room.exists({ _id: req.params.roomId });
    return res.status(exists ? 403 : 404).json({
      success: false,
      message: exists ? 'Only the room owner can update room settings.' : 'Room not found.',
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

router.post('/:roomId/leave', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.roomId, owner: { $ne: req.user._id }, members: req.user._id },
      {
        $pull: { members: req.user._id },
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

module.exports = router;
