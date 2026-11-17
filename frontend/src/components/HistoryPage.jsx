import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download } from '../api.js';
import { formatLocal, userTimeZone, whenOf } from '../time.js';
import { useOperator } from './OperatorPicker.jsx';
import { MethodBadge, useAutoRefresh } from './SentEmailsPage.jsx';
import { Alert, Card, Modal, Pager, Spinner, StatusBadge } from './ui.jsx';

const PAGE_SIZE = 10;
const countsAsSent = (e) => (e.status === 'Success' || e.status === 'Uncertain') && !e.voided;
const norm = (v) => String(v ?? '').trim().toLowerCase();
/** Calendar day of an entry in the viewer's time zone. */
const dayOf = (e) => (e.sentAtUtc ? new Date(e.sentAtUtc).toLocaleDateString('en-CA') : String(e.sentAt || '').slice(0, 10));

/** One row per attorney record (grouped by the stored Record ID). Entries arrive newest first. */
function groupByRecord(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = norm(e.recordId) || `${norm(e.attorneyName)}|${norm(e.recipientEmail)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, latest: e, attempts: 0, sends: 0, resends: 0, failed: 0, manual: 0, firstSent: null, lastSent: null, pendingSave: false };
      groups.set(key, g);
    }
    g.attempts += 1;
    if (e.pendingSave) g.pendingSave = true;
    if (e.status === 'Failed' && !e.voided) g.failed += 1;
    if (countsAsSent(e)) {
      g.sends += 1;
      if (e.sendMethod === 'Manual') g.manual += 1;
      if (e.sendType === 'Resend') g.resends += 1;
      if (!g.lastSent) g.lastSent = e;
      g.firstSent = e; // older entries come later
    }
  }
  return [...groups.values()];
}

const ACTION_LABELS = {
  email_sent: 'Email sent',
  email_failed: 'Send failed',
  email_uncertain: 'Send uncertain',
  send_uncertain_recovered: 'Interrupted send recorded as uncertain',
  manual_mark_sent: 'Marked as sent (manual)',
  history_corrected: 'History corrected',
  workbook_uploaded: 'Workbook uploaded',
  workbook_removed: 'Workbook removed',
  template_updated: 'Template updated',
  mapping_updated: 'Column mapping updated',
  data_migrated: 'Data migrated',
};

function ActivityView({ active }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const load = useCallback(async () => {
    try {
      setData(await api(`/api/activity?${new URLSearchParams({ q, action, page: String(page) })}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [q, action, page]);
  useAutoRefresh(active, load);
  useEffect(() => setPage(1), [q, action]);

  if (data && !data.available) return <p className="muted">The team activity log is available when the shared database (MongoDB) is enabled.</p>;
  return (
    <>
      <p className="muted small">
        Who did what, and when (your time zone: {userTimeZone()}). The operator is <strong>self-declared</strong> (one shared login). IP address, location and device
        are what the request reported; they describe a connection or device, they don't prove who someone is. Visible only to signed-in team members.
      </p>
      <div className="filters">
        <input type="search" placeholder="Search attorney, email or registration no." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search activity" />
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {error && <Alert type="error">{error}</Alert>}
      {data && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Operator</th><th>Action</th><th>Attorney</th><th>Device</th><th>IP (reported)</th><th>Location</th></tr></thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{formatLocal(a.atUtc)}</td>
                    <td>{a.operator || <span className="muted">—</span>}<span className="sub-line">{a.operatorIdType}</span></td>
                    <td>
                      <span className={`badge ${a.outcome === 'failed' ? 'badge-error' : a.outcome === 'uncertain' ? 'badge-warn' : ''}`}>{ACTION_LABELS[a.action] || a.action}</span>
                      <span className="sub-line">{a.summary}{a.details?.reason ? ` — “${a.details.reason}”` : ''}</span>
                    </td>
                    <td>
                      {a.attorney ? (
                        <>
                          {a.attorney.name || <span className="muted">—</span>}
                          <span className="sub-line">{[a.attorney.registrationNumber, a.attorney.recipientEmail].filter(Boolean).join(' · ')}</span>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>{a.os || '—'}<span className="sub-line">{[a.browser, a.deviceType].filter(Boolean).join(' · ')}</span></td>
                    <td className="nowrap" title={a.ipNote || ''}>{a.ip || <span className="muted">—</span>}</td>
                    <td>{a.location?.available ? [a.location.city, a.location.region, a.location.country].filter(Boolean).join(', ') : <span className="muted">Unavailable</span>}</td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan={7} className="empty">No activity recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageCount={data.pageCount} pageSize={20} matched={data.total} noun="actions" onPage={setPage} />
        </>
      )}
    </>
  );
}

function CorrectionModal({ entry, onClose, onDone }) {
  const operator = useOperator();
  const [action, setAction] = useState(entry.status === 'Uncertain' ? 'confirm-not-sent' : 'void');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/history/${encodeURIComponent(entry.id)}/correct`, { method: 'POST', json: { action, reason } });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Correct this history record"
      tone="warning"
      onCancel={() => !busy && onClose()}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} data-autofocus>Cancel</button>
          <button className="btn btn-warning" onClick={submit} disabled={busy || reason.trim().length < 3 || !operator}>{busy ? <><Spinner /> Saving…</> : 'Save correction'}</button>
        </>
      }
    >
      <dl className="details compact">
        <div><dt>Attorney</dt><dd>{entry.attorneyName || '—'}</dd></div>
        <div><dt>Email</dt><dd className="email-cell">{entry.recipientEmail}</dd></div>
        <div><dt>Recorded</dt><dd>{whenOf(entry)} · {entry.status} · {entry.sendMethod || 'method not recorded'}</dd></div>
      </dl>
      <div className="field">
        <span className="field-label">Correction</span>
        {entry.status === 'Uncertain' && (
          <>
            <label className="operator-choice"><input type="radio" checked={action === 'confirm-not-sent'} onChange={() => setAction('confirm-not-sent')} /> It was <strong>not</strong> sent (becomes “Failed”)</label>
            <label className="operator-choice"><input type="radio" checked={action === 'confirm-sent'} onChange={() => setAction('confirm-sent')} /> It <strong>was</strong> sent (becomes “Success”)</label>
          </>
        )}
        <label className="operator-choice"><input type="radio" checked={action === 'void'} onChange={() => setAction('void')} /> Void this record (recorded by mistake; it stops counting as sent)</label>
      </div>
      <label className="field">
        <span className="field-label">Reason (required, kept in the activity log)</span>
        <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Marked the wrong attorney" />
      </label>
      <p className="muted small">Nothing is deleted: the original record stays in the history with this correction, who made it ({operator || 'choose your name first'}, self-declared) and when.</p>
      {error && <Alert type="error">{error}</Alert>}
    </Modal>
  );
}

export default function HistoryPage({ active, appConfig }) {
  const [entries, setEntries] = useState(null);
  const [file, setFile] = useState('');
  const [sender, setSender] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('attorneys'); // attorneys | log | activity
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sendType, setSendType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [correcting, setCorrecting] = useState(null);
  const [exporting, setExporting] = useState(false);
  const canCorrect = Boolean(appConfig?.features?.corrections);

  const load = useCallback(async () => {
    try {
      const data = await api('/api/history');
      setEntries(data.entries);
      setFile(data.file);
      setSender(data.sender);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useAutoRefresh(active && mode !== 'activity', load);

  useEffect(() => setPage(1), [mode, query, status, sendType, from, to]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const q = norm(query);
    return entries.filter((e) => {
      if (mode === 'log' && status && (status === 'Voided' ? !e.voided : e.status !== status || e.voided)) return false;
      if (mode === 'log' && sendType && e.sendType !== sendType) return false;
      const day = dayOf(e);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!q) return true;
      return [e.attorneyName, e.recipientEmail, e.registrationNumber, e.recordId, e.firmName, e.subject, e.operator].some((v) => norm(v).includes(q));
    });
  }, [entries, query, status, sendType, from, to, mode]);

  const attorneys = useMemo(
    () =>
      groupByRecord(filteredEntries).filter((g) => {
        if (status && status !== 'Voided' && g.latest.status !== status) return false;
        if (sendType === 'Resend' && !g.resends) return false;
        if (sendType === 'First Send' && g.resends) return false;
        return true;
      }),
    [filteredEntries, status, sendType],
  );

  const list = mode === 'attorneys' ? attorneys : filteredEntries;
  const total = mode === 'attorneys' ? (entries ? groupByRecord(entries).length : 0) : entries?.length || 0;
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = list.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const sentAttorneys = entries ? groupByRecord(entries).filter((g) => g.sends > 0).length : 0;

  const clear = () => {
    setQuery('');
    setStatus('');
    setSendType('');
    setFrom('');
    setTo('');
  };
  const exportExcel = async () => {
    setExporting(true);
    try {
      await download('/api/history/export', 'sent-history.xlsx');
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title="Sent history"
      actions={
        <>
          <button className="btn btn-small btn-ghost" onClick={exportExcel} disabled={exporting}>{exporting ? <><Spinner /> Exporting…</> : 'Export to Excel'}</button>
          <button className="btn btn-small btn-ghost" onClick={load}>Refresh</button>
        </>
      }
    >
      <p className="muted small">
        Every send attempt is recorded in <code>{file || 'backend/data/sent-emails.xlsx'}</code>. “Success” means the email service accepted the email (or it was marked as sent manually);
        it does not confirm the recipient received it. “Failed” emails were not sent. “Uncertain” means the outcome is unknown. Times are in your time zone ({userTimeZone()}).
        {sender && <> Emails are currently sent from <strong>{sender}</strong>.</>}
      </p>

      <div className="segmented" role="group" aria-label="History view">
        <button aria-pressed={mode === 'attorneys'} onClick={() => setMode('attorneys')}>Attorneys{entries ? ` (${sentAttorneys} emailed)` : ''}</button>
        <button aria-pressed={mode === 'log'} onClick={() => setMode('log')}>All send attempts{entries ? ` (${entries.length})` : ''}</button>
        <button aria-pressed={mode === 'activity'} onClick={() => setMode('activity')}>Team activity</button>
      </div>

      {mode === 'activity' ? (
        <ActivityView active={active && mode === 'activity'} />
      ) : (
        <>
          <div className="filters">
            <input type="search" placeholder="Search attorney name or recipient email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search history" />
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">{mode === 'attorneys' ? 'Any latest status' : 'All statuses'}</option>
              <option value="Success">Success</option>
              <option value="Failed">Failed</option>
              <option value="Uncertain">Uncertain</option>
              {mode === 'log' && <option value="Voided">Voided</option>}
            </select>
            <select value={sendType} onChange={(e) => setSendType(e.target.value)} aria-label="Send type">
              <option value="">All send types</option>
              <option value="First Send">{mode === 'attorneys' ? 'First send only' : 'First Send'}</option>
              <option value="Resend">{mode === 'attorneys' ? 'Resent' : 'Resend'}</option>
            </select>
            <label className="inline-field">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="inline-field">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            {(query || status || sendType || from || to) && <button className="btn btn-small btn-ghost" onClick={clear}>Clear filters</button>}
          </div>
          {error && <Alert type="error">{error}</Alert>}

          {entries && mode === 'attorneys' && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Attorney</th><th>Registration no.</th><th>Recipient</th><th>First sent</th><th>Last sent</th><th>Sends</th><th>Latest status</th></tr>
                </thead>
                <tbody>
                  {visible.map((g) => {
                    const e = g.latest;
                    return (
                      <tr key={g.key}>
                        <td>{e.attorneyName || <span className="muted">—</span>}{e.firmName && <span className="sub-line">{e.firmName}</span>}</td>
                        <td>{e.registrationNumber || <span className="muted" title={`Record ID ${e.recordId}`}>—</span>}</td>
                        <td className="email-cell">{e.recipientEmail}</td>
                        <td className="nowrap">{g.firstSent ? whenOf(g.firstSent) : <span className="muted">—</span>}</td>
                        <td className="nowrap">{g.lastSent ? <>{whenOf(g.lastSent)}<span className="sub-line">{[g.lastSent.sendMethod, g.lastSent.operator].filter(Boolean).join(' · ')}</span></> : <span className="muted">—</span>}</td>
                        <td>
                          {g.sends ? (
                            <>
                              <span className="badge">{g.manual === g.sends ? 'Manual' : 'First Send'}</span>
                              {g.resends > 0 && <span className="badge badge-warn">Resent ×{g.resends}</span>}
                            </>
                          ) : <span className="muted small">Not sent</span>}
                          {g.failed > 0 && <span className="sub-line">{g.failed} failed attempt{g.failed > 1 ? 's' : ''}</span>}
                        </td>
                        <td>
                          {e.voided ? <span className="badge">Voided</span> : <StatusBadge status={e.status} />}
                          {g.pendingSave && <span className="badge badge-warn" title="Waiting to be written to the shared history">Not yet saved</span>}
                          <span className="sub-line">{whenOf(e)}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {!visible.length && <tr><td colSpan={7} className="empty">{entries.length ? 'No attorneys match your filters.' : 'No emails have been sent yet.'}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {entries && mode === 'log' && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Date and time</th><th>Attorney</th><th>Registration no.</th><th>Recipient</th><th>Subject</th><th>Method</th><th>Operator</th><th>Status</th><th>Type</th>{canCorrect && <th />}</tr>
                </thead>
                <tbody>
                  {visible.map((e, i) => (
                    <tr key={e.id || `${e.recordId}-${e.sentAt}-${i}`} className={e.voided ? 'voided-row' : ''}>
                      <td className="nowrap">{whenOf(e)}</td>
                      <td>{e.attorneyName}{(e.firmName || e.city || e.state) && <span className="sub-line">{[e.firmName, [e.city, e.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>}</td>
                      <td>{e.registrationNumber || <span className="muted" title={`Record ID ${e.recordId}`}>—</span>}</td>
                      <td className="email-cell">{e.recipientEmail}</td>
                      <td>{e.subject}{e.note && <span className="sub-line">{e.note}</span>}</td>
                      <td><MethodBadge method={e.sendMethod} /></td>
                      <td>{e.operator || <span className="muted">—</span>}</td>
                      <td>
                        <StatusBadge status={e.status} />
                        {e.voided && <span className="badge" title={`Voided by ${e.void?.operator || '?'} at ${formatLocal(e.void?.atUtc)}: ${e.void?.reason || ''}`}>Voided</span>}
                        {e.resolution && <span className="sub-line" title={e.resolution.reason}>Was uncertain; confirmed “{e.resolution.resolvedAs}” by {e.resolution.operator}</span>}
                        {e.voided && <span className="sub-line">{e.void?.reason}</span>}
                        {e.pendingSave && <span className="badge badge-warn" title="Waiting to be written to the shared history">Not yet saved</span>}
                      </td>
                      <td>{e.sendType === 'Resend' ? <span className="badge badge-warn">Resend</span> : e.sendType ? <span className="badge">{e.sendType}</span> : null}</td>
                      {canCorrect && <td>{e.id && !e.voided && <button className="btn btn-small btn-ghost" onClick={() => setCorrecting(e)}>Correct…</button>}</td>}
                    </tr>
                  ))}
                  {!visible.length && <tr><td colSpan={canCorrect ? 10 : 9} className="empty">{entries.length ? 'No entries match your filters.' : 'No emails have been sent yet.'}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {entries && <Pager page={current} pageCount={pageCount} pageSize={PAGE_SIZE} matched={list.length} total={total} noun={mode === 'attorneys' ? 'attorneys' : 'send attempts'} onPage={setPage} />}
        </>
      )}
      {correcting && <CorrectionModal entry={correcting} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); load(); }} />}
    </Card>
  );
}
