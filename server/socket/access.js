const EVENTS = require('./events');

function roomChannel(roomId) {
  return `room:${roomId}`;
}

async function disconnectRoomUser(io, roomId, userId) {
  const sockets = await io.in(roomChannel(roomId)).fetchSockets();
  await Promise.all(sockets
    .filter((socket) => socket.data.user?.id === userId.toString())
    .map(async (socket) => {
      socket.emit(EVENTS.ROOM_ERROR, {
        code: 'ROOM_ACCESS_REVOKED',
        message: 'Your access to this room has changed.',
      });
      await socket.disconnect(true);
    }));
}

async function disconnectRoom(io, roomId) {
  const sockets = await io.in(roomChannel(roomId)).fetchSockets();
  await Promise.all(sockets.map(async (socket) => {
    socket.emit(EVENTS.ROOM_ERROR, {
      code: 'ROOM_DELETED',
      message: 'This room has been deleted.',
    });
    await socket.disconnect(true);
  }));
}

module.exports = { disconnectRoom, disconnectRoomUser, roomChannel };
