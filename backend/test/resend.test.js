// Resend HTTPS API provider and provider selection. fetch is replaced by a fake:
// no request ever reaches Resend and no email is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { ResendMailer } from '../src/resend.js';
import { createMailer } from '../src/mailer.js';
import { SmtpMailer } from '../src/email.js';
import { loadConfig } from '../src/config.js';
import { SAMPLE_ROWS, makeTempDir, makeWorkbookBuffer, startTestServer, testConfig } from './helpers.js';

const KEY = 're_test_9f8e7d6c5b4a3210fedcba';
const FROM = 'vikram@zodiacpatent.example';
const DOMAIN = 'zodiacpatent.example';

/** Fake fetch. Queue items: { status, json } | { error } | { status, text } */
function fakeFetch() {
  const state = { calls: [], queue: [] };
  const fetch = async (url, init) => {
    state.calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : undefined });
    const next = state.queue.shift() || { status: 200, json: { id: 'email-id-123' } };
    if (next.error) throw next.error;
    return {
      status: next.status,
      json: async () => {
        if (next.text !== undefined) throw new SyntaxError('not json');
        return next.json;
      },
    };
  };
  return { fetch, state };
}
const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const mailer = (fake) => new ResendMailer({ apiKey: KEY, from: FROM }, { fetch: fake.fetch });
const msg = { to: ' one@example.com ', subject: ' Hello ', body: 'Line 1\nLine 2' };

/** Run fn while capturing console output, to prove the key is never logged. */
async function captureConsole(fn) {
  const out = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.map(String).join(' '));
  try {
    return { result: await fn(), out };
  } finally {
    Object.assign(console, orig);
  }
}

// ---------------------------------------------------------------------------
test('config: EMAIL_PROVIDER selects the provider; Resend needs only RESEND_API_KEY and SMTP_FROM', () => {
  const smtpDefault = testConfig();
  assert.equal(smtpDefault.email.provider, 'smtp');
  assert.equal(smtpDefault.smtpConfigured, true);

  const resend = loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, SMTP_FROM: FROM });
  assert.deepEqual(resend.problems, [], 'no SMTP_USER/SMTP_PASS needed for Resend');
  assert.equal(resend.smtpConfigured, true);
  assert.deepEqual(resend.email, { provider: 'resend', from: FROM, resendApiKey: KEY });

  const noKey = loadConfig({ EMAIL_PROVIDER: 'resend', SMTP_FROM: FROM });
  assert.match(noKey.problems.join(), /RESEND_API_KEY is not set/);
  assert.match(loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_your_api_key', SMTP_FROM: FROM }).problems.join(), /RESEND_API_KEY is not set/, 'example value counts as unset');
  assert.match(loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'sk_live_123456789', SMTP_FROM: FROM }).problems.join(), /starts with "re_"/);
  assert.match(loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY }).problems.join(), /SMTP_FROM is not set/);
  assert.match(loadConfig({ EMAIL_PROVIDER: 'mailgun', RESEND_API_KEY: KEY, SMTP_FROM: FROM }).problems.join(), /must be "smtp" or "resend"/);
  assert.equal(loadConfig({ EMAIL_PROVIDER: 'RESEND', RESEND_API_KEY: KEY, SMTP_FROM: FROM }).email.provider, 'resend');
  for (const p of noKey.problems) assert.ok(!p.includes(KEY));
});

test('createMailer picks SMTP or Resend, and nothing when not configured', () => {
  assert.ok(createMailer(testConfig()) instanceof SmtpMailer);
  assert.ok(createMailer(loadConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, SMTP_FROM: FROM })) instanceof ResendMailer);
  assert.equal(createMailer(loadConfig({ EMAIL_PROVIDER: 'resend', SMTP_FROM: FROM })), null);
  assert.equal(createMailer(testConfig({ SMTP_PASS: '' })), null);
});

// ---------------------------------------------------------------------------
test('send: one HTTPS request with the right headers and a plain-text body; resolves only with an email id', async () => {
  const fake = fakeFetch();
  const m = mailer(fake);
  const r = await m.send({ ...msg, idempotencyKey: 'zp-send-abc-123' });
  assert.deepEqual(r, { accepted: true, messageId: 'email-id-123' });
  assert.equal(fake.state.calls.length, 1);
  const c = fake.state.calls[0];
  assert.equal(c.url, 'https://api.resend.com/emails');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers['Idempotency-Key'], 'zp-send-abc-123');
  assert.ok(c.signal, 'request has a timeout');
  assert.deepEqual(c.json, { from: FROM, to: ['one@example.com'], subject: 'Hello', text: 'Line 1\nLine 2' });
  assert.equal(c.json.html, undefined);

  // Very long idempotency keys are cut to Resend's 256-character limit.
  await m.send({ ...msg, idempotencyKey: 'k'.repeat(400) });
  assert.equal(fake.state.calls[1].headers['Idempotency-Key'].length, 256);

  // 2xx without an id is NOT treated as sent.
  fake.state.queue.push({ status: 200, json: {} });
  await assert.rejects(m.send(msg), { code: 'SMTP_UNCERTAIN' });
  fake.state.queue.push({ status: 200, text: '<html>' });
  await assert.rejects(m.send(msg), { code: 'SMTP_UNCERTAIN' });
});

test('send: Resend errors map to clear messages and the right outcome', async () => {
  const cases = [
    [{ status: 401, json: { name: 'validation_error', message: 'API key is invalid' } }, 'SMTP_AUTH_FAILED', /Resend rejected the API key.*not sent/],
    [{ status: 401, json: { name: 'missing_api_key', message: 'Missing API key' } }, 'SMTP_AUTH_FAILED', /RESEND_API_KEY/],
    [{ status: 403, json: { name: 'suspended_api_key', message: 'suspended' } }, 'SMTP_AUTH_FAILED', /not sent/],
    [{ status: 403, json: { name: 'validation_error', message: `The ${DOMAIN} domain is not verified. Please, add and verify your domain on https://resend.com/domains` } }, 'SENDER_REJECTED', new RegExp(`${DOMAIN} is not verified.*not sent`)],
    [{ status: 403, json: { name: 'validation_error', message: 'You can only send testing emails to your own email address (x@y.z).' } }, 'SENDER_REJECTED', /not verified/],
    [{ status: 422, json: { name: 'validation_error', message: 'Invalid `to` field. The email address needs to follow the `email@example.com` format.' } }, 'INVALID_RECIPIENT', /recipient.*not sent/],
    [{ status: 422, json: { name: 'validation_error', message: 'Invalid `from` field.' } }, 'SMTP_REJECTED', /refused the email.*not sent/],
    [{ status: 429, json: { name: 'daily_quota_exceeded', message: 'quota' } }, 'SMTP_TEMPORARY', /daily sending limit.*100.*not sent.*midnight UTC/],
    [{ status: 429, json: { name: 'monthly_quota_exceeded', message: 'quota' } }, 'SMTP_TEMPORARY', /monthly sending limit/],
    [{ status: 429, json: { name: 'rate_limit_exceeded', message: 'Too many requests' } }, 'SMTP_TEMPORARY', /too many per second.*not sent/],
    [{ status: 503, json: { name: 'service_unavailable', message: 'down' } }, 'SMTP_TEMPORARY', /temporarily unavailable.*not sent/],
    [{ status: 500, json: { name: 'application_error', message: 'oops' } }, 'SMTP_UNCERTAIN', /may or may not have been sent/],
    [{ status: 409, json: { name: 'invalid_idempotent_request', message: 'reused' } }, 'SMTP_UNCERTAIN', /not sent a second time/],
    [{ status: 409, json: { name: 'concurrent_idempotent_requests', message: 'in progress' } }, 'SMTP_UNCERTAIN', /already received this exact send request/],
  ];
  for (const [response, code, re] of cases) {
    const fake = fakeFetch();
    fake.state.queue.push(response);
    await assert.rejects(mailer(fake).send(msg), (e) => {
      assert.equal(e.code, code, `${response.status} ${response.json.name}`);
      assert.match(e.message, re);
      return true;
    });
  }
});

test('send: network failures before the request reaches Resend are "not sent"; mid-request failures are "uncertain"', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
    const fake = fakeFetch();
    fake.state.queue.push({ error: netError(code) });
    await assert.rejects(mailer(fake).send(msg), (e) => e.code === 'SMTP_CONNECTION_FAILED' && /not sent/.test(e.message));
  }
  for (const error of [netError('ECONNRESET'), netError('UND_ERR_SOCKET'), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
    const fake = fakeFetch();
    fake.state.queue.push({ error });
    await assert.rejects(mailer(fake).send(msg), (e) => e.code === 'SMTP_UNCERTAIN' && /may or may not have been sent/.test(e.message));
  }
});

test('the API key never appears in errors, objects or logs', async () => {
  const fake = fakeFetch();
  const m = mailer(fake);
  assert.ok(!JSON.stringify(m).includes(KEY));
  assert.ok(!JSON.stringify(m.publicInfo()).includes(KEY));
  // Even if Resend echoed the key back in a message, it is masked.
  fake.state.queue.push({ status: 422, json: { name: 'validation_error', message: `bad request for ${KEY}` } });
  fake.state.queue.push({ status: 401, json: { name: 'validation_error', message: 'API key is invalid' } });
  fake.state.queue.push({ error: netError('ECONNRESET') });
  const { out } = await captureConsole(async () => {
    for (let i = 0; i < 3; i += 1) {
      try {
        await m.send(msg);
      } catch (e) {
        assert.ok(!e.message.includes(KEY) && !JSON.stringify(e).includes(KEY));
      }
    }
    try { await m.verify(); } catch { /* covered elsewhere */ }
  });
  assert.ok(out.length > 0);
  assert.ok(!out.join('\n').includes(KEY), 'nothing logged contains the key');
});

// ---------------------------------------------------------------------------
test('verify (Test Email Connection): checks key and domain without sending', async () => {
  const run = async (response) => {
    const fake = fakeFetch();
    fake.state.queue.push(response);
    const p = mailer(fake).verify();
    const call = fake.state.calls[0];
    return { p, call: () => fake.state.calls[0] || call };
  };
  let { p, call } = await run({ status: 200, json: { object: 'list', data: [{ name: 'other.example', status: 'verified' }, { name: DOMAIN, status: 'verified' }] } });
  const ok = await p;
  assert.equal(ok.ok, true);
  assert.match(ok.message, new RegExp(`${DOMAIN} is verified for sending as ${FROM}`));
  assert.equal(call().url, 'https://api.resend.com/domains');
  assert.equal(call().method, 'GET', 'no email is sent by the test');

  ({ p } = await run({ status: 200, json: { data: [{ name: DOMAIN, status: 'pending' }] } }));
  await assert.rejects(p, (e) => e.code === 'SENDER_REJECTED' && /not verified.*status: pending/.test(e.message));
  ({ p } = await run({ status: 200, json: { data: [] } }));
  await assert.rejects(p, (e) => e.code === 'SENDER_REJECTED' && /has not been added in Resend/.test(e.message));
  ({ p } = await run({ status: 401, json: { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' } }));
  const restricted = await p;
  assert.equal(restricted.ok, true, 'a valid sending-only key passes');
  assert.match(restricted.message, /sending-only key/);
  ({ p } = await run({ status: 400, json: { name: 'validation_error', message: 'API key is invalid' } }));
  await assert.rejects(p, { code: 'SMTP_AUTH_FAILED' });
  ({ p } = await run({ status: 401, json: { name: 'missing_api_key' } }));
  await assert.rejects(p, { code: 'SMTP_AUTH_FAILED' });
  ({ p } = await run({ error: netError('ENOTFOUND') }));
  await assert.rejects(p, (e) => e.code === 'SMTP_CONNECTION_FAILED' && /Resend API/.test(e.message));
});

// ---------------------------------------------------------------------------
// Through the real app: history, duplicates, status and connection test.
async function resendServer() {
  const dataDir = await makeTempDir();
  const fake = fakeFetch();
  const config = testConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, SMTP_FROM: FROM, SMTP_USER: '', SMTP_PASS: '' });
  assert.deepEqual(config.problems, []);
  const srv = await startTestServer({ dataDir, config, mailer: createMailer(config, { fetch: fake.fetch }) });
  assert.equal((await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);
  return { srv, fake, dataDir };
}
const historyRows = async (dataDir) => XLSX.utils.sheet_to_json(XLSX.read(await fs.readFile(path.join(dataDir, 'sent-emails.xlsx'))).Sheets['Sent Emails']);
let n = 0;
const rid = () => `resend-test-${Date.now()}-${(n += 1)}`;

test('app with Resend: successful send is recorded once, with the sender and an idempotency key', async () => {
  const { srv, fake, dataDir } = await resendServer();
  try {
    const requestId = rid();
    const res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Subject A', body: 'Body A', requestId } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.data.messageId, 'email-id-123');
    assert.match(res.data.data.message, /^Resend accepted the email/);
    assert.equal(res.data.data.entry.senderEmail, FROM);
    assert.equal(fake.state.calls[0].headers['Idempotency-Key'], `zp-send-${requestId}`);
    assert.deepEqual(fake.state.calls[0].json, { from: FROM, to: ['one@example.com'], subject: 'Subject A', text: 'Body A' });
    const rows = await historyRows(dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Status, 'Success');
    assert.equal(rows[0]['Sender Email'], FROM);
    assert.ok(!JSON.stringify(res.data).includes(KEY));

    // Same request again: answered from memory, Resend is not called again.
    const again = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Subject A', body: 'Body A', requestId } });
    assert.equal(again.data.data.repeatedRequest, true);
    assert.equal(fake.state.calls.length, 1);
    // Duplicate detection still applies.
    const dup = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(dup.data.error.code, 'ALREADY_SENT');
    assert.equal(fake.state.calls.length, 1);
  } finally {
    await srv.close();
  }
});

test('app with Resend: failures are never recorded as Success; uncertain sends count for duplicate checks', async () => {
  const { srv, fake, dataDir } = await resendServer();
  const send = (rowNumber) => srv.request('POST', '/api/send', { json: { rowNumber, subject: 'S', body: 'B', requestId: rid() } });
  try {
    fake.state.queue.push({ status: 429, json: { name: 'daily_quota_exceeded', message: 'quota' } });
    let r = await send(2);
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'SMTP_TEMPORARY');
    assert.match(r.data.error.message, /daily sending limit/);
    fake.state.queue.push({ status: 403, json: { name: 'validation_error', message: `The ${DOMAIN} domain is not verified.` } });
    r = await send(2);
    assert.equal(r.data.error.code, 'SENDER_REJECTED');
    fake.state.queue.push({ status: 401, json: { name: 'validation_error', message: 'API key is invalid' } });
    r = await send(2);
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'SMTP_AUTH_FAILED');
    let rows = await historyRows(dataDir);
    assert.deepEqual(rows.map((x) => x.Status), ['Failed', 'Failed', 'Failed']);
    assert.equal((await srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } })).data.data.alreadySent, false);
    // An auth failure shows up in the connection status.
    assert.equal((await srv.request('GET', '/api/smtp/status')).data.data.lastTest.code, 'SMTP_AUTH_FAILED');

    fake.state.queue.push({ error: netError('ECONNRESET') });
    r = await send(3);
    assert.equal(r.data.error.code, 'SMTP_UNCERTAIN');
    rows = await historyRows(dataDir);
    assert.equal(rows.at(-1).Status, 'Uncertain');
    assert.equal((await send(3)).data.error.code, 'ALREADY_SENT', 'uncertain send triggers the duplicate warning');
  } finally {
    await srv.close();
  }
});

test('app with Resend: status and Test Email Connection, without exposing the key', async () => {
  const { srv, fake } = await resendServer();
  try {
    let status = (await srv.request('GET', '/api/smtp/status')).data.data;
    assert.equal(status.configured, true);
    assert.equal(status.provider, 'resend');
    assert.equal(status.from, FROM);
    assert.equal(status.host, 'api.resend.com');
    assert.ok(!JSON.stringify(status).includes(KEY));

    fake.state.queue.push({ status: 200, json: { data: [{ name: DOMAIN, status: 'verified' }] } });
    status = (await srv.request('POST', '/api/smtp/test')).data.data;
    assert.equal(status.lastTest.ok, true);
    assert.match(status.lastTest.message, /Connected to Resend/);
    fake.state.queue.push({ status: 200, json: { data: [{ name: DOMAIN, status: 'failed' }] } });
    status = (await srv.request('POST', '/api/smtp/test')).data.data;
    assert.equal(status.lastTest.ok, false);
    assert.match(status.lastTest.message, /not verified/);
    assert.equal(fake.state.calls.filter((c) => c.url.endsWith('/emails')).length, 0, 'testing never sends an email');
  } finally {
    await srv.close();
  }

  // Not configured: the status says what is missing.
  const dataDir = await makeTempDir();
  const config = testConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '', SMTP_FROM: FROM });
  const srv2 = await startTestServer({ dataDir, config, mailer: createMailer(config) });
  try {
    const st = (await srv2.request('GET', '/api/smtp/status')).data.data;
    assert.equal(st.configured, false);
    assert.equal(st.provider, 'resend');
    assert.match(st.problems.join(), /RESEND_API_KEY/);
    assert.equal((await srv2.request('POST', '/api/smtp/test')).data.error.code, 'SMTP_NOT_CONFIGURED');
  } finally {
    await srv2.close();
  }
});
