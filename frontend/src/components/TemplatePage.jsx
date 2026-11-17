import { useEffect, useMemo, useRef, useState } from 'react';
import { api, composeBody, renderPlaceholders } from '../api.js';
import { Alert, Card } from './ui.jsx';

const FIELDS = [
  { key: 'subject', label: 'Subject', rows: 1 },
  { key: 'greeting', label: 'Greeting', rows: 2 },
  { key: 'mainMessage', label: 'Main message', rows: 8 },
  { key: 'closing', label: 'Closing', rows: 2 },
  { key: 'signature', label: 'Signature', rows: 3 },
];

export default function TemplatePage({ active }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [placeholders, setPlaceholders] = useState([]);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAllPlaceholders, setShowAllPlaceholders] = useState(false);
  const lastFocus = useRef({ key: 'mainMessage', start: null, end: null });
  const inputs = useRef({});

  const dirty = Boolean(form && saved && FIELDS.some((f) => form[f.key] !== saved[f.key]));
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Reload when the page is opened (placeholders depend on the uploaded workbook),
  // but never overwrite unsaved edits.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api('/api/template')
      .then((data) => {
        if (cancelled) return;
        setPlaceholders(data.placeholders);
        setDefaults(data.defaultTemplate);
        setSaved(data.template);
        setForm((f) => (f && dirtyRef.current ? f : data.template));
        if (data.warning) setMessage({ type: 'warning', text: data.warning });
      })
      .catch((err) => !cancelled && setMessage({ type: 'error', text: err.message }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const commonPlaceholders = useMemo(() => placeholders.filter((p) => p.common), [placeholders]);
  const otherCount = placeholders.length - commonPlaceholders.length;

  const known = useMemo(() => new Set(placeholders.map((p) => p.key)), [placeholders]);
  const unknownUsed = useMemo(() => {
    if (!form) return [];
    const found = new Set();
    for (const f of FIELDS) {
      for (const m of String(form[f.key]).matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) if (!known.has(m[1])) found.add(m[1]);
    }
    return [...found];
  }, [form, known]);

  const sampleValues = useMemo(() => Object.fromEntries(placeholders.map((p) => [p.key, `[${p.label}]`])), [placeholders]);

  if (!form) {
    return <Card title="Template settings">{message ? <Alert type={message.type}>{message.text}</Alert> : <p className="muted">Loading template…</p>}</Card>;
  }

  const update = (key, value) => {
    setForm({ ...form, [key]: key === 'subject' ? value.replace(/[\r\n]/g, ' ') : value });
    setMessage(null);
  };

  const insertPlaceholder = (key) => {
    const token = `{{${key}}}`;
    const { key: field, start, end } = lastFocus.current;
    const value = form[field] ?? '';
    const s = start ?? value.length;
    const e = end ?? value.length;
    const next = value.slice(0, s) + token + value.slice(e);
    update(field, next);
    requestAnimationFrame(() => {
      const el = inputs.current[field];
      if (el) {
        el.focus();
        el.setSelectionRange(s + token.length, s + token.length);
        lastFocus.current = { key: field, start: s + token.length, end: s + token.length };
      }
    });
  };

  const trackFocus = (key) => (e) => {
    lastFocus.current = { key, start: e.target.selectionStart, end: e.target.selectionEnd };
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await api('/api/template', { method: 'PUT', json: { template: form } });
      setSaved(data.template);
      setForm(data.template);
      setMessage({ type: 'success', text: 'Template saved. New emails will use it (re-select an attorney to refresh an open email).' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="template-grid">
      <Card title="Email template" actions={dirty && <span className="badge badge-warn">Unsaved changes</span>}>
        <p className="muted small">Write the email once using placeholders like <code>{'{{attorneyName}}'}</code>. They are replaced with each attorney’s details from the Excel workbook.</p>
        {FIELDS.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}</span>
            {f.rows === 1 ? (
              <input
                ref={(el) => (inputs.current[f.key] = el)}
                type="text"
                maxLength={255}
                value={form[f.key]}
                onChange={(e) => update(f.key, e.target.value)}
                onSelect={trackFocus(f.key)}
                onFocus={trackFocus(f.key)}
              />
            ) : (
              <textarea
                ref={(el) => (inputs.current[f.key] = el)}
                rows={f.rows}
                value={form[f.key]}
                onChange={(e) => update(f.key, e.target.value)}
                onSelect={trackFocus(f.key)}
                onFocus={trackFocus(f.key)}
              />
            )}
          </label>
        ))}
        {unknownUsed.length > 0 && (
          <Alert type="warning">
            Not available in the current workbook: {unknownUsed.map((k) => `{{${k}}}`).join(', ')}. These will appear unchanged in emails unless the uploaded workbook has a matching column.
          </Alert>
        )}
        {message && <Alert type={message.type} onClose={() => setMessage(null)}>{message.text}</Alert>}
        <div className="row-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save Template'}</button>
          <button className="btn btn-ghost" onClick={() => setForm(saved)} disabled={!dirty || busy}>Discard changes</button>
          <button
            className="btn btn-ghost"
            onClick={() => window.confirm('Replace the form with the original example template? (Nothing is saved until you click Save Template.)') && setForm({ ...defaults })}
            disabled={busy}
          >
            Restore example
          </button>
        </div>
      </Card>

      <div className="template-side">
        <Card title="Available placeholders">
          <p className="muted small">Click a placeholder to insert it where your cursor is.</p>
          <ul className="placeholder-list">
            {(showAllPlaceholders ? placeholders : commonPlaceholders).map((p) => (
              <li key={p.key}>
                <button className="placeholder-btn" onClick={() => insertPlaceholder(p.key)} title={`Insert {{${p.key}}}`}>
                  <code>{`{{${p.key}}}`}</code>
                  <span className="muted small">{p.source === 'column' ? `Column “${p.label}”` : p.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {otherCount > 0 ? (
            <button
              className="btn btn-small btn-ghost placeholder-toggle"
              onClick={() => setShowAllPlaceholders((v) => !v)}
              aria-expanded={showAllPlaceholders}
            >
              {showAllPlaceholders ? 'Show Less' : `Show All Placeholders (${otherCount} more)`}
            </button>
          ) : (
            <p className="muted small">Upload a workbook on the Compose Email page to also use any of its other columns.</p>
          )}
        </Card>
        <Card title="Preview">
          <div className="preview">
            <div className="preview-head">
              <div><span>Subject</span><strong>{renderPlaceholders(form.subject, sampleValues)}</strong></div>
            </div>
            <div className="preview-body">{renderPlaceholders(composeBody(form), sampleValues)}</div>
          </div>
        </Card>
      </div>
    </div>
  );
}
