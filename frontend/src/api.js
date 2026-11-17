export class ApiError extends Error {
  constructor(message, { code = 'ERROR', status = 0, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Hosted (Vercel): VITE_API_BASE_URL=https://api.zodiacpatent.com, set at build time.
// Local: empty, so requests go to /api on the Vite dev server, which proxies them.
export const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

const UNREACHABLE = API_BASE
  ? 'Cannot reach the ZodiacPatent server. Check your internet connection and try again.'
  : 'Cannot reach the application server. Make sure the app is running (double-click the desktop shortcut) and try again.';

// Session CSRF token (kept in memory only; the session itself is an HttpOnly cookie).
let csrfToken = null;
let onAuthRequired = null;
export function setCsrfToken(token) {
  csrfToken = token || null;
}
/** Called when the backend reports that the session has ended. */
export function setAuthRequiredHandler(fn) {
  onAuthRequired = fn;
}

/** Call the backend. Resolves with `data`, or throws ApiError with a user-friendly message. */
export async function api(path, { method = 'GET', json, form } = {}) {
  const headers = {};
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

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body, credentials: 'include' });
  } catch {
    throw new ApiError(UNREACHABLE, { code: 'BACKEND_UNAVAILABLE' });
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
