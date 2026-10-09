import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EDITOR_LANGUAGES } from './constants/editorLanguages';
import { useCollaborativeCursors } from './hooks/useCollaborativeCursors';
import { useCollaborativeEditor } from './hooks/useCollaborativeEditor';
import { useRoomPresence } from './hooks/useRoomPresence';
import { SOCKET_EVENTS } from './socket/events';
import RoomChat from './components/RoomChat';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const ROOM_LANGUAGES = EDITOR_LANGUAGES.map(({ id, label }) => ({ value: id, label }));
const EXECUTABLE_LANGUAGES = new Set([
  'javascript',
  'python',
  'java',
  'c',
  'cpp',
  'go',
  'php',
  'ruby',
]);

async function readApiResult(response, fallbackMessage) {
  let result = null;
  try {
    result = await response.json();
  } catch {
    if (response.ok) {
      throw new Error('The server returned an invalid response. Please try again.');
    }
  }

  if (!response.ok) {
    const error = new Error(result?.message || fallbackMessage);
    error.status = response.status;
    throw error;
  }
  if (!result || typeof result !== 'object') {
    throw new Error('The server returned an invalid response. Please try again.');
  }
  return result;
}

async function requestAuth(endpoint, body) {
  const response = await fetch(`${API_URL}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return readApiResult(response, 'The authentication request could not be completed.');
}

async function requestRooms(endpoint, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`${API_URL}/api/rooms${endpoint}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return readApiResult(response, 'The room request could not be completed.');
}

function Brand({ light = false }) {
  return (
    <Link className={`inline-flex items-center gap-3 font-semibold tracking-tight ${light ? 'text-white' : 'text-slate-100'}`} to="/">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-400 font-mono text-lg text-slate-950">
        {'</>'}
      </span>
      colabCode
    </Link>
  );
}

function HomePage({ currentUser, authLoadError }) {
  return (
    <main className="min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
        <header className="flex items-center justify-between border-b border-slate-800 pb-5">
          <Brand />
          <nav className="flex items-center gap-3 text-sm">
            {currentUser ? (
              <Link className="rounded-lg bg-brand-400 px-4 py-2 font-semibold text-slate-950 hover:bg-brand-300" to="/workspace">
                Open workspace
              </Link>
            ) : (
              <>
                <Link className="px-3 py-2 text-slate-300 hover:text-white" to="/login">Log in</Link>
                <Link className="rounded-lg bg-brand-400 px-4 py-2 font-semibold text-slate-950 hover:bg-brand-300" to="/register">
                  Create account
                </Link>
              </>
            )}
          </nav>
        </header>

        <section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            {authLoadError && (
              <p role="alert" className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                Could not check your sign-in status: {authLoadError}
              </p>
            )}
            <p className="mb-5 inline-flex rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-brand-300">
              Build together, in real time
            </p>
            <h1 className="max-w-2xl text-5xl font-bold leading-tight tracking-tight text-white md:text-6xl">
              A better place to think in code.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
              Bring your team into one shared coding space. Sign in to pick up where your collaboration begins.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              {currentUser ? (
                <Link className="rounded-xl bg-brand-400 px-5 py-3 font-semibold text-slate-950 hover:bg-brand-300" to="/workspace">
                  Continue as {currentUser.username}
                </Link>
              ) : (
                <>
                  <Link className="rounded-xl bg-brand-400 px-5 py-3 font-semibold text-slate-950 hover:bg-brand-300" to="/register">
                    Get started
                  </Link>
                  <Link className="rounded-xl border border-slate-700 px-5 py-3 font-semibold text-white hover:border-slate-500" to="/login">
                    I already have an account
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="relative rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-brand-950/30">
            <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-brand-500/10 blur-3xl" />
            <div className="relative flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Shared workspace</p>
                <h2 className="mt-1 text-lg font-semibold text-white">hello-world.js</h2>
              </div>
              <span className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live
              </span>
            </div>
            <div className="relative mt-5 rounded-2xl border border-slate-800 bg-slate-950 p-5 font-mono text-sm leading-8">
              <p><span className="mr-5 text-slate-600">1</span><span className="text-brand-300">function</span> <span className="text-brand-200">buildTogether</span>() {'{'}</p>
              <p><span className="mr-5 text-slate-600">2</span>  <span className="text-brand-300">return</span> <span className="text-brand-100">'great ideas'</span>;</p>
              <p><span className="mr-5 text-slate-600">3</span>{'}'}</p>
              <div className="absolute left-[7.55rem] top-[3.1rem] h-6 border-l-2 border-brand-400" />
            </div>
            <div className="relative mt-4 flex items-center gap-2 text-xs text-slate-400">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500/20 font-medium text-brand-200">JD</span>
              <span>Jordan is collaborating</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function AuthPage({ mode, onLogin, authLoadError }) {
  const isRegister = mode === 'register';
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if (isRegister && form.password !== form.confirmPassword) {
      setError('Your passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const result = await requestAuth(isRegister ? 'register' : 'login', form);
      if (isRegister) {
        navigate('/login', {
          replace: true,
          state: { message: 'Your account is ready. Log in to continue.' },
        });
      } else {
        onLogin(result.user);
        navigate('/workspace', { replace: true });
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 py-12 text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Brand />
          <h1 className="mt-8 text-3xl font-bold tracking-tight text-white">
            {isRegister ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {isRegister ? 'Make room for better collaboration.' : 'Log in to return to your workspace.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl">
          {!isRegister && location.state?.message && (
            <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              {location.state.message}
            </p>
          )}
          {authLoadError && (
            <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              Could not check your sign-in status: {authLoadError}
            </p>
          )}
          {isRegister && (
            <label className="block space-y-2 text-sm font-medium text-slate-300">
              Username
              <input
                autoComplete="username"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
                maxLength={30}
                minLength={3}
                name="username"
                onChange={updateField}
                pattern="[A-Za-z0-9_-]{3,30}"
                required
                title="Use 3–30 letters, numbers, underscores, or hyphens."
                value={form.username}
              />
            </label>
          )}
          <label className="block space-y-2 text-sm font-medium text-slate-300">
            Email
            <input
              autoComplete="email"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
              name="email"
              onChange={updateField}
              required
              type="email"
              value={form.email}
            />
          </label>
          <label className="block space-y-2 text-sm font-medium text-slate-300">
            Password
            <input
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
              minLength={isRegister ? 8 : undefined}
              name="password"
              onChange={updateField}
              required
              type="password"
              value={form.password}
            />
          </label>
          {isRegister && (
            <label className="block space-y-2 text-sm font-medium text-slate-300">
              Confirm password
              <input
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
                name="confirmPassword"
                onChange={updateField}
                required
                type="password"
                value={form.confirmPassword}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          )}
          <button
            className="w-full rounded-lg bg-brand-400 px-4 py-3 font-semibold text-slate-950 hover:bg-brand-300 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          {isRegister ? 'Already have an account?' : 'New to colabCode?'}{' '}
          <Link className="font-medium text-brand-300 hover:text-brand-200" to={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Log in' : 'Create an account'}
          </Link>
        </p>
        <div className="mt-6 text-center">
          <Link className="text-xs text-slate-500 hover:text-slate-300" to="/">Back to home</Link>
        </div>
      </div>
    </main>
  );
}

function RoomCard({ room, actionLabel, onAction, busy }) {
  const createdAt = new Date(room.createdAt);

  return (
    <article className="group flex min-h-56 flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-5 transition hover:-translate-y-0.5 hover:border-slate-700 hover:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-400/15 bg-brand-400/10 font-mono text-sm font-semibold text-brand-200">
            {'</>'}
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-white">{room.title}</h3>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {room.owner.username ? `by ${room.owner.username}` : 'Your room'}
            </p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${
          room.visibility === 'public'
            ? 'border border-emerald-400/15 bg-emerald-400/10 text-emerald-300'
            : 'border border-brand-400/15 bg-brand-400/10 text-brand-200'
        }`}>
          {room.visibility}
        </span>
      </div>

      <p className="mt-4 line-clamp-2 min-h-10 text-sm leading-5 text-slate-400">
        {room.description || 'A focused space to build something together.'}
      </p>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-slate-800 pt-4">
        <div>
          <p className="text-xs text-slate-400">
            <span className="font-medium text-slate-200">{room.memberCount}</span>
            <span className="text-slate-600"> / {room.maxMembers}</span>
            <span className="ml-1.5">members</span>
          </p>
          <p className="mt-1 text-[11px] text-slate-600">
            {Number.isNaN(createdAt.getTime()) ? 'Recently created' : `Created ${createdAt.toLocaleDateString()}`}
          </p>
        </div>
        <button
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-brand-400/60 hover:text-brand-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => onAction(room)}
          type="button"
        >
          {busy ? 'Joining…' : actionLabel}
        </button>
      </div>
    </article>
  );
}

function CreateRoomDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    visibility: 'public',
    maxMembers: 10,
    defaultLanguage: 'javascript',
    allowMemberEdits: true,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await requestRooms('', {
        method: 'POST',
        body: { ...form, maxMembers: Number(form.maxMembers) },
      });
      onCreated(result.room);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section aria-labelledby="create-room-title" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl" role="dialog">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand-300">New workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-white" id="create-room-title">Create a room</h2>
          </div>
          <button aria-label="Close" className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-800 hover:text-white" disabled={busy} onClick={onClose} type="button">✕</button>
        </div>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <label className="block space-y-1.5 text-sm font-medium text-slate-300">
            Room name
            <input
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
              maxLength={60}
              minLength={3}
              name="title"
              onChange={updateField}
              placeholder="e.g. Project Atlas"
              required
              value={form.title}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium text-slate-300">
            Description <span className="font-normal text-slate-600">· optional</span>
            <textarea
              className="min-h-24 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-brand-400"
              maxLength={500}
              name="description"
              onChange={updateField}
              placeholder="What are you working on?"
              value={form.description}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm font-medium text-slate-300">
              Visibility
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400"
                name="visibility"
                onChange={updateField}
                value={form.visibility}
              >
                <option value="public">Public · discoverable</option>
                <option value="private">Private · invite only</option>
              </select>
            </label>
            <label className="block space-y-1.5 text-sm font-medium text-slate-300">
              Room capacity
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400"
                name="maxMembers"
                onChange={updateField}
                value={form.maxMembers}
              >
                {[2, 5, 10, 20, 50].map((count) => <option key={count} value={count}>{count} people</option>)}
              </select>
            </label>
          </div>
          <label className="block space-y-1.5 text-sm font-medium text-slate-300">
            Default language
            <select
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400"
              name="defaultLanguage"
              onChange={updateField}
              value={form.defaultLanguage}
            >
              {ROOM_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>{language.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-300">
            <input checked={form.allowMemberEdits} className="accent-brand-400" name="allowMemberEdits" onChange={(event) => setForm((current) => ({ ...current, allowMemberEdits: event.target.checked }))} type="checkbox" />
            Allow members to edit files
          </label>
          <p className="text-xs text-slate-500">Guest access is disabled; participants must sign in.</p>
          {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">{error}</p>}
          <div className="flex justify-end gap-3 border-t border-slate-800 pt-4">
            <button className="rounded-lg px-4 py-2.5 text-sm text-slate-400 hover:text-white disabled:opacity-50" disabled={busy} onClick={onClose} type="button">Cancel</button>
            <button className="rounded-lg bg-brand-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50" disabled={busy} type="submit">
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DashboardPage({ currentUser, onLogout }) {
  const navigate = useNavigate();
  const [myRooms, setMyRooms] = useState([]);
  const [publicRooms, setPublicRooms] = useState([]);
  const [search, setSearch] = useState('');
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState('');
  const [joiningId, setJoiningId] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  async function loadMyRooms() {
    const result = await requestRooms('/mine');
    setMyRooms(result.rooms);
  }

  useEffect(() => {
    let active = true;
    requestRooms('/mine')
      .then((result) => {
        if (active) setMyRooms(result.rooms);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoadingRooms(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestRooms(`/?search=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((result) => {
          setPublicRooms(result.rooms);
          setSearchError('');
        })
        .catch((requestError) => {
          if (requestError.name !== 'AbortError') setSearchError(requestError.message);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  async function handleLogout() {
    setError('');
    setLoggingOut(true);
    try {
      await requestAuth('logout', {});
      onLogout();
      navigate('/', { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoggingOut(false);
    }
  }

  async function joinRoom(room) {
    setJoiningId(room.id);
    setError('');
    try {
      const result = await requestRooms(`/${room.id}/join`, { method: 'POST' });
      await loadMyRooms();
      setPublicRooms((rooms) => rooms.filter((item) => item.id !== result.room.id));
      navigate(`/rooms/${result.room.id}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setJoiningId('');
    }
  }

  async function roomCreated(room) {
    setShowCreateDialog(false);
    try {
      await loadMyRooms();
      navigate(`/rooms/${room.id}`);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between gap-5 px-5 sm:px-8">
          <div className="flex items-center gap-8">
            <Brand />
            <nav aria-label="Main navigation" className="hidden items-center gap-1 text-sm md:flex">
              <a className="rounded-lg bg-slate-800/70 px-3 py-2 font-medium text-white" href="#my-rooms">Dashboard</a>
              <a className="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-800/50 hover:text-white" href="#discover">Explore rooms</a>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <button className="hidden rounded-lg bg-brand-400 px-3.5 py-2 text-sm font-semibold text-slate-950 hover:bg-brand-300 sm:inline-flex" onClick={() => setShowCreateDialog(true)} type="button">
              <span className="mr-1.5 text-base">+</span> New room
            </button>
            <div className="flex items-center gap-2.5 border-l border-slate-800 pl-3 sm:pl-4">
              <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full border border-brand-300/20 bg-brand-400/10 text-xs font-semibold uppercase text-brand-200">
                {currentUser.username.slice(0, 2)}
              </span>
              <div className="hidden sm:block">
                <p className="max-w-28 truncate text-sm font-medium text-slate-200">{currentUser.username}</p>
                <p className="max-w-36 truncate text-[11px] text-slate-500">{currentUser.email}</p>
              </div>
              <button className="rounded-lg px-2.5 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-50" disabled={loggingOut} onClick={handleLogout} type="button">
                {loggingOut ? '…' : 'Log out'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 pb-16 sm:px-8">
        <section className="flex flex-col justify-between gap-6 border-b border-slate-800/80 py-9 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Developer workspace</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Good to see you, {currentUser.username}.</h1>
            <p className="mt-2 text-sm text-slate-400">Pick up a project or find a room to build in.</p>
          </div>
          <button className="inline-flex items-center justify-center rounded-xl bg-brand-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-brand-300 sm:hidden" onClick={() => setShowCreateDialog(true)} type="button">
            <span className="mr-2 text-lg">+</span> Create a room
          </button>
          <div className="hidden gap-3 sm:flex">
            <div className="min-w-28 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
              <p className="text-xs text-slate-500">Your rooms</p>
              <p className="mt-1 text-xl font-semibold text-white">{myRooms.length}</p>
            </div>
            <div className="min-w-28 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
              <p className="text-xs text-slate-500">Open rooms</p>
              <p className="mt-1 text-xl font-semibold text-white">{publicRooms.length}</p>
            </div>
          </div>
        </section>

        {error && <p className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" role="alert">{error}</p>}

        <section className="pt-8" id="my-rooms">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Your workspaces</p>
              <h2 className="mt-1 text-xl font-semibold text-white">My rooms</h2>
            </div>
            {myRooms.length > 0 && <span className="text-xs text-slate-500">{myRooms.length} {myRooms.length === 1 ? 'room' : 'rooms'}</span>}
          </div>
          {loadingRooms ? (
            <div className="grid min-h-36 place-items-center rounded-2xl border border-slate-800 bg-slate-900/30 text-sm text-slate-500">Loading your rooms…</div>
          ) : myRooms.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {myRooms.map((room) => (
                <RoomCard key={room.id} actionLabel="Open room" onAction={(selectedRoom) => navigate(`/rooms/${selectedRoom.id}`)} room={room} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 px-6 py-10 text-center">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-slate-800 font-mono text-sm text-brand-200">{'{ }'}</span>
              <h3 className="mt-4 font-semibold text-white">Your first room starts here</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">Create a private workspace for your team, or join a public room below.</p>
              <button className="mt-5 rounded-lg bg-brand-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-brand-300" onClick={() => setShowCreateDialog(true)} type="button">Create your first room</button>
            </div>
          )}
        </section>

        <section className="pt-12" id="discover">
          <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Find your people</p>
              <h2 className="mt-1 text-xl font-semibold text-white">Explore public rooms</h2>
            </div>
            <label className="relative block w-full sm:max-w-xs">
              <span className="sr-only">Search public rooms</span>
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">⌕</span>
              <input
                className="w-full rounded-xl border border-slate-800 bg-slate-900/60 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand-400/60"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search rooms…"
                type="search"
                value={search}
              />
            </label>
          </div>
          {searchError ? (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" role="alert">{searchError}</p>
          ) : publicRooms.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {publicRooms.map((room) => (
                <RoomCard
                  actionLabel="Join room"
                  busy={joiningId === room.id}
                  key={room.id}
                  onAction={joinRoom}
                  room={room}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/30 px-6 py-9 text-center text-sm text-slate-500">
              {search ? `No public rooms match “${search}”.` : 'No public rooms to show yet. Create one and invite others to join.'}
            </div>
          )}
        </section>
      </div>
      {showCreateDialog && <CreateRoomDialog onClose={() => setShowCreateDialog(false)} onCreated={roomCreated} />}
    </main>
  );
}

function RoomPage({ currentUser }) {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState(null);
  const [accessRequests, setAccessRequests] = useState([]);
  const loadRoomRef = useRef(null);
  const [activeFileId, setActiveFileId] = useState('');
  const [fileDialog, setFileDialog] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    title: '',
    description: '',
    visibility: 'public',
    maxMembers: 10,
    defaultLanguage: 'javascript',
    allowMemberEdits: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [isRunningCode, setIsRunningCode] = useState(false);
  const [execution, setExecution] = useState(null);
  const [executionError, setExecutionError] = useState('');
  const canJoinLivePresence = Boolean(room?.isOwner || room?.isMember);
  const presence = useRoomPresence(roomId, canJoinLivePresence);
  const onlineUserIds = new Set(presence.users.map((user) => user.id));
  const canEditFile = Boolean(room && (
    room.isOwner ||
    room.currentRole === 'moderator' ||
    (room.isMember && room.settings?.allowMemberEdits !== false)
  ));
  const [monacoEditor, setMonacoEditor] = useState(null);
  const [monacoApi, setMonacoApi] = useState(null);
  const editorDecorationIdsRef = useRef([]);
  const collaborativeCursors = useCollaborativeCursors({
    socket: presence.socket,
    roomId,
    fileId: activeFileId,
    userId: currentUser.id,
  });
  useEffect(() => {
    const socket = presence.socket;
    if (!socket) return undefined;

    const handleFilesUpdate = (payload) => {
      if (payload.roomId !== roomId) return;
      setRoom((current) => current && ({ ...current, files: payload.files }));
      setActiveFileId((current) =>
        payload.files.some((file) => file.id === current)
          ? current
          : payload.files[0]?.id || '',
      );
    };
    socket.on(SOCKET_EVENTS.FILES_UPDATE, handleFilesUpdate);
    return () => socket.off(SOCKET_EVENTS.FILES_UPDATE, handleFilesUpdate);
  }, [presence.socket, roomId]);
  useEffect(() => {
    const socket = presence.socket;
    if (!socket) return undefined;
    const handleExecutionResult = (result) => {
      if (result.roomId === roomId) {
        setExecution(result);
        setExecutionError('');
      }
    };
    socket.on(SOCKET_EVENTS.EXECUTION_RESULT, handleExecutionResult);
    return () => socket.off(SOCKET_EVENTS.EXECUTION_RESULT, handleExecutionResult);
  }, [presence.socket, roomId]);
  useEffect(() => {
    setExecution(null);
    setExecutionError('');
  }, [roomId]);
  useEffect(() => {
    if (['ROOM_ACCESS_REVOKED', 'ROOM_DELETED'].includes(presence.errorCode)) {
      navigate('/workspace', { replace: true });
    }
  }, [navigate, presence.errorCode]);
  const activeFile = room?.files?.find((file) => file.id === activeFileId) || null;
  const canRunCode = Boolean(room && (
    room.isOwner ||
    room.currentRole === 'moderator' ||
    (room.isMember && room.settings?.allowMemberEdits !== false)
  ));
  const activeLanguageIsExecutable = Boolean(activeFile && EXECUTABLE_LANGUAGES.has(activeFile.language));
  const [editorSettings, setEditorSettings] = useState({
    theme: 'vs-dark',
    fontSize: 14,
    minimap: false,
    wordWrap: 'on',
  });
  const updateRoomFile = useCallback((updatedFile) => {
    setRoom((current) => current && ({
      ...current,
      files: current.files.map((file) => file.id === updatedFile.id ? updatedFile : file),
    }));
  }, []);
  const collaborativeEditor = useCollaborativeEditor({
    socket: presence.socket,
    roomId,
    file: activeFile,
    canEdit: canEditFile,
    onFileUpdate: updateRoomFile,
  });
  const handleEditorMount = useCallback((editor, monaco) => {
    setMonacoEditor(editor);
    setMonacoApi(monaco);
  }, []);

  useEffect(() => {
    if (!monacoEditor) return undefined;
    const editorNode = monacoEditor.getDomNode();
    if (!editorNode) return undefined;

    const handleEditorWheel = (event) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      const maxScrollTop = Math.max(
        0,
        monacoEditor.getScrollHeight() - monacoEditor.getLayoutInfo().height,
      );
      const scrollTop = monacoEditor.getScrollTop();
      const scrollingPastTop = event.deltaY < 0 && scrollTop <= 0;
      const scrollingPastBottom = event.deltaY > 0 && scrollTop >= maxScrollTop - 1;
      if (!scrollingPastTop && !scrollingPastBottom) return;

      window.scrollBy({ top: event.deltaY, behavior: 'instant' });
      event.preventDefault();
      event.stopPropagation();
    };

    editorNode.addEventListener('wheel', handleEditorWheel, { capture: true, passive: false });
    return () => editorNode.removeEventListener('wheel', handleEditorWheel, { capture: true });
  }, [monacoEditor]);

  useEffect(() => {
    if (!monacoEditor || !activeFileId) return undefined;

    const publishCurrentCursor = (event) => {
      const model = monacoEditor.getModel();
      if (!model || !event.position) return;
      const position = model.validatePosition(event.position);
      const selection = event.selection && !event.selection.isEmpty()
        ? {
          startLineNumber: event.selection.getStartPosition().lineNumber,
          startColumn: event.selection.getStartPosition().column,
          endLineNumber: event.selection.getEndPosition().lineNumber,
          endColumn: event.selection.getEndPosition().column,
        }
        : null;
      collaborativeCursors.publishCursor(position, selection);
    };

    const cursorSubscription = monacoEditor.onDidChangeCursorSelection(publishCurrentCursor);
    const currentPosition = monacoEditor.getPosition();
    if (currentPosition) {
      publishCurrentCursor({
        position: currentPosition,
        selection: monacoEditor.getSelection(),
      });
    }
    return () => cursorSubscription.dispose();
  }, [activeFileId, collaborativeCursors.publishCursor, monacoEditor]);

  useEffect(() => {
    if (!monacoEditor || !monacoApi) return undefined;
    const model = monacoEditor.getModel();
    if (!model) return undefined;

    const decorations = collaborativeCursors.cursors
      .filter((cursor) => cursor.fileId === activeFileId)
      .flatMap((cursor) => {
        const color = [...cursor.userId].reduce(
          (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
          0,
        ) % 6;
        const position = model.validatePosition(cursor.position);
        const cursorRange = new monacoApi.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        );
        const cursorDecoration = {
          range: cursorRange,
          options: {
            before: {
              content: `${cursor.username} `,
              inlineClassName: `remote-cursor-label remote-cursor-color-${color}`,
            },
            hoverMessage: { value: `${cursor.username} is here` },
            stickiness: monacoApi.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };

        if (!cursor.selection) return [cursorDecoration];
        const selection = model.validateRange(new monacoApi.Range(
          cursor.selection.startLineNumber,
          cursor.selection.startColumn,
          cursor.selection.endLineNumber,
          cursor.selection.endColumn,
        ));
        if (selection.isEmpty()) return [cursorDecoration];
        return [
          cursorDecoration,
          {
            range: selection,
            options: {
              className: `remote-cursor-selection-${color}`,
              hoverMessage: { value: `${cursor.username}'s selection` },
              stickiness: monacoApi.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ];
      });
    editorDecorationIdsRef.current = monacoEditor.deltaDecorations(
      editorDecorationIdsRef.current,
      decorations,
    );
    return () => {
      editorDecorationIdsRef.current = monacoEditor.deltaDecorations(
        editorDecorationIdsRef.current,
        [],
      );
    };
  }, [activeFileId, collaborativeCursors.cursors, monacoApi, monacoEditor]);

  async function loadRoom() {
    const result = await requestRooms(`/${roomId}`);
    setRoom(result.room);
    setActiveFileId((current) =>
      result.room.files.some((file) => file.id === current)
        ? current
        : result.room.files[0]?.id || '',
    );
    setSettingsForm({
      title: result.room.title,
      description: result.room.description || '',
      visibility: result.room.visibility,
      maxMembers: result.room.maxMembers,
      defaultLanguage: result.room.settings?.defaultLanguage || 'javascript',
      allowMemberEdits: result.room.settings?.allowMemberEdits !== false,
    });
    if (
      (result.room.isOwner || result.room.currentRole === 'moderator') &&
      result.room.visibility === 'private'
    ) {
      const requestResult = await requestRooms(`/${roomId}/access-requests`);
      setAccessRequests(requestResult.requests);
    } else {
      setAccessRequests([]);
    }
  }

  loadRoomRef.current = loadRoom;

  useEffect(() => {
    const socket = presence.socket;
    if (!socket) return undefined;

    function handleAccessRequestCreated(payload) {
      if (payload.roomId !== roomId) return;
      setAccessRequests((current) => (
        current.some((request) => request.user.id === payload.request.user.id)
          ? current
          : [...current, payload.request]
      ));
      setActionMessage(`New access request from ${payload.request.user.username}.`);
    }

    function handleAccessRequestResolved(payload) {
      if (payload.roomId !== roomId) return;
      setAccessRequests((current) => (
        current.filter((request) => request.user.id !== payload.requesterId)
      ));

      if (payload.requesterId === currentUser.id) {
        const decisionMessage = `Your access request was ${payload.decision === 'approve' ? 'approved' : 'rejected'}.`;
        setActionMessage(decisionMessage);
        loadRoomRef.current?.().catch((loadError) => setError(loadError.message));
        return;
      }

      setActionMessage(
        `An access request was ${payload.decision === 'approve' ? 'approved' : 'rejected'}${payload.actor?.username ? ` by ${payload.actor.username}` : ''}.`,
      );
    }

    socket.on(SOCKET_EVENTS.ACCESS_REQUEST_CREATED, handleAccessRequestCreated);
    socket.on(SOCKET_EVENTS.ACCESS_REQUEST_RESOLVED, handleAccessRequestResolved);
    return () => {
      socket.off(SOCKET_EVENTS.ACCESS_REQUEST_CREATED, handleAccessRequestCreated);
      socket.off(SOCKET_EVENTS.ACCESS_REQUEST_RESOLVED, handleAccessRequestResolved);
    };
  }, [currentUser.id, presence.socket, roomId]);

  useEffect(() => {
    let active = true;
    setRoom(null);
    setActiveFileId('');
    setFileDialog(null);
    setError('');
    setActionMessage('');
    setLoading(true);
    requestRooms(`/${roomId}`)
      .then(async (result) => {
        if (!active) return;
        setRoom(result.room);
        setActiveFileId(result.room.files?.[0]?.id || '');
        setSettingsForm({
          title: result.room.title,
          description: result.room.description || '',
          visibility: result.room.visibility,
          maxMembers: result.room.maxMembers,
          defaultLanguage: result.room.settings?.defaultLanguage || 'javascript',
          allowMemberEdits: result.room.settings?.allowMemberEdits !== false,
        });
        if (
          (result.room.isOwner || result.room.currentRole === 'moderator') &&
          result.room.visibility === 'private'
        ) {
          const requestResult = await requestRooms(`/${roomId}/access-requests`);
          if (active) setAccessRequests(requestResult.requests);
        } else {
          setAccessRequests([]);
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roomId]);

  async function performAction(actionName, action) {
    setBusyAction(actionName);
    setError('');
    setActionMessage('');
    try {
      const message = await action();
      if (message) setActionMessage(message);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyAction('');
    }
  }

  function handleJoin() {
    performAction('join', async () => {
      await requestRooms(`/${roomId}/join`, { method: 'POST' });
      await loadRoom();
      return 'You joined this room.';
    });
  }

  function handleAccessRequest() {
    performAction('request', async () => {
      await requestRooms(`/${roomId}/request-access`, { method: 'POST' });
      await loadRoom();
      return 'Your access request was sent to the room owner.';
    });
  }

  function handleSettingsSubmit(event) {
    event.preventDefault();
    performAction('settings', async () => {
      const settings = room.isOwner
        ? { ...settingsForm }
        : {
          description: settingsForm.description,
          defaultLanguage: settingsForm.defaultLanguage,
          allowMemberEdits: settingsForm.allowMemberEdits,
        };
      const result = await requestRooms(`/${roomId}`, {
        method: 'PATCH',
        body: {
          ...settings,
          ...(room.isOwner ? { maxMembers: Number(settingsForm.maxMembers) } : {}),
        },
      });
      setRoom(result.room);
      if (result.room.visibility === 'private' && result.room.isOwner) {
        const requestResult = await requestRooms(`/${roomId}/access-requests`);
        setAccessRequests(requestResult.requests);
      } else {
        setAccessRequests([]);
      }
      return 'Room settings saved.';
    });
  }

  function handleAccessDecision(requesterId, decision) {
    performAction(`${decision}-${requesterId}`, async () => {
      await requestRooms(`/${roomId}/access-requests/${requesterId}`, {
        method: 'PATCH',
        body: { decision },
      });
      await loadRoom();
      return `Access request ${decision === 'approve' ? 'approved' : 'rejected'}.`;
    });
  }

  function handleRoleChange(memberId, role) {
    performAction(`role-${memberId}`, async () => {
      await requestRooms(`/${roomId}/members/${memberId}/role`, {
        method: 'PATCH',
        body: { role },
      });
      await loadRoom();
      return `Member role updated to ${role}.`;
    });
  }

  function handleMemberRemoval(member) {
    if (!window.confirm(`Remove ${member.username} from this room?`)) return;
    performAction(`remove-${member.id}`, async () => {
      await requestRooms(`/${roomId}/members/${member.id}`, { method: 'DELETE' });
      await loadRoom();
      return `${member.username} was removed from the room.`;
    });
  }

  function handleTransferOwnership(member) {
    if (!window.confirm(`Transfer ownership to ${member.username}? You will become a member.`)) return;
    performAction('transfer', async () => {
      await requestRooms(`/${roomId}/transfer-ownership`, {
        method: 'POST',
        body: { memberId: member.id },
      });
      await loadRoom();
      return `Ownership transferred to ${member.username}.`;
    });
  }

  function handleLeave() {
    if (!window.confirm('Leave this room?')) return;
    performAction('leave', async () => {
      await requestRooms(`/${roomId}/leave`, { method: 'POST' });
      navigate('/workspace', { replace: true });
      return '';
    });
  }

  function handleDelete() {
    if (!window.confirm('Delete this room permanently? This cannot be undone.')) return;
    performAction('delete', async () => {
      await requestRooms(`/${roomId}`, { method: 'DELETE' });
      navigate('/workspace', { replace: true });
      return '';
    });
  }

  async function handleWorkspaceDownload() {
    setBusyAction('download');
    setError('');
    setActionMessage('');
    try {
      const response = await fetch(`${API_URL}/api/rooms/${roomId}/download`, {
        credentials: 'include',
      });
      if (!response.ok) {
        await readApiResult(response, 'Unable to download the workspace.');
      }
      const archive = await response.blob();
      const objectUrl = URL.createObjectURL(archive);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `${roomId}-workspace.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setActionMessage('Workspace ZIP downloaded.');
    } catch (downloadError) {
      setError(downloadError.message || 'Unable to download the workspace.');
    } finally {
      setBusyAction('');
    }
  }

  async function handleCopyShareLink() {
    setBusyAction('share');
    setError('');
    setActionMessage('');
    try {
      const result = await requestRooms(`/${roomId}/share-link`, { method: 'POST' });
      await navigator.clipboard.writeText(new URL(result.path, window.location.origin).toString());
      setActionMessage('Room link copied to clipboard.');
    } catch (shareError) {
      setError(shareError.message || 'Unable to copy the room link.');
    } finally {
      setBusyAction('');
    }
  }

  function showFileDialog(mode, file = null) {
    const language = file?.language || room.settings?.defaultLanguage || 'javascript';
    const languageDefinition = EDITOR_LANGUAGES.find((item) => item.id === language) || EDITOR_LANGUAGES[0];
    setFileDialog({
      mode,
      fileId: file?.id || '',
      language,
      name: file?.name || `new-file.${languageDefinition.extension}`,
    });
    setError('');
  }

  function handleFileSubmit(event) {
    event.preventDefault();
    if (!fileDialog) return;
    performAction(`file-${fileDialog.mode}`, async () => {
      const isRename = fileDialog.mode === 'rename';
      const result = await requestRooms(
        `/${roomId}/files${isRename ? `/${fileDialog.fileId}` : ''}`,
        {
          method: isRename ? 'PATCH' : 'POST',
          body: { name: fileDialog.name, language: fileDialog.language },
        },
      );
      setRoom(result.room);
      if (!isRename && (!activeFileId || collaborativeEditor.syncStatus === 'saved')) {
        setActiveFileId(result.file.id);
      }
      setFileDialog(null);
      return isRename ? 'File renamed.' : 'File created.';
    });
  }

  function handleFileDelete(file) {
    if (file.id === activeFileId && collaborativeEditor.syncStatus !== 'saved') {
      setError('Save the active file before deleting it.');
      return;
    }
    if (!window.confirm(`Delete ${file.name}? This cannot be undone.`)) return;
    performAction('file-delete', async () => {
      const result = await requestRooms(`/${roomId}/files/${file.id}`, { method: 'DELETE' });
      setRoom(result.room);
      if (file.id === activeFileId) {
        setActiveFileId(result.room.files[0]?.id || '');
      }
      return 'File deleted.';
    });
  }

  async function handleRunCode() {
    if (!activeFile || !canRunCode || isRunningCode) return;
    setIsRunningCode(true);
    setExecutionError('');
    try {
      const response = await fetch(
        `${API_URL}/api/rooms/${roomId}/files/${activeFile.id}/run`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: collaborativeEditor.draft,
        },
      );
      const result = await readApiResult(response, 'Unable to run code.');
      setExecution(result.execution);
    } catch (runError) {
      setExecutionError(runError.message);
    } finally {
      setIsRunningCode(false);
    }
  }

  function updateSettings(event) {
    setSettingsForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-6 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between border-b border-slate-800 pb-5">
          <Brand />
          <button className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white" onClick={() => navigate('/workspace')} type="button">
            Back to dashboard
          </button>
        </header>
        {loading ? (
          <div className="grid min-h-80 place-items-center text-sm text-slate-500">Loading room…</div>
        ) : error ? (
          <div className="mx-auto mt-20 max-w-lg rounded-2xl border border-slate-800 bg-slate-900/50 p-8 text-center">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-rose-300">Unable to open room</p>
            <p className="mt-3 text-sm text-slate-400">{error}</p>
            <button className="mt-6 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700" onClick={() => navigate('/workspace')} type="button">Return to dashboard</button>
          </div>
        ) : room && (
          <section className="py-12">
            {error && <p className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200" role="alert">{error}</p>}
            {actionMessage && <p className="mb-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" role="status">{actionMessage}</p>}
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <button className="mb-5 text-xs text-slate-500 hover:text-brand-300" onClick={() => navigate('/workspace')} type="button">← Dashboard</button>
                <div className="flex items-center gap-3">
                  <span className="grid h-12 w-12 place-items-center rounded-2xl border border-brand-400/15 bg-brand-400/10 font-mono text-brand-200">{'</>'}</span>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.15em] text-brand-300">Coding room</p>
                    <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">{room.title}</h1>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {canJoinLivePresence && (
                  <button
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-brand-400/50 hover:text-brand-200 disabled:cursor-wait disabled:opacity-50"
                    disabled={Boolean(busyAction)}
                    onClick={handleCopyShareLink}
                    type="button"
                  >
                    {busyAction === 'share' ? 'Copying…' : 'Copy room link'}
                  </button>
                )}
                <span className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize ${room.visibility === 'public' ? 'bg-brand-400/10 text-brand-200' : 'bg-slate-800 text-slate-300'}`}>
                  {room.visibility} room
                </span>
              </div>
            </div>
            <p className="mt-6 max-w-2xl leading-7 text-slate-400">{room.description || 'A focused space to build something together.'}</p>
            {room.visibility === 'private' && !room.isOwner && !room.isMember ? (
              <div className="mt-8 max-w-2xl rounded-2xl border border-brand-400/20 bg-brand-400/5 p-6">
                <h2 className="text-lg font-semibold text-white">This room is private</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Request access from {room.owner.username}. The owner or a moderator must approve your request before room contents are available.
                </p>
                {room.accessRequestStatus === 'pending' ? (
                  <p className="mt-5 inline-flex rounded-lg border border-brand-400/20 bg-brand-400/10 px-3 py-2 text-sm text-brand-200">Access request pending</p>
                ) : (
                  <button
                    className="mt-5 rounded-lg bg-brand-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50"
                    disabled={Boolean(busyAction)}
                    onClick={handleAccessRequest}
                    type="button"
                  >
                    {busyAction === 'request' ? 'Sending request…' : room.accessRequestStatus === 'rejected' ? 'Request access again' : 'Request access'}
                  </button>
                )}
              </div>
            ) : (
              <>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <p className="text-xs text-slate-500">Created by</p>
                <p className="mt-1 font-medium text-slate-200">{room.owner.username || 'Room owner'}{room.isOwner ? ' (you)' : ''}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <p className="text-xs text-slate-500">Members</p>
                <p className="mt-1 font-medium text-slate-200">{room.memberCount} / {room.maxMembers}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <p className="text-xs text-slate-500">Signed in as</p>
                <p className="mt-1 font-medium text-slate-200">{currentUser.username}</p>
              </div>
            </div>
            {!room.isMember && !room.isOwner && room.visibility === 'public' && (
              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <p className="text-sm text-slate-400">Join this room to become a member and see it in your dashboard.</p>
                <button className="mt-3 rounded-lg bg-brand-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={handleJoin} type="button">
                  {busyAction === 'join' ? 'Joining…' : 'Join room'}
                </button>
              </div>
            )}

            <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
              <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Collaborative workspace</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">Code editor</h2>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      className="rounded-lg bg-brand-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!activeFile || !activeLanguageIsExecutable || !canRunCode || isRunningCode || collaborativeEditor.syncStatus === 'conflict'}
                      onClick={handleRunCode}
                      title={!canRunCode
                        ? 'Join the room and have permission to edit to run code.'
                        : !activeLanguageIsExecutable
                          ? 'Code execution is not enabled for this language.'
                          : undefined}
                      type="button"
                    >
                      {isRunningCode ? 'Running…' : 'Run'}
                    </button>
                    <span className={`rounded-full px-2.5 py-1 text-xs ${
                      collaborativeEditor.syncStatus === 'saved'
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : collaborativeEditor.syncStatus === 'conflict' || collaborativeEditor.syncStatus === 'error'
                          ? 'bg-rose-400/10 text-rose-300'
                          : 'bg-amber-400/10 text-amber-300'
                    }`}>
                      {collaborativeEditor.syncStatus === 'saved' ? 'All changes saved'
                        : collaborativeEditor.syncStatus === 'saving' ? 'Saving…'
                          : collaborativeEditor.syncStatus === 'conflict' ? 'Conflict'
                            : collaborativeEditor.syncStatus === 'offline' ? 'Offline · changes pending'
                              : collaborativeEditor.syncStatus === 'error' ? 'Sync failed'
                                : 'Unsaved changes'}
                    </span>
                  </div>
                </div>
                <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-slate-200">File explorer</h3>
                    {(room.isOwner || room.currentRole === 'moderator') && (
                      <button
                        className="rounded-md border border-brand-400/30 px-2.5 py-1.5 text-xs font-medium text-brand-200 hover:bg-brand-400/10 disabled:opacity-50"
                        disabled={Boolean(busyAction)}
                        onClick={() => showFileDialog('create')}
                        type="button"
                      >
                        New file
                      </button>
                    )}
                  </div>
                  {fileDialog && (
                    <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3" onSubmit={handleFileSubmit}>
                      <label className="min-w-48 flex-1 text-xs text-slate-400">
                        File name
                        <input
                          autoFocus
                          className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-brand-400/60"
                          maxLength={100}
                          onChange={(event) => setFileDialog((current) => ({ ...current, name: event.target.value }))}
                          required
                          value={fileDialog.name}
                        />
                      </label>
                      <label className="text-xs text-slate-400">
                        Language
                        <select
                          className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                          onChange={(event) => {
                            const language = EDITOR_LANGUAGES.find((item) => item.id === event.target.value);
                            setFileDialog((current) => {
                              const extensionIndex = current.name.lastIndexOf('.');
                              const baseName = extensionIndex > 0
                                ? current.name.slice(0, extensionIndex)
                                : current.name;
                              return {
                                ...current,
                                language: language.id,
                                name: `${baseName}.${language.extension}`,
                              };
                            });
                          }}
                          value={fileDialog.language}
                        >
                          {EDITOR_LANGUAGES.map((language) => (
                            <option key={language.id} value={language.id}>{language.label}</option>
                          ))}
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button className="rounded-md bg-brand-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50" disabled={Boolean(busyAction)} type="submit">
                          {busyAction === `file-${fileDialog.mode}` ? 'Saving…' : fileDialog.mode === 'rename' ? 'Rename' : 'Create'}
                        </button>
                        <button className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:text-white" onClick={() => setFileDialog(null)} type="button">
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  {room.files?.length ? (
                    <ul className="mt-3 space-y-1">
                      {room.files.map((file) => {
                        const isFileManager = room.isOwner || room.currentRole === 'moderator';
                        const activeFileIsDirty = file.id === activeFileId && collaborativeEditor.syncStatus !== 'saved';
                        return (
                          <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-900" key={`explorer-${file.id}`}>
                            <button
                              aria-current={activeFileId === file.id ? 'page' : undefined}
                              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-slate-300 hover:text-white disabled:opacity-50"
                              disabled={activeFileId !== file.id && collaborativeEditor.syncStatus !== 'saved'}
                              onClick={() => setActiveFileId(file.id)}
                              type="button"
                            >
                              {file.name}
                            </button>
                            {isFileManager && (
                              <div className="flex shrink-0 gap-1">
                                <button
                                  aria-label={`Rename ${file.name}`}
                                  className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                                  disabled={Boolean(busyAction) || activeFileIsDirty}
                                  onClick={() => showFileDialog('rename', file)}
                                  type="button"
                                >
                                  Rename
                                </button>
                                <button
                                  aria-label={`Delete ${file.name}`}
                                  className="rounded px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                                  disabled={Boolean(busyAction) || activeFileIsDirty}
                                  onClick={() => handleFileDelete(file)}
                                  type="button"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-3 px-2 py-3 text-xs text-slate-500">No files yet. Create one to start coding.</p>
                  )}
                </div>
                {room.files?.length ? (
                  <div aria-label="Open files" className="mt-5 flex overflow-x-auto border-b border-slate-800" role="tablist">
                    {room.files.map((file) => (
                      <button
                        aria-selected={activeFileId === file.id}
                        className={`shrink-0 border-b-2 px-4 py-2.5 font-mono text-xs ${
                          activeFileId === file.id
                            ? 'border-brand-400 bg-slate-950/70 text-white'
                            : 'border-transparent text-slate-500 hover:text-slate-200'
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                        disabled={activeFileId !== file.id && collaborativeEditor.syncStatus !== 'saved'}
                        key={file.id}
                        onClick={() => setActiveFileId(file.id)}
                        role="tab"
                        type="button"
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-500">No files in this workspace yet.</p>
                )}
                {activeFile && (
                  <>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <span className="text-xs text-slate-500">{activeFile.name} · {activeFile.language}</span>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                        <label className="flex items-center gap-2">
                          Theme
                          <select
                            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                            onChange={(event) => setEditorSettings((current) => ({ ...current, theme: event.target.value }))}
                            value={editorSettings.theme}
                          >
                            <option value="vs-dark">Dark</option>
                            <option value="light">Light</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-2">
                          Font
                          <select
                            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                            onChange={(event) => setEditorSettings((current) => ({ ...current, fontSize: Number(event.target.value) }))}
                            value={editorSettings.fontSize}
                          >
                            {[12, 14, 16, 18, 20].map((size) => <option key={size} value={size}>{size}px</option>)}
                          </select>
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            checked={editorSettings.minimap}
                            onChange={(event) => setEditorSettings((current) => ({ ...current, minimap: event.target.checked }))}
                            type="checkbox"
                          />
                          Minimap
                        </label>
                        <label className="flex items-center gap-2">
                          Wrap
                          <select
                            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                            onChange={(event) => setEditorSettings((current) => ({ ...current, wordWrap: event.target.value }))}
                            value={editorSettings.wordWrap}
                          >
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        </label>
                      </div>
                    </div>
                    <div className="mt-3 overflow-hidden rounded-xl border border-slate-800">
                      <Editor
                        height="min(65vh, 680px)"
                        key={activeFile.id}
                        language={EDITOR_LANGUAGES.some((language) => language.id === activeFile.language) ? activeFile.language : 'plaintext'}
                        onMount={handleEditorMount}
                        onChange={(value) => collaborativeEditor.changeDraft(value ?? '', activeFile.id)}
                        options={{
                          automaticLayout: true,
                          fontSize: editorSettings.fontSize,
                          minimap: { enabled: editorSettings.minimap },
                          readOnly: !canEditFile,
                          scrollBeyondLastLine: false,
                          tabSize: 2,
                          wordWrap: editorSettings.wordWrap,
                        }}
                        theme={editorSettings.theme}
                        value={collaborativeEditor.draft}
                      />
                    </div>
                    {collaborativeEditor.conflictFile && (
                      <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3" role="alert">
                        <p className="text-sm text-amber-200">
                          This file changed in another session. Your draft is preserved; choose which version to use.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button className="rounded-md border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-300/10" onClick={() => collaborativeEditor.resolveConflict('latest')} type="button">Load latest version</button>
                          <button className="rounded-md bg-amber-300 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-200" onClick={() => collaborativeEditor.resolveConflict('mine')} type="button">Keep my draft</button>
                        </div>
                      </div>
                    )}
                    {executionError && (
                      <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert">
                        {executionError}
                      </p>
                    )}
                    {execution && (
                      <section className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4" aria-live="polite">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-white">
                            Run result · {execution.fileName} · {execution.language}
                          </h3>
                          <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                            {execution.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {execution.actor.username}
                          {execution.executionTime !== null && ` · ${execution.executionTime}s`}
                          {` · ${new Date(execution.createdAt).toLocaleTimeString()}`}
                        </p>
                        <div className="mt-3 grid gap-3">
                          <div>
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">stdout</p>
                            <pre className="min-h-10 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-xs text-slate-200">{execution.stdout || '(empty)'}</pre>
                          </div>
                          <div>
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">stderr</p>
                            <pre className="min-h-10 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-xs text-rose-200">{execution.stderr || '(empty)'}</pre>
                          </div>
                        </div>
                      </section>
                    )}
                    {!room.isOwner && room.currentRole !== 'moderator' && !room.isMember && (
                      <p className="mt-2 text-xs text-slate-500">Join this room to edit the file.</p>
                    )}
                    {!room.isOwner && room.currentRole !== 'moderator' && room.isMember && room.settings?.allowMemberEdits === false && (
                      <p className="mt-2 text-xs text-slate-500">Editing is disabled for members by the owner.</p>
                    )}
                  </>
                )}
                <button
                  className="mt-4 inline-flex text-xs font-medium text-brand-300 hover:text-brand-200 disabled:cursor-wait disabled:opacity-50"
                  disabled={Boolean(busyAction)}
                  onClick={handleWorkspaceDownload}
                  type="button"
                >
                  {busyAction === 'download' ? 'Preparing ZIP…' : 'Download workspace ZIP'}
                </button>
                <p className="mt-2 text-xs leading-5 text-slate-600">Editor changes sync live. Code runs in Wandbox’s isolated sandbox.</p>
              </section>

              <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">People</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">Members</h2>
                  </div>
                  {canJoinLivePresence && (
                    <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ${
                      presence.status === 'online'
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : presence.status === 'error'
                          ? 'bg-rose-400/10 text-rose-300'
                          : 'bg-slate-800 text-slate-400'
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        presence.status === 'online' ? 'bg-emerald-400' : presence.status === 'error' ? 'bg-rose-400' : 'bg-slate-500'
                      }`} />
                      {presence.status === 'online'
                        ? `${presence.users.length} online`
                        : presence.status === 'error'
                          ? 'Presence unavailable'
                          : 'Connecting'}
                    </span>
                  )}
                </div>
                {presence.status === 'error' && canJoinLivePresence && (
                  <p className="mt-2 text-xs text-rose-300" role="status">{presence.error}</p>
                )}
                <ul className="mt-4 space-y-2">
                  {room.members?.map((member) => (
                    <li className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2.5" key={member.id}>
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-400/10 text-xs font-semibold uppercase text-brand-200">
                          {member.username.slice(0, 2)}
                          {canJoinLivePresence && (
                            <span
                              aria-label={onlineUserIds.has(member.id) ? 'Online' : 'Offline'}
                              className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-slate-950 ${
                                onlineUserIds.has(member.id) ? 'bg-emerald-400' : 'bg-slate-600'
                              }`}
                              title={onlineUserIds.has(member.id) ? 'Online' : 'Offline'}
                            />
                          )}
                        </span>
                        <span className="truncate text-sm text-slate-200">{member.username}{member.id === currentUser.id ? ' (you)' : ''}</span>
                      </span>
                      <span className="ml-2 shrink-0 rounded-full bg-slate-800 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">{member.role}</span>
                    </li>
                  ))}
                </ul>
                {(room.isOwner || room.currentRole === 'moderator') && (
                  <ul className="mt-4 space-y-2 border-t border-slate-800 pt-4">
                    {room.members.filter((member) => member.role !== 'owner').map((member) => (
                      <li className="flex flex-wrap items-center justify-between gap-2 text-xs" key={`manage-${member.id}`}>
                        <span className="text-slate-400">{member.username} <span className="text-slate-600">· {member.role}</span></span>
                        <div className="flex flex-wrap gap-2">
                          {room.isOwner && (
                            <>
                              <button className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-brand-400/50 hover:text-brand-200 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleRoleChange(member.id, member.role === 'moderator' ? 'member' : 'moderator')} type="button">
                                {member.role === 'moderator' ? 'Demote' : 'Make moderator'}
                              </button>
                              <button className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-brand-400/50 hover:text-brand-200 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleTransferOwnership(member)} type="button">Transfer ownership</button>
                            </>
                          )}
                          {(room.isOwner || member.role === 'member') && (
                            <button className="rounded-md border border-rose-500/20 px-2 py-1 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleMemberRemoval(member)} type="button">Remove</button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
            {canJoinLivePresence ? (
              <div className="mt-6">
                <RoomChat
                  connectionStatus={presence.status}
                  currentUser={currentUser}
                  roomId={roomId}
                  socket={presence.socket}
                />
              </div>
            ) : (
              <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                <h2 className="text-lg font-semibold text-white">Room chat</h2>
                <p className="mt-2 text-sm text-slate-400">Join this room to view chat history and send messages.</p>
              </section>
            )}

            {(room.isOwner || room.currentRole === 'moderator') && (
              <div className="mt-8 space-y-4">
                <details className="rounded-2xl border border-slate-800 bg-slate-900/40">
                  <summary className="cursor-pointer list-none px-5 py-4">
                    <span className="font-medium text-white">Room settings</span>
                    <span className="ml-2 text-xs text-slate-500">{room.isOwner ? 'Owner' : 'Moderator'} · {room.settings?.defaultLanguage || 'javascript'}</span>
                  </summary>
                  <form className="space-y-4 border-t border-slate-800 p-5" onSubmit={handleSettingsSubmit}>
                    {room.isOwner && (
                      <label className="block space-y-1.5 text-sm text-slate-300">Room title
                        <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400" maxLength={60} minLength={3} name="title" onChange={updateSettings} required value={settingsForm.title} />
                      </label>
                    )}
                    <label className="block space-y-1.5 text-sm text-slate-300">Description
                      <textarea className="min-h-20 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400" maxLength={500} name="description" onChange={updateSettings} value={settingsForm.description} />
                    </label>
                    {room.isOwner && <div className="grid gap-4 sm:grid-cols-3">
                      <label className="block space-y-1.5 text-sm text-slate-300">Visibility
                        <select className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400" name="visibility" onChange={updateSettings} value={settingsForm.visibility}>
                          <option value="public">Public</option>
                          <option value="private">Private</option>
                        </select>
                      </label>
                      <label className="block space-y-1.5 text-sm text-slate-300">Capacity
                        <select className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400" name="maxMembers" onChange={updateSettings} value={settingsForm.maxMembers}>
                          {[2, 5, 10, 20, 50].map((count) => <option key={count} value={count}>{count} people</option>)}
                        </select>
                      </label>
                      <label className="block space-y-1.5 text-sm text-slate-300">Default language
                        <select className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none focus:border-brand-400" name="defaultLanguage" onChange={updateSettings} value={settingsForm.defaultLanguage}>
                          {ROOM_LANGUAGES.map((language) => (
                            <option key={language.value} value={language.value}>{language.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>}
                    {(room.isOwner || room.currentRole === 'moderator') && (
                      <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-300">
                        <input checked={settingsForm.allowMemberEdits} className="accent-brand-400" name="allowMemberEdits" onChange={(event) => setSettingsForm((current) => ({ ...current, allowMemberEdits: event.target.checked }))} type="checkbox" />
                        Allow members to edit files
                      </label>
                    )}
                    <p className="text-xs text-slate-500">Guest access is disabled; room users must authenticate.</p>
                    <div className="flex justify-end">
                      <button className="rounded-lg bg-brand-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50" disabled={Boolean(busyAction)} type="submit">
                        {busyAction === 'settings' ? 'Saving…' : 'Save settings'}
                      </button>
                    </div>
                  </form>
                </details>

                {room.visibility === 'private' && (
                  <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.15em] text-slate-500">Private room</p>
                        <h2 className="mt-1 text-lg font-semibold text-white">Access requests</h2>
                      </div>
                      <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-400">{accessRequests.filter((item) => item.status === 'pending').length} pending</span>
                    </div>
                    {accessRequests.filter((item) => item.status === 'pending').length ? (
                      <ul className="mt-4 space-y-2">
                        {accessRequests.filter((item) => item.status === 'pending').map((request) => (
                          <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3" key={request.user.id}>
                            <div>
                              <p className="text-sm font-medium text-slate-200">{request.user.username}</p>
                              <p className="mt-0.5 text-xs text-slate-500">{request.user.email}</p>
                            </div>
                            <div className="flex gap-2">
                              <button className="rounded-lg bg-brand-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-brand-300 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleAccessDecision(request.user.id, 'approve')} type="button">
                                {busyAction === `approve-${request.user.id}` ? 'Approving…' : 'Approve'}
                              </button>
                              <button className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={() => handleAccessDecision(request.user.id, 'reject')} type="button">
                                Reject
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-4 text-sm text-slate-500">No pending access requests.</p>
                    )}
                  </section>
                )}
              </div>
            )}

            <div className="mt-8 flex flex-wrap justify-end gap-3 border-t border-slate-800 pt-6">
              {!room.isOwner && room.isMember && (
                <button className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={handleLeave} type="button">
                  {busyAction === 'leave' ? 'Leaving…' : 'Leave room'}
                </button>
              )}
              {room.isOwner && (
                <button className="rounded-lg border border-rose-500/30 px-4 py-2.5 text-sm text-rose-300 hover:border-rose-400/70 hover:bg-rose-500/10 disabled:opacity-50" disabled={Boolean(busyAction)} onClick={handleDelete} type="button">
                  {busyAction === 'delete' ? 'Deleting…' : 'Delete room'}
                </button>
              )}
            </div>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-center text-slate-100">
      <div>
        <p className="font-mono text-sm text-brand-300">404 · not found</p>
        <h1 className="mt-3 text-3xl font-bold text-white">This page isn’t here.</h1>
        <p className="mt-2 text-sm text-slate-400">The address may be out of date, or the page may have moved.</p>
        <Link className="mt-6 inline-flex rounded-lg bg-brand-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-brand-300" to="/">Back to colabCode</Link>
      </div>
    </main>
  );
}

function ProtectedRoute({ currentUser, loading, children }) {
  if (loading) {
    return <div className="grid min-h-screen place-items-center bg-slate-950 text-slate-300">Loading your account…</div>;
  }
  return currentUser ? children : <Navigate to="/login" replace />;
}

function AppRoutes() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authLoadError, setAuthLoadError] = useState('');

  useEffect(() => {
    requestAuth('me')
      .then((result) => setCurrentUser(result.user))
      .catch((error) => {
        setCurrentUser(null);
        if (error.status !== 401) {
          setAuthLoadError(error.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <Routes>
      <Route path="/" element={<HomePage currentUser={currentUser} authLoadError={authLoadError} />} />
      <Route path="/login" element={currentUser ? <Navigate to="/workspace" replace /> : <AuthPage mode="login" onLogin={setCurrentUser} authLoadError={authLoadError} />} />
      <Route path="/register" element={currentUser ? <Navigate to="/workspace" replace /> : <AuthPage mode="register" onLogin={setCurrentUser} authLoadError={authLoadError} />} />
      <Route
        path="/workspace"
        element={
          <ProtectedRoute currentUser={currentUser} loading={loading}>
            <DashboardPage currentUser={currentUser} onLogout={() => setCurrentUser(null)} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/rooms/:roomId"
        element={
          <ProtectedRoute currentUser={currentUser} loading={loading}>
            <RoomPage currentUser={currentUser} />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
