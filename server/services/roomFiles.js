const Room = require('../models/Room');
const mongoose = require('mongoose');

function roleForRoom(room, userId) {
  if (room.owner.toString() === userId.toString()) return 'owner';
  if (!(room.members || []).some((member) => member.toString() === userId.toString())) return null;

  const roles = room.memberRoles instanceof Map ? room.memberRoles : room.memberRoles || {};
  const role = typeof roles.get === 'function' ? roles.get(userId.toString()) : roles[userId.toString()];
  return role === 'moderator' ? 'moderator' : 'member';
}

function fileVersion(file) {
  return Number.isInteger(file.version) ? file.version : 0;
}

function canManageFiles(room, userId) {
  return ['owner', 'moderator'].includes(roleForRoom(room, userId));
}

function fileManagerFilter(roomId, userId) {
  const id = userId.toString();
  return {
    _id: roomId,
    $or: [
      { owner: userId },
      { members: userId, [`memberRoles.${id}`]: 'moderator' },
    ],
  };
}

function noDuplicateFileName(name, excludedFileId) {
  const files = { $ifNull: ['$files', []] };
  const matchesName = {
    $eq: [{ $toLower: '$$file.name' }, name.toLowerCase()],
  };
  const conditions = excludedFileId
    ? { $and: [{ $ne: ['$$file._id', excludedFileId] }, matchesName] }
    : matchesName;
  return {
    $expr: {
      $eq: [
        {
          $size: {
            $filter: { input: files, as: 'file', cond: conditions },
          },
        },
        0,
      ],
    },
  };
}

function serializeFile(file) {
  return {
    id: file.id,
    name: file.name,
    language: file.language,
    content: file.content,
    version: fileVersion(file),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

async function diagnoseFileManagementFailure(roomId, userId, fileId, name) {
  const room = await Room.findById(roomId)
    .select('_id owner members memberRoles files')
    .lean();
  if (!room) return { status: 'not-found' };
  if (!canManageFiles(room, userId)) return { status: 'forbidden' };
  if (fileId && !room.files.some((file) => file._id.toString() === fileId.toString())) {
    return { status: 'not-found' };
  }
  if (name && room.files.some((file) =>
    file._id.toString() !== (fileId ? fileId.toString() : '') &&
    file.name.toLowerCase() === name.toLowerCase())) {
    return { status: 'duplicate' };
  }
  return { status: 'conflict' };
}

async function createRoomFile({ roomId, userId, name, language }) {
  const room = await Room.findOneAndUpdate(
    {
      ...fileManagerFilter(roomId, userId),
      ...noDuplicateFileName(name),
    },
    { $push: { files: { name, language, content: '' } } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!room) return diagnoseFileManagementFailure(roomId, userId, null, name);
  return { status: 'updated', room, file: serializeFile(room.files[room.files.length - 1]) };
}

async function renameRoomFile({ roomId, fileId, userId, name, language }) {
  const objectId = new mongoose.Types.ObjectId(fileId);
  const room = await Room.findOneAndUpdate(
    {
      ...fileManagerFilter(roomId, userId),
      'files._id': objectId,
      ...noDuplicateFileName(name, objectId),
    },
    {
      $set: {
        'files.$.name': name,
        'files.$.language': language,
        'files.$.updatedAt': new Date(),
      },
      $inc: { 'files.$.version': 1 },
    },
    { returnDocument: 'after', runValidators: true },
  );
  if (!room) return diagnoseFileManagementFailure(roomId, userId, objectId, name);
  return { status: 'updated', room, file: serializeFile(room.files.id(objectId)) };
}

async function deleteRoomFile({ roomId, fileId, userId }) {
  const objectId = new mongoose.Types.ObjectId(fileId);
  const room = await Room.findOneAndUpdate(
    {
      ...fileManagerFilter(roomId, userId),
      'files._id': objectId,
    },
    { $pull: { files: { _id: objectId } } },
    { returnDocument: 'after' },
  );
  if (!room) return diagnoseFileManagementFailure(roomId, userId, objectId);
  return { status: 'updated', room };
}

async function updateRoomFile({ roomId, fileId, userId, content, version }) {
  const room = await Room.findById(roomId)
    .select('_id owner members memberRoles settings.allowMemberEdits')
    .lean();
  if (!room) return { status: 'not-found' };

  const role = roleForRoom(room, userId);
  if (!role) {
    return {
      status: 'forbidden',
      reason: 'not-member',
      message: 'Join the room before editing files.',
    };
  }
  if (role === 'member' && room.settings?.allowMemberEdits === false) {
    return { status: 'forbidden', message: 'The owner has disabled editing for members.' };
  }

  const filter = {
    _id: roomId,
    files: {
      $elemMatch: {
        _id: fileId,
        $or: [
          { version },
          ...(version === 0 ? [{ version: { $exists: false } }] : []),
        ],
      },
    },
  };
  if (role === 'owner') {
    filter.owner = userId;
  } else {
    filter.owner = room.owner;
    filter.members = userId;
    if (role === 'moderator') {
      filter[`memberRoles.${userId}`] = 'moderator';
    } else {
      filter['settings.allowMemberEdits'] = { $ne: false };
      filter[`memberRoles.${userId}`] = { $ne: 'moderator' };
    }
  }

  const updated = await Room.findOneAndUpdate(
    filter,
    {
      $set: {
        'files.$.content': content,
        'files.$.updatedAt': new Date(),
      },
      $inc: { 'files.$.version': 1 },
    },
    { returnDocument: 'after', runValidators: true },
  );
  if (updated) {
    return { status: 'updated', file: serializeFile(updated.files.id(fileId)) };
  }

  const current = await Room.findById(roomId)
    .select('_id owner members memberRoles settings.allowMemberEdits')
    .lean();
  if (!current) return { status: 'not-found' };
  const currentRole = roleForRoom(current, userId);
  if (!currentRole) {
    return {
      status: 'forbidden',
      reason: 'not-member',
      message: 'Join the room before editing files.',
    };
  }
  if (currentRole === 'member' && current.settings?.allowMemberEdits === false) {
    return { status: 'forbidden', message: 'The owner has disabled editing for members.' };
  }
  const latest = await Room.findOne({ _id: roomId, 'files._id': fileId })
    .select({ files: { $elemMatch: { _id: fileId } } })
    .lean();
  if (!latest?.files?.length) return { status: 'not-found' };
  return {
    status: 'stale',
    file: {
      ...latest.files[0],
      id: latest.files[0]._id.toString(),
      version: fileVersion(latest.files[0]),
    },
  };
}

module.exports = {
  createRoomFile,
  deleteRoomFile,
  fileVersion,
  renameRoomFile,
  serializeFile,
  updateRoomFile,
};
