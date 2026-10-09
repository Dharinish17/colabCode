import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SOCKET_EVENTS } from '../socket/events';

function normalizedFile(file) {
  return { ...file, version: Number.isInteger(file.version) ? file.version : 0 };
}

export function useCollaborativeEditor({ socket, roomId, file, onFileUpdate }) {
  const [drafts, setDrafts] = useState(() => (
    file?.id ? { [file.id]: file.content || '' } : {}
  ));
  const [activeDraftFileId, setActiveDraftFileId] = useState(file?.id || '');
  const [version, setVersion] = useState(file?.version || 0);
  const [syncStatus, setSyncStatus] = useState('saved');
  const [conflictFile, setConflictFile] = useState(null);
  const draftRef = useRef(file?.content || '');
  const versionRef = useRef(version);
  const fileIdRef = useRef(file?.id || '');
  const roomIdRef = useRef(roomId);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(null);
  const joinedRef = useRef(false);
  const conflictRef = useRef(null);
  const timerRef = useRef(null);
  const sendRef = useRef(() => {});
  const onFileUpdateRef = useRef(onFileUpdate);
  const changeIdRef = useRef(0);

  onFileUpdateRef.current = onFileUpdate;

  const applyFile = useCallback((incoming) => {
    const nextFile = normalizedFile(incoming);
    draftRef.current = nextFile.content;
    versionRef.current = nextFile.version;
    dirtyRef.current = false;
    conflictRef.current = null;
    setDrafts((current) => ({ ...current, [nextFile.id]: nextFile.content }));
    setVersion(nextFile.version);
    setConflictFile(null);
    setSyncStatus('saved');
    onFileUpdateRef.current(nextFile);
  }, []);

  useLayoutEffect(() => {
    const roomChanged = roomIdRef.current !== roomId;
    roomIdRef.current = roomId;
    fileIdRef.current = file?.id || '';
    setActiveDraftFileId(file?.id || '');
    draftRef.current = file?.content || '';
    versionRef.current = Number.isInteger(file?.version) ? file.version : 0;
    dirtyRef.current = false;
    pendingRef.current = null;
    conflictRef.current = null;
    setDrafts((current) => {
      const next = roomChanged ? {} : current;
      return file?.id ? { ...next, [file.id]: draftRef.current } : next;
    });
    setVersion(versionRef.current);
    setConflictFile(null);
    setSyncStatus('saved');
  }, [file?.id, roomId]);

  useEffect(() => {
    joinedRef.current = false;
  }, [roomId]);

  useEffect(() => {
    if (!file?.id || file.id !== fileIdRef.current || dirtyRef.current || pendingRef.current) return;
    const incoming = normalizedFile(file);
    if (incoming.version > versionRef.current) applyFile(incoming);
  }, [applyFile, file?.content, file?.id, file?.version]);

  const scheduleSend = useCallback((delay = 400) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => sendRef.current(), delay);
  }, []);

  useEffect(() => {
    if (!socket || !roomId || !file?.id) {
      joinedRef.current = false;
      return undefined;
    }

    const handleEditorState = (payload) => {
      if (payload.roomId !== roomId) return;
      joinedRef.current = true;
      const currentFile = payload.files.find((item) => item.id === fileIdRef.current);
      if (currentFile && !dirtyRef.current && !pendingRef.current) {
        applyFile(currentFile);
      }
      for (const item of payload.files) {
        if (item.id !== fileIdRef.current) {
          const incoming = normalizedFile(item);
          setDrafts((current) => ({ ...current, [incoming.id]: incoming.content }));
          onFileUpdateRef.current(incoming);
        }
      }
      if (dirtyRef.current) scheduleSend(0);
    };

    const handleEditorUpdate = (payload) => {
      if (payload.roomId !== roomId) return;
      const incoming = normalizedFile(payload.file);
      if (incoming.id !== fileIdRef.current) {
        setDrafts((current) => ({ ...current, [incoming.id]: incoming.content }));
        onFileUpdateRef.current(incoming);
        return;
      }
      if (incoming.version <= versionRef.current) return;
      if (dirtyRef.current || pendingRef.current) {
        conflictRef.current = incoming;
        setConflictFile(incoming);
        setSyncStatus('conflict');
        return;
      }
      applyFile(incoming);
    };

    const handleEditorConflict = (payload) => {
      if (payload.roomId !== roomId || payload.file.id !== fileIdRef.current) return;
      conflictRef.current = normalizedFile(payload.file);
      setConflictFile(conflictRef.current);
      setSyncStatus('conflict');
      pendingRef.current = null;
    };

    const handleConnect = () => {
      joinedRef.current = false;
    };
    const handleDisconnect = () => {
      joinedRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = null;
        dirtyRef.current = true;
      }
      if (dirtyRef.current) setSyncStatus('offline');
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on(SOCKET_EVENTS.EDITOR_STATE, handleEditorState);
    socket.on(SOCKET_EVENTS.EDITOR_UPDATE, handleEditorUpdate);
    socket.on(SOCKET_EVENTS.EDITOR_CONFLICT, handleEditorConflict);
    return () => {
      clearTimeout(timerRef.current);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off(SOCKET_EVENTS.EDITOR_STATE, handleEditorState);
      socket.off(SOCKET_EVENTS.EDITOR_UPDATE, handleEditorUpdate);
      socket.off(SOCKET_EVENTS.EDITOR_CONFLICT, handleEditorConflict);
    };
  }, [applyFile, file?.id, roomId, scheduleSend, socket]);

  useEffect(() => {
    sendRef.current = () => {
      if (
        !socket?.connected ||
        !joinedRef.current ||
        !dirtyRef.current ||
        pendingRef.current ||
        conflictRef.current ||
        !fileIdRef.current
      ) return;

      const content = draftRef.current;
      const sentVersion = versionRef.current;
      const clientChangeId = `${Date.now()}-${++changeIdRef.current}`;
      pendingRef.current = { clientChangeId, content };
      setSyncStatus('saving');
      socket.emit(
        SOCKET_EVENTS.EDITOR_CHANGE,
        { roomId, fileId: fileIdRef.current, content, version: sentVersion, clientChangeId },
        (result) => {
          if (pendingRef.current?.clientChangeId !== clientChangeId) return;
          pendingRef.current = null;
          if (!result?.success) {
            if (result?.code === 'STALE_FILE' && result.file) {
              conflictRef.current = normalizedFile(result.file);
              setConflictFile(conflictRef.current);
              setSyncStatus('conflict');
              return;
            }
            setSyncStatus(result?.code === 'ROOM_NOT_JOINED' ? 'offline' : 'error');
            return;
          }

          const savedFile = normalizedFile(result.file);
          versionRef.current = savedFile.version;
          setVersion(savedFile.version);
          onFileUpdateRef.current(savedFile);
          dirtyRef.current = draftRef.current !== content;
          if (dirtyRef.current) {
            setSyncStatus('unsaved');
            scheduleSend(400);
          } else {
            setSyncStatus('saved');
          }
        },
      );
    };
  }, [roomId, scheduleSend, socket]);

  const changeDraft = useCallback((value, changedFileId = fileIdRef.current) => {
    if (!changedFileId || changedFileId !== fileIdRef.current) return;
    draftRef.current = value;
    dirtyRef.current = true;
    setDrafts((current) => ({ ...current, [changedFileId]: value }));
    if (conflictRef.current) {
      setSyncStatus('conflict');
    } else {
      setSyncStatus(socket?.connected ? 'unsaved' : 'offline');
      scheduleSend();
    }
  }, [scheduleSend, socket]);

  const resolveConflict = useCallback((resolution) => {
    const latest = conflictRef.current;
    if (!latest) return;
    if (resolution === 'latest') {
      applyFile(latest);
      return;
    }
    versionRef.current = latest.version;
    setVersion(latest.version);
    conflictRef.current = null;
    setConflictFile(null);
    dirtyRef.current = true;
    setSyncStatus('unsaved');
    scheduleSend(0);
  }, [applyFile, scheduleSend]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return {
    draft: file?.id && activeDraftFileId === file.id
      ? drafts[file.id] ?? file.content ?? ''
      : file?.content || '',
    version,
    syncStatus,
    conflictFile,
    changeDraft,
    resolveConflict,
  };
}
