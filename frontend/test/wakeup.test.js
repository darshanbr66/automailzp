// Unit tests for the Render cold-start handling (no browser or server needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_HINT_KEY, WakeTimeoutError, hasSessionHint, isLocalHost, setSessionHint, shouldCheckSessionOnLoad, waitForBackend } from '../src/wakeup.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const FAST = { delaysMs: [5], slowAfterMs: 1000, attemptTimeoutMs: 200 };

/** fetch stand-in answering from a script; records every call. */
function scripted(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === 'throw') throw new TypeError('Failed to fetch');
    if (step === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return step;
  };
  return { impl, calls };
}

test('an awake server: one request, no "waking" state', async () => {
  const { impl, calls } = scripted([json(200, { ok: true, data: { ready: true } })]);
  let waking = 0;
  const r = await waitForBackend({ url: '/api/health', fetchImpl: impl, onWaking: () => waking++, ...FAST });
  assert.deepEqual(r, { attempts: 1, waited: false });
  assert.equal(calls.length, 1);
  assert.equal(waking, 0);
  assert.equal(calls[0].url, '/api/health');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined, 'the readiness check never carries a body (no credentials)');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('a sleeping server: proxy errors and network failures are retried until it is ready', async () => {
  const { impl, calls } = scripted([json(502, null), 'throw', json(503, { ok: false }), json(200, { ok: true })]);
  let waking = 0;
  const r = await waitForBackend({ url: '/api/health', fetchImpl: impl, onWaking: () => waking++, ...FAST });
  assert.equal(r.attempts, 4);
  assert.equal(r.waited, true);
  assert.equal(calls.length, 4);
  assert.equal(waking, 1, '"Waking up server" is announced once');
});

test('HTML or a non-API body is not mistaken for readiness', async () => {
  const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const { impl, calls } = scripted([notJson, json(200, { hello: 1 }), json(200, { ok: true })]);
  await waitForBackend({ url: '/api/health', fetchImpl: impl, ...FAST });
  assert.equal(calls.length, 3);
});

test('a slow first answer shows "waking" before it arrives', async () => {
  let waking = 0;
  const impl = () => new Promise((r) => setTimeout(() => r(json(200, { ok: true })), 60));
  const r = await waitForBackend({ url: '/x', fetchImpl: impl, onWaking: () => waking++, ...FAST, slowAfterMs: 10 });
  assert.equal(r.attempts, 1);
  assert.equal(r.waited, true);
  assert.equal(waking, 1);
});

test('a hanging request is aborted per attempt, and the whole wait is bounded', async () => {
  const { impl, calls } = scripted(['hang']);
  const started = Date.now();
  await assert.rejects(
    waitForBackend({ url: '/x', fetchImpl: impl, timeoutMs: 150, attemptTimeoutMs: 40, delaysMs: [10], slowAfterMs: 5 }),
    (err) => err instanceof WakeTimeoutError && err.code === 'WAKE_TIMEOUT',
  );
  const took = Date.now() - started;
  assert.ok(took < 1000, `gave up after the time limit (${took} ms)`);
  assert.ok(calls.length >= 2, 'several attempts were made');
});

test('the wait can be cancelled (e.g. the form is closed)', async () => {
  const { impl, calls } = scripted([json(502, null)]);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(waitForBackend({ url: '/x', fetchImpl: impl, signal: ctl.signal, ...FAST, delaysMs: [10] }), { name: 'AbortError' });
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, n, 'no requests after cancelling');
});

test('session check on load: only for a local install or a browser that signed in before', () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('127.0.0.1'), true);
    assert.equal(isLocalHost('automailzp.vercel.app'), false);

    assert.equal(shouldCheckSessionOnLoad('automailzp.vercel.app'), false, 'hosted homepage: no backend request on load');
    assert.equal(shouldCheckSessionOnLoad('localhost'), true);
    setSessionHint(true);
    assert.equal(mem.get(SESSION_HINT_KEY), '1', 'the hint is a flag only (no token, no name)');
    assert.equal(hasSessionHint(), true);
    assert.equal(shouldCheckSessionOnLoad('automailzp.vercel.app'), true, 'a reload after signing in restores the session');
    setSessionHint(false);
    assert.equal(shouldCheckSessionOnLoad('automailzp.vercel.app'), false);

    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    setSessionHint(true); // does not throw
    assert.equal(hasSessionHint(), false, 'blocked storage: treated as not signed in');
  } finally {
    delete globalThis.localStorage;
  }
});
