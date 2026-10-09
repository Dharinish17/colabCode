import { useEffect, useRef, useState } from 'react';
import { SOCKET_EVENTS } from '../socket/events';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const PAGE_SIZE = 50;
const MAX_MESSAGE_LENGTH = 2000;

async function loadMessages(roomId, before, signal) {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  const response = await fetch(`${API_URL}/api/rooms/${roomId}/messages${query}`, {
    credentials: 'include',
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Unable to load room chat.');
  return result;
}

function appendUnique(messages, message) {
  if (messages.some((current) => current.id === message.id)) return messages;
  return [...messages, message];
}

function mergeMessages(...groups) {
  const unique = new Map();
  for (const message of groups.flat()) unique.set(message.id, message);
  return [...unique.values()].sort((left, right) =>
    new Date(left.createdAt) - new Date(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function RoomChat({ roomId, socket, connectionStatus, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const messageListRef = useRef(null);
  const shouldScrollRef = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    setMessages([]);
    setLoading(true);
    setError('');
    shouldScrollRef.current = true;
    loadMessages(roomId, null, controller.signal)
      .then((result) => {
        setMessages((current) => mergeMessages(result.messages, current));
        setHasMore(result.hasMore);
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setError(loadError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [roomId]);

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;
    const refreshRecentMessages = () => {
      loadMessages(roomId)
        .then((result) => {
          if (!active) return;
          setMessages((current) => mergeMessages(result.messages, current));
          setHasMore(result.hasMore);
          setError('');
        })
        .catch((loadError) => {
          if (active) setError(loadError.message);
        });
    };
    const handleMessage = (payload) => {
      if (payload.roomId !== roomId) return;
      shouldScrollRef.current = true;
      setMessages((current) => appendUnique(current, payload.message));
    };
    socket.on('connect', refreshRecentMessages);
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, handleMessage);
    if (socket.connected) refreshRecentMessages();
    return () => {
      active = false;
      socket.off('connect', refreshRecentMessages);
      socket.off(SOCKET_EVENTS.CHAT_MESSAGE, handleMessage);
    };
  }, [roomId, socket]);

  useEffect(() => {
    if (shouldScrollRef.current) {
      messageListRef.current?.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: 'smooth',
      });
      shouldScrollRef.current = false;
    }
  }, [messages]);

  async function loadOlderMessages() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    setError('');
    try {
      const result = await loadMessages(roomId, messages[0].id);
      shouldScrollRef.current = false;
      setMessages((current) => mergeMessages(result.messages, current));
      setHasMore(result.hasMore);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingOlder(false);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    const body = messageText.trim();
    if (!body || body.length > MAX_MESSAGE_LENGTH || !socket?.connected || sending) return;
    setSending(true);
    setError('');
    socket.emit(SOCKET_EVENTS.CHAT_SEND, { roomId, body }, (result) => {
      setSending(false);
      if (!result?.success) {
        setError(result?.message || 'Unable to send your message.');
        return;
      }
      shouldScrollRef.current = true;
      setMessages((current) => appendUnique(current, result.message));
      setMessageText((current) => current === body ? '' : current);
    });
  }

  const canSend = connectionStatus === 'online' && socket?.connected;
  return (
    <section aria-label="Room chat" className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Room chat</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Messages</h2>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs ${
          canSend ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-800 text-slate-400'
        }`}>
          {canSend ? 'Connected' : 'Reconnecting'}
        </span>
      </div>
      {error && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">
          {error}
        </p>
      )}
      <div
        aria-live="polite"
        className="mt-4 h-72 space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 p-3"
        ref={messageListRef}
      >
        {hasMore && (
          <button
            className="w-full rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-400 hover:border-slate-600 hover:text-white disabled:opacity-50"
            disabled={loadingOlder}
            onClick={loadOlderMessages}
            type="button"
          >
            {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
          </button>
        )}
        {loading ? (
          <p className="py-8 text-center text-xs text-slate-500">Loading chat…</p>
        ) : messages.length ? messages.map((message) => (
          <article className="break-words text-sm" key={message.id}>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`font-medium ${message.sender.id === currentUser.id ? 'text-brand-200' : 'text-slate-200'}`}>
                {message.sender.username}{message.sender.id === currentUser.id ? ' (you)' : ''}
              </span>
              <time className="shrink-0 text-[10px] text-slate-600" dateTime={message.createdAt}>
                {formatTime(message.createdAt)}
              </time>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-slate-300">{message.body}</p>
          </article>
        )) : (
          <p className="py-8 text-center text-xs text-slate-500">No messages yet. Say hello to the room.</p>
        )}
      </div>
      <form className="mt-3" onSubmit={sendMessage}>
        <label className="sr-only" htmlFor={`room-chat-${roomId}`}>Message</label>
        <textarea
          className="min-h-20 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand-400/60"
          id={`room-chat-${roomId}`}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => setMessageText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form.requestSubmit();
            }
          }}
          placeholder={canSend ? 'Write a message…' : 'Connect to the room to send messages'}
          value={messageText}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[10px] text-slate-600">{messageText.length}/{MAX_MESSAGE_LENGTH} · Enter to send, Shift+Enter for newline</span>
          <button
            className="rounded-lg bg-brand-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSend || sending || !messageText.trim() || messageText.length > MAX_MESSAGE_LENGTH}
            type="submit"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
