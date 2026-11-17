import { Spinner } from './ui.jsx';

/** Top-bar status: sender address, configuration state and the connection test button. */
export default function SmtpStatus({ smtp, testing, onTest }) {
  if (!smtp) return <div className="outlook-status muted">Checking email settings…</div>;
  if (smtp.unavailable) return <div className="outlook-status"><span className="dot dot-off" />Server unavailable</div>;

  const test = smtp.lastTest;
  const dot = !smtp.configured ? 'dot-warn' : !test ? 'dot-warn' : test.ok ? 'dot-on' : 'dot-error';
  const state = !smtp.configured ? 'Not configured' : !test ? 'Not tested yet' : test.ok ? 'Connection OK' : 'Connection failed';
  return (
    <div className="outlook-status">
      <span className={`dot ${dot}`} />
      <span className="account" title={`${smtp.host}:${smtp.port} (${smtp.secure ? 'SSL' : 'STARTTLS'}) — ${state}`}>
        Sending as <strong>{smtp.from || '(SMTP_FROM not set)'}</strong>
        <span className="muted small"> · {state}</span>
      </span>
      <button className="btn btn-small btn-ghost" onClick={onTest} disabled={testing}>
        {testing ? <><Spinner /> Testing…</> : 'Test SMTP Connection'}
      </button>
    </div>
  );
}
