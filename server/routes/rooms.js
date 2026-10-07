const express = require('express');
const mongoose = require('mongoose');
const Room = require('../models/Room');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

function serializeRoom(room, userId) {
  const ownerId = room.owner._id ? room.owner._id.toString() : room.owner.toString();
  const members = room.members || [];
  const isOwner = ownerId === userId;
  const isMember = members.some((member) =>
    (member._id ? member._id.toString() : member.toString()) === userId,
  );

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
    createdAt: room.createdAt,
    isOwner,
    isMember,
  };
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

router.post('/', async (req, res, next) => {
  const { title, description = '', visibility = 'public', maxMembers = 10 } = req.body || {};
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
    maxMembers > 50
  ) {
    return res.status(400).json({
      success: false,
      message: 'Provide a 3–60 character title, a description up to 500 characters, public or private visibility, and a capacity from 2 to 50.',
    });
  }

  try {
    const room = await Room.create({
      title: normalizedTitle,
      description: normalizedDescription,
      visibility,
      maxMembers,
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
        { $add: [{ $size: '$members' }, 1] },
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
            { $add: [{ $size: '$members' }, 1] },
            '$maxMembers',
          ],
        },
      },
      { $addToSet: { members: userId } },
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

router.get('/:roomId', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.roomId)) {
    return res.status(404).json({ success: false, message: 'Room not found.' });
  }

  try {
    const room = await roomById(req.params.roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const safeRoom = serializeRoom(room, req.user.id);
    if (room.visibility === 'private' && !safeRoom.isOwner && !safeRoom.isMember) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    return res.json({ success: true, room: safeRoom });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
