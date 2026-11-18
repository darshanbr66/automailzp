import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { whenOf } from '../time.js';
import { Alert, Card, Modal, Pager, Spinner, StatusBadge, Toast } from './ui.jsx';
import { clipboardText, copiedMessage, labelFor, manualCopyMessage, queuedCopy, sessionSentNames } from '../sentNames.js';

export default function ComposePage({ smtp, onSmtpChanged }) {
  const [workbook, setWorkbook] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null); // preview data for the selected row
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState({ q: '', page: 1 }); // search + page of the attorney list
  const [loadingRecords, setLoadingRecords] = useState(false);
  const seq = useRef(0);
  const [toast, setToast] = useState(null);
  const closeToast = useCallback(() => setToast(null), []);

  // Called ONLY after the server confirmed the email was accepted by the email
  // service. Adds the attorney to this browser's cumulative list and copies it.
  const onConfirmedSend = useCallback(async (who) => {
    const list = sessionSentNames.add(labelFor(who));
    if (!list.length) return;
    const copied = await queuedCopy(clipboardText(list));
    setToast(copied ? { type: 'success', text: copiedMessage(list) } : { type: 'warning', text: manualCopyMessage(list), list });
  }, []);

  const copyManually = async () => {
    const list = sessionSentNames.list();
    if (await queuedCopy(clipboardText(list))) setToast({ type: 'success', text: copiedMessage(list) });
  };

  // Only one page (10 records) is ever fetched; search runs on the server over the whole workbook.
  const loadRecords = useCallback(async ({ q, page }) => {
    const mine = (seq.current += 1);
    setLoadingRecords(true);
    try {
      const data = await api(`/api/excel/records?q=${encodeURIComponent(q)}&page=${page}`);
      if (mine !== seq.current) return; // a newer request has been made
      setWorkbook(data);
      setLoadError(null);
    } catch (err) {
      if (mine === seq.current) setLoadError(err.message);
    } finally {
      if (mine === seq.current) setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    loadRecords(view);
  }, [loadRecords, view]);

  const dirty = selected && (draft.subject !== selected.subject || draft.body !== selected.body);

  const selectRow = async (rowNumber, listNumber) => {
    // Re-select the same row only if the list now belongs to a different workbook/mapping.
    const sameVersion = selected?.workbookVersion === workbook?.workbookVersion && selected?.mappingVersion === workbook?.mappingVersion;
    if (selected?.rowNumber === rowNumber && sameVersion) return;
    if (dirty && !window.confirm('You have edited this email. Discard your changes and select another attorney?')) return;
    setNotice(null);
    try {
      // Send the versions of the list that was clicked: the server refuses if another
      // team member has replaced the workbook or changed the mapping since.
      const preview = await api('/api/preview', {
        method: 'POST',
        json: { rowNumber, workbookVersion: workbook?.workbookVersion, mappingVersion: workbook?.mappingVersion },
      });
      setSelected({ ...preview, recordNumber: preview.recordNumber ?? listNumber });
      setDraft({ subject: preview.subject, body: preview.body });
    } catch (err) {
      setNotice({ type: 'error', text: err.message, stale: err.code === 'STALE_SELECTION' });
    }
  };

  const onWorkbookChanged = (data) => {
    seq.current += 1; // ignore any list request still in flight
    setWorkbook(data);
    setSelected(null);
    setDraft({ subject: '', body: '' });
    setView((v) => (v.q || v.page !== 1 ? { q: '', page: 1 } : v));
  };

  return (
    <div className="compose-grid">
      <div className="compose-left">
        {loadError && <Alert type="error">{loadError}</Alert>}
        <UploadCard workbook={workbook} onUploaded={onWorkbookChanged} />
        {workbook?.loaded && <MappingCard workbook={workbook} onSaved={onWorkbookChanged} />}
        {workbook?.loaded && (
          <RecordsCard
            workbook={workbook}
            view={view}
            setView={setView}
            busy={loadingRecords}
            selectedRow={selected?.rowNumber}
            onSelect={selectRow}
          />
        )}
      </div>
      <div className="compose-right">
        {notice && (
          <Alert type={notice.type} onClose={() => setNotice(null)}>
            {notice.text}
            {notice.stale && <ReloadButton />}
          </Alert>
        )}
        <EmailCard
          smtp={smtp}
          selected={selected}
          draft={draft}
          setDraft={setDraft}
          onReset={() => selected && setDraft({ subject: selected.subject, body: selected.body })}
          onSent={() => loadRecords(view)}
          onConfirmedSend={onConfirmedSend}
          onSmtpChanged={onSmtpChanged}
        />
      </div>
      <Toast toast={toast} onClose={closeToast}>
        {toast?.list && (
          <>
            <textarea readOnly rows={Math.min(8, toast.list.length + 1)} value={clipboardText(toast.list)} onFocus={(e) => e.target.select()} aria-label="Sent attorney names" />
            <div className="row-actions">
              <button className="btn btn-small btn-primary" onClick={copyManually}>Copy names</button>
            </div>
          </>
        )}
      </Toast>
    </div>
  );
}

// ---------------------------------------------------------------------------
function UploadCard({ workbook, onUploaded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const upload = async (file) => {
    if (!file) return;
    setError(null);
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setError('Please choose an Excel workbook (.xlsx or .xls).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('The file is larger than 10 MB.');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      onUploaded(await api('/api/excel/upload', { method: 'POST', form }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Card step="1" title="Attorney workbook">
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files?.[0]);
        }}
      >
        <input ref={inputRef} type="file" accept=".xlsx,.xls" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? <><Spinner /> Reading workbook…</> : workbook?.loaded ? 'Upload a different workbook' : 'Choose Excel file'}
        </button>
        <span className="muted">or drag and drop a .xlsx / .xls file here</span>
      </div>
      {workbook?.loaded && (
        <p className="file-info">
          <strong>{workbook.fileName}</strong> · sheet “{workbook.sheetName}” · {workbook.totalRecords} record{workbook.totalRecords === 1 ? '' : 's'}
        </p>
      )}
      {!workbook?.loaded && <p className="muted small">The first worksheet is used. Its first row must contain the column headings. The data stays on this computer.</p>}
      {error && <Alert type="error">{error}</Alert>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function MappingCard({ workbook, onSaved }) {
  const [mapping, setMapping] = useState(workbook.mapping);
  const [open, setOpen] = useState(workbook.mappingErrors.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMapping(workbook.mapping);
    if (workbook.mappingErrors.length) setOpen(true);
  }, [workbook.mapping, workbook.mappingErrors.length]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api('/api/mapping', { method: 'PUT', json: { mapping } });
      onSaved(data);
      setSaved(true);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const valid = workbook.mappingErrors.length === 0;

  return (
    <Card
      step="2"
      title="Column mapping"
      actions={!open && <button className="btn btn-small btn-ghost" onClick={() => setOpen(true)}>Edit mapping</button>}
    >
      {!open ? (
        <div className="mapping-summary">
          {workbook.fields.filter((f) => workbook.mapping[f.key]).map((f) => (
            <span key={f.key} className="chip">
              {f.label}: <strong>{workbook.mapping[f.key]}</strong>
            </span>
          ))}
          {saved && <span className="success-text">Saved</span>}
        </div>
      ) : (
        <>
          <p className="muted small">Tell the app which Excel column holds each piece of information. This is remembered for next time.</p>
          <div className="mapping-grid">
            {workbook.fields.map((f) => (
              <label key={f.key} className="field">
                <span className="field-label">
                  {f.label} {f.required ? <span className="req">*</span> : <span className="muted">(optional)</span>}
                </span>
                <select value={mapping[f.key] || ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                  <option value="">— Not used —</option>
                  {workbook.headers.map((h) => (
                    <option key={h.name} value={h.name}>{h.name}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="muted small">
            When an attorney has a registration number, it is used to detect duplicate emails. Without one, the app identifies the attorney from the name, email address, firm, city and state instead.
          </p>
          {!valid && !error && <Alert type="warning">{workbook.mappingErrors.join(' ')}</Alert>}
          {error && <Alert type="error">{error}</Alert>}
          <div className="row-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save mapping'}</button>
            {valid && <button className="btn btn-ghost" onClick={() => { setMapping(workbook.mapping); setOpen(false); setError(null); }}>Cancel</button>}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function RecordsCard({ workbook, view, setView, busy, selectedRow, onSelect }) {
  const [query, setQuery] = useState(view.q);
  const records = workbook.records;

  useEffect(() => setQuery(view.q), [view.q]);

  // Search the whole workbook on the server, shortly after typing stops.
  useEffect(() => {
    if (query === view.q) return undefined;
    const t = setTimeout(() => setView({ q: query, page: 1 }), 250);
    return () => clearTimeout(t);
  }, [query, view.q, setView]);

  if (!records) {
    return (
      <Card step="3" title="Select an attorney">
        <p className="muted">Complete the column mapping above to see the attorney list.</p>
      </Card>
    );
  }

  return (
    <Card step="3" title="Select an attorney" actions={<span className="muted small">{workbook.totalRecords} total</span>}>
      <input
        type="search"
        className="search"
        placeholder="Search name, registration no., email, firm, city or state"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search attorneys"
      />
      {workbook.historyError && <Alert type="warning">{workbook.historyError}</Alert>}
      <div className="table-wrap records-table-wrap">
        <table className="table selectable">
          <thead>
            <tr>
              <th className="num col-num">#</th>
              <th className="col-name">Attorney name</th>
              <th className="col-reg">Registration no.</th>
              <th className="col-email">Email</th>
              <th className="col-status">Status</th>
            </tr>
          </thead>
          <tbody>
            {records.rows.map((r, i) => {
              // Position in the workbook list (1..N), continuing across pages. Never the Excel row,
              // and never used to identify the record. Falls back to the position on this page of
              // results if the backend did not supply it.
              const n = r.recordNumber ?? (records.page - 1) * records.pageSize + i + 1;
              return (
              <tr
                key={r.rowNumber}
                className={r.rowNumber === selectedRow ? 'selected' : ''}
                onClick={() => onSelect(r.rowNumber, n)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(r.rowNumber, n))}
                tabIndex={0}
              >
                <td className="num col-num" title={`Excel row ${r.rowNumber}`}>{n}</td>
                <td className="col-name">
                  {r.attorneyName || <span className="muted">—</span>}
                  {(r.firmName || r.city || r.state) && <span className="sub-line">{[r.firmName, [r.city, r.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>}
                </td>
                <td className="col-reg">{r.registrationNumber || <span className="muted">—</span>}</td>
                <td className="email-cell col-email">{r.recipientEmail || <span className="muted">—</span>}</td>
                <td className="col-status">
                  {r.problems?.length ? (
                    <span className="badge badge-warn" title={r.problems.join(', ')}>{r.problems[0]}</span>
                  ) : r.sentCount ? (
                    <span className="badge badge-sent">{r.sentInfo?.lastMethod === 'Manual' ? 'Sent (manual)' : `Sent${r.sentCount > 1 ? ` ×${r.sentCount}` : ''}`}</span>
                  ) : r.possiblySent ? (
                    <span className="badge badge-warn" title="An email to this address is already in the sending history under a different record.">Possibly sent</span>
                  ) : r.sentCount === 0 ? (
                    <span className="badge">Not sent</span>
                  ) : null}
                </td>
              </tr>
              );
            })}
            {!records.rows.length && (
              <tr>
                <td colSpan={5} className="empty">No attorneys match “{records.query}”.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager
        page={records.page}
        pageCount={records.pageCount}
        pageSize={records.pageSize}
        matched={records.matched}
        total={workbook.totalRecords}
        noun="records"
        busy={busy}
        onPage={(page) => setView({ q: view.q, page })}
      />
      <p className="muted small">Click a row to compose an email.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function EmailCard({ smtp, selected, draft, setDraft, onReset, onSent, onConfirmedSend, onSmtpChanged }) {
  const [stage, setStage] = useState('idle'); // idle | checking | duplicate | possible | uncertain | confirmResend | sending
  const [previous, setPrevious] = useState([]);
  const [uncertain, setUncertain] = useState([]);
  const [dupKind, setDupKind] = useState('exact'); // exact | possible
  const [result, setResult] = useState(null);
  const requestIdRef = useRef(null);

  // A new attorney means a new send request.
  useEffect(() => {
    requestIdRef.current = null;
    setResult(null);
    setStage('idle');
  }, [selected?.rowNumber]);

  if (!selected) {
    return (
      <Card step="4" title="Compose email">
        <div className="placeholder-panel">
          <p>Upload the attorney workbook and select an attorney from the list.</p>
          <p className="muted small">The email is filled in from your template. You can edit it before sending. Nothing is sent until you click <strong>Send Email</strong>.</p>
        </div>
      </Card>
    );
  }

  const blockingProblems = selected.problems.filter((p) => p !== 'Missing attorney name');
  const subjectOk = draft.subject.trim().length > 0 && draft.subject.length <= 255;
  const bodyOk = draft.body.trim().length > 0;
  const busy = stage === 'checking' || stage === 'sending';
  const canSend = smtp?.configured && !blockingProblems.length && subjectOk && bodyOk && !busy;

  const showDuplicate = (kind, list) => {
    setDupKind(kind);
    setPrevious(list || []);
    setStage(kind === 'exact' ? 'duplicate' : 'possible');
  };

  // What the user selected and previewed. The server only sends if this is still
  // exactly the same attorney and recipient in the current workbook and mapping.
  const selection = () => ({
    workbookVersion: selected.workbookVersion,
    mappingVersion: selected.mappingVersion,
    recordId: selected.recordId,
    recipientEmail: selected.recipientEmail,
  });

  // An earlier send with an unknown outcome: it is never resent until a team
  // member has checked the provider and recorded the result in Sent History.
  const showUncertain = (list) => {
    setUncertain(list || []);
    setStage('uncertain');
  };

  const handleError = (err) => {
    if (err.code === 'UNCERTAIN_UNRESOLVED') {
      requestIdRef.current = null;
      onSent(); // refresh the lists: the record may have just been created by recovery
      return showUncertain(err.details?.uncertain);
    }
    if (err.code === 'ALREADY_SENT') return showDuplicate('exact', err.details?.previous);
    if (err.code === 'POSSIBLE_DUPLICATE') return showDuplicate('possible', err.details?.possible);
    if (['SMTP_AUTH_FAILED', 'SMTP_NOT_CONFIGURED'].includes(err.code)) onSmtpChanged();
    // Keep the request ID only when we don't know whether the server finished,
    // so a retry can never send twice.
    if (err.code !== 'BACKEND_UNAVAILABLE') requestIdRef.current = null;
    setResult({ type: 'error', text: err.message, stale: err.code === 'STALE_SELECTION' });
    setStage('idle');
    onSent(); // failed and uncertain attempts are recorded in the history too
  };

  const send = async (confirmResend) => {
    setStage('sending');
    setResult(null);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const res = await api('/api/send', {
        method: 'POST',
        json: { rowNumber: selected.rowNumber, subject: draft.subject, body: draft.body, confirmResend, requestId: requestIdRef.current, expected: selection() },
      });
      requestIdRef.current = null;
      // Short confirmation only; the full details are recorded in Sent History.
      setResult({ type: 'success', text: 'Email sent successfully!', warning: res.historySaved ? null : res.historyWarning });
      setStage('idle');
      onSent();
      // Reached only when the server confirmed acceptance (failures, uncertain,
      // duplicate, stale and in-progress replies all go to the catch below).
      if (res?.accepted === true) onConfirmedSend({ attorneyName: selected.attorneyName, recipientEmail: selected.recipientEmail });
    } catch (err) {
      handleError(err);
    }
  };

  const startSend = async () => {
    if (!canSend) return;
    setStage('checking');
    setResult(null);
    try {
      const check = await api('/api/history/check', { method: 'POST', json: { rowNumber: selected.rowNumber, expected: selection() } });
      if (check.uncertainUnresolved) return showUncertain(check.uncertain);
      if (check.alreadySent) return showDuplicate('exact', check.previous);
      if (check.possibleDuplicate) return showDuplicate('possible', check.possible);
      await send(false);
    } catch (err) {
      handleError(err);
    }
  };

  const cancelSend = () => setStage('idle');
  const location = [selected.city, selected.state].filter(Boolean).join(', ');

  return (
    <Card step="4" title="Compose email" className="email-card">
      <dl className="details">
        <div><dt>Attorney</dt><dd>{selected.attorneyName || <span className="muted">(no name)</span>}</dd></div>
        <div><dt>Registration no.</dt><dd>{selected.registrationNumber || <span className="muted">—</span>}</dd></div>
        <div><dt>Recipient</dt><dd className="email-cell">{selected.recipientEmail || <span className="error-text">Missing</span>}</dd></div>
        {selected.firmName && <div><dt>Firm</dt><dd>{selected.firmName}</dd></div>}
        {location && <div><dt>Location</dt><dd>{location}</dd></div>}
        <div><dt>Record no.</dt><dd title={`Excel row ${selected.rowNumber}`}>{selected.recordNumber}</dd></div>
        <div>
          <dt>Record ID</dt>
          <dd className="mono" title={selected.idType === 'fallback' ? 'Derived from name, email, firm, city and state because there is no registration number. Used to detect duplicates.' : 'The registration number. Used to detect duplicates.'}>
            {selected.recordId}
          </dd>
        </div>
      </dl>

      {blockingProblems.length > 0 && (
        <Alert type="error">This attorney cannot be emailed yet: {blockingProblems.join(', ').toLowerCase()}. Please correct the Excel workbook and upload it again.</Alert>
      )}
      {selected.warnings.map((w) => <Alert key={w} type="warning">{w}</Alert>)}

      <label className="field">
        <span className="field-label">Subject</span>
        <input type="text" value={draft.subject} maxLength={255} onChange={(e) => setDraft({ ...draft, subject: e.target.value.replace(/[\r\n]/g, ' ') })} />
        {!subjectOk && <span className="error-text small">Please enter a subject.</span>}
      </label>
      <label className="field">
        <span className="field-label">Email body</span>
        <textarea rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        {!bodyOk && <span className="error-text small">Please enter the email body.</span>}
      </label>
      <div className="row-actions">
        <button className="btn btn-ghost btn-small" onClick={onReset} disabled={draft.subject === selected.subject && draft.body === selected.body}>
          Reset to template
        </button>
      </div>

      <div className="preview">
        <div className="preview-title">Preview</div>
        <div className="preview-head">
          <div><span>From</span>{smtp?.configured ? smtp.from : <em className="muted">Email sending is not configured</em>}</div>
          <div><span>To</span>{selected.recipientEmail}</div>
          <div><span>Subject</span><strong>{draft.subject}</strong></div>
        </div>
        <div className="preview-body">{draft.body}</div>
      </div>

      {result?.type === 'success' && (
        <Alert type="success" onClose={() => setResult(null)}>
          <div className="success-line" title="Accepted by the email service for delivery">
            <span className="check-icon" aria-hidden="true">✓</span>
            {result.text}
          </div>
        </Alert>
      )}
      {result?.warning && <Alert type="warning">{result.warning}</Alert>}
      {result?.type === 'error' && (
        <Alert type="error" onClose={() => setResult(null)}>
          {result.text}
          {result.stale && <ReloadButton />}
        </Alert>
      )}

      <div className="send-bar">
        {!smtp?.configured && <span className="muted small">Email sending is not configured. See the message at the top of the page.</span>}
        <button className="btn btn-primary btn-large" onClick={startSend} disabled={!canSend}>
          {stage === 'checking' ? <><Spinner /> Checking history…</> : stage === 'sending' ? <><Spinner /> Sending…</> : 'Send Email'}
        </button>
      </div>

      {(stage === 'duplicate' || stage === 'possible') && (
        <Modal
          title={stage === 'duplicate' ? 'This attorney has already received an email' : 'This attorney may already have received an email'}
          tone="warning"
          onCancel={cancelSend}
          actions={
            <>
              <button className="btn btn-ghost" onClick={cancelSend} data-autofocus>Cancel</button>
              <button className="btn btn-warning" onClick={() => setStage('confirmResend')}>{stage === 'duplicate' ? 'Send Again' : 'Send Anyway'}</button>
            </>
          }
        >
          {stage === 'possible' && (
            <p className="small">
              This attorney has no registration number, so they can’t be matched exactly. The history below has earlier emails to the same address
              (the name, firm, city or state may have changed in the workbook). Check these before sending.
            </p>
          )}
          <dl className="details compact">
            <div><dt>Attorney</dt><dd>{selected.attorneyName}</dd></div>
            <div><dt>{selected.registrationNumber ? 'Registration no.' : 'Record ID'}</dt><dd>{selected.registrationNumber || selected.recordId}</dd></div>
          </dl>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Sent at</th>{stage === 'possible' && <th>Attorney</th>}<th>Recipient</th><th>Status</th><th>Type</th></tr>
              </thead>
              <tbody>
                {previous.map((p, i) => (
                  <tr key={i}>
                    <td className="nowrap">{whenOf(p)}{p.sendMethod === 'Manual' && <span className="sub-line">Marked as sent manually{p.operator ? ` by ${p.operator}` : ''}</span>}</td>
                    {stage === 'possible' && <td>{p.attorneyName}{p.firmName && <span className="sub-line">{p.firmName}</span>}</td>}
                    <td className="email-cell">{p.recipientEmail}</td>
                    <td><StatusBadge status={p.status} />{p.pendingSave ? ' (not yet in Excel)' : ''}</td>
                    <td>{p.sendType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {stage === 'uncertain' && (
        <Modal
          title="The last email to this attorney has an unknown outcome"
          tone="warning"
          onCancel={cancelSend}
          actions={<button className="btn btn-primary" onClick={cancelSend} data-autofocus>Close</button>}
        >
          <p>
            An earlier send to <strong>{selected.recipientEmail}</strong> is recorded as <strong>Uncertain</strong>: the connection or the server failed while it was
            being sent, so it may or may not have arrived. To avoid a duplicate, it is <strong>not sent again</strong> until someone has checked.
          </p>
          <ol className="small">
            <li>Look the email up at the provider: the <strong>Resend dashboard → Emails</strong> (search the recipient), or the <strong>Sent</strong> folder in Hostinger Webmail.</li>
            <li>Open <strong>Sent History → Send log</strong>, click <strong>Correct…</strong> on that entry and choose “It was sent” or “It was not sent”, with a short reason.</li>
            <li>If it was not sent, come back here and send it.</li>
          </ol>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Sent at</th><th>Recipient</th><th>Method</th><th>By</th></tr></thead>
              <tbody>
                {uncertain.map((p, i) => (
                  <tr key={p.id || i}>
                    <td className="nowrap">{whenOf(p)}</td>
                    <td className="email-cell">{p.recipientEmail}</td>
                    <td>{p.sendMethod || '—'}</td>
                    <td>{p.operator || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {stage === 'confirmResend' && (
        <Modal
          title="Send the email again?"
          tone="warning"
          onCancel={cancelSend}
          actions={
            <>
              <button className="btn btn-ghost" onClick={cancelSend} data-autofocus>Cancel</button>
              <button className="btn btn-warning" onClick={() => send(true)}>Yes, send {dupKind === 'exact' ? 'again' : 'anyway'}</button>
            </>
          }
        >
          <p>
            You are about to send another email to <strong>{selected.recipientEmail}</strong> ({selected.attorneyName || 'no name'}).
            {dupKind === 'exact' ? <> It will be recorded as a <strong>Resend</strong> in the history.</> : ' It will be recorded in the history under this record.'}
          </p>
        </Modal>
      )}
    </Card>
  );
}

/** Offered when another team member replaced the workbook or changed the mapping. */
function ReloadButton() {
  return (
    <div className="row-actions">
      <button className="btn btn-small btn-primary" onClick={() => window.location.reload()}>Reload page</button>
    </div>
  );
}
