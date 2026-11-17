import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Alert, Spinner } from './ui.jsx';

/** Shared team sign-in. The password is sent once to the backend and never stored in the browser. */
export default function LoginForm({ message, onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const userRef = useRef(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter the team username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api('/api/auth/login', { method: 'POST', json: { username: username.trim(), password } });
      setPassword('');
      onSignedIn(session);
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth-card" onSubmit={submit} noValidate>
      <div className="brand auth-brand">
        <span className="brand-mark" aria-hidden="true">✉</span>
        <span className="brand-text">
          <span className="brand-name">ZodiacPatent</span>
          <span className="brand-sub">Attorney Email Automation</span>
        </span>
      </div>
      <h1 className="auth-title">Sign in</h1>
      {message && !error && <Alert type="info">{message}</Alert>}
      {error && <Alert type="error">{error}</Alert>}
      <label className="field">
        <span className="field-label">Username</span>
        <input ref={userRef} type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </label>
      <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
        {busy ? <><Spinner /> Signing in…</> : 'Sign in'}
      </button>
      <p className="muted small auth-note">Use the shared ZodiacPatent team login.</p>
    </form>
  );
}
