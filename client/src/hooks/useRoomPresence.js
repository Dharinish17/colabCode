import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_EVENTS } from '../socket/events';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export function useRoomPresence(roomId, enabled) {
  const [socketClient, setSocketClient] = useState(null);
  const [presence, setPresence] = useState({
    status: 'idle',
    users: [],
    error: '',
    errorCode: '',
  });

  useEffect(() => {
    if (!roomId || !enabled) {
      setPresence({ status: 'idle', users: [], error: '', errorCode: '' });
      return undefined;
    }

    const socket = io(API_URL, {
      autoConnect: false,
      withCredentials: true,
    });
    let active = true;
    setSocketClient(socket);
    setPresence({ status: 'connecting', users: [], error: '', errorCode: '' });

    function joinCurrentRoom() {
      setPresence({ status: 'joining', users: [], error: '', errorCode: '' });
      socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId }, (result) => {
        if (!active) return;
        if (!result?.success) {
          setPresence({
            status: 'error',
            users: [],
            error: result?.message || 'Unable to join live room presence.',
            errorCode: result?.code || '',
          });
          return;
        }
        setPresence({ status: 'online', users: result.users, error: '', errorCode: '' });
      });
    }

    function handleSnapshot(payload) {
      if (!active || payload.roomId !== roomId) return;
      setPresence({ status: 'online', users: payload.users, error: '', errorCode: '' });
    }

    function handleUserOnline(payload) {
      if (!active || payload.roomId !== roomId) return;
      setPresence((current) => ({
        ...current,
        users: current.users.some((user) => user.id === payload.user.id)
          ? current.users
          : [...current.users, payload.user],
      }));
    }

    function handleUserOffline(payload) {
      if (!active || payload.roomId !== roomId) return;
      setPresence((current) => ({
        ...current,
        users: current.users.filter((user) => user.id !== payload.user.id),
      }));
    }

    function handleConnectError(error) {
      if (!active) return;
      setPresence({
        status: 'error',
        users: [],
        error: error.message || 'Unable to connect to live room presence.',
        errorCode: error.code || '',
      });
    }

    function handleDisconnect(reason) {
      if (!active || reason === 'io client disconnect') return;
      if (reason === 'io server disconnect') {
        setPresence((current) => ({
          status: 'error',
          users: [],
          error: current.error || 'The live presence connection was closed by the server.',
          errorCode: current.errorCode,
        }));
        return;
      }
      setPresence({ status: 'connecting', users: [], error: '', errorCode: '' });
    }

    socket.on('connect', joinCurrentRoom);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    socket.on(SOCKET_EVENTS.PRESENCE_SNAPSHOT, handleSnapshot);
    socket.on(SOCKET_EVENTS.PRESENCE_USER_ONLINE, handleUserOnline);
    socket.on(SOCKET_EVENTS.PRESENCE_USER_OFFLINE, handleUserOffline);
    socket.on(SOCKET_EVENTS.ROOM_ERROR, handleConnectError);
    socket.connect();

    return () => {
      active = false;
      if (socket.connected) {
        socket.emit(SOCKET_EVENTS.ROOM_LEAVE, { roomId });
      }
      socket.disconnect();
      setSocketClient(null);
    };
  }, [enabled, roomId]);

  return { ...presence, socket: socketClient };
}
