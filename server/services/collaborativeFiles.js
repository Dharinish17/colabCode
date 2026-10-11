const mongoose = require('mongoose');
const Y = require('yjs');
const Room = require('../models/Room');

const MAX_FILE_BYTES = 100000;
const MAX_UPDATE_BYTES = 256000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_PERSIST_ATTEMPTS = 20;
const TEXT_NAME = 'content';

function seedClientId(fileId) {
  let hash = 2166136261;
  for (const character of fileId.toString()) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) || 1;
}

function roleForRoom(room, userId) {
  if (room.owner.toString() === userId.toString()) return 'owner';
  if (!(room.members || []).some((member) => member.toString() === userId.toString())) return null;

  const roles = room.memberRoles instanceof Map ? room.memberRoles : room.memberRoles || {};
  const role = typeof roles.get === 'function' ? roles.get(userId.toString()) : roles[userId.toString()];
  return role === 'moderator' ? 'moderator' : 'member';
}

function decodeUpdate(encodedUpdate) {
  if (
    typeof encodedUpdate !== 'string' ||
    encodedUpdate.length === 0 ||
    encodedUpdate.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedUpdate)
  ) {
    return null;
  }
  const update = Buffer.from(encodedUpdate, 'base64');
  return update.length > 0 && update.length <= MAX_UPDATE_BYTES &&
    update.toString('base64') === encodedUpdate
    ? new Uint8Array(update)
    : null;
}

function documentFromFile(file) {
  const document = new Y.Doc();
  if (file.collabState) {
    const state = Buffer.from(file.collabState, 'base64');
    if (!state.length || state.toString('base64') !== file.collabState) {
      document.destroy();
      throw new Error('Stored collaborative file state is invalid.');
    }
    Y.applyUpdate(document, new Uint8Array(state));
  } else if (file.content) {
    const clientId = document.clientID;
    document.clientID = seedClientId(file._id);
    document.getText(TEXT_NAME).insert(0, file.content);
    document.clientID = clientId;
  }
  return document;
}

function authorizedFilter(roomId, userId, room, role) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const id = userId.toString();
  if (role === 'owner') return { _id: roomId, owner: userObjectId };
  if (role === 'moderator') {
    return {
      _id: roomId,
      owner: room.owner,
      members: userObjectId,
      [`memberRoles.${id}`]: 'moderator',
    };
  }
  return {
    _id: roomId,
    owner: room.owner,
    members: userObjectId,
    'settings.allowMemberEdits': { $ne: false },
    [`memberRoles.${id}`]: { $ne: 'moderator' },
  };
}

function stateFilter(fileId, currentState) {
  return {
    files: {
      $elemMatch: {
        _id: fileId,
        ...(currentState
          ? { collabState: currentState }
          : { collabState: { $in: [null, ''] } }),
      },
    },
  };
}

function fileFromRoom(room, fileId) {
  const file = room.files?.find((item) => item._id.toString() === fileId.toString());
  if (!file) return null;
  return {
    id: file._id.toString(),
    name: file.name,
    language: file.language,
    content: file.content || '',
    collabState: file.collabState || '',
    version: Number.isInteger(file.version) ? file.version : 0,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

async function applyCollaborativeUpdate({ roomId, fileId, userId, encodedUpdate }) {
  if (!mongoose.isObjectIdOrHexString(roomId) || !mongoose.isObjectIdOrHexString(fileId)) {
    return { status: 'not-found' };
  }
  const update = decodeUpdate(encodedUpdate);
  if (!update) return { status: 'invalid-update' };

  const roomObjectId = new mongoose.Types.ObjectId(roomId);
  const fileObjectId = new mongoose.Types.ObjectId(fileId);
  for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt += 1) {
    const room = await Room.findOne({ _id: roomObjectId, 'files._id': fileObjectId })
      .select('_id owner members memberRoles settings.allowMemberEdits files.$')
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

    const currentFile = room.files?.[0];
    if (!currentFile) return { status: 'not-found' };

    const document = documentFromFile(currentFile);
    try {
      Y.applyUpdate(document, update);
      const text = document.getText(TEXT_NAME).toString();
      if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
        return { status: 'too-large' };
      }
      const encodedState = Y.encodeStateAsUpdate(document);
      if (encodedState.byteLength > MAX_STATE_BYTES) {
        return { status: 'state-too-large' };
      }
      const collabState = Buffer.from(encodedState).toString('base64');
      const filter = {
        ...authorizedFilter(roomObjectId, userId, room, role),
        ...stateFilter(fileObjectId, currentFile.collabState || ''),
      };
      const result = await Room.collection.updateOne(filter, {
        $set: {
          'files.$[target].content': text,
          'files.$[target].collabState': collabState,
          'files.$[target].updatedAt': new Date(),
        },
        $inc: { 'files.$[target].version': 1 },
      }, {
        arrayFilters: [{ 'target._id': fileObjectId }],
      });
      if (result.matchedCount === 1) {
        const updated = await Room.findOne({ _id: roomObjectId, 'files._id': fileObjectId })
          .select('_id files.$')
          .lean();
        const file = updated && fileFromRoom(updated, fileObjectId);
        return file
          ? { status: 'updated', file, update: encodedUpdate }
          : { status: 'not-found' };
      }
    } finally {
      document.destroy();
    }
  }

  return {
    status: 'busy',
    message: 'The file is receiving many simultaneous changes. Please retry.',
  };
}

module.exports = {
  applyCollaborativeUpdate,
  MAX_FILE_BYTES,
  MAX_UPDATE_BYTES,
};
