import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatLocal } from '../time.js';
import { useOperator } from './OperatorPicker.jsx';
import { useAutoRefresh } from './SentEmailsPage.jsx';
import { Alert, Card, Modal, Pager, Spinner } from './ui.jsx';

function SentStatus({ r }) {
  const info = r.sentInfo;
  if (r.sentCount) {
    const allUncertain = info && info.uncertain === r.sentCount;
    const label = allUncertain ? 'Uncertain' : info?.lastMethod === 'Manual' ? 'Sent (manual)' : `Sent${r.sentCount > 1 ? ` ×${r.sentCount}` : ''}`;
    const when = info?.lastAtUtc ? formatLocal(info.lastAtUtc) : info?.lastAt || '';
    return (
      <>
        <span className={`badge ${allUncertain ? 'badge-warn' : 'badge-sent'}`}>{label}</span>
        {when && <span className="sub-line">{info?.lastMethod && info.lastMethod !== 'Manual' ? `${info.lastMethod} · ` : ''}{when}{info?.lastOperator ? ` · ${info.lastOperator}` : ''}</span>}
      </>
    );
  }
  if (r.possiblySent) return <span className="badge badge-warn" title="An email to this address is already in the history under a different record.">Possibly sent</span>;
  if (r.sentCount === 0) return <span className="badge">Not sent</span>;
  return null;
}

export default function AllAttorneysPage({ active, appConfig }) {
  const [view, setView] = useState({ q: '', page: 1 });
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [marking, setMarking] = useState(null); // { row, stage: 'confirm' | 'possible', possible, busy, error }
  const operator = useOperator();
  const canMark = Boolean(appConfig?.features?.manualMarking);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/excel/records?q=${encodeURIComponent(view.q)}&page=${view.page}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [view]);
  useAutoRefresh(active, load);

  useEffect(() => {
    if (query === view.q) return undefined;
    const t = setTimeout(() => setView({ q: query, page: 1 }), 250);
    return () => clearTimeout(t);
  }, [query, view.q]);

  const records = data?.records;

  const submitMark = async (confirmPossible) => {
    const r = marking.row;
    setMarking((m) => ({ ...m, busy: true, error: null }));
    try {
      await api('/api/attorneys/mark-sent', {
        method: 'POST',
        json: {
          rowNumber: r.rowNumber,
          note: marking.note || '',
          confirmPossible,
          expected: { workbookVersion: data.workbookVersion, mappingVersion: data.mappingVersion, recordId: r.recordId, recipientEmail: r.recipientEmail || '' },
        },
      });
      setMarking(null);
      setNotice({ type: 'success', text: `${r.attorneyName || r.recipientEmail} is now recorded as sent (manual). It appears in Sent Emails and Sent History.` });
      load();
    } catch (err) {
      if (err.code === 'POSSIBLE_DUPLICATE') return setMarking((m) => ({ ...m, busy: false, stage: 'possible', possible: err.details?.possible || [] }));
      setMarking((m) => ({ ...m, busy: false, error: err.message, stale: err.code === 'STALE_SELECTION' }));
      if (err.code === 'ALREADY_SENT') load();
    }
  };

  if (data && !data.loaded) {
    return <Card title="All attorneys"><p className="muted">No workbook has been uploaded yet. Upload one on the Compose Email page.</p></Card>;
  }

  return (
    <Card title="All attorneys" actions={data && <span className="muted small">{data.fileName} · {data.totalRecords} total</span>}>
      {error && <Alert type="error">{error}</Alert>}
      {notice && <Alert type={notice.type} onClose={() => setNotice(null)}>{notice.text}</Alert>}
      {!canMark && appConfig && <p className="muted small">Marking attorneys as sent requires the shared database (MongoDB). Status is still shown.</p>}
      <input type="search" className="search" placeholder="Search name, registration no., email, firm, city or state" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search attorneys" />
      {data?.historyError && <Alert type="warning">{data.historyError}</Alert>}
      {records && (
        <>
          <div className="table-wrap records-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num col-num">#</th>
                  <th className="col-name">Attorney name</th>
                  <th className="col-reg">Registration no.</th>
                  <th className="col-email">Email</th>
                  <th className="col-status">Sent status</th>
                  {canMark && <th className="col-status">Action</th>}
                </tr>
              </thead>
              <tbody>
                {records.rows.map((r, i) => {
                  const n = r.recordNumber ?? (records.page - 1) * records.pageSize + i + 1;
                  const sent = Boolean(r.sentCount);
                  return (
                    <tr key={r.rowNumber}>
                      <td className="num col-num" title={`Excel row ${r.rowNumber}`}>{n}</td>
                      <td className="col-name">
                        {r.attorneyName || <span className="muted">—</span>}
                        {(r.firmName || r.city || r.state) && <span className="sub-line">{[r.firmName, [r.city, r.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>}
                      </td>
                      <td className="col-reg">{r.registrationNumber || <span className="muted">—</span>}</td>
                      <td className="email-cell col-email">{r.recipientEmail || <span className="muted">—</span>}</td>
                      <td className="col-status"><SentStatus r={r} /></td>
                      {canMark && (
                        <td className="col-status">
                          {!sent && (
                            <button className="btn btn-small btn-ghost" onClick={() => setMarking({ row: r, stage: 'confirm', note: '' })} disabled={!operator} title={operator ? 'Record that this attorney was contacted outside the app' : 'Choose your name at the top of the page first'}>
                              Mark as sent
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!records.rows.length && <tr><td colSpan={canMark ? 6 : 5} className="empty">No attorneys match “{records.query}”.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={records.page} pageCount={records.pageCount} pageSize={records.pageSize} matched={records.matched} total={data.totalRecords} noun="records" onPage={(page) => setView({ q: view.q, page })} />
        </>
      )}

      {marking && (
        <Modal
          title={marking.stage === 'possible' ? 'This address may already have been emailed' : 'Mark as sent (contacted outside the app)?'}
          tone="warning"
          onCancel={() => !marking.busy && setMarking(null)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setMarking(null)} disabled={marking.busy} data-autofocus>Cancel</button>
              {!marking.stale && (
                <button className="btn btn-warning" onClick={() => submitMark(marking.stage === 'possible')} disabled={marking.busy}>
                  {marking.busy ? <><Spinner /> Saving…</> : marking.stage === 'possible' ? 'Mark anyway' : 'Yes, mark as sent'}
                </button>
              )}
              {marking.stale && <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload page</button>}
            </>
          }
        >
          <dl className="details compact">
            <div><dt>Attorney</dt><dd>{marking.row.attorneyName || '—'}</dd></div>
            <div><dt>Registration no.</dt><dd>{marking.row.registrationNumber || '—'}</dd></div>
            <div><dt>Email</dt><dd className="email-cell">{marking.row.recipientEmail || '—'}</dd></div>
            <div><dt>Recorded by</dt><dd>{operator} <span className="muted small">(self-declared)</span></dd></div>
          </dl>
          {marking.stage === 'possible' ? (
            <p className="small">The history already has {marking.possible.length} email(s) to <strong>{marking.row.recipientEmail}</strong> under a different record ({marking.possible.map((p) => p.attorneyName).filter(Boolean).join(', ') || 'unnamed'}). Mark this attorney as sent as well?</p>
          ) : (
            <>
              <p className="small">This records that the attorney was contacted outside the app (sending method “Manual”). The app will then warn before emailing them. It can be corrected later from Sent History (audited, never deleted).</p>
              <label className="field">
                <span className="field-label">Note (optional)</span>
                <input type="text" maxLength={500} value={marking.note} onChange={(e) => setMarking((m) => ({ ...m, note: e.target.value }))} placeholder="e.g. Emailed from Outlook on 12 Nov" />
              </label>
            </>
          )}
          {marking.error && <Alert type="error">{marking.error}</Alert>}
        </Modal>
      )}
    </Card>
  );
}
