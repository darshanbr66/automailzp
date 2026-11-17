import { useCallback, useEffect, useState } from 'react';
import { api, setAuthRequiredHandler, setCsrfToken } from './api.js';
import LoginForm from './components/LoginForm.jsx';
import SmtpStatus from './components/SmtpStatus.jsx';
import ComposePage from './components/ComposePage.jsx';
import TemplatePage from './components/TemplatePage.jsx';
import HistoryPage from './components/HistoryPage.jsx';
import { Alert, Spinner } from './components/ui.jsx';

const TABS = [
  { id: 'compose', label: 'Compose Email' },
  { id: 'template', label: 'Template Settings' },
  { id: 'history', label: 'Sent History' },
];

/**
 * Shared team sign-in gate. When the backend has login enabled, nothing else is
 * shown (or requested) until the team has signed in. If the session ends while
 * the app is open, the sign-in form appears over the page so unsaved edits
 * are kept.
 */
export default function App() {
  const [auth, setAuth] = useState({ state: 'loading' }); // loading | signin | ready | error
  const [workspaceShown, setWorkspaceShown] = useState(false);

  const checkSession = useCallback(async () => {
    setAuth({ state: 'loading' });
    try {
      const s = await api('/api/auth/session');
      setCsrfToken(s.csrfToken);
      setAuth(s.authenticated ? { state: 'ready', required: s.authRequired, username: s.username } : { state: 'signin' });
    } catch (err) {
      setAuth({ state: 'error', message: err.message });
    }
  }, []);

  useEffect(() => {
    checkSession();
    setAuthRequiredHandler((message) => {
      setCsrfToken(null);
      setAuth({ state: 'signin', message });
    });
    return () => setAuthRequiredHandler(null);
  }, [checkSession]);

  useEffect(() => {
    if (auth.state === 'ready') setWorkspaceShown(true);
  }, [auth.state]);

  const onSignedIn = (s) => {
    setCsrfToken(s.csrfToken);
    setAuth({ state: 'ready', required: true, username: s.username });
  };

  const signOut = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* the session is cleared below either way */
    }
    setCsrfToken(null);
    setWorkspaceShown(false);
    setAuth({ state: 'signin', message: 'You have signed out.' });
  };

  if (auth.state === 'loading' && !workspaceShown) {
    return <div className="auth-screen"><div className="auth-card"><Spinner /> <span className="muted">Loading…</span></div></div>;
  }
  if (auth.state === 'error') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Alert type="error">{auth.message}</Alert>
          <button className="btn btn-primary" onClick={checkSession}>Try again</button>
        </div>
      </div>
    );
  }
  if (auth.state === 'signin' && !workspaceShown) {
    return <div className="auth-screen"><LoginForm message={auth.message} onSignedIn={onSignedIn} /></div>;
  }
  return (
    <>
      <Workspace auth={auth} onSignOut={signOut} />
      {auth.state === 'signin' && (
        <div className="modal-backdrop">
          <LoginForm message={auth.message} onSignedIn={onSignedIn} />
        </div>
      )}
    </>
  );
}

function Workspace({ auth, onSignOut }) {
  const [tab, setTab] = useState('compose');
  const [smtp, setSmtp] = useState(null);
  const [testing, setTesting] = useState(false);
  const [banner, setBanner] = useState(null);
  const [backendError, setBackendError] = useState(null);

  const refreshSmtp = useCallback(async () => {
    try {
      setSmtp(await api('/api/smtp/status'));
      setBackendError(null);
    } catch (err) {
      if (err.code === 'BACKEND_UNAVAILABLE') setBackendError(err.message);
      setSmtp((s) => s || { configured: false, unavailable: true });
    }
  }, []);

  const testConnection = async () => {
    setTesting(true);
    setBanner(null);
    try {
      const status = await api('/api/smtp/test', { method: 'POST' });
      setSmtp(status);
      const t = status.lastTest;
      setBanner(t.ok ? { type: 'success', text: `Email connection test succeeded. ${t.message} No email was sent.` } : { type: 'error', text: `Email connection test failed. ${t.message}` });
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
      if (err.code === 'BACKEND_UNAVAILABLE') setBackendError(err.message);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    refreshSmtp();
  }, [refreshSmtp]);

  useEffect(() => {
    document.title = smtp?.from ? `ZodiacPatent – Attorney Email (${smtp.from})` : 'ZodiacPatent – Attorney Email Automation';
  }, [smtp?.from]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✉</span>
          <span className="brand-text">
            <span className="brand-name">ZodiacPatent</span>
            <span className="brand-sub">Attorney Email Automation</span>
          </span>
        </div>
        <div className="topbar-right">
          <SmtpStatus smtp={smtp} testing={testing} onTest={testConnection} />
          {auth.required && (
            <span className="session-info">
              <span className="muted small">Signed in as <strong>{auth.username}</strong></span>
              <button className="btn btn-small btn-ghost" onClick={onSignOut}>Sign out</button>
            </span>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {backendError && (
          <Alert type="error" onClose={() => setBackendError(null)}>
            {backendError}{' '}
            <button className="link-button" onClick={refreshSmtp}>Retry</button>
          </Alert>
        )}
        {smtp && !smtp.unavailable && !smtp.configured && (
          <Alert type="warning">
            Email sending is not configured yet: {(smtp.problems || []).join('; ')}.{' '}
            {smtp.hosted
              ? 'An administrator needs to update the email settings (environment variables) on Render and restart the service.'
              : <>Edit <code>backend\.env</code> (see README, “Hostinger App Password”) and restart the app.</>}
          </Alert>
        )}
        {smtp?.storageWarning && <Alert type="warning"><strong>Temporary storage.</strong> {smtp.storageWarning.replace(/^Temporary storage: /, '')}</Alert>}
        {smtp?.configured && smtp.warnings?.map((w) => <Alert key={w} type="warning">{w}</Alert>)}
        {banner && <Alert type={banner.type} onClose={() => setBanner(null)}>{banner.text}</Alert>}
        {!banner && smtp?.configured && smtp.lastTest && !smtp.lastTest.ok && (
          <Alert type="error">Last email connection test ({smtp.lastTest.at}) failed. {smtp.lastTest.message}</Alert>
        )}

        {/* Pages stay mounted so unsaved edits survive switching tabs. */}
        <div hidden={tab !== 'compose'}>
          <ComposePage smtp={smtp} onSmtpChanged={refreshSmtp} active={tab === 'compose'} />
        </div>
        <div hidden={tab !== 'template'}>
          <TemplatePage active={tab === 'template'} />
        </div>
        <div hidden={tab !== 'history'}>
          <HistoryPage active={tab === 'history'} />
        </div>
      </main>
    </div>
  );
}
