export class ApiError extends Error {
  constructor(message, { code = 'ERROR', status = 0, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Normally empty: requests go to /api on the app's own address. On Vercel the
// rewrite in vercel.json forwards them to Render; locally the Vite dev server
// proxies them. (Optional VITE_API_BASE_URL is only for a same-site API origin.)
import { getOperator } from './operator.js';
import { waitForBackend, wakePingUrl } from './wakeup.js';

export const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

const UNREACHABLE = API_BASE
  ? 'Cannot reach the ZodiacPatent server. Check your internet connection and try again.'
  : 'Cannot reach the application server. Make sure the app is running (double-click the desktop shortcut) and try again.';

// Session CSRF token (kept in memory only; the session itself is an HttpOnly cookie).
let csrfToken = null;
let onAuthRequired = null;
let onOperatorRequired = null;
export function setCsrfToken(token) {
  csrfToken = token || null;
}
/** Called when the backend reports that the session has ended. */
export function setAuthRequiredHandler(fn) {
  onAuthRequired = fn;
}
/** Called when the backend refuses an action because no (valid) operator was chosen. */
export function setOperatorRequiredHandler(fn) {
  onOperatorRequired = fn;
}

/** Call the backend. Resolves with `data`, or throws ApiError with a user-friendly message. */
/** Headers sent with every request: the self-declared operator, when chosen. */
function baseHeaders() {
  const op = getOperator();
  return op ? { 'X-Operator': encodeURIComponent(op) } : {};
}

/** Download a file from the API (e.g. the Excel history export). */
export async function download(path, fallbackName) {
  let res;
  try {
    res = await fetch(API_BASE + path, { headers: baseHeaders(), credentials: 'include' });
  } catch {
    throw new ApiError(UNREACHABLE, { code: 'BACKEND_UNAVAILABLE' });
  }
  if (!res.ok) {
    let msg = `The download failed (HTTP ${res.status}).`;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, { status: res.status });
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Wait until the backend answers its public readiness check, pinging Render directly first to wake it (see wakeup.js). */
export function waitForApi(options = {}) {
  return waitForBackend({ url: `${API_BASE}/api/health`, wakeUrl: wakePingUrl({ apiBase: API_BASE }), ...options });
}

export async function api(path, { method = 'GET', json, form, timeoutMs } = {}) {
  const headers = baseHeaders();
  if (method !== 'GET') {
    headers['X-OEA-Request'] = '1'; // required by the backend for changes
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  // Optional time limit (used only for the quick session check on page load).
  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body, credentials: 'include', signal: ctl?.signal });
  } catch {
    throw new ApiError(UNREACHABLE, { code: 'BACKEND_UNAVAILABLE' });
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* not JSON: the proxy could not reach the backend */
  }
  if (!payload || typeof payload.ok !== 'boolean') {
    throw new ApiError(res.status >= 500 ? UNREACHABLE : `Unexpected response from the server (HTTP ${res.status}).`, {
      code: 'BACKEND_UNAVAILABLE',
      status: res.status,
    });
  }
  if (!payload.ok) {
    if (payload.error?.code === 'AUTH_REQUIRED' && onAuthRequired) onAuthRequired(payload.error.message);
    if (payload.error?.code === 'OPERATOR_REQUIRED' && onOperatorRequired) onOperatorRequired();
    throw new ApiError(payload.error?.message || 'The request failed.', {
      code: payload.error?.code,
      status: res.status,
      details: payload.error?.details,
    });
  }
  return payload.data;
}

/** Simple client-side placeholder rendering, used only for the template preview. */
export function renderPlaceholders(text, values) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m,
  );
}

export function composeBody(tpl) {
  const blocks = [];
  if (tpl.greeting?.trim()) blocks.push(tpl.greeting.trim());
  if (tpl.mainMessage?.trim()) blocks.push(tpl.mainMessage.trim());
  const signOff = [tpl.closing?.trim(), tpl.signature?.trim()].filter(Boolean).join('\n');
  if (signOff) blocks.push(signOff);
  return blocks.join('\n\n');
}
