import { useEffect, useRef, useState } from 'react';
import { api, waitForApi } from '../api.js';
import { Alert, Spinner } from './ui.jsx';

/**
 * Shared team sign-in, with Render cold-start handling.
 *
 *   idle → connecting → (waking) → signing → signed in
 *                ↘ timeout (Retry)       ↘ failed (Login / Retry)
 *
 * The backend is woken with the public readiness check first; the credentials
 * are posted exactly once per click, and only after that check succeeded. They
 * are never part of the polling, never stored in the browser, and the password
 * field is cleared after a rejected sign-in.
 */
const BUSY = new Set(['connecting', 'waking', 'signing']);
const BUTTON_LABEL = { connecting: 'Connecting…', waking: 'Waking up server…', signing: 'Signing in…' };

export default function LoginForm({ message, onSignedIn, variant = 'card', onPhaseChange }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | connecting | waking | signing | failed | timeout
  const [error, setError] = useState(null);
  const [retryable, setRetryable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const userRef = useRef(null);
  const passRef = useRef(null);
  const inFlight = useRef(false); // synchronous guard: a double click can't start a second attempt
  const cancel = useRef(null);

  useEffect(() => {
    userRef.current?.focus();
    return () => cancel.current?.abort(); // stop polling if the form goes away
  }, []);

  // Presentation only: lets the page reflect progress (e.g. the dial on the sign-in screen).
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  const busy = BUSY.has(phase);

  const validate = () => {
    const errs = {};
    if (!username.trim()) errs.username = 'Enter the team username.';
    if (!password) errs.password = 'Enter the password.';
    setFieldErrors(errs);
    if (errs.username) userRef.current?.focus();
    else if (errs.password) passRef.current?.focus();
    return !errs.username && !errs.password;
  };

  const fail = (nextPhase, text, canRetry) => {
    setPhase(nextPhase);
    setError(text);
    setRetryable(canRetry);
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (inFlight.current) return;
    if (!validate()) {
      setError(null);
      setPhase('idle');
      return;
    }
    inFlight.current = true;
    const ctl = new AbortController();
    cancel.current = ctl;
    setError(null);
    setPhase('connecting');
    try {
      // 1. Make sure the server is awake. Nothing secret is sent here.
      try {
        await waitForApi({ signal: ctl.signal, onWaking: () => setPhase('waking') });
      } catch (err) {
        if (err.name === 'AbortError') return;
        fail('timeout', 'The server is taking longer than usual to start. Please wait a moment and try again. Your details have not been sent.', true);
        return;
      }
      // 2. Sign in, once.
      setPhase('signing');
      let session;
      try {
        session = await api('/api/auth/login', { method: 'POST', json: { username: username.trim(), password } });
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (err.code === 'BACKEND_UNAVAILABLE') {
          // The connection dropped during sign-in. Nothing is retried automatically.
          fail('failed', 'The connection to the server was interrupted while signing in. Please try again.', true);
        } else {
          fail('failed', err.message, false);
          setPassword(''); // rejected credentials are not kept
          passRef.current?.focus();
        }
        return;
      }
      if (ctl.signal.aborted) return;
      setPassword('');
      setPhase('idle');
      onSignedIn(session);
    } finally {
      inFlight.current = false;
      if (cancel.current === ctl) cancel.current = null;
    }
  };

  // The button names the step; this line only adds what the button can't say.
  // Connecting/signing are short, so their text is for screen readers only.
  const status =
    phase === 'connecting' ? { title: 'Connecting to the server…', srOnly: true } :
    phase === 'waking' ? { text: 'The server was idle and is starting up. This may take up to a minute; please keep this page open.' } :
    phase === 'signing' ? { title: 'Signing in…', srOnly: true } : null;

  const page = variant !== 'card'; // full sign-in page (not the pop-up after a session ends)
  const Title = page ? 'h1' : 'h2';

  return (
    <form className={`auth-card login-card login-${variant}`} onSubmit={submit} noValidate aria-busy={busy}>
      {variant === 'card' && (
        <div className="brand auth-brand">
          <span className="brand-mark" aria-hidden="true">✉</span>
          <span className="brand-text">
            <span className="brand-name">ZodiacPatent</span>
            <span className="brand-sub">Attorney Email Automation</span>
          </span>
        </div>
      )}
      <Title className="login-title">Sign in</Title>
      <p className="muted login-lead">{page ? 'Use your team credentials.' : 'Use the shared ZodiacPatent team credentials.'}</p>

      <div aria-live="polite">
        {message && !error && phase === 'idle' && <Alert type="info">{message}</Alert>}
      </div>
      <div aria-live="assertive">
        {error && (
          <Alert type={phase === 'timeout' ? 'warning' : 'error'}>
            <strong>{phase === 'timeout' ? 'Server not ready yet.' : 'Login failed.'}</strong> {error}
          </Alert>
        )}
      </div>

      <label className="field">
        <span className="field-label">Username</span>
        <input
          ref={userRef}
          id="login-username"
          type="text"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined }));
          }}
          disabled={busy}
          aria-invalid={Boolean(fieldErrors.username)}
          aria-describedby={fieldErrors.username ? 'login-username-error' : undefined}
        />
        {fieldErrors.username && <span id="login-username-error" className="field-error">{fieldErrors.username}</span>}
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <span className="password-wrap">
          <input
            ref={passRef}
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
            }}
            disabled={busy}
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            disabled={busy}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </span>
        {fieldErrors.password && <span id="login-password-error" className="field-error">{fieldErrors.password}</span>}
      </label>

      <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
        {busy ? <><Spinner /> {BUTTON_LABEL[phase]}</> : retryable && (phase === 'timeout' || phase === 'failed') ? 'Retry' : 'Sign in'}
      </button>

      {/* Below the button, so the fields never move while the server starts. */}
      <div className="login-status-area" role="status" aria-live="polite">
        {status ? (
          <div className={`login-status login-status-${phase}`}>
            <span className={`login-status-line${status.srOnly ? ' sr-only' : ''}`}>
              {status.title && <strong>{status.title}</strong>}
              {status.text && <span className="login-status-text">{status.text}</span>}
            </span>
            {/* On the sign-in page the dial shows the progress instead. */}
            {phase === 'waking' && variant !== 'stage' && <span className="login-progress" aria-hidden="true"><span /></span>}
          </div>
        ) : variant === 'stage' ? null : (
          <p className="muted small auth-note">The first sign-in after a quiet period can take up to a minute while the server starts.</p>
        )}
      </div>
    </form>
  );
}
