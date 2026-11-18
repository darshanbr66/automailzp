import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { SmtpMailer, mapSmtpError } from '../src/email.js';
import { TEST_SENDER, fakeTransport, makeMailer, makeTempDir, smtpError, startTestServer, testConfig } from './helpers.js';

const TEST_PASS = 'fake-app-password-for-tests';

test('config: Hostinger defaults, placeholders and validation', () => {
  const c = loadConfig({ SMTP_USER: 'mailbox@example.com', SMTP_PASS: TEST_PASS });
  assert.equal(c.smtpConfigured, true);
  assert.deepEqual(c.smtp, { host: 'smtp.hostinger.com', port: 465, secure: true, user: 'mailbox@example.com', pass: TEST_PASS, from: 'mailbox@example.com' });

  const empty = loadConfig({ SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'mailbox@example.com', SMTP_PASS: '' });
  assert.equal(empty.smtpConfigured, false);
  assert.ok(empty.problems.some((p) => /SMTP_PASS/.test(p)));

  const placeholder = loadConfig({ SMTP_USER: 'mailbox@example.com', SMTP_PASS: '   ' });
  assert.equal(placeholder.smtpConfigured, false);

  const wrongSsl = loadConfig({ SMTP_PORT: '465', SMTP_SECURE: 'false', SMTP_USER: 'mailbox@example.com', SMTP_PASS: TEST_PASS });
  assert.ok(wrongSsl.problems.some((p) => /SMTP_SECURE/.test(p)));

  const badUser = loadConfig({ SMTP_USER: 'mailbox', SMTP_PASS: TEST_PASS });
  assert.ok(badUser.problems.some((p) => /SMTP_USER/.test(p)));

  const otherFrom = loadConfig({ SMTP_USER: 'mailbox@example.com', SMTP_FROM: 'other@example.com', SMTP_PASS: TEST_PASS });
  assert.equal(otherFrom.smtpConfigured, true);
  assert.ok(otherFrom.warnings.some((w) => /SMTP_FROM/.test(w)));
});

test('mailer uses SSL on 465, STARTTLS on 587, and never reveals the password', () => {
  const fake = fakeTransport();
  const ssl = makeMailer(fake);
  ssl.transport();
  assert.equal(fake.state.options[0].secure, true);
  assert.equal(fake.state.options[0].requireTLS, false);
  assert.equal(fake.state.options[0].tls.minVersion, 'TLSv1.2');
  assert.ok(!JSON.stringify(ssl.publicInfo()).includes(TEST_PASS));

  const tls = new SmtpMailer(testConfig({ SMTP_PORT: '587', SMTP_SECURE: 'false' }).smtp, { createTransport: fake.createTransport });
  tls.transport();
  assert.equal(fake.state.options[1].port, 587);
  assert.equal(fake.state.options[1].secure, false);
  assert.equal(fake.state.options[1].requireTLS, true);
});

test('SMTP errors are mapped to clear messages', () => {
  const smtp = { host: 'smtp.hostinger.com', user: 'mailbox@example.com', from: 'mailbox@example.com' };
  const auth = mapSmtpError(smtpError('EAUTH', { responseCode: 535, command: 'AUTH PLAIN' }), 'verify', smtp);
  assert.equal(auth.code, 'SMTP_AUTH_FAILED');
  assert.match(auth.message, /mailbox@example\.com/);
  assert.match(auth.message, /not your hPanel/);
  assert.doesNotMatch(auth.message, /not sent/, 'a connection test never sends');
  assert.equal(mapSmtpError(smtpError('EDNS', { message: 'getaddrinfo ENOTFOUND' }), 'verify', smtp).code, 'SMTP_CONNECTION_FAILED');
  assert.match(mapSmtpError(smtpError('ETLS', { command: 'CONN' }), 'verify', smtp).message, /SSL\/TLS/);
  assert.equal(mapSmtpError(smtpError('ETIMEDOUT', { command: 'CONN' }), 'send', smtp).code, 'SMTP_CONNECTION_FAILED');
  assert.equal(mapSmtpError(smtpError('ESOCKET', {}), 'send', smtp).code, 'SMTP_UNCERTAIN');
  // A raw connection reset while the message is transmitted may still have delivered it.
  assert.equal(mapSmtpError(smtpError('ECONNRESET', { command: 'DATA' }), 'send', smtp).code, 'SMTP_UNCERTAIN');
  assert.equal(mapSmtpError(smtpError('ECONNRESET', { command: 'MAIL FROM' }), 'send', smtp).code, 'SMTP_CONNECTION_FAILED');
  assert.equal(mapSmtpError(new Error('weird'), 'send', smtp).code, 'SMTP_ERROR');
});

test('status endpoint shows sender and configuration without the password', async () => {
  const dataDir = await makeTempDir();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(fakeTransport()) });
  try {
    const res = await srv.request('GET', '/api/smtp/status');
    assert.equal(res.status, 200);
    const d = res.data.data;
    assert.equal(d.configured, true);
    assert.equal(d.from, TEST_SENDER);
    assert.equal(d.user, TEST_SENDER);
    assert.equal(d.host, 'smtp.example.com');
    assert.equal(d.port, 465);
    assert.equal(d.secure, true);
    assert.equal(d.lastTest, null);
    for (const path of ['/api/smtp/status', '/api/status']) {
      const r = await srv.request('GET', path);
      assert.ok(!JSON.stringify(r.data).includes(TEST_PASS), `${path} must not contain the password`);
      assert.ok(!/"pass"/.test(JSON.stringify(r.data)));
    }
  } finally {
    await srv.close();
  }
});

test('Test SMTP Connection reports success and authentication failure', async () => {
  const dataDir = await makeTempDir();
  const fake = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(fake) });
  try {
    let res = await srv.request('POST', '/api/smtp/test');
    assert.equal(res.status, 200);
    assert.equal(res.data.data.lastTest.ok, true);
    assert.match(res.data.data.lastTest.message, /logged in/);
    assert.equal(fake.state.verifies, 1);
    assert.equal(fake.state.sent.length, 0, 'the connection test sends no email');

    fake.state.verifyQueue.push({ verifyError: smtpError('EAUTH', { responseCode: 535, command: 'AUTH PLAIN', response: '535 5.7.8 Error: authentication failed' }) });
    res = await srv.request('POST', '/api/smtp/test');
    assert.equal(res.status, 200);
    assert.equal(res.data.data.lastTest.ok, false);
    assert.equal(res.data.data.lastTest.code, 'SMTP_AUTH_FAILED');
    assert.match(res.data.data.lastTest.message, /App Password/);
    assert.ok(!JSON.stringify(res.data).includes(TEST_PASS));

    // The result is remembered for the status display.
    res = await srv.request('GET', '/api/smtp/status');
    assert.equal(res.data.data.lastTest.code, 'SMTP_AUTH_FAILED');

    // Simultaneous clicks share one connection attempt.
    fake.state.verifyQueue.push({ delayMs: 100 });
    await Promise.all([srv.request('POST', '/api/smtp/test'), srv.request('POST', '/api/smtp/test')]);
    assert.equal(fake.state.verifies, 3);
  } finally {
    await srv.close();
  }
});

test('Test SMTP Connection explains missing configuration', async () => {
  const dataDir = await makeTempDir();
  const srv = await startTestServer({ dataDir, mailer: null, config: testConfig({ SMTP_PASS: '' }) });
  try {
    const status = await srv.request('GET', '/api/smtp/status');
    assert.equal(status.data.data.configured, false);
    assert.ok(status.data.data.problems.some((p) => /SMTP_PASS/.test(p)));
    const res = await srv.request('POST', '/api/smtp/test');
    assert.equal(res.status, 503);
    assert.equal(res.data.error.code, 'SMTP_NOT_CONFIGURED');
    assert.match(res.data.error.message, /SMTP_PASS/);
  } finally {
    await srv.close();
  }
});

test('state-changing requests need the app header and an allowed origin', async () => {
  const dataDir = await makeTempDir();
  const fake = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(fake) });
  try {
    let res = await srv.request('POST', '/api/smtp/test', { csrf: false });
    assert.equal(res.status, 403);
    res = await srv.request('POST', '/api/smtp/test', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    res = await srv.request('POST', '/api/send', { csrf: false, json: { rowNumber: 2, subject: 'S', body: 'B', requestId: 'abcdefgh-1234' } });
    assert.equal(res.status, 403);
    res = await srv.request('POST', '/api/smtp/test', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200);
    assert.equal(fake.state.verifies, 1);
  } finally {
    await srv.close();
  }
});

test('requests with a foreign Host header are rejected (DNS rebinding)', async () => {
  const dataDir = await makeTempDir();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(fakeTransport()) });
  try {
    const status = await new Promise((resolve, reject) => {
      const u = new URL(srv.base);
      http
        .get({ host: u.hostname, port: u.port, path: '/api/smtp/status', headers: { host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(status, 403);
  } finally {
    await srv.close();
  }
});

test('real Nodemailer against a local fake SMTP server: wrong App Password and refused connection', async () => {
  const net = await import('node:net');
  const nodemailer = (await import('nodemailer')).default;
  // Minimal local SMTP server that always rejects the login. Nothing leaves this computer.
  const server = net.createServer((socket) => {
    socket.write('220 fake.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of String(chunk).split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(line)) socket.write('250-fake.local\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) socket.write('535 5.7.8 Error: authentication failed\r\n');
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('502 5.5.2 Error: command not recognized\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // The test server has no TLS, so only here is the TLS requirement relaxed.
  const plain = (o) => nodemailer.createTransport({ ...o, secure: false, requireTLS: false, ignoreTLS: true });
  try {
    const mailer = new SmtpMailer({ host: '127.0.0.1', port, secure: true, user: 'mailbox@example.com', pass: TEST_PASS, from: 'mailbox@example.com' }, { createTransport: plain });
    await assert.rejects(mailer.verify(), (e) => e.code === 'SMTP_AUTH_FAILED');
    await assert.rejects(mailer.send({ to: 'one@example.com', subject: 'S', body: 'B' }), (e) => e.code === 'SMTP_AUTH_FAILED' && /not sent/.test(e.message));
  } finally {
    await new Promise((r) => server.close(r));
  }
  const closed = new SmtpMailer({ host: '127.0.0.1', port, secure: true, user: 'mailbox@example.com', pass: TEST_PASS, from: 'mailbox@example.com' }, { createTransport: plain, timeouts: { connectionTimeout: 3000 } });
  await assert.rejects(closed.verify(), (e) => e.code === 'SMTP_CONNECTION_FAILED');
});
