import { useEffect, useRef, useState } from 'react';
import { useVoiceChat } from '../hooks/useVoiceChat';

function RemoteAudio({ stream, onPlaybackBlocked }) {
  const audioRef = useRef(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.srcObject = stream;
    audio.play()
      .then(() => onPlaybackBlocked(false))
      .catch(() => onPlaybackBlocked(true));
    return () => {
      audio.srcObject = null;
    };
  }, [onPlaybackBlocked, stream]);

  return <audio autoPlay className="hidden" playsInline ref={audioRef} />;
}

function participantLabel(participant, currentUser) {
  const name = participant.username || 'Room member';
  return participant.userId === currentUser.id ? `${name} (you)` : name;
}

export default function RoomVoiceChat({ room, roomId, currentUser, socket }) {
  const voice = useVoiceChat({ roomId, socket, currentUser });
  const [membersCanSpeak, setMembersCanSpeak] = useState(
    room.voicePermissions?.membersCanSpeak !== false,
  );
  const [memberOverrides, setMemberOverrides] = useState(
    room.voicePermissions?.memberOverrides || {},
  );
  const [permissionError, setPermissionError] = useState('');
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const audioContainerRef = useRef(null);
  const canManageVoice = room.isOwner || room.currentRole === 'moderator';
  const onlineVoiceUsers = new Set(voice.participants.map((participant) => participant.userId));

  useEffect(() => {
    setMembersCanSpeak(room.voicePermissions?.membersCanSpeak !== false);
    setMemberOverrides(room.voicePermissions?.memberOverrides || {});
  }, [room.id, room.voicePermissions]);

  useEffect(() => {
    const change = voice.permissionUpdate;
    if (!change || change.roomId !== roomId) return;
    if (change.scope === 'members') {
      setMembersCanSpeak(change.allowed);
      setMemberOverrides({});
    } else if (change.scope === 'member' && change.targetUserId) {
      setMemberOverrides((current) => ({
        ...current,
        [change.targetUserId]: change.allowed,
      }));
    }
  }, [roomId, voice.permissionUpdate]);

  async function enableAudioPlayback() {
    const audioElements = audioContainerRef.current?.querySelectorAll('audio') || [];
    const results = await Promise.allSettled(
      [...audioElements].map((audio) => audio.play()),
    );
    setAudioPlaybackBlocked(results.some((result) => result.status === 'rejected'));
  }

  async function updateAllMembers(allowed) {
    setPermissionError('');
    try {
      await voice.setAllMemberVoicePermissions(allowed);
      setMembersCanSpeak(allowed);
      setMemberOverrides({});
    } catch (requestError) {
      setPermissionError(requestError.message);
    }
  }

  async function updateMember(member, allowed) {
    setPermissionError('');
    try {
      await voice.setMemberVoicePermission(member.id, allowed);
      setMemberOverrides((current) => ({ ...current, [member.id]: allowed }));
    } catch (requestError) {
      setPermissionError(requestError.message);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Room audio</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Voice chat</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">
            Audio is peer-to-peer and is not recorded. Your microphone is requested only when you join voice chat.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {voice.status === 'idle' || voice.status === 'error' ? (
            <button
              className="rounded-lg bg-brand-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!socket?.connected || voice.status === 'joining'}
              onClick={() => void voice.startVoice()}
              type="button"
            >
              {voice.status === 'joining' ? 'Connecting…' : 'Join voice'}
            </button>
          ) : (
            <>
              <button
                className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                  voice.microphoneEnabled
                    ? 'border border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20'
                    : 'bg-brand-400 text-slate-950 hover:bg-brand-300'
                }`}
                disabled={!voice.canSpeak || voice.status !== 'connected' || voice.microphoneBusy}
                onClick={() => void voice.toggleMicrophone()}
                title={!voice.canSpeak ? 'A room owner or moderator must grant microphone permission.' : undefined}
                type="button"
              >
                {voice.microphoneBusy
                  ? 'Connecting microphone…'
                  : voice.microphoneEnabled ? 'Mute microphone' : 'Enable microphone'}
              </button>
              <button
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white"
                onClick={() => void enableAudioPlayback()}
                type="button"
              >
                Enable speaker
              </button>
              <button
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white"
                onClick={() => void voice.leaveVoice()}
                type="button"
              >
                Leave voice
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2.5 py-1 ${
          voice.status === 'connected'
            ? 'bg-emerald-400/10 text-emerald-300'
            : voice.status === 'error'
              ? 'bg-rose-400/10 text-rose-300'
              : 'bg-slate-800 text-slate-400'
        }`}>
          {voice.status === 'connected'
            ? 'Connected'
            : voice.status === 'joining'
              ? 'Connecting'
              : voice.status === 'reconnecting'
                ? 'Reconnecting'
                : voice.status === 'error'
                  ? 'Connection error'
                  : 'Not connected'}
        </span>
        {voice.status === 'connected' && (
          <span className="text-slate-500">
            {voice.microphoneBusy
              ? 'Microphone connecting'
              : voice.microphoneEnabled ? 'Microphone on' : 'Microphone off'}
          </span>
        )}
        {voice.status === 'connected' && !voice.canSpeak && (
          <span className="text-amber-300">Listening only · microphone permission is disabled</span>
        )}
      </div>

      {voice.error && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-200" role="alert">
          {voice.error}
        </p>
      )}
      {audioPlaybackBlocked && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200" role="status">
          Your browser paused room audio. Select “Enable speaker” to hear participants.
        </p>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-slate-400">
          Voice participants {voice.status === 'connected' ? `· ${voice.participants.length}` : ''}
        </p>
        {voice.status === 'connected' && voice.participants.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {voice.participants.map((participant) => {
              const isSpeaking = voice.speakingUserIds.includes(participant.userId);
              return (
                <li
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
                    isSpeaking
                      ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200'
                      : 'border-slate-800 bg-slate-950/60 text-slate-300'
                  }`}
                  key={participant.socketId}
                  title={isSpeaking ? 'Speaking' : participant.microphoneEnabled ? 'Microphone on' : 'Microphone off'}
                >
                  <span className={`h-2 w-2 rounded-full ${
                    isSpeaking
                      ? 'animate-pulse bg-emerald-400'
                      : participant.microphoneEnabled ? 'bg-brand-300' : 'bg-slate-600'
                  }`} />
                  <span>{participantLabel(participant, currentUser)}</span>
                  <span className="text-[10px] text-slate-500">
                    {participant.microphoneEnabled ? 'mic on' : 'muted'}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
            {voice.status === 'connected'
              ? 'You are the first participant in voice chat.'
              : `${onlineVoiceUsers.size} ${onlineVoiceUsers.size === 1 ? 'member is' : 'members are'} in this room. Join voice to talk.`}
          </p>
        )}
      </div>

      {canManageVoice && (
        <details className="mt-4 border-t border-slate-800 pt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">
            Microphone permissions
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-5 text-slate-500">
              Owners and moderators can always speak. Permission changes apply to regular members and are enforced by the room server for joining and unmuting.
            </p>
            <button
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-brand-400/50 hover:text-brand-200"
              onClick={() => void updateAllMembers(!membersCanSpeak)}
              type="button"
            >
              {membersCanSpeak ? 'Disable microphones for all members' : 'Allow microphones for all members'}
            </button>
            <ul className="space-y-2">
              {room.members
                .filter((member) => member.role === 'member')
                .map((member) => {
                  const allowed = typeof memberOverrides[member.id] === 'boolean'
                    ? memberOverrides[member.id]
                    : membersCanSpeak;
                  const isConnected = onlineVoiceUsers.has(member.id);
                  return (
                    <li className="flex flex-wrap items-center justify-between gap-2 text-xs" key={member.id}>
                      <span className="text-slate-400">
                        {member.username}
                        {member.id === currentUser.id ? ' (you)' : ''}
                        <span className="text-slate-600"> · {isConnected ? 'in voice' : 'not in voice'}</span>
                      </span>
                      <button
                        className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-brand-400/50 hover:text-brand-200"
                        onClick={() => void updateMember(member, !allowed)}
                        type="button"
                      >
                        {allowed ? 'Take mic permission' : 'Give mic permission'}
                      </button>
                    </li>
                  );
                })}
            </ul>
            {permissionError && (
              <p className="text-xs text-rose-300" role="alert">{permissionError}</p>
            )}
          </div>
        </details>
      )}

      <div className="hidden" ref={audioContainerRef}>
        {Object.entries(voice.remoteStreams).map(([socketId, stream]) => (
          <RemoteAudio
            key={socketId}
            onPlaybackBlocked={setAudioPlaybackBlocked}
            stream={stream}
          />
        ))}
      </div>
    </section>
  );
}
