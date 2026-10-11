import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { SOCKET_EVENTS } from '../socket/events';

const TEXT_NAME = 'content';
const LOCAL_ORIGIN = 'local-editor';
const SERVER_ORIGIN = 'server-sync';
const MAX_FILE_BYTES = 100000;

function seedClientId(fileId) {
  let hash = 2166136261;
  for (const character of fileId.toString()) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) || 1;
}

function decodeUpdate(encodedUpdate) {
  if (
    typeof encodedUpdate !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedUpdate)
  ) {
    throw new Error('The server sent an invalid collaborative update.');
  }
  const binary = atob(encodedUpdate);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeUpdate(update) {
  let binary = '';
  for (const byte of update) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function contentDiff(current, next) {
  const currentCharacters = [...current];
  const nextCharacters = [...next];
  let prefix = 0;
  while (
    prefix < currentCharacters.length &&
    prefix < nextCharacters.length &&
    currentCharacters[prefix] === nextCharacters[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < currentCharacters.length - prefix &&
    suffix < nextCharacters.length - prefix &&
    currentCharacters[currentCharacters.length - suffix - 1] ===
      nextCharacters[nextCharacters.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const index = currentCharacters.slice(0, prefix).join('').length;
  const deletedLength = currentCharacters
    .slice(prefix, currentCharacters.length - suffix)
    .join('').length;
  const insertedText = nextCharacters
    .slice(prefix, nextCharacters.length - suffix)
    .join('');
  return { index, deletedLength, insertedText };
}

export function useCollaborativeEditor({ socket, roomId, file, canEdit = true, onFileUpdate }) {
  const [drafts, setDrafts] = useState(() => (
    file?.id ? { [file.id]: file.content || '' } : {}
  ));
  const [activeDraftFileId, setActiveDraftFileId] = useState(file?.id || '');
  const [version, setVersion] = useState(file?.version || 0);
  const [syncStatus, setSyncStatus] = useState('saved');
  const documentsRef = useRef(new Map());
  const pendingUpdatesRef = useRef(new Map());
  const inFlightRef = useRef(new Set());
  const joinedRef = useRef(false);
  const currentFileIdRef = useRef(file?.id || '');
  const roomIdRef = useRef(roomId);
  const socketRef = useRef(socket);
  const canEditRef = useRef(canEdit);
  const onFileUpdateRef = useRef(onFileUpdate);
  const versionsRef = useRef(new Map());
  const statusRef = useRef('saved');

  socketRef.current = socket;
  canEditRef.current = canEdit;
  onFileUpdateRef.current = onFileUpdate;

  const updateStatus = useCallback((nextStatus) => {
    statusRef.current = nextStatus;
    setSyncStatus(nextStatus);
  }, []);

  const updateFileContent = useCallback((fileId, content, state, nextVersion) => {
    const currentVersion = versionsRef.current.get(fileId) || 0;
    const resolvedVersion = Number.isInteger(nextVersion)
      ? Math.max(currentVersion, nextVersion)
      : currentVersion;
    versionsRef.current.set(fileId, resolvedVersion);
    const documentEntry = documentsRef.current.get(fileId);
    const updatedFile = {
      ...(documentEntry?.file || {}),
      id: fileId,
      content,
      collabState: state,
      version: resolvedVersion,
    };
    if (documentEntry) documentEntry.file = updatedFile;
    onFileUpdateRef.current?.(updatedFile);
  }, []);

  const flushFileUpdates = useCallback((fileId) => {
    const socketClient = socketRef.current;
    const pending = pendingUpdatesRef.current.get(fileId) || [];
    if (!socketClient?.connected || !joinedRef.current || !pending.length || inFlightRef.current.has(fileId)) {
      return;
    }

    inFlightRef.current.add(fileId);
    const batch = pending.slice();
    const update = batch.length === 1
      ? batch[0].update
      : Y.mergeUpdates(batch.map((item) => item.update));
    socketClient.emit(
      SOCKET_EVENTS.EDITOR_CRDT_UPDATE,
      {
        roomId: roomIdRef.current,
        fileId,
        update: encodeUpdate(update),
      },
      (result) => {
        inFlightRef.current.delete(fileId);
        if (!result?.success) {
          if (fileId === currentFileIdRef.current) {
            updateStatus(result?.code === 'ROOM_NOT_JOINED' ? 'offline' : 'error');
          }
          return;
        }

        const currentPending = pendingUpdatesRef.current.get(fileId) || [];
        const sentIds = new Set(batch.map((item) => item.id));
        const remaining = currentPending.filter((item) => !sentIds.has(item.id));
        if (remaining.length) pendingUpdatesRef.current.set(fileId, remaining);
        else pendingUpdatesRef.current.delete(fileId);

        if (Number.isInteger(result.version)) {
          versionsRef.current.set(
            fileId,
            Math.max(versionsRef.current.get(fileId) || 0, result.version),
          );
          if (fileId === currentFileIdRef.current) {
            setVersion(versionsRef.current.get(fileId));
          }
        }
        if (fileId === currentFileIdRef.current) {
          updateStatus(remaining.length ? 'saving' : 'saved');
        }
        if (remaining.length) flushFileUpdates(fileId);
      },
    );
  }, [updateStatus]);

  const getOrCreateDocument = useCallback((file) => {
    if (!file?.id) return null;
    const existing = documentsRef.current.get(file.id);
    if (existing) {
      existing.file = { ...existing.file, ...file };
      if (Number.isInteger(file.version)) {
        versionsRef.current.set(
          file.id,
          Math.max(versionsRef.current.get(file.id) || 0, file.version),
        );
      }
      if (file.collabState) {
        Y.applyUpdate(existing.document, decodeUpdate(file.collabState), SERVER_ORIGIN);
      } else if (typeof file.content === 'string' && file.content !== existing.text.toString()) {
        const { index, deletedLength, insertedText } = contentDiff(existing.text.toString(), file.content);
        existing.document.transact(() => {
          if (deletedLength) existing.text.delete(index, deletedLength);
          if (insertedText) existing.text.insert(index, insertedText);
        }, SERVER_ORIGIN);
      }
      if (file.id === currentFileIdRef.current) {
        setDrafts((current) => ({ ...current, [file.id]: existing.text.toString() }));
      }
      return existing;
    }

    const document = new Y.Doc();
    const text = document.getText(TEXT_NAME);
    if (file.collabState) {
      Y.applyUpdate(document, decodeUpdate(file.collabState), SERVER_ORIGIN);
    } else if (file.content) {
      const clientId = document.clientID;
      document.clientID = seedClientId(file.id);
      document.transact(() => text.insert(0, file.content), SERVER_ORIGIN);
      document.clientID = clientId;
    }
    const entry = { document, text, file: { ...file } };
    documentsRef.current.set(file.id, entry);
    versionsRef.current.set(file.id, Number.isInteger(file.version) ? file.version : 0);

    document.on('update', (update, origin) => {
      if (origin !== LOCAL_ORIGIN) return;
      const content = text.toString();
      setDrafts((current) => ({ ...current, [file.id]: content }));
      const state = encodeUpdate(Y.encodeStateAsUpdate(document));
      updateFileContent(file.id, content, state);
      if (file.id === currentFileIdRef.current) {
        updateStatus(socketRef.current?.connected && joinedRef.current ? 'saving' : 'offline');
      }
      if (!canEditRef.current) return;

      const queue = pendingUpdatesRef.current.get(file.id) || [];
      queue.push({ id: `${Date.now()}-${Math.random()}`, update });
      pendingUpdatesRef.current.set(file.id, queue);
      flushFileUpdates(file.id);
    });
    return entry;
  }, [flushFileUpdates, updateFileContent, updateStatus]);

  useLayoutEffect(() => {
    const roomChanged = roomIdRef.current !== roomId;
    roomIdRef.current = roomId;
    currentFileIdRef.current = file?.id || '';
    setActiveDraftFileId(file?.id || '');
    if (roomChanged) {
      for (const { document } of documentsRef.current.values()) document.destroy();
      documentsRef.current.clear();
      pendingUpdatesRef.current.clear();
      inFlightRef.current.clear();
      versionsRef.current.clear();
      setDrafts({});
    }
    if (!file?.id) return;
    const entry = getOrCreateDocument(file);
    const content = entry.text.toString();
    setDrafts((current) => ({ ...current, [file.id]: content }));
    setVersion(versionsRef.current.get(file.id) || 0);
    updateStatus((pendingUpdatesRef.current.get(file.id) || []).length ? 'unsaved' : 'saved');
  }, [file?.id, getOrCreateDocument, roomId, updateStatus]);

  useEffect(() => {
    if (!socket || !roomId) {
      joinedRef.current = false;
      return undefined;
    }

    const handleEditorState = (payload) => {
      if (payload.roomId !== roomId) return;
      for (const incoming of payload.files || []) {
        const entry = getOrCreateDocument(incoming);
        if (!entry) continue;
        if (!incoming.collabState && incoming.content !== entry.text.toString()) {
          const { index, deletedLength, insertedText } = contentDiff(entry.text.toString(), incoming.content || '');
          entry.document.transact(() => {
            if (deletedLength) entry.text.delete(index, deletedLength);
            if (insertedText) entry.text.insert(index, insertedText);
          }, SERVER_ORIGIN);
        }
        const content = entry.text.toString();
        updateFileContent(
          incoming.id,
          content,
          encodeUpdate(Y.encodeStateAsUpdate(entry.document)),
          incoming.version,
        );
        if (incoming.id === currentFileIdRef.current) {
          setDrafts((current) => ({ ...current, [incoming.id]: content }));
          setVersion(versionsRef.current.get(incoming.id) || 0);
        }
      }
      joinedRef.current = true;
      for (const fileId of pendingUpdatesRef.current.keys()) flushFileUpdates(fileId);
      if (!pendingUpdatesRef.current.size && statusRef.current !== 'error') updateStatus('saved');
    };

    const handleCrdtUpdate = (payload) => {
      if (payload.roomId !== roomId || typeof payload.fileId !== 'string') return;
      const entry = documentsRef.current.get(payload.fileId);
      if (!entry) return;
      try {
        Y.applyUpdate(entry.document, decodeUpdate(payload.update), SERVER_ORIGIN);
      } catch (error) {
        console.error('Unable to apply a collaborative editor update:', error);
        if (payload.fileId === currentFileIdRef.current) updateStatus('error');
        return;
      }
      const content = entry.text.toString();
      updateFileContent(
        payload.fileId,
        content,
        encodeUpdate(Y.encodeStateAsUpdate(entry.document)),
        payload.version,
      );
      if (payload.fileId === currentFileIdRef.current) {
        setDrafts((current) => ({ ...current, [payload.fileId]: content }));
        setVersion(versionsRef.current.get(payload.fileId) || 0);
        if (!(pendingUpdatesRef.current.get(payload.fileId) || []).length) updateStatus('saved');
      }
    };

    const handleFilesUpdate = (payload) => {
      if (payload.roomId !== roomId) return;
      const fileIds = new Set((payload.files || []).map((item) => item.id));
      for (const [fileId, entry] of documentsRef.current) {
        if (!fileIds.has(fileId)) {
          entry.document.destroy();
          documentsRef.current.delete(fileId);
          pendingUpdatesRef.current.delete(fileId);
          versionsRef.current.delete(fileId);
        }
      }
      for (const item of payload.files || []) getOrCreateDocument(item);
    };

    const handleConnect = () => {
      joinedRef.current = false;
      if (currentFileIdRef.current) updateStatus('offline');
    };
    const handleDisconnect = () => {
      joinedRef.current = false;
      if (currentFileIdRef.current) updateStatus('offline');
      inFlightRef.current.clear();
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on(SOCKET_EVENTS.EDITOR_STATE, handleEditorState);
    socket.on(SOCKET_EVENTS.EDITOR_CRDT_UPDATE, handleCrdtUpdate);
    socket.on(SOCKET_EVENTS.FILES_UPDATE, handleFilesUpdate);
    if (socket.connected) socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId });
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off(SOCKET_EVENTS.EDITOR_STATE, handleEditorState);
      socket.off(SOCKET_EVENTS.EDITOR_CRDT_UPDATE, handleCrdtUpdate);
      socket.off(SOCKET_EVENTS.FILES_UPDATE, handleFilesUpdate);
    };
  }, [flushFileUpdates, getOrCreateDocument, roomId, socket, updateFileContent, updateStatus]);

  const changeDraft = useCallback((value, changedFileId = currentFileIdRef.current) => {
    if (!changedFileId || changedFileId !== currentFileIdRef.current || !canEditRef.current) return;
    const entry = getOrCreateDocument({
      id: changedFileId,
      content: drafts[changedFileId] || '',
      version: versionsRef.current.get(changedFileId) || 0,
    });
    const current = entry.text.toString();
    if (value === current) return;
    if (new TextEncoder().encode(value).length > MAX_FILE_BYTES) {
      updateStatus('error');
      return;
    }

    const { index, deletedLength, insertedText } = contentDiff(current, value);
    entry.document.transact(() => {
      if (deletedLength) entry.text.delete(index, deletedLength);
      if (insertedText) entry.text.insert(index, insertedText);
    }, LOCAL_ORIGIN);
  }, [drafts, getOrCreateDocument, updateStatus]);

  useEffect(() => () => {
    for (const { document } of documentsRef.current.values()) document.destroy();
    documentsRef.current.clear();
    pendingUpdatesRef.current.clear();
    inFlightRef.current.clear();
  }, []);

  return {
    draft: file?.id && activeDraftFileId === file.id
      ? drafts[file.id] ?? file.content ?? ''
      : file?.content || '',
    version,
    syncStatus,
    changeDraft,
  };
}
