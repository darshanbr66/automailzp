// Waking the backend before signing in.
//
// The API runs on Render's free plan, which sleeps after a period without
// traffic. While it starts up (up to about a minute) requests through the
// Vercel proxy hang or fail with 502/503/504. The sign-in page therefore first
// polls the public readiness check (GET /api/health, which sends no cookie data
// and no credentials) and submits the login only once that check succeeds.
//
// No React or browser globals beyond fetch/AbortController, so it is unit-tested
// with node --test.

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
 * Resolve once the backend answers its readiness check.
 *
 * @param {object} o
 * @param {string} o.url            readiness endpoint, e.g. '/api/health'
 * @param {Function} [o.fetchImpl]  defaults to global fetch
 * @param {Function} [o.onWaking]   called once, when the server looks asleep
 * @param {AbortSignal} [o.signal]  cancels the wait (rejects with AbortError)
 * @returns {Promise<{ attempts: number, waited: boolean }>}
 * @throws {WakeTimeoutError} after `timeoutMs` without a successful check
 */
export async function waitForBackend({
  url,
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
  const slowTimer = setTimeout(markWaking, slowAfterMs);
  try {
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      const left = deadline - now();
      if (left <= 0) throw new WakeTimeoutError(attempt - 1);
      const ready = await checkOnce(url, fetchImpl, Math.min(attemptTimeoutMs, left), signal);
      if (signal?.aborted) throw abortError();
      if (ready) return { attempts: attempt, waited: waking };
      markWaking();
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
