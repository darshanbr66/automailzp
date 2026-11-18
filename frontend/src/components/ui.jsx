import { useEffect, useRef } from 'react';

export function Alert({ type = 'info', children, onClose }) {
  return (
    <div className={`alert alert-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <div className="alert-body">{children}</div>
      {onClose && (
        <button className="alert-close" onClick={onClose} aria-label="Dismiss">×</button>
      )}
    </div>
  );
}

export function Card({ title, step, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {step && <span className="step">{step}</span>}
            {title}
          </h2>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Accessible modal dialog. Escape and clicking the backdrop call onCancel. */
export function Modal({ title, children, actions, onCancel, tone }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('[data-autofocus]')?.focus();
    const onKey = (e) => e.key === 'Escape' && onCancel?.();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel?.()}>
      <div className={`modal ${tone ? `modal-${tone}` : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <h3 id="modal-title">{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** "Showing 11–20 of 57" with Previous / Next buttons. */
export function Pager({ page, pageCount, pageSize, matched, total, noun = 'records', onPage, busy }) {
  const first = matched ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, matched);
  return (
    <div className="pager">
      <span className="muted small">
        {matched ? `Showing ${first}–${last} of ${matched}` : 'No matches'}
        {total !== undefined && matched !== total ? ` (filtered from ${total} ${noun})` : ` ${noun}`}
      </span>
      {pageCount > 1 && (
        <span className="pager-controls">
          <button className="btn btn-small btn-ghost" onClick={() => onPage(page - 1)} disabled={busy || page <= 1}>‹ Previous</button>
          <span className="small">Page {page} of {pageCount}</span>
          <button className="btn btn-small btn-ghost" onClick={() => onPage(page + 1)} disabled={busy || page >= pageCount}>Next ›</button>
        </span>
      )}
    </div>
  );
}

export function StatusBadge({ status }) {
  const cls = status === 'Success' ? 'badge-sent' : status === 'Failed' ? 'badge-error' : 'badge-warn';
  const title = status === 'Uncertain' ? 'The connection dropped while sending; the email may or may not have been delivered.' : status === 'Failed' ? 'The email was not sent.' : 'Accepted by the mail server for delivery.';
  return <span className={`badge ${cls}`} title={title}>{status || 'Unknown'}</span>;
}

/**
 * Bottom-right notification. Success toasts close by themselves after
 * `autoCloseMs`; others stay until dismissed.
 */
export function Toast({ toast, onClose, children, autoCloseMs = 10000 }) {
  useEffect(() => {
    if (!toast || toast.type !== 'success') return undefined;
    const t = setTimeout(onClose, autoCloseMs);
    return () => clearTimeout(t);
  }, [toast, onClose, autoCloseMs]);
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.type}`} role={toast.type === 'success' ? 'status' : 'alert'} aria-live="polite">
      <div className="toast-body">
        {toast.type === 'success' && <span className="check-icon" aria-hidden="true">✓</span>}
        <div className="toast-content">
          <div>{toast.text}</div>
          {children}
        </div>
      </div>
      <button className="alert-close" onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
}
