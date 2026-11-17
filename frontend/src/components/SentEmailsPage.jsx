import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { userTimeZone, whenOf } from '../time.js';
import { Alert, Card, Pager } from './ui.jsx';

const REFRESH_MS = 30000;
const PAGE_SIZE = 20;

/** Refresh `load` every 30 s while the page is visible and active, so team members see each other's work. */
export function useAutoRefresh(active, load) {
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, load]);
}

export function MethodBadge({ method }) {
  const m = method || 'Unknown';
  const cls = m === 'Manual' ? 'badge-warn' : m === 'Unknown' ? '' : 'badge-sent';
  const title = m === 'Unknown' ? 'Recorded before the sending method was tracked' : m === 'Manual' ? 'Contacted outside the app and marked as sent' : `Sent by the app via ${m}`;
  return <span className={`badge ${cls}`} title={title}>{m === 'Unknown' ? 'Not recorded' : m}</span>;
}

function Stats({ stats }) {
  if (!stats) return null;
  const tiles = [
    ['Total emails sent', stats.totalSent],
    ['Sent today', stats.today],
    ['Sent by Resend', stats.resend],
    ['Marked as sent manually', stats.manual],
    ...(stats.smtp ? [['Sent by SMTP', stats.smtp]] : []),
    ['Failed', stats.failed],
    ['Uncertain', stats.uncertain],
  ];
  return (
    <>
      <div className="stat-grid">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>
      <div className="stat-columns">
        <div>
          <h3 className="sub-heading">Activity by team member <span className="muted small">(self-declared)</span></h3>
          <table className="table compact-table">
            <thead><tr><th>Operator</th><th className="num">Sent</th><th className="num">Manual</th><th className="num">Failed</th><th className="num">Uncertain</th></tr></thead>
            <tbody>
              {stats.byOperator.map((o) => (
                <tr key={o.operator}><td>{o.operator}</td><td className="num">{o.sent}</td><td className="num">{o.manual}</td><td className="num">{o.failed}</td><td className="num">{o.uncertain}</td></tr>
              ))}
              {!stats.byOperator.length && <tr><td colSpan={5} className="empty">Nothing recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="sub-heading">Daily sending count <span className="muted small">({stats.timeZone})</span></h3>
          <table className="table compact-table">
            <thead><tr><th>Date</th><th className="num">Emails</th></tr></thead>
            <tbody>
              {stats.daily.slice(0, 7).map((d) => (
                <tr key={d.date}><td>{d.date}</td><td className="num">{d.count}</td></tr>
              ))}
              {!stats.daily.length && <tr><td colSpan={2} className="empty">No emails sent yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {stats.inProgress?.length > 0 && (
        <Alert type="info">
          Being sent right now: {stats.inProgress.map((p) => p.attorneyName || p.recipientEmail).join(', ')}. If a send was interrupted, it is recorded as “Uncertain” automatically after 10 minutes.
        </Alert>
      )}
    </>
  );
}

export default function SentEmailsPage({ active }) {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ q: '', method: '', operator: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    const tz = encodeURIComponent(userTimeZone());
    const qs = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE), tz: userTimeZone() }).toString();
    try {
      const [list, st] = await Promise.all([api(`/api/sent?${qs}`), api(`/api/stats?tz=${tz}`)]);
      setData(list);
      setStats(st);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err.message);
    }
  }, [filters, page]);
  useAutoRefresh(active, load);

  const set = (k) => (e) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <>
      <Card title="Overview" actions={<span className="muted small">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ''} · refreshes every 30 s</span>}>
        {error && <Alert type="error">{error}</Alert>}
        <Stats stats={stats} />
      </Card>
      <Card title="Sent emails" actions={<button className="btn btn-small btn-ghost" onClick={load}>Refresh</button>}>
        <p className="muted small">Every email the email service accepted, and every attorney marked as sent manually, for the whole team. Times are shown in your time zone ({userTimeZone()}).</p>
        <div className="filters">
          <input type="search" placeholder="Search attorney name, registration no. or email" value={filters.q} onChange={set('q')} aria-label="Search sent emails" />
          <select value={filters.method} onChange={set('method')} aria-label="Sending method">
            <option value="">All methods</option>
            {(data?.methods || []).map((m) => <option key={m} value={m}>{m === 'Unknown' ? 'Not recorded' : m}</option>)}
          </select>
          <select value={filters.operator} onChange={set('operator')} aria-label="Operator">
            <option value="">All operators</option>
            {(data?.operators || []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <label className="inline-field">From <input type="date" value={filters.from} onChange={set('from')} /></label>
          <label className="inline-field">To <input type="date" value={filters.to} onChange={set('to')} /></label>
          {anyFilter && <button className="btn btn-small btn-ghost" onClick={() => { setFilters({ q: '', method: '', operator: '', from: '', to: '' }); setPage(1); }}>Clear filters</button>}
        </div>
        {data && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Date and time</th><th>Attorney</th><th>Registration no.</th><th>Email</th><th>Method</th><th>Operator</th></tr>
                </thead>
                <tbody>
                  {data.items.map((e, i) => (
                    <tr key={e.id || `${e.recordId}-${e.sentAt}-${i}`}>
                      <td className="nowrap">{whenOf(e)}</td>
                      <td>{e.attorneyName || <span className="muted">—</span>}{e.firmName && <span className="sub-line">{e.firmName}</span>}</td>
                      <td>{e.registrationNumber || <span className="muted">—</span>}</td>
                      <td className="email-cell">{e.recipientEmail}</td>
                      <td><MethodBadge method={e.sendMethod} />{e.note && <span className="sub-line" title={e.note}>{e.note}</span>}</td>
                      <td>{e.operator || <span className="muted" title="Not recorded (before operators were tracked)">—</span>}</td>
                    </tr>
                  ))}
                  {!data.items.length && <tr><td colSpan={6} className="empty">{anyFilter ? 'No sent emails match your filters.' : 'No emails have been sent yet.'}</td></tr>}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageCount={data.pageCount} pageSize={data.pageSize} matched={data.total} noun="sent emails" onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
