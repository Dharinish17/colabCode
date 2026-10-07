import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

async function requestAuth(endpoint, body) {
  const response = await fetch(`${API_URL}/api/auth/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function Brand({ light = false }) {
  return (
    <Link className={`inline-flex items-center gap-3 font-semibold tracking-tight ${light ? 'text-white' : 'text-slate-100'}`} to="/">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400 font-mono text-lg text-slate-950">
        {'</>'}
      </span>
      CodeRoom
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
              <Link className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300" to="/workspace">
                Open workspace
              </Link>
            ) : (
              <>
                <Link className="px-3 py-2 text-slate-300 hover:text-white" to="/login">Log in</Link>
                <Link className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-300" to="/register">
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
            <p className="mb-5 inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-300">
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
                <Link className="rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950 hover:bg-cyan-300" to="/workspace">
                  Continue as {currentUser.username}
                </Link>
              ) : (
                <>
                  <Link className="rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950 hover:bg-cyan-300" to="/register">
                    Get started
                  </Link>
                  <Link className="rounded-xl border border-slate-700 px-5 py-3 font-semibold text-white hover:border-slate-500" to="/login">
                    I already have an account
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="relative rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-cyan-950/30">
            <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-cyan-500/10 blur-3xl" />
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
              <p><span className="mr-5 text-slate-600">1</span><span className="text-fuchsia-300">function</span> <span className="text-cyan-200">buildTogether</span>() {'{'}</p>
              <p><span className="mr-5 text-slate-600">2</span>  <span className="text-fuchsia-300">return</span> <span className="text-amber-200">'great ideas'</span>;</p>
              <p><span className="mr-5 text-slate-600">3</span>{'}'}</p>
              <div className="absolute left-[7.55rem] top-[3.1rem] h-6 border-l-2 border-cyan-400" />
            </div>
            <div className="relative mt-4 flex items-center gap-2 text-xs text-slate-400">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20 font-medium text-violet-200">JD</span>
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
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
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
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
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
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
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
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none placeholder:text-slate-600 focus:border-cyan-400"
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
            className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          {isRegister ? 'Already have an account?' : 'New to CodeRoom?'}{' '}
          <Link className="font-medium text-cyan-300 hover:text-cyan-200" to={isRegister ? '/login' : '/register'}>
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

function WorkspacePage({ currentUser, onLogout }) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setError('');
    setBusy(true);
    try {
      await requestAuth('logout', {});
      onLogout();
      navigate('/', { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between border-b border-slate-800 pb-5">
          <Brand />
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-slate-300 sm:inline">{currentUser.username}</span>
            <button
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-60"
              disabled={busy}
              onClick={handleLogout}
              type="button"
            >
              {busy ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </header>
        <section className="py-16">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300">Your account</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">You’re signed in.</h1>
          <p className="mt-3 text-slate-400">Your protected workspace is ready, {currentUser.username}.</p>
          {error && <p role="alert" className="mt-5 text-sm text-rose-300">{error}</p>}
          <div className="mt-8 max-w-xl rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
            <h2 className="text-lg font-semibold text-white">Profile</h2>
            <dl className="mt-5 space-y-4 text-sm">
              <div>
                <dt className="text-slate-500">Username</dt>
                <dd className="mt-1 text-slate-200">{currentUser.username}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Email</dt>
                <dd className="mt-1 text-slate-200">{currentUser.email}</dd>
              </div>
            </dl>
          </div>
        </section>
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
            <WorkspacePage currentUser={currentUser} onLogout={() => setCurrentUser(null)} />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
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
