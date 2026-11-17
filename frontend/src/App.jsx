import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import SmtpStatus from './components/SmtpStatus.jsx';
import ComposePage from './components/ComposePage.jsx';
import TemplatePage from './components/TemplatePage.jsx';
import HistoryPage from './components/HistoryPage.jsx';
import { Alert } from './components/ui.jsx';

const TABS = [
  { id: 'compose', label: 'Compose Email' },
  { id: 'template', label: 'Template Settings' },
  { id: 'history', label: 'Sent History' },
];

export default function App() {
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
      setBanner(t.ok ? { type: 'success', text: `SMTP connection test succeeded. ${t.message} No email was sent.` } : { type: 'error', text: `SMTP connection test failed. ${t.message}` });
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
        <SmtpStatus smtp={smtp} testing={testing} onTest={testConnection} />
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
            Email sending is not configured yet: {(smtp.problems || []).join('; ')}. Edit <code>backend\.env</code> (see README, “Hostinger App Password”) and restart the app.
          </Alert>
        )}
        {smtp?.configured && smtp.warnings?.map((w) => <Alert key={w} type="warning">{w}</Alert>)}
        {banner && <Alert type={banner.type} onClose={() => setBanner(null)}>{banner.text}</Alert>}
        {!banner && smtp?.configured && smtp.lastTest && !smtp.lastTest.ok && (
          <Alert type="error">Last SMTP connection test ({smtp.lastTest.at}) failed. {smtp.lastTest.message}</Alert>
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
