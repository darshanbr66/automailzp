// Shared team login, sessions, CSRF, CORS, production configuration and team
// concurrency. SMTP is mocked; no email is ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createApp } from '../src/app.js';
import { DEFAULT_DATA_DIR, loadConfig } from '../src/config.js';
import { LoginLimiter, hashPassword, isValidPasswordHash, verifyPassword } from '../src/auth.js';
import { SAMPLE_ROWS, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-session-secret-0123456789-abcdefghijklmnop';
const ORIGIN = 'https://app.zodiacpatent.com';
const HASH = await hashPassword(PASSWORD);

const prodEnv = (dataDir, over = {}) => ({
  NODE_ENV: 'production',
  FRONTEND_URL: ORIGIN,
  ALLOWED_HOSTS: 'api.zodiacpatent.com',
  DATA_DIR: dataDir,
  APP_USERNAME: 'zodiac-team',
  APP_PASSWORD_HASH: HASH,
  SESSION_SECRET: SECRET,
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'sender@zodiacpatent.example',
  SMTP_PASS: 'fake-app-password-for-tests',
  SMTP_FROM: 'sender@zodiacpatent.example',
  ...over,
});

/** Start a production-mode app. Each client() has its own cookie jar and CSRF token. */
async function startProd({ dataDir, smtp = fakeTransport(), env = {}, loginLimiter } = {}) {
  dataDir = dataDir || (await makeTempDir());
  const config = loadConfig(prodEnv(dataDir, env));
  assert.deepEqual(config.fatal, []);
  const app = createApp({ config, dataDir, mailer: makeMailer(smtp, config), ...(loginLimiter ? { loginLimiter } : {}) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    const c = { cookie: '', csrf: '', lastSetCookie: null };
    c.request = async (method, url, { json, form, headers = {}, origin = ORIGIN, csrf = true } = {}) => {
      const h = { ...headers };
      if (c.cookie) h.cookie = c.cookie;
      if (origin) h.origin = origin;
      if (method !== 'GET') {
        h['x-oea-request'] = '1';
        if (csrf && c.csrf) h['x-csrf-token'] = c.csrf;
      }
      let body;
      if (json !== undefined) {
        h['content-type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form) body = form;
      const res = await fetch(base + url, { method, headers: h, body });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        c.lastSetCookie = setCookie;
        c.cookie = setCookie.split(';')[0];
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, data, headers: res.headers, text };
    };
    c.login = async (password = PASSWORD, username = 'zodiac-team') => {
      const r = await c.request('POST', '/api/auth/login', { json: { username, password } });
      if (r.status === 200) c.csrf = r.data.data.csrfToken;
      return r;
    };
    /** Preview a row and return the selection the server verifies on send (like the browser). */
    c.select = async (rowNumber) => {
      const p = await c.request('POST', '/api/preview', { json: { rowNumber } });
      const { workbookVersion, mappingVersion, recordId, recipientEmail } = p.data.data;
      return { workbookVersion, mappingVersion, recordId, recipientEmail };
    };
    c.upload = (buffer) => {
      const f = new FormData();
      f.append('file', new Blob([buffer]), 'attorneys.xlsx');
      return c.request('POST', '/api/excel/upload', { form: f });
    };
    return c;
  }
  return { base, dataDir, smtp, server, client, close: () => new Promise((r) => server.close(r)) };
}

function rawRequest(base, { path: p = '/api/auth/session', host, method = 'GET', headers = {} }) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let n = 0;
const rid = () => `auth-test-request-${Date.now()}-${(n += 1)}`;

// ---------------------------------------------------------------------------
test('password hashing: scrypt format, verification, and no plain text', async () => {
  assert.ok(isValidPasswordHash(HASH));
  assert.match(HASH, /^scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.ok(!HASH.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, HASH), true);
  assert.equal(await verifyPassword('wrong password!!', HASH), false);
  assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
  assert.notEqual(await hashPassword(PASSWORD), HASH, 'random salt');
  await assert.rejects(hashPassword('short'), /at least 12/);
  assert.equal(isValidPasswordHash('scrypt:1024:8:1:AAAAAAAAAAAAAAAAAAAAAA:' + 'A'.repeat(86)), false, 'weak parameters rejected');
});

test('production configuration: strict requirements and safe defaults', async () => {
  const bad = loadConfig({ NODE_ENV: 'production' });
  const msg = bad.fatal.join(' | ');
  assert.match(msg, /FRONTEND_URL/);
  assert.match(msg, /ALLOWED_HOSTS/);
  assert.match(msg, /APP_USERNAME/);
  assert.match(msg, /APP_PASSWORD_HASH/);
  assert.match(msg, /SESSION_SECRET/);

  const ok = loadConfig(prodEnv(undefined, { DATA_DIR: '' }));
  assert.deepEqual(ok.fatal, []);
  assert.equal(ok.isProduction, true);
  // Without DATA_DIR (e.g. Render Free, no disk): app folder, flagged as temporary.
  assert.equal(ok.dataDir, DEFAULT_DATA_DIR);
  assert.equal(ok.persistentStorage, false);
  assert.match(ok.storageWarning, /history.*template.*mapping.*sessions.*restarts/);
  // With DATA_DIR (a persistent disk): persistent.
  const disk = loadConfig(prodEnv('/var/data'));
  assert.equal(disk.dataDir, '/var/data');
  assert.equal(disk.persistentStorage, true);
  assert.equal(disk.storageWarning, null);
  assert.equal(loadConfig({}).persistentStorage, true, 'local PC folder is permanent');
  assert.equal(ok.host, '0.0.0.0');
  assert.equal(ok.trustProxy, 1);
  assert.deepEqual(ok.allowedOrigins, [ORIGIN], 'exactly one origin, never a wildcard');
  assert.equal(ok.auth.enabled, true);

  assert.match(loadConfig(prodEnv('/var/data', { FRONTEND_URL: 'http://app.zodiacpatent.com' })).fatal.join(), /https/);
  assert.match(loadConfig(prodEnv('/var/data', { FRONTEND_URL: 'https://app.zodiacpatent.com/app' })).fatal.join(), /origin only/);
  assert.match(loadConfig(prodEnv('/var/data', { SESSION_SECRET: 'short' })).fatal.join(), /32 characters/);
  assert.match(loadConfig(prodEnv('/var/data', { APP_PASSWORD_HASH: 'plaintext-password' })).fatal.join(), /not a valid hash/);
  const onRender = loadConfig(prodEnv('/var/data', { RENDER_EXTERNAL_HOSTNAME: 'zodiacpatent-api.onrender.com' }));
  assert.deepEqual(onRender.allowedHosts, ['api.zodiacpatent.com', 'zodiacpatent-api.onrender.com']);

  // Local development stays as it was: no login unless configured, loopback only.
  const local = loadConfig({});
  assert.deepEqual(local.fatal, []);
  assert.equal(local.auth.enabled, false);
  assert.equal(local.host, '127.0.0.1');
  assert.deepEqual(local.allowedOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);
  // A half-configured login is an error even locally.
  assert.match(loadConfig({ APP_USERNAME: 'x' }).fatal.join(), /APP_PASSWORD_HASH/);
});

// ---------------------------------------------------------------------------
test('health check is public and minimal; every API endpoint needs a session', async () => {
  const srv = await startProd();
  const c = srv.client();
  try {
    const health = await c.request('GET', '/healthz', { origin: null });
    assert.equal(health.status, 200);
    assert.equal(health.text, '{"ok":true}');

    for (const url of ['/api/excel/records', '/api/smtp/status', '/api/history', '/api/template', '/api/mapping', '/api/status']) {
      const r = await c.request('GET', url);
      assert.equal(r.status, 401, url);
      assert.equal(r.data.error.code, 'AUTH_REQUIRED');
    }
    const post = await c.request('POST', '/api/smtp/test');
    assert.equal(post.status, 401);
    const s = await c.request('GET', '/api/auth/session');
    assert.deepEqual(s.data.data, { authRequired: true, authenticated: false });
  } finally {
    await srv.close();
  }
});

test('login sets a secure HttpOnly host-only cookie and never exposes secrets', async () => {
  const srv = await startProd();
  const c = srv.client();
  try {
    assert.equal((await c.login('wrong password here')).status, 401);
    assert.equal((await c.login(PASSWORD, 'someone-else')).status, 401);
    assert.equal(c.cookie, '', 'no cookie after failed login');

    const r = await c.login();
    assert.equal(r.status, 200);
    const sc = c.lastSetCookie;
    assert.match(sc, /^__Host-zp_session=[A-Za-z0-9_-]{43};/);
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /Secure/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Path=\//);
    assert.match(sc, /Max-Age=\d+/);
    assert.doesNotMatch(sc, /Domain=/i, 'host-only cookie for api.zodiacpatent.com');
    assert.equal(r.data.data.username, 'zodiac-team');
    assert.match(r.data.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);

    const session = await c.request('GET', '/api/auth/session');
    const status = await c.request('GET', '/api/smtp/status');
    assert.equal(status.status, 200);
    for (const text of [r.text, session.text, status.text]) {
      assert.ok(!text.includes(SECRET) && !text.includes(HASH) && !text.includes(PASSWORD) && !text.includes('fake-app-password'));
    }
  } finally {
    await srv.close();
  }
});

test('CSRF: changes need the session token and an allowed Origin', async () => {
  const srv = await startProd();
  const c = srv.client();
  try {
    await c.login();
    assert.equal((await c.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);

    let r = await c.request('POST', '/api/preview', { json: { rowNumber: 2 }, csrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'CSRF_FAILED');
    r = await c.request('POST', '/api/preview', { json: { rowNumber: 2 }, headers: { 'x-csrf-token': 'x'.repeat(43) }, csrf: false });
    assert.equal(r.data.error.code, 'CSRF_FAILED');
    r = await c.request('POST', '/api/preview', { json: { rowNumber: 2 }, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await c.request('POST', '/api/preview', { json: { rowNumber: 2 }, origin: null });
    assert.equal(r.status, 403, 'Origin is required in production');
    r = await c.request('POST', '/api/preview', { json: { rowNumber: 2 } });
    assert.equal(r.status, 200);
  } finally {
    await srv.close();
  }
});

test('sessions persist on disk across restarts, are stored hashed, expire, and end on logout', async () => {
  const dataDir = await makeTempDir();
  let srv = await startProd({ dataDir });
  const c = srv.client();
  await c.login();
  const cookieValue = c.cookie.split('=')[1];
  await srv.close();

  const files = await fs.readdir(path.join(dataDir, 'sessions'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  const raw = await fs.readFile(path.join(dataDir, 'sessions', files[0]), 'utf8');
  assert.ok(!files[0].includes(cookieValue) && !raw.includes(cookieValue), 'the cookie value is not stored');

  // "Redeploy": a new app instance on the same disk keeps the session.
  srv = await startProd({ dataDir });
  try {
    const again = srv.client();
    Object.assign(again, { cookie: c.cookie, csrf: c.csrf });
    assert.equal((await again.request('GET', '/api/excel/records')).status, 200);

    // Idle expiry: push lastSeen back beyond the idle timeout (2 hours by default).
    const file = path.join(dataDir, 'sessions', files[0]);
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...s, lastSeen: Date.now() - 3 * 3600 * 1000 }));
    assert.equal((await again.request('GET', '/api/excel/records')).status, 401);
    await assert.rejects(fs.access(file), 'expired session file is deleted');

    // Absolute expiry and logout.
    const d = srv.client();
    await d.login();
    const [f2] = await fs.readdir(path.join(dataDir, 'sessions'));
    const s2 = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', f2), 'utf8'));
    await fs.writeFile(path.join(dataDir, 'sessions', f2), JSON.stringify({ ...s2, createdAt: Date.now() - 13 * 3600 * 1000 }));
    assert.equal((await d.request('GET', '/api/history')).status, 401);

    const e = srv.client();
    await e.login();
    const oldCookie = e.cookie;
    const out = await e.request('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(e.lastSetCookie, /__Host-zp_session=;/);
    const stale = srv.client();
    stale.cookie = oldCookie;
    assert.equal((await stale.request('GET', '/api/history')).status, 401, 'logged-out session cannot be reused');
  } finally {
    await srv.close();
  }
});

test('login rate limiting: per client, and correct passwords are refused while locked', async () => {
  const srv = await startProd({ loginLimiter: new LoginLimiter({ perIp: 5, global: 50 }) });
  const c = srv.client();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await c.login('wrong password here')).status, 401);
    const locked = await c.login();
    assert.equal(locked.status, 429);
    assert.equal(locked.data.error.code, 'TOO_MANY_ATTEMPTS');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal(c.cookie, '');
  } finally {
    await srv.close();
  }
  // Global limit across many addresses.
  const lim = new LoginLimiter({ perIp: 5, global: 10 });
  for (let i = 0; i < 10; i += 1) lim.fail(`10.0.0.${i}`);
  assert.ok(lim.retryAfter('10.9.9.9') > 0);
});

test('CORS allows only the exact frontend origin, with credentials, never a wildcard', async () => {
  const srv = await startProd();
  try {
    const pre = await fetch(`${srv.base}/api/send`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-oea-request,x-csrf-token' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-CSRF-Token/);

    for (const origin of ['https://evil.example', 'https://app.zodiacpatent.com.evil.example', 'http://app.zodiacpatent.com', 'https://zodiacpatent.com', 'null']) {
      const bad = await fetch(`${srv.base}/api/send`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
      assert.equal(bad.status, 403, origin);
      assert.equal(bad.headers.get('access-control-allow-origin'), null);
      const get = await fetch(`${srv.base}/api/auth/session`, { headers: { origin } });
      assert.equal(get.headers.get('access-control-allow-origin'), null);
    }
    const get = await fetch(`${srv.base}/api/auth/session`, { headers: { origin: ORIGIN } });
    assert.equal(get.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(get.headers.get('strict-transport-security'), /max-age=/);
  } finally {
    await srv.close();
  }
});

test('host check: the API host and Render host name are accepted, others refused', async () => {
  const srv = await startProd({ env: { RENDER_EXTERNAL_HOSTNAME: 'zodiacpatent-api.onrender.com' } });
  try {
    assert.equal((await rawRequest(srv.base, { host: 'api.zodiacpatent.com' })).status, 200);
    assert.equal((await rawRequest(srv.base, { host: 'zodiacpatent-api.onrender.com' })).status, 200);
    assert.equal((await rawRequest(srv.base, { host: 'evil.example' })).status, 403);
    assert.equal((await rawRequest(srv.base, { host: 'evil.example', path: '/healthz' })).status, 200, 'health check works for Render probes');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
test('team concurrency: sends from different sessions are serialized; duplicate checks see each other', async () => {
  // Track how many SMTP sends are in progress at once.
  const base = fakeTransport();
  let active = 0;
  let maxActive = 0;
  const smtp = {
    state: base.state,
    createTransport: (opts) => {
      const t = base.createTransport(opts);
      return {
        ...t,
        sendMail: async (m) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 80));
          try { return await t.sendMail(m); } finally { active -= 1; }
        },
      };
    },
  };
  // Two rows without registration numbers but the same email address.
  const rows = [['Full Name', 'Reg No', 'E-mail', 'Firm'], ['Pat One', '', 'shared@example.com', 'A LLP'], ['Pat One', '', 'shared@example.com', 'B LLP'], ['Other Person', 'REG-9', 'other@example.com', '']];
  const srv = await startProd({ smtp });
  const alice = srv.client();
  const bob = srv.client();
  try {
    await alice.login();
    await bob.login();
    assert.notEqual(alice.cookie, bob.cookie, 'each team member gets their own session');
    assert.equal((await alice.upload(makeWorkbookBuffer(rows))).status, 200);
    // Bob sees the workbook Alice uploaded (shared team workbook).
    assert.equal((await bob.request('GET', '/api/excel/records')).data.data.totalRecords, 3);

    const selections = { 2: await alice.select(2), 3: await bob.select(3), 4: await bob.select(4) };
    const send = (c, rowNumber) => c.request('POST', '/api/send', { json: { rowNumber, subject: 'S', body: 'B', requestId: rid(), expected: selections[rowNumber] } });
    const results = await Promise.all([send(alice, 2), send(bob, 3), send(bob, 4)]);
    assert.equal(maxActive, 1, 'only one SMTP send at a time');
    const codes = results.map((r) => r.status);
    // Rows 2 and 3 are possibly the same person: whichever runs second must be warned, not sent.
    assert.deepEqual(codes.slice(0, 2).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).data.error.code, 'POSSIBLE_DUPLICATE');
    assert.equal(results[2].status, 200);
    assert.equal(base.state.sent.length, 2);

    const wb = XLSX.read(await fs.readFile(path.join(srv.dataDir, 'sent-emails.xlsx')));
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Sent Emails']).length, 2, 'history written under DATA_DIR');
  } finally {
    await srv.close();
  }
});

test('production ignores backend/.env; only the platform environment is used', async () => {
  const dir = await makeTempDir();
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, 'FRONTEND_URL=http://localhost:5173\nSMTP_USER=local-file@zodiacpatent.example\nAPP_USERNAME=from-file\n');
  const { loadConfigFromEnvFile } = await import('../src/config.js');
  const prod = loadConfigFromEnvFile(envPath, prodEnv('/var/data'));
  assert.deepEqual(prod.fatal, []);
  assert.equal(prod.frontendUrl, ORIGIN);
  assert.equal(prod.smtp.user, 'sender@zodiacpatent.example');
  assert.equal(prod.auth.username, 'zodiac-team');
  // Locally the file still wins (switching mailboxes by editing .env keeps working).
  const local = loadConfigFromEnvFile(envPath, { SMTP_USER: 'other@example.com' });
  assert.equal(local.smtp.user, 'local-file@zodiacpatent.example');
});

test('without DATA_DIR (Render Free) the app runs and tells signed-in users that storage is temporary', async () => {
  const dataDir = await makeTempDir();
  const config = loadConfig(prodEnv(undefined, { DATA_DIR: '' }));
  assert.deepEqual(config.fatal, []);
  const app = createApp({ config, dataDir, mailer: makeMailer(fakeTransport(), config) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: ORIGIN, 'x-oea-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'zodiac-team', password: PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const status = await (await fetch(`${base}/api/smtp/status`, { headers: { cookie } })).json();
    assert.match(status.data.storageWarning, /lost whenever the server restarts/);
    const history = await (await fetch(`${base}/api/history`, { headers: { cookie } })).json();
    assert.equal(history.data.file, 'backend/data/sent-emails.xlsx');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Vercel → Render proxy (frontend/vercel.json forwards /api/* to Render).
test('behind the proxy chain, forged X-Forwarded-For entries cannot dodge the login limiter (TRUST_PROXY=1)', async () => {
  const srv = await startProd({ env: { TRUST_PROXY: '1' }, loginLimiter: new LoginLimiter({ perIp: 5, global: 50 }) });
  try {
    // Render's load balancer appends the address that really connected as the LAST
    // entry; everything before it is client-controlled and must be ignored.
    const attempt = async (spoofed, real) => {
      const c = srv.client();
      return c.request('POST', '/api/auth/login', { json: { username: 'zodiac-team', password: 'wrong password here' }, headers: { 'x-forwarded-for': `${spoofed}, ${real}` } });
    };
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt(`198.51.100.${i}`, '203.0.113.7')).status, 401);
    assert.equal((await attempt('198.51.100.99', '203.0.113.7')).status, 429, 'rotating the forged part does not reset the limit');
    assert.equal((await attempt('203.0.113.7', '203.0.113.8')).status, 401, 'a different real address has its own limit');
  } finally {
    await srv.close();
  }
});

test('requests forwarded by the Vercel proxy are accepted (Host and Origin of the Vercel site)', async () => {
  const VERCEL = 'https://automailzp.vercel.app';
  const srv = await startProd({ env: { FRONTEND_URL: VERCEL, ALLOWED_HOSTS: 'automailzp.onrender.com,automailzp.vercel.app' } });
  try {
    for (const host of ['automailzp.onrender.com', 'automailzp.vercel.app']) {
      assert.equal((await rawRequest(srv.base, { host })).status, 200, host);
    }
    assert.equal((await rawRequest(srv.base, { host: 'other.vercel.app' })).status, 403);
    const c = srv.client();
    const login = await c.request('POST', '/api/auth/login', { json: { username: 'zodiac-team', password: PASSWORD }, origin: VERCEL });
    assert.equal(login.status, 200);
    c.csrf = login.data.data.csrfToken;
    assert.equal((await c.request('GET', '/api/auth/session', { origin: VERCEL })).data.data.authenticated, true);
    assert.equal((await c.request('POST', '/api/auth/logout', { origin: VERCEL })).status, 200);
    assert.equal((await c.request('POST', '/api/auth/login', { json: { username: 'zodiac-team', password: PASSWORD }, origin: 'https://evil.vercel.app' })).status, 403);
  } finally {
    await srv.close();
  }
});

test('frontend/vercel.json proxies /api to Render before the SPA fallback, with a same-origin CSP', async () => {
  const vercel = JSON.parse(await fs.readFile(new URL('../../frontend/vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.rewrites, [
    { source: '/api/:path*', destination: 'https://automailzp.onrender.com/api/:path*' },
    { source: '/(.*)', destination: '/index.html' },
  ]);
  const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /connect-src[^;]*https?:/, 'the browser never calls another origin');
});

test('two signed-in members: a workbook uploaded by Bob makes Alice\'s earlier selection stale (no wrong-recipient send)', async () => {
  const srv = await startProd();
  const alice = srv.client();
  const bob = srv.client();
  try {
    await alice.login();
    await bob.login();
    const head = ['Full Name', 'Reg No', 'E-mail'];
    assert.equal((await alice.upload(makeWorkbookBuffer([head, ['Attorney New', 'REG-NEW', 'new@example.com']]))).status, 200);
    const sel = await alice.select(2);
    assert.equal(sel.recipientEmail, 'new@example.com');

    // The exact scenario from the audit: Bob uploads a different workbook.
    assert.equal((await bob.upload(makeWorkbookBuffer([head, ['Attorney Other', 'REG-OTHER', 'other@example.com'], ['Attorney New', 'REG-NEW', 'new@example.com']]))).status, 200);
    const r = await alice.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'Dear Attorney New, ...', requestId: rid(), expected: sel } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'STALE_SELECTION');
    assert.match(r.data.error.message, /reload the page/);
    assert.equal(srv.smtp.state.sent.length, 0, 'other@example.com did not receive Alice\'s email');
    assert.equal((await bob.request('GET', '/api/history')).data.data.entries.length, 0);

    // Alice reloads and selects again: the email goes to the right attorney.
    const fresh = await alice.select(3);
    assert.equal(fresh.recipientEmail, 'new@example.com');
    const ok = await alice.request('POST', '/api/send', { json: { rowNumber: 3, subject: 'S', body: 'Dear Attorney New, ...', requestId: rid(), expected: fresh } });
    assert.equal(ok.status, 200);
    assert.deepEqual(srv.smtp.state.sent.map((m) => m.to), ['new@example.com']);
  } finally {
    await srv.close();
  }
});
