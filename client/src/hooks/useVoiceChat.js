import { useCallback, useEffect, useRef, useState } from 'react';
import { SOCKET_EVENTS } from '../socket/events';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const SIGNAL_TIMEOUT_MS = 10000;

function mediaErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Microphone access was denied. Allow microphone access in your browser settings and try again.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect a microphone and try again.';
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'The microphone is unavailable or already in use by another application.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Microphone access requires a supported browser and a secure HTTPS connection (localhost is supported for development).';
  }
  return 'Unable to access the microphone. Check your device and browser permissions.';
}

function emitAcknowledged(socket, event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('The room connection is offline. Reconnect and try again.'));
      return;
    }
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The voice service did not respond. Check your connection and try again.'));
    }, SIGNAL_TIMEOUT_MS);

    socket.emit(event, payload, (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (!result?.success) {
        reject(new Error(result?.message || 'The voice request could not be completed.'));
        return;
      }
      resolve(result);
    });
  });
}

function participantList(values) {
  return [...values].sort((left, right) =>
    left.username.localeCompare(right.username) || left.socketId.localeCompare(right.socketId),
  );
}

export function useVoiceChat({ roomId, socket, currentUser }) {
  const [status, setStatus] = useState('idle');
  const [participants, setParticipants] = useState([]);
  const [canSpeak, setCanSpeak] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [microphoneBusy, setMicrophoneBusy] = useState(false);
  const [error, setError] = useState('');
  const [remoteStreams, setRemoteStreams] = useState({});
  const [speakingUserIds, setSpeakingUserIds] = useState([]);
  const [permissionUpdate, setPermissionUpdate] = useState(null);

  const activeRef = useRef(false);
  const roomIdRef = useRef(roomId);
  const socketRef = useRef(socket);
  const canSpeakRef = useRef(false);
  const microphoneEnabledRef = useRef(false);
  const microphoneBusyRef = useRef(false);
  const microphoneAttemptRef = useRef(0);
  const joinAttemptRef = useRef(0);
  const localStreamRef = useRef(null);
  const iceServersRef = useRef([]);
  const peersRef = useRef(new Map());
  const participantsRef = useRef(new Map());
  const remoteStreamsRef = useRef({});
  const renegotiateRef = useRef(() => {});

  roomIdRef.current = roomId;
  socketRef.current = socket;

  const updateParticipant = useCallback((participant) => {
    if (!participant?.socketId) return;
    participantsRef.current.set(participant.socketId, participant);
    setParticipants(participantList(participantsRef.current.values()));
  }, []);

  const replaceParticipants = useCallback((items) => {
    participantsRef.current = new Map(
      (items || []).filter((item) => item?.socketId).map((item) => [item.socketId, item]),
    );
    setParticipants(participantList(participantsRef.current.values()));
  }, []);

  const updateRemoteStream = useCallback((socketId, stream) => {
    const next = { ...remoteStreamsRef.current };
    if (stream) next[socketId] = stream;
    else delete next[socketId];
    remoteStreamsRef.current = next;
    setRemoteStreams(next);
  }, []);

  const closePeer = useCallback((socketId) => {
    const peer = peersRef.current.get(socketId);
    if (peer) {
      peer.connection.ontrack = null;
      peer.connection.onicecandidate = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.onsignalingstatechange = null;
      peer.connection.close();
      peersRef.current.delete(socketId);
    }
    updateRemoteStream(socketId, null);
  }, [updateRemoteStream]);

  const closePeers = useCallback(() => {
    for (const socketId of peersRef.current.keys()) closePeer(socketId);
    peersRef.current.clear();
    remoteStreamsRef.current = {};
    setRemoteStreams({});
    setSpeakingUserIds([]);
  }, [closePeer]);

  const stopMicrophone = useCallback(async ({ notify = false, revokeDirection = false } = {}) => {
    microphoneAttemptRef.current += 1;
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    microphoneEnabledRef.current = false;
    setMicrophoneEnabled(false);
    stream?.getTracks().forEach((track) => track.stop());

    const peerUpdates = [];
    let renegotiatePeers = false;
    for (const peer of peersRef.current.values()) {
      if (peer.audioTransceiver) {
        peerUpdates.push(peer.audioTransceiver.sender.replaceTrack(null));
        if (revokeDirection && peer.audioTransceiver.direction !== 'recvonly') {
          peer.audioTransceiver.direction = 'recvonly';
          peer.needsNegotiation = true;
          renegotiatePeers = true;
        }
      }
    }
    await Promise.allSettled(peerUpdates);
    if (renegotiatePeers) {
      for (const peer of peersRef.current.values()) {
        if (peer.needsNegotiation) void renegotiateRef.current(peer);
      }
    }
    if (notify && socketRef.current?.connected && activeRef.current) {
      try {
        await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_MIC_STATE, {
          roomId: roomIdRef.current,
          enabled: false,
        });
      } catch (requestError) {
        setError(requestError.message);
      }
    }

    const ownSocketId = socketRef.current?.id;
    if (ownSocketId) {
      const ownParticipant = participantsRef.current.get(ownSocketId);
      if (ownParticipant) {
        updateParticipant({ ...ownParticipant, microphoneEnabled: false });
      }
    }
  }, [updateParticipant]);

  const sendSignal = useCallback(async (targetSocketId, type, data) => {
    const result = await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_SIGNAL, {
      roomId: roomIdRef.current,
      targetSocketId,
      type,
      data,
    });
    return result.success;
  }, []);

  const renegotiate = useCallback(async (peer) => {
    if (
      !peer ||
      peer.connection.signalingState !== 'stable' ||
      peer.makingOffer ||
      !socketRef.current?.connected ||
      !activeRef.current
    ) {
      if (peer) peer.needsNegotiation = true;
      return;
    }

    peer.makingOffer = true;
    peer.needsNegotiation = false;
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      await sendSignal(peer.socketId, 'offer', peer.connection.localDescription.toJSON());
    } catch (requestError) {
      setError(requestError.message || 'Unable to establish a peer voice connection.');
    } finally {
      peer.makingOffer = false;
    }
  }, [sendSignal]);

  renegotiateRef.current = renegotiate;

  const createPeer = useCallback((participant, initiate = false) => {
    if (!participant?.socketId || participant.socketId === socketRef.current?.id) return null;
    const existing = peersRef.current.get(participant.socketId);
    if (existing) {
      if (initiate) {
        existing.needsNegotiation = true;
        void renegotiate(existing);
      }
      return existing;
    }

    const connection = new RTCPeerConnection({ iceServers: iceServersRef.current });
    const peer = {
      socketId: participant.socketId,
      userId: participant.userId,
      username: participant.username,
      connection,
      audioTransceiver: null,
      pendingCandidates: [],
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      polite: String(socketRef.current?.id || '').localeCompare(participant.socketId) > 0,
      needsNegotiation: false,
    };
    peersRef.current.set(participant.socketId, peer);

    try {
      peer.audioTransceiver = connection.addTransceiver('audio', {
        direction: canSpeakRef.current ? 'sendrecv' : 'recvonly',
      });
      const localTrack = localStreamRef.current?.getAudioTracks()[0];
      if (localTrack) {
        localTrack.enabled = microphoneEnabledRef.current;
        void peer.audioTransceiver.sender.replaceTrack(localTrack).catch(() => {
          setError('Unable to attach your microphone to the room voice connection.');
        });
      }
    } catch (requestError) {
      peersRef.current.delete(participant.socketId);
      connection.close();
      setError(requestError.message || 'Unable to create a room voice connection.');
      return null;
    }

    connection.onicecandidate = (event) => {
      if (!activeRef.current) return;
      const candidate = event.candidate?.toJSON() || { candidate: null };
      void sendSignal(peer.socketId, 'ice-candidate', candidate).catch((signalError) => {
        if (activeRef.current) setError(signalError.message);
      });
    };
    connection.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      updateRemoteStream(peer.socketId, stream);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') {
        setError(`Could not connect to ${peer.username}. Check the network or TURN server configuration.`);
      } else if (connection.connectionState === 'connected') {
        setError((current) => current.includes(peer.username) ? '' : current);
      }
    };
    connection.onsignalingstatechange = () => {
      if (connection.signalingState === 'stable' && peer.needsNegotiation) {
        void renegotiate(peer);
      }
    };

    if (initiate) {
      peer.needsNegotiation = true;
      void renegotiate(peer);
    }
    return peer;
  }, [renegotiate, sendSignal, updateRemoteStream]);

  const applyMicrophoneStream = useCallback(async (stream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('No audio track was returned by the microphone.');
    }
    track.enabled = false;

    const replacements = [];
    for (const peer of peersRef.current.values()) {
      if (peer.audioTransceiver) {
        if (peer.audioTransceiver.direction !== 'sendrecv') {
          peer.audioTransceiver.direction = 'sendrecv';
          peer.needsNegotiation = true;
        }
        replacements.push(peer.audioTransceiver.sender.replaceTrack(track));
      }
    }
    const results = await Promise.allSettled(replacements);
    const failedReplacement = results.find((result) => result.status === 'rejected');
    if (failedReplacement) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('Unable to attach your microphone to every room participant.');
    }
    localStreamRef.current = stream;
  }, []);

  const turnMicrophoneOn = useCallback(async () => {
    if (!activeRef.current) {
      setError('Join room voice chat before enabling your microphone.');
      return;
    }
    if (!canSpeakRef.current) {
      setError('The room owner or a moderator has not enabled your microphone permission.');
      return;
    }
    if (microphoneEnabledRef.current || microphoneBusyRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(mediaErrorMessage());
      return;
    }

    setError('');
    microphoneBusyRef.current = true;
    setMicrophoneBusy(true);
    const attemptId = ++microphoneAttemptRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (attemptId !== microphoneAttemptRef.current || !activeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await applyMicrophoneStream(stream);
      await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_MIC_STATE, {
        roomId: roomIdRef.current,
        enabled: true,
      });
      if (attemptId !== microphoneAttemptRef.current || !activeRef.current) {
        await stopMicrophone();
        return;
      }
      stream.getAudioTracks().forEach((track) => { track.enabled = true; });
      microphoneEnabledRef.current = true;
      setMicrophoneEnabled(true);
      const ownParticipant = participantsRef.current.get(socketRef.current?.id);
      if (ownParticipant) {
        updateParticipant({ ...ownParticipant, microphoneEnabled: true });
      }
      for (const peer of peersRef.current.values()) {
        if (peer.needsNegotiation) void renegotiate(peer);
      }
    } catch (requestError) {
      if (attemptId !== microphoneAttemptRef.current) return;
      if (localStreamRef.current) {
        await stopMicrophone({ notify: true });
      }
      setError(
        requestError?.name === 'NotAllowedError' ||
        requestError?.name === 'NotFoundError' ||
        requestError?.name === 'NotReadableError' ||
        requestError?.name === 'SecurityError'
          ? mediaErrorMessage(requestError)
          : requestError.message || 'Unable to turn on your microphone.',
      );
    } finally {
      microphoneBusyRef.current = false;
      setMicrophoneBusy(false);
    }
  }, [applyMicrophoneStream, renegotiate, stopMicrophone, updateParticipant]);

  const startVoice = useCallback(async () => {
    if (!socket?.connected) {
      setError('Connect to this room before joining voice chat.');
      setStatus('error');
      return;
    }
    if (activeRef.current) return;

    const attemptId = ++joinAttemptRef.current;
    setStatus('joining');
    setError('');
    closePeers();
    let pendingStream = null;
    try {
      const response = await fetch(`${API_URL}/api/rooms/${roomId}/voice-config`, {
        credentials: 'include',
        cache: 'no-store',
      });
      let config;
      try {
        config = await response.json();
      } catch {
        throw new Error('The voice service returned an invalid configuration response.');
      }
      if (!response.ok) {
        throw new Error(config?.message || 'Unable to configure room voice chat.');
      }
      if (attemptId !== joinAttemptRef.current) return;
      if (!Array.isArray(config.iceServers) || typeof config.canSpeak !== 'boolean') {
        throw new Error('The voice service returned an invalid configuration response.');
      }
      iceServersRef.current = config.iceServers;
      canSpeakRef.current = config.canSpeak;
      setCanSpeak(config.canSpeak);

      let microphoneError = '';
      if (config.canSpeak) {
        if (!navigator.mediaDevices?.getUserMedia) {
          microphoneError = mediaErrorMessage();
        } else {
          try {
            pendingStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
            pendingStream.getAudioTracks().forEach((track) => { track.enabled = false; });
          } catch (mediaError) {
            microphoneError = mediaErrorMessage(mediaError);
          }
        }
      }
      if (attemptId !== joinAttemptRef.current) {
        pendingStream?.getTracks().forEach((track) => track.stop());
        pendingStream = null;
        return;
      }

      const result = await emitAcknowledged(socket, SOCKET_EVENTS.VOICE_JOIN, { roomId });
      if (attemptId !== joinAttemptRef.current) {
        pendingStream?.getTracks().forEach((track) => track.stop());
        pendingStream = null;
        socket.emit(SOCKET_EVENTS.VOICE_LEAVE, { roomId });
        return;
      }
      activeRef.current = true;
      replaceParticipants(result.participants);
      canSpeakRef.current = result.canSpeak;
      setCanSpeak(result.canSpeak);
      if (pendingStream && result.canSpeak) {
        localStreamRef.current = pendingStream;
      } else if (pendingStream) {
        pendingStream.getTracks().forEach((track) => track.stop());
        pendingStream = null;
      }
      setMicrophoneEnabled(false);
      microphoneEnabledRef.current = false;
      setStatus('connected');
      if (microphoneError) setError(microphoneError);

      for (const participant of result.participants) {
        if (participant.socketId !== socket.id) createPeer(participant, true);
      }
      if (pendingStream && result.canSpeak) {
        await emitAcknowledged(socket, SOCKET_EVENTS.VOICE_MIC_STATE, {
          roomId,
          enabled: true,
        });
        if (attemptId !== joinAttemptRef.current) {
          pendingStream.getTracks().forEach((track) => track.stop());
          pendingStream = null;
          localStreamRef.current = null;
          socket.emit(SOCKET_EVENTS.VOICE_LEAVE, { roomId });
          return;
        }
        pendingStream.getAudioTracks().forEach((track) => { track.enabled = true; });
        pendingStream = null;
        microphoneEnabledRef.current = true;
        setMicrophoneEnabled(true);
        const own = participantsRef.current.get(socket.id);
        if (own) updateParticipant({ ...own, microphoneEnabled: true });
      }
    } catch (requestError) {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (attemptId !== joinAttemptRef.current) return;
      activeRef.current = false;
      const stream = localStreamRef.current;
      localStreamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      setMicrophoneEnabled(false);
      microphoneEnabledRef.current = false;
      closePeers();
      setStatus('error');
      setError(requestError.message || 'Unable to join room voice chat.');
      if (socket.connected) {
        socket.emit(SOCKET_EVENTS.VOICE_LEAVE, { roomId });
      }
    }
  }, [closePeers, createPeer, replaceParticipants, roomId, socket, updateParticipant]);

  const leaveVoice = useCallback(async () => {
    joinAttemptRef.current += 1;
    const wasActive = activeRef.current;
    activeRef.current = false;
    await stopMicrophone();
    closePeers();
    participantsRef.current.clear();
    setParticipants([]);
    setCanSpeak(false);
    canSpeakRef.current = false;
    setPermissionUpdate(null);
    setStatus('idle');
    if (wasActive && socketRef.current?.connected) {
      try {
        await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_LEAVE, {
          roomId: roomIdRef.current,
        });
      } catch (requestError) {
        setError(requestError.message);
      }
    }
  }, [closePeers, stopMicrophone]);

  const toggleMicrophone = useCallback(async () => {
    if (microphoneEnabledRef.current) {
      await stopMicrophone({ notify: true });
      return;
    }
    await turnMicrophoneOn();
  }, [stopMicrophone, turnMicrophoneOn]);

  const setMemberVoicePermission = useCallback(async (targetUserId, allowed) => {
    if (!socketRef.current?.connected) throw new Error('Connect to the room before changing voice permissions.');
    const result = await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_PERMISSION_SET, {
      roomId: roomIdRef.current,
      targetUserId,
      allowed,
    });
    setPermissionUpdate(result);
    return result;
  }, []);

  const setAllMemberVoicePermissions = useCallback(async (allowed) => {
    if (!socketRef.current?.connected) throw new Error('Connect to the room before changing voice permissions.');
    const result = await emitAcknowledged(socketRef.current, SOCKET_EVENTS.VOICE_PERMISSION_SET, {
      roomId: roomIdRef.current,
      allowed,
    });
    setPermissionUpdate(result);
    return result;
  }, []);

  useEffect(() => {
    if (!socket || !roomId) return undefined;

    const handleVoiceState = (payload) => {
      if (payload.roomId !== roomId) return;
      replaceParticipants(payload.participants);
      canSpeakRef.current = payload.canSpeak;
      setCanSpeak(payload.canSpeak);
    };
    const handleParticipantJoined = (payload) => {
      if (payload.roomId !== roomId) return;
      updateParticipant(payload.participant);
    };
    const handleParticipantLeft = (payload) => {
      if (payload.roomId !== roomId) return;
      participantsRef.current.delete(payload.socketId);
      setParticipants(participantList(participantsRef.current.values()));
      closePeer(payload.socketId);
    };
    const handleParticipantUpdated = (payload) => {
      if (payload.roomId !== roomId) return;
      updateParticipant(payload.participant);
      if (payload.participant.userId === currentUser.id) {
        canSpeakRef.current = payload.participant.canSpeak;
        setCanSpeak(payload.participant.canSpeak);
        if (!payload.participant.canSpeak) {
          void stopMicrophone({ notify: true, revokeDirection: true });
          setError('Your microphone permission was removed by a room moderator.');
        }
      }
    };
    const handlePermissionUpdated = (payload) => {
      if (payload.roomId !== roomId) return;
      setPermissionUpdate(payload);
    };
    const handleSignal = async (payload) => {
      if (payload.roomId !== roomId || !payload.from?.socketId || !activeRef.current) return;
      if (!participantsRef.current.has(payload.from.socketId)) return;
      let peer = peersRef.current.get(payload.from.socketId);
      if (!peer) peer = createPeer(payload.from, false);
      if (!peer) return;

      const connection = peer.connection;
      try {
        if (payload.type === 'ice-candidate') {
          const candidate = payload.data?.candidate === null
            ? null
            : new RTCIceCandidate(payload.data);
          if (connection.remoteDescription) {
            await connection.addIceCandidate(candidate);
          } else {
            peer.pendingCandidates.push(candidate);
          }
          return;
        }

        if (payload.type !== 'offer' && payload.type !== 'answer') return;
        const offerCollision = payload.type === 'offer' &&
          (peer.makingOffer || (connection.signalingState !== 'stable' && !peer.settingRemoteAnswer));
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        peer.settingRemoteAnswer = payload.type === 'answer';
        if (offerCollision && peer.polite) {
          await connection.setLocalDescription({ type: 'rollback' });
        }
        await connection.setRemoteDescription(new RTCSessionDescription(payload.data));
        peer.settingRemoteAnswer = false;
        for (const candidate of peer.pendingCandidates.splice(0)) {
          await connection.addIceCandidate(candidate);
        }
        if (payload.type === 'offer') {
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
          await sendSignal(peer.socketId, 'answer', connection.localDescription.toJSON());
        }
      } catch (signalError) {
        peer.settingRemoteAnswer = false;
        if (!peer.ignoreOffer) {
          setError(signalError.message || `Unable to connect voice with ${payload.from.username}.`);
        }
      }
    };
    const handleVoiceError = (payload) => {
      if (payload?.message) setError(payload.message);
    };
    const handleDisconnect = () => {
      closePeers();
      void stopMicrophone();
      if (activeRef.current) {
        setMicrophoneEnabled(false);
        microphoneEnabledRef.current = false;
        setStatus('reconnecting');
        setError('Voice connection interrupted. Reconnecting…');
      }
    };
    const handleConnect = async () => {
      if (!activeRef.current) return;
      setStatus('joining');
      setError('');
      try {
        const response = await fetch(`${API_URL}/api/rooms/${roomId}/voice-config`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config?.message || 'Unable to reconnect to room voice chat.');
        iceServersRef.current = config.iceServers;
        canSpeakRef.current = config.canSpeak;
        const result = await emitAcknowledged(socket, SOCKET_EVENTS.VOICE_JOIN, { roomId });
        replaceParticipants(result.participants);
        canSpeakRef.current = result.canSpeak;
        setCanSpeak(result.canSpeak);
        setStatus('connected');
        for (const participant of result.participants) {
          if (participant.socketId !== socket.id) createPeer(participant, true);
        }
      } catch (reconnectError) {
        activeRef.current = false;
        closePeers();
        participantsRef.current.clear();
        setParticipants([]);
        setStatus('error');
        setError(reconnectError.message || 'Unable to reconnect to room voice chat.');
      }
    };

    socket.on(SOCKET_EVENTS.VOICE_STATE, handleVoiceState);
    socket.on(SOCKET_EVENTS.VOICE_PARTICIPANT_JOINED, handleParticipantJoined);
    socket.on(SOCKET_EVENTS.VOICE_PARTICIPANT_LEFT, handleParticipantLeft);
    socket.on(SOCKET_EVENTS.VOICE_PARTICIPANT_UPDATED, handleParticipantUpdated);
    socket.on(SOCKET_EVENTS.VOICE_PERMISSION_UPDATED, handlePermissionUpdated);
    socket.on(SOCKET_EVENTS.VOICE_SIGNAL, handleSignal);
    socket.on(SOCKET_EVENTS.VOICE_ERROR, handleVoiceError);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect', handleConnect);
    return () => {
      socket.off(SOCKET_EVENTS.VOICE_STATE, handleVoiceState);
      socket.off(SOCKET_EVENTS.VOICE_PARTICIPANT_JOINED, handleParticipantJoined);
      socket.off(SOCKET_EVENTS.VOICE_PARTICIPANT_LEFT, handleParticipantLeft);
      socket.off(SOCKET_EVENTS.VOICE_PARTICIPANT_UPDATED, handleParticipantUpdated);
      socket.off(SOCKET_EVENTS.VOICE_PERMISSION_UPDATED, handlePermissionUpdated);
      socket.off(SOCKET_EVENTS.VOICE_SIGNAL, handleSignal);
      socket.off(SOCKET_EVENTS.VOICE_ERROR, handleVoiceError);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect', handleConnect);
    };
  }, [
    closePeer,
    closePeers,
    createPeer,
    currentUser.id,
    replaceParticipants,
    roomId,
    sendSignal,
    socket,
    stopMicrophone,
    updateParticipant,
  ]);

  useEffect(() => {
    const audioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!audioContextConstructor) return undefined;

    let audioContext;
    let active = true;
    const analysers = [];
    try {
      audioContext = new audioContextConstructor();
      void audioContext.resume().catch(() => {});
      const streams = [];
      if (localStreamRef.current && microphoneEnabledRef.current) {
        streams.push([currentUser.id, localStreamRef.current]);
      }
      for (const [socketId, stream] of Object.entries(remoteStreams)) {
        const participant = participantsRef.current.get(socketId);
        if (participant) streams.push([participant.userId, stream]);
      }
      for (const [userId, stream] of streams) {
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analysers.push({ userId, analyser, source, samples: new Uint8Array(analyser.fftSize) });
      }

      const timer = window.setInterval(() => {
        if (!active) return;
        const speaking = new Set();
        for (const { userId, analyser, samples } of analysers) {
          analyser.getByteTimeDomainData(samples);
          let total = 0;
          for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            total += normalized * normalized;
          }
          if (Math.sqrt(total / samples.length) > 0.04) speaking.add(userId);
        }
        setSpeakingUserIds((current) => {
          const next = [...speaking].sort();
          return current.length === next.length && current.every((id, index) => id === next[index])
            ? current
            : next;
        });
      }, 120);

      return () => {
        active = false;
        window.clearInterval(timer);
        for (const { source, analyser } of analysers) {
          source.disconnect();
          analyser.disconnect();
        }
        void audioContext.close();
      };
    } catch {
      if (audioContext) void audioContext.close();
      return undefined;
    }
  }, [currentUser.id, microphoneEnabled, remoteStreams]);

  useEffect(() => () => {
    joinAttemptRef.current += 1;
    microphoneAttemptRef.current += 1;
    activeRef.current = false;
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    for (const peer of peersRef.current.values()) peer.connection.close();
    peersRef.current.clear();
    if (socketRef.current?.connected) {
      socketRef.current.emit(SOCKET_EVENTS.VOICE_LEAVE, { roomId: roomIdRef.current });
    }
  }, []);

  return {
    status,
    participants,
    canSpeak,
    microphoneEnabled,
    microphoneBusy,
    error,
    remoteStreams,
    speakingUserIds,
    permissionUpdate,
    startVoice,
    leaveVoice,
    toggleMicrophone,
    setMemberVoicePermission,
    setAllMemberVoicePermissions,
  };
}
