import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { SAMPLE_ROWS, TEST_SENDER, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, smtpError, startTestServer, testConfig } from './helpers.js';

const TEST_PASS = 'fake-app-password-for-tests';
let n = 0;
const rid = () => `test-request-${Date.now()}-${(n += 1)}`;

async function setup() {
  const dataDir = await makeTempDir();
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp) });
  const up = await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  return { dataDir, smtp, srv };
}

const historyRows = async (dataDir) => {
  try {
    const wb = XLSX.read(await fs.readFile(path.join(dataDir, 'sent-emails.xlsx')));
    return XLSX.utils.sheet_to_json(wb.Sheets['Sent Emails']);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

test('upload returns records with auto-mapped fields and problems', async () => {
  const { srv } = await setup();
  try {
    const res = await srv.request('GET', '/api/excel/records');
    const d = res.data.data;
    assert.equal(d.loaded, true);
    assert.equal(d.totalRecords, 4);
    assert.equal(d.records.matched, 4);
    const rows = d.records.rows;
    assert.equal(rows.length, 4);
    assert.deepEqual(d.mappingErrors, []);
    assert.equal(rows[0].registrationNumber, 'REG-001');
    assert.equal(rows[0].recordId, 'REG-001');
    assert.equal(rows[0].idType, 'registration');
    assert.equal(rows[0].sentCount, 0);
    // A missing registration number is not a problem; a fallback identifier is used.
    assert.deepEqual(rows[2].problems, []);
    assert.equal(rows[2].idType, 'fallback');
    assert.match(rows[2].recordId, /^AUTO-[0-9A-F]{16}$/);
    assert.deepEqual(rows[3].problems, ['Invalid email address']);
    assert.ok(d.placeholders.some((p) => p.key === 'practiceArea'));
  } finally {
    await srv.close();
  }
});

test('invalid uploads give clear errors', async () => {
  const { srv } = await setup();
  try {
    let res = await srv.upload(Buffer.from('hello'), 'notes.txt');
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'INVALID_FILE_TYPE');
    res = await srv.upload(Buffer.from('hello'), 'fake.xlsx');
    assert.equal(res.data.error.code, 'INVALID_EXCEL');
    res = await srv.request('POST', '/api/excel/upload', { form: new FormData() });
    assert.equal(res.data.error.code, 'NO_FILE');
  } finally {
    await srv.close();
  }
});

test('mapping is validated, saved to disk and reused', async () => {
  const { srv, dataDir } = await setup();
  try {
    const bad = await srv.request('PUT', '/api/mapping', { json: { mapping: { attorneyName: 'Full Name', registrationNumber: 'Reg No', recipientEmail: '' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'INVALID_MAPPING');

    const mapping = { attorneyName: 'Full Name', registrationNumber: 'Reg No', recipientEmail: 'E-mail', firmName: 'Practice Area', city: '', state: '' };
    const good = await srv.request('PUT', '/api/mapping', { json: { mapping } });
    assert.equal(good.status, 200);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.mapping, mapping);

    const preview = await srv.request('POST', '/api/preview', { json: { rowNumber: 2 } });
    assert.equal(preview.data.data.attorneyName, 'Test Attorney One');
  } finally {
    await srv.close();
  }
});

test('preview fills the saved template from the selected row', async () => {
  const { srv } = await setup();
  try {
    await srv.request('PUT', '/api/template', {
      json: { template: { subject: 'Re: {{registrationNumber}} ({{city}})', greeting: 'Dear {{attorneyName}},', mainMessage: 'Firm: {{firmName}}. Area: {{practiceArea}}.', closing: 'Regards,', signature: 'Team' } },
    });
    const res = await srv.request('POST', '/api/preview', { json: { rowNumber: 3 } });
    const d = res.data.data;
    assert.equal(d.subject, 'Re: REG-002 (Shelbyville)');
    assert.equal(d.body, 'Dear Test Attorney Two,\n\nFirm: . Area: .\n\nRegards,\nTeam');
    assert.equal(d.recipientEmail, 'two@example.com');
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /firmName/);
  } finally {
    await srv.close();
  }
});

test('successful send uses SMTP over SSL once, records history after acceptance, never exposes the password', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    const check = await srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } });
    assert.equal(check.data.data.alreadySent, false);

    const res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Edited subject', body: 'Edited body', requestId: rid() } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.data.accepted, true);
    assert.equal(res.data.data.historySaved, true);
    assert.equal(res.data.data.entry.sendType, 'First Send');
    assert.ok(!JSON.stringify(res.data).includes(TEST_PASS));

    assert.equal(smtp.state.sent.length, 1);
    const opts = smtp.state.options.at(-1);
    assert.equal(opts.host, 'smtp.example.com');
    assert.equal(opts.port, 465);
    assert.equal(opts.secure, true);
    assert.deepEqual(opts.auth, { user: TEST_SENDER, pass: TEST_PASS });
    const msg = smtp.state.sent[0];
    assert.equal(msg.from, TEST_SENDER);
    assert.equal(msg.to, 'one@example.com');
    assert.equal(msg.subject, 'Edited subject');
    assert.equal(msg.text, 'Edited body');
    assert.equal(msg.html, undefined);
    assert.equal(smtp.state.closed, 1, 'connection is closed after sending');

    const rows = await historyRows(dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['Record ID'], 'REG-001');
    assert.equal(rows[0]['Registration Number'], 'REG-001');
    assert.equal(rows[0]['Attorney Name'], 'Test Attorney One');
    assert.equal(rows[0]['Recipient Email'], 'one@example.com');
    assert.equal(rows[0]['Firm Name'], 'Example Law LLP');
    assert.equal(rows[0].City, 'Springfield');
    assert.equal(rows[0].State, 'IL');
    assert.equal(rows[0].Subject, 'Edited subject');
    assert.equal(rows[0]['Sender Email'], TEST_SENDER);
    assert.equal(rows[0].Status, 'Success');
    assert.equal(rows[0]['Send Type'], 'First Send');
    assert.match(rows[0]['Sent At'], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  } finally {
    await srv.close();
  }
});

test('failed SMTP sends are recorded as Failed (never Success) and do not count as sent', async () => {
  const { srv, smtp, dataDir } = await setup();
  const send = () => srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
  try {
    smtp.state.sendQueue.push({ error: smtpError('EAUTH', { responseCode: 535, command: 'AUTH PLAIN', response: '535 5.7.8 Error: authentication failed' }) });
    let res = await send();
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'SMTP_AUTH_FAILED');
    assert.match(res.data.error.message, /App Password/);
    assert.match(res.data.error.message, /not sent/);
    assert.ok(!res.data.error.message.includes(TEST_PASS));

    smtp.state.sendQueue.push({ error: smtpError('EENVELOPE', { responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 Recipient address rejected' }) });
    res = await send();
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'INVALID_RECIPIENT');

    smtp.state.sendQueue.push({ info: { accepted: [], rejected: ['one@example.com'], messageId: '<x@example.com>' } });
    res = await send();
    assert.equal(res.data.error.code, 'INVALID_RECIPIENT');

    smtp.state.sendQueue.push({ error: smtpError('EENVELOPE', { responseCode: 553, command: 'MAIL FROM', response: '553 Sender address rejected' }) });
    res = await send();
    assert.equal(res.data.error.code, 'SENDER_REJECTED');

    smtp.state.sendQueue.push({ error: smtpError('ECONNECTION', { command: 'CONN', message: 'connect ECONNREFUSED' }) });
    res = await send();
    assert.equal(res.status, 503);
    assert.equal(res.data.error.code, 'SMTP_CONNECTION_FAILED');

    smtp.state.sendQueue.push({ error: smtpError('EMESSAGE', { responseCode: 451, command: 'DATA', response: '451 4.7.1 Ratelimit' }) });
    res = await send();
    assert.equal(res.data.error.code, 'SMTP_TEMPORARY');

    smtp.state.sendQueue.push({ error: smtpError('EMESSAGE', { responseCode: 554, command: 'DATA', response: '554 5.7.1 Message rejected as spam' }) });
    res = await send();
    assert.equal(res.data.error.code, 'SMTP_REJECTED');
    assert.match(res.data.error.message, /rejected as spam/);

    let rows = await historyRows(dataDir);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((r) => r.Status === 'Failed'), 'failed attempts are never marked as successful');
    assert.ok(rows.every((r) => r['Send Type'] === 'First Send'));
    let check = await srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } });
    assert.equal(check.data.data.alreadySent, false, 'failed attempts do not count as already sent');
    const records = await srv.request('GET', '/api/excel/records');
    assert.equal(records.data.data.records.rows[0].sentCount, 0);

    // A connection drop mid-transmission is "Uncertain" and DOES count, so the user is warned.
    smtp.state.sendQueue.push({ error: smtpError('ETIMEDOUT', { command: 'DATA', message: 'Timeout' }) });
    res = await send();
    assert.equal(res.data.error.code, 'SMTP_UNCERTAIN');
    assert.match(res.data.error.message, /may or may not have been sent/);
    rows = await historyRows(dataDir);
    assert.equal(rows.at(-1).Status, 'Uncertain');
    check = await srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } });
    assert.equal(check.data.data.alreadySent, true);
    assert.equal((await send()).data.error.code, 'ALREADY_SENT');
  } finally {
    await srv.close();
  }
});

test('duplicate is blocked without confirmation; confirmed resend is a separate event', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'First', body: 'B', requestId: rid() } });

    const check = await srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } });
    assert.equal(check.data.data.alreadySent, true);
    assert.equal(check.data.data.previous[0].recipientEmail, 'one@example.com');
    assert.equal(check.data.data.previous[0].status, 'Success');
    assert.ok(check.data.data.previous[0].sentAt);

    const blocked = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Second', body: 'B', requestId: rid() } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, 'ALREADY_SENT');
    assert.equal(blocked.data.error.details.previous.length, 1);
    assert.equal(smtp.state.sent.length, 1, 'nothing sent for a blocked duplicate');

    const resend = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Second', body: 'B', confirmResend: true, requestId: rid() } });
    assert.equal(resend.status, 200);
    assert.equal(resend.data.data.entry.sendType, 'Resend');

    const rows = await historyRows(dataDir);
    assert.deepEqual(rows.map((r) => [r.Subject, r['Send Type']]), [['First', 'First Send'], ['Second', 'Resend']]);

    const list = await srv.request('GET', '/api/history');
    assert.equal(list.data.data.entries.length, 2);
    assert.equal(list.data.data.entries[0].sendType, 'Resend', 'newest first');
  } finally {
    await srv.close();
  }
});

test('repeated or simultaneous clicks send only once', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    smtp.state.sendQueue.push({ delayMs: 150 });
    const requestId = rid();
    const payload = { json: { rowNumber: 3, subject: 'S', body: 'B', requestId } };
    const [a, b] = await Promise.all([srv.request('POST', '/api/send', payload), srv.request('POST', '/api/send', payload)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);

    // Same request ID again after completion returns the stored result without sending.
    const again = await srv.request('POST', '/api/send', payload);
    assert.equal(again.status, 200);
    assert.equal(again.data.data.repeatedRequest, true);

    // Two different request IDs at the same time for the same attorney: one is rejected.
    smtp.state.sendQueue.push({ delayMs: 150 });
    const [c, d] = await Promise.all([
      srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } }),
      srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } }),
    ]);
    assert.deepEqual([c.status, d.status].sort(), [200, 409]);

    assert.equal(smtp.state.sent.length, 2);
    assert.equal((await historyRows(dataDir)).length, 2);
  } finally {
    await srv.close();
  }
});

test('send validation: invalid email, empty subject/body, header injection, bad row', async () => {
  const { srv, smtp } = await setup();
  try {
    let res = await srv.request('POST', '/api/send', { json: { rowNumber: 6, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(res.data.error.code, 'INVALID_RECIPIENT');
    res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: ' ', body: 'B', requestId: rid() } });
    assert.equal(res.data.error.code, 'MISSING_SUBJECT');
    res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: '', requestId: rid() } });
    assert.equal(res.data.error.code, 'MISSING_BODY');
    res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'Hello\r\nBcc: x@example.com', body: 'B', requestId: rid() } });
    assert.equal(res.data.error.code, 'INVALID_SUBJECT', 'header injection through the subject is refused');
    res = await srv.request('POST', '/api/send', { json: { rowNumber: 999, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(res.status, 404);
    res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B' } });
    assert.equal(res.data.error.code, 'INVALID_REQUEST');

    assert.equal(smtp.state.sent.length, 0);
    assert.equal(smtp.state.options.length, 0, 'no SMTP connection is opened for invalid requests');
  } finally {
    await srv.close();
  }
});

test('history write failure after a successful send is a warning, not a failure', { skip: process.platform !== 'win32' && 'read-only file lock simulation is Windows-specific' }, async () => {
  const { srv, dataDir } = await setup();
  const file = path.join(dataDir, 'sent-emails.xlsx');
  try {
    await srv.request('POST', '/api/send', { json: { rowNumber: 3, subject: 'S', body: 'B', requestId: rid() } });
    await fs.chmod(file, 0o444); // simulate the workbook being locked by Excel
    const res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.accepted, true);
    assert.equal(res.data.data.historySaved, false);
    assert.match(res.data.data.historyWarning, /accepted by the mail server/);
    // The pending record still prevents an accidental duplicate.
    const again = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(again.data.error.code, 'ALREADY_SENT');
  } finally {
    await fs.chmod(file, 0o666).catch(() => {});
    await srv.close();
  }
});

test('sending is blocked while the history workbook is corrupted', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    await fs.writeFile(path.join(dataDir, 'sent-emails.xlsx'), 'garbage');
    const res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(res.status, 500);
    assert.equal(res.data.error.code, 'HISTORY_CORRUPT');
    assert.equal(smtp.state.sent.length, 0);
  } finally {
    await srv.close();
  }
});

test('sending is refused with a clear message when SMTP is not configured', async () => {
  const dataDir = await makeTempDir();
  const srv = await startTestServer({ dataDir, mailer: null, config: testConfig({ SMTP_PASS: '' }) });
  try {
    await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const res = await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(res.status, 503);
    assert.equal(res.data.error.code, 'SMTP_NOT_CONFIGURED');
  } finally {
    await srv.close();
  }
});
