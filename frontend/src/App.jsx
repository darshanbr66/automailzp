import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setAuthRequiredHandler, setCsrfToken, setOperatorRequiredHandler } from './api.js';
import LoginForm from './components/LoginForm.jsx';
import { sessionSentNames } from './sentNames.js';
import SmtpStatus from './components/SmtpStatus.jsx';
import ComposePage from './components/ComposePage.jsx';
import TemplatePage from './components/TemplatePage.jsx';
import HistoryPage from './components/HistoryPage.jsx';
import SentEmailsPage from './components/SentEmailsPage.jsx';
import AllAttorneysPage from './components/AllAttorneysPage.jsx';
import { OperatorPrompt, OperatorSelect } from './components/OperatorPicker.jsx';
import { getOperator, knownOperator, setOperator } from './operator.js';
import { Alert, Spinner } from './components/ui.jsx';

const TABS = [
  { id: 'compose', label: 'Compose Email' },
  { id: 'sent', label: 'Sent Emails' },
  { id: 'attorneys', label: 'All Attorneys' },
  { id: 'template', label: 'Template Settings' },
  { id: 'history', label: 'Sent History' },
];

/** Extra attempts (1 s, 2 s, 4 s apart) to load the app settings, e.g. while Render is waking up. */
const CONFIG_RETRIES = 3;

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
    sessionSentNames.clear(); // a new sign-in starts a new list of sent names
    setOperator(null); // and asks again who is using this browser
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
  const [appConfig, setAppConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const configLoad = useRef(0);

  // Capabilities of this server (file storage or the shared MongoDB database).
  // A failed request is retried and, if it keeps failing, reported with a Retry
  // button. It is never treated as "file storage": that hid the operator prompt
  // while the server still required an operator for every action.
  const loadConfig = useCallback(async () => {
    const run = ++configLoad.current;
    setConfigError(null);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const cfg = await api('/api/app/config');
        if (run === configLoad.current) setAppConfig(cfg);
        return;
      } catch (err) {
        if (run !== configLoad.current) return; // superseded or unmounted
        if (err.code === 'AUTH_REQUIRED' || attempt >= CONFIG_RETRIES) {
          setConfigError(err.message);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }, []);
  useEffect(() => {
    loadConfig();
    return () => {
      configLoad.current += 1; // stop retries after unmount
    };
  }, [loadConfig]);
  // Signed in again after the session ended while settings were still missing.
  useEffect(() => {
    if (auth.state === 'ready' && configError) loadConfig();
  }, [auth.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const operatorRequired = Boolean(appConfig?.features?.operatorRequired);
  const teamMembers = appConfig?.teamMembers;

  // A stored name the server does not accept (e.g. the team list changed) is cleared, so the prompt asks again.
  useEffect(() => {
    if (!operatorRequired) return;
    const op = getOperator();
    if (op && !knownOperator(op, teamMembers)) setOperator(null);
    else if (op && knownOperator(op, teamMembers) !== op) setOperator(knownOperator(op, teamMembers));
  }, [operatorRequired, teamMembers]);

  // The server refused an action for lack of a valid operator: ask again, with the current team list.
  useEffect(() => {
    setOperatorRequiredHandler(() => {
      setOperator(null);
      loadConfig();
    });
    return () => setOperatorRequiredHandler(null);
  }, [loadConfig]);

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
          {appConfig && (
            <span
              className={`storage-badge ${appConfig.storage === 'mongodb' ? 'storage-db' : 'storage-file'}`}
              title={appConfig.storage === 'mongodb' ? 'History, workbook and activity are saved in the shared MongoDB database.' : 'History is saved in a local Excel file on this server.'}
            >
              {appConfig.storage === 'mongodb' ? `Shared database: ${appConfig.database || 'MongoDB'}` : 'Local files'}
            </span>
          )}
          {operatorRequired && <OperatorSelect teamMembers={appConfig.teamMembers} />}
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
        {configError && (
          <Alert type="error" onClose={() => setConfigError(null)}>
            The application settings could not be loaded, so the team member selection is not available yet. {configError}{' '}
            <button className="link-button" onClick={loadConfig}>Retry</button>
          </Alert>
        )}
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
        <div hidden={tab !== 'sent'}>
          <SentEmailsPage active={tab === 'sent'} />
        </div>
        <div hidden={tab !== 'attorneys'}>
          <AllAttorneysPage active={tab === 'attorneys'} appConfig={appConfig} />
        </div>
        <div hidden={tab !== 'template'}>
          <TemplatePage active={tab === 'template'} />
        </div>
        <div hidden={tab !== 'history'}>
          <HistoryPage active={tab === 'history'} appConfig={appConfig} />
        </div>
      </main>
      {operatorRequired && <OperatorPrompt teamMembers={appConfig.teamMembers} />}
    </div>
  );
}
