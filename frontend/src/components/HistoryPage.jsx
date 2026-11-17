import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Alert, Card, Pager, StatusBadge } from './ui.jsx';

const PAGE_SIZE = 10;
const countsAsSent = (status) => status === 'Success' || status === 'Uncertain';
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** One row per attorney record (grouped by the stored Record ID). Entries arrive newest first. */
function groupByRecord(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = norm(e.recordId) || `${norm(e.attorneyName)}|${norm(e.recipientEmail)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, latest: e, attempts: 0, sends: 0, resends: 0, failed: 0, firstSent: '', lastSent: '', pendingSave: false };
      groups.set(key, g);
    }
    g.attempts += 1;
    if (e.pendingSave) g.pendingSave = true;
    if (e.status === 'Failed') g.failed += 1;
    if (countsAsSent(e.status)) {
      g.sends += 1;
      if (e.sendType === 'Resend') g.resends += 1;
      if (!g.lastSent) g.lastSent = e.sentAt;
      g.firstSent = e.sentAt; // older entries come later
    }
  }
  return [...groups.values()];
}

export default function HistoryPage({ active }) {
  const [entries, setEntries] = useState(null);
  const [file, setFile] = useState('');
  const [sender, setSender] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('attorneys'); // attorneys | log
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sendType, setSendType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

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

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  useEffect(() => setPage(1), [mode, query, status, sendType, from, to]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const q = norm(query);
    return entries.filter((e) => {
      if (mode === 'log' && status && e.status !== status) return false;
      if (mode === 'log' && sendType && e.sendType !== sendType) return false;
      const day = (e.sentAt || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!q) return true;
      return [e.attorneyName, e.recipientEmail, e.registrationNumber, e.recordId, e.firmName, e.subject].some((v) => norm(v).includes(q));
    });
  }, [entries, query, status, sendType, from, to, mode]);

  const attorneys = useMemo(() => {
    const groups = groupByRecord(filteredEntries);
    return groups.filter((g) => {
      if (status === 'Success' && g.latest.status !== 'Success') return false;
      if (status === 'Failed' && g.latest.status !== 'Failed') return false;
      if (status === 'Uncertain' && g.latest.status !== 'Uncertain') return false;
      if (sendType === 'Resend' && !g.resends) return false;
      if (sendType === 'First Send' && g.resends) return false;
      return true;
    });
  }, [filteredEntries, status, sendType]);

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

  return (
    <Card title="Sent history" actions={<button className="btn btn-small btn-ghost" onClick={load}>Refresh</button>}>
      <p className="muted small">
        Every send attempt is recorded in <code>{file || 'backend/data/sent-emails.xlsx'}</code>.
        {' '}“Success” means the Hostinger mail server accepted the email for delivery; it does not confirm the recipient received it.
        {' '}“Failed” emails were not sent. “Uncertain” means the connection dropped mid-send, so the email may or may not have gone out.
        {sender && <> Emails are currently sent from <strong>{sender}</strong>.</>}
      </p>

      <div className="segmented" role="group" aria-label="History view">
        <button aria-pressed={mode === 'attorneys'} onClick={() => setMode('attorneys')}>Attorneys{entries ? ` (${sentAttorneys} emailed)` : ''}</button>
        <button aria-pressed={mode === 'log'} onClick={() => setMode('log')}>All send attempts{entries ? ` (${entries.length})` : ''}</button>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search attorney name or recipient email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search history" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">{mode === 'attorneys' ? 'Any latest status' : 'All statuses'}</option>
          <option value="Success">Success</option>
          <option value="Failed">Failed</option>
          <option value="Uncertain">Uncertain</option>
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
              <tr>
                <th>Attorney</th>
                <th>Registration no.</th>
                <th>Recipient</th>
                <th>City / State</th>
                <th>First sent</th>
                <th>Last sent</th>
                <th>Sends</th>
                <th>Latest status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => {
                const e = g.latest;
                return (
                  <tr key={g.key}>
                    <td>
                      {e.attorneyName || <span className="muted">—</span>}
                      {e.firmName && <span className="sub-line">{e.firmName}</span>}
                    </td>
                    <td>{e.registrationNumber || <span className="muted" title={`Record ID ${e.recordId}`}>—</span>}</td>
                    <td className="email-cell">{e.recipientEmail}</td>
                    <td>{[e.city, e.state].filter(Boolean).join(', ') || <span className="muted">—</span>}</td>
                    <td className="nowrap">{g.firstSent || <span className="muted">—</span>}</td>
                    <td className="nowrap">{g.lastSent || <span className="muted">—</span>}</td>
                    <td>
                      {g.sends ? (
                        <>
                          <span className="badge">First Send</span>
                          {g.resends > 0 && <span className="badge badge-warn">Resent ×{g.resends}</span>}
                        </>
                      ) : (
                        <span className="muted small">Not sent</span>
                      )}
                      {g.failed > 0 && <span className="sub-line">{g.failed} failed attempt{g.failed > 1 ? 's' : ''}</span>}
                    </td>
                    <td>
                      <StatusBadge status={e.status} />
                      {g.pendingSave && <span className="badge badge-warn" title="Will be written to the Excel file when it is no longer open in another program">Not yet in Excel</span>}
                      <span className="sub-line">{e.sentAt}</span>
                    </td>
                  </tr>
                );
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={8} className="empty">{entries.length ? 'No attorneys match your filters.' : 'No emails have been sent yet.'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {entries && mode === 'log' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Sent at</th>
                <th>Attorney</th>
                <th>Registration no.</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Sender</th>
                <th>Status</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => (
                <tr key={`${e.recordId}-${e.sentAt}-${i}`}>
                  <td className="nowrap">{e.sentAt}</td>
                  <td>
                    {e.attorneyName}
                    {(e.firmName || e.city || e.state) && <span className="sub-line">{[e.firmName, [e.city, e.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>}
                  </td>
                  <td>{e.registrationNumber || <span className="muted" title={`Record ID ${e.recordId}`}>—</span>}</td>
                  <td className="email-cell">{e.recipientEmail}</td>
                  <td>{e.subject}</td>
                  <td className="email-cell">{e.senderEmail}</td>
                  <td>
                    <StatusBadge status={e.status} />
                    {e.pendingSave && <span className="badge badge-warn" title="Will be written to the Excel file when it is no longer open in another program">Not yet in Excel</span>}
                  </td>
                  <td>{e.sendType === 'Resend' ? <span className="badge badge-warn">Resend</span> : <span className="badge">First Send</span>}</td>
                </tr>
              ))}
              {!visible.length && (
                <tr>
                  <td colSpan={8} className="empty">{entries.length ? 'No entries match your filters.' : 'No emails have been sent yet.'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {entries && (
        <Pager
          page={current}
          pageCount={pageCount}
          pageSize={PAGE_SIZE}
          matched={list.length}
          total={total}
          noun={mode === 'attorneys' ? 'attorneys' : 'send attempts'}
          onPage={setPage}
        />
      )}
    </Card>
  );
}
