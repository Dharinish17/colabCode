import { useCallback, useEffect, useRef, useState } from 'react';
import { SOCKET_EVENTS } from '../socket/events';

export function useCollaborativeCursors({ socket, roomId, fileId, userId }) {
  const [cursors, setCursors] = useState([]);
  const fileIdRef = useRef(fileId);
  const pendingCursorRef = useRef(null);
  const timerRef = useRef(null);
  const lastSentAtRef = useRef(0);
  const sequenceRef = useRef(0);

  fileIdRef.current = fileId;

  useEffect(() => {
    if (!socket || !roomId) {
      setCursors([]);
      return undefined;
    }

    const handleCursorState = (payload) => {
      if (payload.roomId !== roomId) return;
      setCursors(payload.cursors.filter((cursor) => cursor.userId !== userId));
    };
    const handleCursorUpdate = (cursor) => {
      if (cursor.roomId !== roomId || cursor.userId === userId) return;
      setCursors((current) => {
        const previous = current.find((item) => item.cursorId === cursor.cursorId);
        if (previous && previous.sequence >= cursor.sequence) return current;
        return [
          ...current.filter((item) => item.cursorId !== cursor.cursorId),
          cursor,
        ];
      });
    };
    const handleCursorClear = (payload) => {
      if (payload.roomId !== roomId) return;
      setCursors((current) => current.filter((cursor) => cursor.cursorId !== payload.cursorId));
    };

    socket.on(SOCKET_EVENTS.CURSOR_STATE, handleCursorState);
    socket.on(SOCKET_EVENTS.CURSOR_UPDATE, handleCursorUpdate);
    socket.on(SOCKET_EVENTS.CURSOR_CLEAR, handleCursorClear);
    return () => {
      socket.off(SOCKET_EVENTS.CURSOR_STATE, handleCursorState);
      socket.off(SOCKET_EVENTS.CURSOR_UPDATE, handleCursorUpdate);
      socket.off(SOCKET_EVENTS.CURSOR_CLEAR, handleCursorClear);
    };
  }, [roomId, socket, userId]);

  useEffect(() => {
    setCursors((current) => current.filter((cursor) => cursor.fileId === fileId));
    return () => {
      clearTimeout(timerRef.current);
      if (socket?.connected && fileId) {
        socket.emit(SOCKET_EVENTS.CURSOR_CLEAR, { roomId, fileId });
      }
    };
  }, [fileId, roomId, socket]);

  const publishCursor = useCallback((position, selection) => {
    if (!socket?.connected || !roomId || !fileIdRef.current) return;
    pendingCursorRef.current = {
      roomId,
      fileId: fileIdRef.current,
      position,
      selection,
    };
    const elapsed = Date.now() - lastSentAtRef.current;
    const delay = Math.max(0, 50 - elapsed);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!socket.connected || !pendingCursorRef.current) return;
      socket.emit(SOCKET_EVENTS.CURSOR_UPDATE, {
        ...pendingCursorRef.current,
        sequence: ++sequenceRef.current,
      });
      pendingCursorRef.current = null;
      lastSentAtRef.current = Date.now();
    }, delay);
  }, [roomId, socket]);

  return { cursors, publishCursor };
}
