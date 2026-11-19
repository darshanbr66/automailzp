// Waking the backend before signing in.
//
// The API runs on Render's free plan, which sleeps after a period without
// traffic. While it starts up (up to about a minute) requests through the
// Vercel proxy hang or fail with 502/503/504. The sign-in page therefore first
// polls the public readiness check (GET /api/health, which sends no cookie data
// and no credentials) and submits the login only once that check succeeds.
//
// A sleeping Render service is NOT woken by requests arriving through the
// Vercel proxy: Render answers those with an immediate 502 for as long as the
// service sleeps (measured in production). Only a direct request to the
// onrender.com address starts it. So before polling, the page also sends one
// direct "wake" ping to Render's readiness check: a plain no-cors GET with no
// cookies, no credentials and no body, whose response is never read. Readiness
// is still decided only by the proxied /api/health check, and the login itself
// still goes only through the proxy (first-party session cookie, CSRF, Origin
// checks unchanged).
//
// No React or browser globals beyond fetch/AbortController, so it is unit-tested
// with node --test.

/**
 * Direct Render address of the public readiness check (same origin as the
 * /api rewrite destination in frontend/vercel.json, and allowed by its CSP
 * connect-src). Used only for the wake ping.
 */
export const DIRECT_WAKE_URL = 'https://automailzp.onrender.com/api/health';
/** At most this many wake pings per sign-in attempt (one, plus repeats while the server stays unready). */
export const MAX_WAKE_PINGS = 3;

export const WAKE_DEFAULTS = Object.freeze({
  /** Give up (and offer Retry) after this long. Render cold starts take ~30-60 s. */
  timeoutMs: 90_000,
  /** Abort a single health request after this long and try again. */
  attemptTimeoutMs: 15_000,
  /** If the first check has not answered by then, the server is probably asleep. */
  slowAfterMs: 1_500,
  /** Pause between attempts (the last value repeats). */
  delaysMs: [1_000, 2_000, 3_000, 5_000],
});

export class WakeTimeoutError extends Error {
  constructor(attempts) {
    super('The server did not respond in time.');
    this.name = 'WakeTimeoutError';
    this.code = 'WAKE_TIMEOUT';
    this.attempts = attempts;
  }
}

function abortError() {
  const e = new Error('Cancelled.');
  e.name = 'AbortError';
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One readiness check. True only for HTTP 2xx with the API's `{ ok: true }` body. */
async function checkOnce(url, fetchImpl, ms, signal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false; // network error, proxy timeout or our own per-attempt abort
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fire-and-forget wake request. `mode: 'no-cors'` + `credentials: 'omit'`: no
 * cookie, no Authorization, no custom header, no body, no preflight; the
 * response is never read. Resolves (never rejects) once the request has
 * finished either way. The outcome says nothing about whether Render received
 * it: the API sends `Cross-Origin-Resource-Policy: same-site`, so the browser
 * rejects the cross-site response even though the request reached Render and
 * woke it (verified in production).
 */
export function sendWakePing(url, fetchImpl = globalThis.fetch) {
  try {
    return Promise.resolve(
      fetchImpl(url, { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
    ).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Where to send the direct wake ping from this page, or null for none: never
 * from a local install (its backend is on the same computer and does not
 * sleep), and not when a custom API address is configured.
 */
export function wakePingUrl({ hostname = globalThis.location?.hostname, apiBase = '' } = {}) {
  if (apiBase || isLocalHost(hostname)) return null;
  return DIRECT_WAKE_URL;
}

/**
 * Resolve once the backend answers its readiness check.
 *
 * @param {object} o
 * @param {string} o.url            readiness endpoint, e.g. '/api/health'
 * @param {string} [o.wakeUrl]      direct address pinged (credential-free) before polling
 * @param {Function} [o.fetchImpl]  defaults to global fetch
 * @param {Function} [o.onWaking]   called once, when the server looks asleep
 * @param {AbortSignal} [o.signal]  cancels the wait (rejects with AbortError)
 * @returns {Promise<{ attempts: number, waited: boolean, pings: number }>}
 * @throws {WakeTimeoutError} after `timeoutMs` without a successful check
 */
export async function waitForBackend({
  url,
  wakeUrl = null,
  fetchImpl = globalThis.fetch,
  onWaking,
  signal,
  timeoutMs = WAKE_DEFAULTS.timeoutMs,
  attemptTimeoutMs = WAKE_DEFAULTS.attemptTimeoutMs,
  slowAfterMs = WAKE_DEFAULTS.slowAfterMs,
  delaysMs = WAKE_DEFAULTS.delaysMs,
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  let waking = false;
  const markWaking = () => {
    if (waking) return;
    waking = true;
    onWaking?.();
  };
  // Wake ping: one before the first check. Another only once the previous one
  // has finished and the proxied check still fails (never two at once; a
  // sleeping Render holds the first one open while it starts), up to MAX_WAKE_PINGS.
  let pings = 0;
  let pingInFlight = false;
  const ping = () => {
    pings += 1;
    pingInFlight = true;
    sendWakePing(wakeUrl, fetchImpl).then(() => {
      pingInFlight = false;
    });
  };
  if (signal?.aborted) throw abortError();
  if (wakeUrl) ping();

  const slowTimer = setTimeout(markWaking, slowAfterMs);
  try {
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      const left = deadline - now();
      if (left <= 0) throw new WakeTimeoutError(attempt - 1);
      const ready = await checkOnce(url, fetchImpl, Math.min(attemptTimeoutMs, left), signal);
      if (signal?.aborted) throw abortError();
      if (ready) return { attempts: attempt, waited: waking, pings };
      markWaking();
      if (wakeUrl && !pingInFlight && pings < MAX_WAKE_PINGS) ping();
      const pause = Math.min(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)], deadline - now());
      if (pause <= 0) throw new WakeTimeoutError(attempt);
      await sleep(pause, signal);
    }
  } finally {
    clearTimeout(slowTimer);
  }
}

// ---- Restoring a session on page load ---------------------------------------------
// The homepage makes no backend request when it loads, so a sleeping server is
// not woken just by visiting it. Two exceptions, both without credentials:
//  * a local install (localhost): the backend runs on the same computer, never
//    sleeps, and may have sign-in turned off, so its session status is read;
//  * this browser signed in earlier: one short session check restores the
//    workspace after a reload. The hint is only "1", never a token or a name.

export const SESSION_HINT_KEY = 'zp-signed-in';
/** Only one short request: if the server is asleep, its sessions are gone anyway. */
export const RESTORE_TIMEOUT_MS = 6_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').toLowerCase());
}

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
}
export function hasSessionHint() {
  try {
    return store()?.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}
export function setSessionHint(on) {
  try {
    if (on) store()?.setItem(SESSION_HINT_KEY, '1');
    else store()?.removeItem(SESSION_HINT_KEY);
  } catch {
    /* storage blocked: the homepage is simply shown after a reload */
  }
}

/** Whether the app should ask the backend for the session status on load. */
export function shouldCheckSessionOnLoad(hostname = globalThis.location?.hostname) {
  return isLocalHost(hostname) || hasSessionHint();
}
