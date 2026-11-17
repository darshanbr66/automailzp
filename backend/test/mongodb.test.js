// MongoDB storage, run against an in-memory MongoDB (mongodb-memory-server):
// Atlas is never contacted and no email is ever sent (mocked transport).
// Two app instances on one database stand in for two server processes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createMongoStorage, COLLECTIONS, LOCK_STALE_MS } from '../src/storage/mongo.js';
import { HistoryStore } from '../src/history.js';
import { backup, legacyLocalToUtc, migrate } from '../src/migrate.js';
import { parseUserAgent } from '../src/useragent.js';
import { reportedClientIp } from '../src/audit.js';
import { SAMPLE_ROWS, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, startTestServer, testConfig } from './helpers.js';

let mongod;
let uri;
const clients = [];
before(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await mongod?.stop();
});

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ALICE = { 'x-operator': 'Team Member 1', 'user-agent': CHROME_WIN };
const BOB = { 'x-operator': 'Team Member 2', 'user-agent': SAFARI_IPHONE };
let n = 0;
const rid = () => `mongo-test-${Date.now()}-${(n += 1)}`;
const dbName = () => `test_${crypto.randomBytes(6).toString('hex')}`;

/** One app "process" on the shared database. */
async function instance(name, { headers = ALICE, smtp = fakeTransport(), config = testConfig() } = {}) {
  const dataDir = await makeTempDir();
  const storage = createMongoStorage({ uri, dbName: name, dataDir });
  clients.push(storage.client);
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp, config), config, storage, headers });
  return { srv, smtp, storage, dataDir };
}
const db = async (name) => {
  const c = await MongoClient.connect(uri);
  clients.push(c);
  return c.db(name);
};
const send = (srv, rowNumber, extra = {}) => srv.request('POST', '/api/send', { json: { rowNumber, subject: 'Subject', body: 'Body', requestId: rid(), ...extra } });

// ---------------------------------------------------------------------------
test('indexes: unique keys for workbook rows, success-per-request, legacy rows and in-flight claims', async () => {
  const name = dbName();
  const { srv, storage } = await instance(name);
  try {
    await storage.init();
    const d = await db(name);
    const idx = async (c) => Object.fromEntries((await d.collection(c).indexes()).map((i) => [i.name, i]));
    assert.equal((await idx(COLLECTIONS.attorneys)).workbook_row_unique.unique, true);
    const h = await idx(COLLECTIONS.history);
    assert.equal(h.success_request_unique.unique, true);
    assert.deepEqual(h.success_request_unique.partialFilterExpression, { status: 'Success', requestId: { $type: 'string' } });
    assert.equal(h.legacy_unique.unique, true);
    const p = await idx(COLLECTIONS.pending);
    assert.equal(p.record_unique.unique, true);
    assert.equal(p.email_unique.unique, true);
    assert.ok((await idx(COLLECTIONS.activity)).operator_date);
  } finally {
    await srv.close();
  }
});

test('the workbook, mapping and template are shared and survive a restart', async () => {
  const name = dbName();
  const a = await instance(name);
  assert.equal((await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);
  const before = (await a.srv.request('GET', '/api/excel/records')).data.data;
  const mapping = (await a.srv.request('GET', '/api/mapping')).data.data.mapping;
  assert.equal((await a.srv.request('PUT', '/api/mapping', { json: { mapping: { ...mapping, firmName: 'Practice Area' } } })).status, 200);
  const tpl = { subject: 'Hello {{attorneyName}}', greeting: 'Dear {{attorneyName}},', mainMessage: 'Body', closing: 'Regards,', signature: 'ZodiacPatent Team' };
  assert.equal((await a.srv.request('PUT', '/api/template', { json: { template: tpl } })).status, 200);
  await a.srv.close();

  // "Restart": a brand-new process with an empty memory.
  const b = await instance(name, { headers: BOB });
  try {
    const after = (await b.srv.request('GET', '/api/excel/records')).data.data;
    assert.equal(after.loaded, true);
    assert.equal(after.totalRecords, before.totalRecords);
    assert.equal(after.workbookVersion, before.workbookVersion, 'same shared workbook version');
    assert.equal(after.mapping.firmName, 'Practice Area');
    assert.deepEqual((await b.srv.request('GET', '/api/template')).data.data.template, tpl);
    // A send works straight after the restart, without uploading again.
    const r = await send(b.srv, 2);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(b.smtp.state.sent[0].to, 'one@example.com');
  } finally {
    await b.srv.close();
  }
});

test('two processes, same attorney, same moment: exactly one email', async () => {
  const name = dbName();
  const slow = () => {
    const s = fakeTransport();
    s.state.sendQueue.push({ delayMs: 300 });
    return s;
  };
  const a = await instance(name, { smtp: slow() });
  const b = await instance(name, { headers: BOB, smtp: slow() });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const [ra, rb] = await Promise.all([send(a.srv, 2), send(b.srv, 2)]);
    const codes = [ra, rb].map((r) => r.data.error?.code || 'SENT').sort();
    assert.ok(codes[0] === 'SENT' || codes[1] === 'SENT', JSON.stringify(codes));
    assert.ok(['SEND_IN_PROGRESS', 'ALREADY_SENT'].includes(codes.find((c) => c !== 'SENT')), JSON.stringify(codes));
    assert.equal(a.smtp.state.sent.length + b.smtp.state.sent.length, 1, 'one email in total');
    const d = await db(name);
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({ status: 'Success' }), 1);
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0, 'claims are released');

    // Afterwards, either process sees the send and warns.
    assert.equal((await send(a.srv, 2)).data.error.code, 'ALREADY_SENT');
    assert.equal((await send(b.srv, 2)).data.error.code, 'ALREADY_SENT');
    // Two rows with the same address at the same time (different processes): one at a time.
    const rows = [['Full Name', 'Reg No', 'E-mail'], ['Pat One', '', 'shared@example.com'], ['Pat Two', '', 'shared@example.com']];
    await a.srv.upload(makeWorkbookBuffer(rows));
    a.smtp.state.sendQueue.push({ delayMs: 300 });
    b.smtp.state.sendQueue.push({ delayMs: 300 });
    const pair = await Promise.all([send(a.srv, 2), send(b.srv, 3)]);
    assert.equal(pair.filter((r) => r.status === 200).length, 1, JSON.stringify(pair.map((r) => r.data.error?.code || 'SENT')));
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('stale selection across processes: B replaces the workbook, A\'s send is refused', async () => {
  const name = dbName();
  const a = await instance(name);
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const p = (await a.srv.request('POST', '/api/preview', { json: { rowNumber: 2 } })).data.data;
    const expected = { workbookVersion: p.workbookVersion, mappingVersion: p.mappingVersion, recordId: p.recordId, recipientEmail: p.recipientEmail };
    await b.srv.upload(makeWorkbookBuffer([SAMPLE_ROWS[0], SAMPLE_ROWS[2], SAMPLE_ROWS[1]]));
    const r = await a.srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid(), expected } });
    assert.equal(r.data.error.code, 'STALE_SELECTION');
    assert.equal(a.smtp.state.sent.length, 0);
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('operator is required (self-declared, from the configured list) for audited actions', async () => {
  const name = dbName();
  const a = await instance(name, { headers: {} });
  try {
    let r = await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    assert.equal(r.data.error.code, 'OPERATOR_REQUIRED');
    r = await a.srv.request('POST', '/api/excel/upload', { form: (() => { const f = new FormData(); f.append('file', new Blob([makeWorkbookBuffer(SAMPLE_ROWS)]), 'a.xlsx'); return f; })(), headers: { 'x-operator': 'Somebody Else' } });
    assert.equal(r.data.error.code, 'OPERATOR_REQUIRED', 'names not on the list are refused');
    r = await a.srv.request('POST', '/api/excel/upload', { form: (() => { const f = new FormData(); f.append('file', new Blob([makeWorkbookBuffer(SAMPLE_ROWS)]), 'a.xlsx'); return f; })(), headers: { 'x-operator': encodeURIComponent('team member 1') } });
    assert.equal(r.status, 200, 'case-insensitive match');
    const s = await a.srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } });
    assert.equal(s.data.error.code, 'OPERATOR_REQUIRED');
    assert.equal(a.smtp.state.sent.length, 0);
    const cfg = (await a.srv.request('GET', '/api/app/config')).data.data;
    assert.deepEqual(cfg, { storage: 'mongodb', features: cfg.features, teamMembers: ['Team Member 1', 'Team Member 2'], operatorIdentification: 'self-declared', historyLabel: 'MongoDB collection "email_history"' });
    assert.ok(!JSON.stringify(cfg).includes('mongodb://'));
  } finally {
    await a.srv.close();
  }
});

// ---------------------------------------------------------------------------
test('activity log: operator (self-declared), reported IP, device details, UTC time, attorney, linked history', async () => {
  const name = dbName();
  const a = await instance(name, { config: testConfig({ AUDIT_CLIENT_IP_HOPS: '1' }) });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const r = await a.srv.request('POST', '/api/send', {
      json: { rowNumber: 2, subject: 'Subject', body: 'Body', requestId: rid() },
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-vercel-ip-city': 'Pune', 'x-vercel-ip-country-region': 'MH', 'x-vercel-ip-country': 'IN' },
    });
    assert.equal(r.status, 200);
    const list = (await a.srv.request('GET', '/api/activity')).data.data;
    assert.equal(list.available, true);
    const sent = list.items.find((i) => i.action === 'email_sent');
    assert.equal(sent.operator, 'Team Member 1');
    assert.equal(sent.operatorIdType, 'self-declared');
    assert.equal(sent.ip, '203.0.113.9');
    assert.match(sent.ipNote, /not proof of identity/);
    assert.equal(sent.os, 'Windows 10 or 11');
    assert.equal(sent.browser, 'Chrome 131.0.0.0');
    assert.equal(sent.deviceType, 'desktop or laptop');
    assert.deepEqual({ ...sent.location, source: undefined }, { available: true, city: 'Pune', region: 'MH', country: 'IN', source: undefined });
    assert.match(sent.atUtc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(sent.attorney.name, 'Test Attorney One');
    assert.equal(sent.attorney.registrationNumber, 'REG-001');
    assert.equal(sent.attorney.recipientEmail, 'one@example.com');
    const hist = (await a.srv.request('GET', '/api/history')).data.data.entries;
    assert.equal(sent.historyId, hist[0].id, 'activity is linked to the history record');
    assert.equal(hist[0].operator, 'Team Member 1');
    assert.equal(hist[0].sendMethod, 'SMTP');
    const upload = list.items.find((i) => i.action === 'workbook_uploaded');
    assert.equal(upload.location.available, false, 'no geolocation headers -> unavailable, not guessed');
  } finally {
    await a.srv.close();
  }
});

test('failed and uncertain sends are recorded with their activity; never as Success', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const { smtpError } = await import('./helpers.js');
    a.smtp.state.sendQueue.push({ error: smtpError('EENVELOPE', { responseCode: 550, command: 'RCPT TO', response: '550 nope' }) });
    assert.equal((await send(a.srv, 2)).data.error.code, 'INVALID_RECIPIENT');
    a.smtp.state.sendQueue.push({ error: smtpError('ETIMEDOUT', { command: 'DATA', message: 'Timeout' }) });
    assert.equal((await send(a.srv, 3)).data.error.code, 'SMTP_UNCERTAIN');
    const h = (await a.srv.request('GET', '/api/history')).data.data.entries;
    assert.deepEqual(h.map((e) => e.status).sort(), ['Failed', 'Uncertain']);
    const acts = (await a.srv.request('GET', '/api/activity')).data.data.items.map((i) => i.action);
    assert.ok(acts.includes('email_failed') && acts.includes('email_uncertain'));
    const stats = (await a.srv.request('GET', '/api/stats?tz=Asia/Kolkata')).data.data;
    assert.equal(stats.totalSent, 0);
    assert.equal(stats.failed, 1);
    assert.equal(stats.uncertain, 1);
    assert.equal((await send(a.srv, 3)).data.error.code, 'ALREADY_SENT', 'uncertain still blocks a repeat');
  } finally {
    await a.srv.close();
  }
});

// ---------------------------------------------------------------------------
async function selection(srv, rowNumber) {
  const p = (await srv.request('POST', '/api/preview', { json: { rowNumber } })).data.data;
  return { workbookVersion: p.workbookVersion, mappingVersion: p.mappingVersion, recordId: p.recordId, recipientEmail: p.recipientEmail };
}

test('manual "Mark as sent": recorded once, shown everywhere, and blocks an accidental app send', async () => {
  const name = dbName();
  const a = await instance(name);
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const missing = await a.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 2 } });
    assert.equal(missing.data.error.code, 'STALE_SELECTION', 'needs the same selection check as sending');

    const [ea, eb] = [await selection(a.srv, 2), await selection(b.srv, 2)];
    const both = await Promise.all([
      a.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 2, expected: ea, note: 'Called by phone' } }),
      b.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 2, expected: eb } }),
    ]);
    assert.equal(both.filter((r) => r.status === 200).length, 1, JSON.stringify(both.map((r) => r.data.error?.code || 'OK')));
    assert.ok(['ALREADY_SENT', 'SEND_IN_PROGRESS'].includes(both.find((r) => r.status !== 200).data.error.code));

    const rec = (await b.srv.request('GET', '/api/excel/records')).data.data.records.rows[0];
    assert.equal(rec.sentCount, 1);
    assert.equal(rec.sentInfo.manual, 1);
    assert.equal(rec.sentInfo.lastMethod, 'Manual');
    const sentList = (await b.srv.request('GET', '/api/sent')).data.data;
    assert.equal(sentList.total, 1);
    assert.equal(sentList.items[0].sendMethod, 'Manual');
    assert.ok(['Team Member 1', 'Team Member 2'].includes(sentList.items[0].operator));
    assert.equal((await b.srv.request('GET', '/api/stats')).data.data.manual, 1);

    // The app won't email a manually contacted attorney without the resend confirmation.
    const r = await send(b.srv, 2);
    assert.equal(r.data.error.code, 'ALREADY_SENT');
    assert.equal(b.smtp.state.sent.length, 0);
    // Marking again is refused.
    const again = await a.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 2, expected: await selection(a.srv, 2) } });
    assert.equal(again.data.error.code, 'ALREADY_SENT');
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('corrections are audited and never delete history', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    await a.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 2, expected: await selection(a.srv, 2) } });
    const id = (await a.srv.request('GET', '/api/history')).data.data.entries[0].id;
    assert.equal((await a.srv.request('POST', `/api/history/${id}/correct`, { json: { action: 'void', reason: '' } })).data.error.code, 'REASON_REQUIRED');
    const v = await a.srv.request('POST', `/api/history/${id}/correct`, { json: { action: 'void', reason: 'Marked the wrong attorney' } });
    assert.equal(v.status, 200);
    assert.equal(v.data.data.entry.voided, true);
    assert.equal((await a.srv.request('POST', `/api/history/${id}/correct`, { json: { action: 'void', reason: 'again' } })).data.error.code, 'ALREADY_VOIDED');
    const h = (await a.srv.request('GET', '/api/history')).data.data.entries;
    assert.equal(h.length, 1, 'the record is kept');
    assert.equal(h[0].void.reason, 'Marked the wrong attorney');
    assert.equal(h[0].void.operator, 'Team Member 1');
    assert.equal((await a.srv.request('GET', '/api/sent')).data.data.total, 0, 'voided records are not "sent"');
    assert.equal((await a.srv.request('GET', '/api/excel/records')).data.data.records.rows[0].sentCount, 0);
    // The attorney can be emailed again now.
    assert.equal((await send(a.srv, 2)).status, 200);
    const act = (await a.srv.request('GET', '/api/activity?action=history_corrected')).data.data.items[0];
    assert.deepEqual(act.details.before, { status: 'Success', voided: false });
    assert.deepEqual(act.details.after, { status: 'Success', voided: true });

    // Uncertain -> confirmed sent / not sent.
    const { smtpError } = await import('./helpers.js');
    a.smtp.state.sendQueue.push({ error: smtpError('ETIMEDOUT', { command: 'DATA', message: 'Timeout' }) });
    await send(a.srv, 3);
    const uncertain = (await a.srv.request('GET', '/api/history')).data.data.entries.find((e) => e.status === 'Uncertain');
    const c = await a.srv.request('POST', `/api/history/${uncertain.id}/correct`, { json: { action: 'confirm-not-sent', reason: 'Not in the Resend dashboard' } });
    assert.equal(c.data.data.entry.status, 'Failed');
    assert.equal(c.data.data.entry.resolution.previousStatus, 'Uncertain');
    assert.equal((await a.srv.request('POST', `/api/history/${uncertain.id}/correct`, { json: { action: 'confirm-sent', reason: 'x y z' } })).data.error.code, 'NOT_UNCERTAIN');
  } finally {
    await a.srv.close();
  }
});

test('a send interrupted by a stopped server is recorded as Uncertain (never lost) and blocks repeats meanwhile', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    // Simulate a process that claimed the attorney and then died mid-send.
    const entry = { recordId: 'REG-001', attorneyName: 'Test Attorney One', recipientEmail: 'one@example.com', registrationNumber: 'REG-001', subject: 'S', sentAt: '2026-01-01 10:00:00', status: 'Uncertain', sendMethod: 'Resend', operator: 'Team Member 2', requestId: 'dead-process-request' };
    await a.storage.locks.acquire({ recordKey: 'REG-001', emailKey: 'one@example.com', requestId: 'dead-process-request', kind: 'send', entry });
    const blocked = await send(a.srv, 2);
    assert.equal(blocked.data.error.code, 'SEND_IN_PROGRESS', 'still blocked while the outcome is unknown');
    assert.equal(await a.storage.locks.sweep(Date.now()), 0, 'fresh claims are left alone');
    assert.equal(await a.storage.locks.sweep(Date.now() + LOCK_STALE_MS + 1000), 1);
    const h = (await a.srv.request('GET', '/api/history')).data.data.entries;
    assert.equal(h[0].status, 'Uncertain');
    assert.match(h[0].note, /server stopped/);
    assert.equal((await send(a.srv, 2)).data.error.code, 'ALREADY_SENT', 'the uncertain record now triggers the duplicate warning');
  } finally {
    await a.srv.close();
  }
});

test('if MongoDB fails after the email was sent, the record is kept locally and written later', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const d = await db(name);
    // Make the history collection reject new documents for a moment.
    await d.command({ collMod: COLLECTIONS.history, validator: { subject: { $ne: 'Subject' } }, validationAction: 'error' });
    const r = await send(a.srv, 2);
    assert.equal(r.status, 200, 'the email was sent, so the user is told so');
    assert.equal(r.data.data.historySaved, false);
    assert.match(r.data.data.historyWarning, /kept on the server/);
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({ status: 'Success' }), 0);
    // Still counts for duplicates meanwhile.
    assert.equal((await send(a.srv, 2)).data.error.code, 'ALREADY_SENT');
    await d.command({ collMod: COLLECTIONS.history, validator: {} });
    await a.srv.request('GET', '/api/history'); // next read flushes the kept record
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({ status: 'Success' }), 1);
  } finally {
    await a.srv.close();
  }
});

test('database unreachable: actions are refused with a clear message and nothing is sent', async () => {
  const dataDir = await makeTempDir();
  const client = new MongoClient('mongodb://127.0.0.1:1', { serverSelectionTimeoutMS: 300 });
  clients.push(client);
  const storage = createMongoStorage({ dbName: 'unreachable', dataDir, client });
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp), storage, headers: ALICE });
  try {
    const r = await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'DB_UNAVAILABLE');
    assert.ok(!JSON.stringify(r.data).includes('127.0.0.1:1'));
    assert.equal((await srv.request('GET', '/api/excel/records')).status, 503);
    assert.equal(smtp.state.sent.length, 0);
  } finally {
    await srv.close();
  }
});

test('Sent Emails list, statistics and Excel export', async () => {
  const name = dbName();
  const a = await instance(name);
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    assert.equal((await send(a.srv, 2)).status, 200);
    assert.equal((await send(b.srv, 3)).status, 200);
    await b.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 5, expected: await selection(b.srv, 5) } });
    const list = (await a.srv.request('GET', '/api/sent?pageSize=5')).data.data;
    assert.equal(list.total, 3);
    assert.deepEqual(list.operators, ['Team Member 1', 'Team Member 2']);
    assert.match(list.items[0].sentAtUtc, /Z$/);
    assert.equal((await a.srv.request('GET', '/api/sent?operator=Team%20Member%202')).data.data.total, 2);
    assert.equal((await a.srv.request('GET', '/api/sent?method=Manual')).data.data.total, 1);
    assert.equal((await a.srv.request('GET', '/api/sent?q=two%40example')).data.data.total, 1);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assert.equal((await a.srv.request('GET', `/api/sent?tz=Asia/Kolkata&from=${today}&to=${today}`)).data.data.total, 3);
    assert.equal((await a.srv.request('GET', '/api/sent?from=2000-01-01&to=2000-01-02')).data.data.total, 0);

    const s = (await a.srv.request('GET', '/api/stats?tz=Asia/Kolkata')).data.data;
    assert.equal(s.totalSent, 3);
    assert.equal(s.manual, 1);
    assert.equal(s.smtp, 2);
    assert.equal(s.today, 3);
    assert.deepEqual(s.byOperator.map((o) => [o.operator, o.sent, o.manual]).sort(), [['Team Member 1', 1, 0], ['Team Member 2', 1, 1]]);

    const res = await fetch(`${a.srv.base}/api/history/export`);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const rows = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await res.arrayBuffer())).Sheets['Sent Emails']);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r['Sent At UTC'] && r.Operator && r['Send Method']));
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('no API keys, passwords or connection strings are stored in MongoDB', async () => {
  const name = dbName();
  const config = testConfig({ SMTP_PASS: 'super-secret-smtp-password' });
  const a = await instance(name, { config });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    await send(a.srv, 2);
    const d = await db(name);
    for (const c of Object.values(COLLECTIONS)) {
      const text = JSON.stringify(await d.collection(c).find({}).toArray());
      assert.ok(!text.includes('super-secret-smtp-password') && !text.includes(uri) && !/re_[A-Za-z0-9]{8,}/.test(text), c);
    }
  } finally {
    await a.srv.close();
  }
});

// ---------------------------------------------------------------------------
test('migration: backup first, import once (repeatable), never changes the source files', async () => {
  const name = dbName();
  const dataDir = await makeTempDir();
  const store = new HistoryStore(dataDir);
  const row = (o) => ({ recordId: 'REG-1', registrationNumber: 'REG-1', attorneyName: 'Old One', recipientEmail: 'old1@example.com', firmName: '', city: '', state: '', subject: 'Hi', sentAt: '2026-01-01 10:00:00', senderEmail: 'x@zodiacpatent.example', status: 'Success', sendType: 'First Send', ...o });
  await store.append(row());
  await store.append(row({ recordId: 'REG-2', attorneyName: 'Old Two', recipientEmail: 'old2@example.com', status: 'Uncertain', sentAt: '2026-01-02 09:30:00' }));
  await store.append(row()); // a genuinely repeated row is kept
  await fs.writeFile(path.join(dataDir, 'sent-emails-pending.json'), JSON.stringify([row({ recordId: 'REG-3', attorneyName: 'Pending Three', recipientEmail: 'p3@example.com', sentAt: '2026-01-03 12:00:00' })]));
  await fs.writeFile(path.join(dataDir, 'template.json'), JSON.stringify({ subject: 'Legacy {{attorneyName}}', greeting: 'Hi', mainMessage: 'Text', closing: 'Bye', signature: 'ZodiacPatent Team' }));
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ mapping: { attorneyName: 'Full Name', registrationNumber: 'Reg No', recipientEmail: 'E-mail', firmName: '', city: '', state: '' } }));
  // Production export from /api/history (newest first; times are Render's UTC clock). REG-1's first row also appears here.
  const exportPath = path.join(dataDir, 'prod-history.json');
  await fs.writeFile(exportPath, JSON.stringify({ ok: true, data: { entries: [row({ recordId: 'REG-9', attorneyName: 'Prod Nine', recipientEmail: 'p9@example.com', sentAt: '2026-02-01 08:00:00' }), row()] } }));
  const hash = async (f) => crypto.createHash('sha256').update(await fs.readFile(path.join(dataDir, f))).digest('hex');
  const before = { xlsx: await hash('sent-emails.xlsx'), pending: await hash('sent-emails-pending.json') };

  const d = await db(name);
  const dry = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'Asia/Kolkata', historyJsonTimeZone: 'UTC', dryRun: true });
  assert.deepEqual(dry.found, { excelRows: 3, pendingRows: 1, apiExportRows: 2, template: true, mapping: true });
  assert.equal(dry.history.inserted, 5, 'REG-1 (in both Excel and the export) counted once; the repeated Excel row kept');
  assert.equal(await d.collection(COLLECTIONS.history).countDocuments(), 0, 'dry run writes nothing');

  const b = await backup({ dataDir, db: d, outDir: path.join(dataDir, 'backups', 'b1'), historyJsonPath: exportPath });
  assert.deepEqual(b.files.sort(), ['prod-history.json', 'sent-emails-pending.json', 'sent-emails.xlsx', 'settings.json', 'template.json']);
  assert.equal(b.collections.email_history, 0);

  const r1 = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'Asia/Kolkata', historyJsonTimeZone: 'UTC', dryRun: false });
  assert.equal(r1.history.inserted, 5);
  assert.equal(r1.template, 'imported');
  assert.equal(r1.mapping, 'imported');
  const r2 = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'Asia/Kolkata', historyJsonTimeZone: 'UTC', dryRun: false });
  assert.equal(r2.history.inserted, 0, 'second run imports nothing');
  assert.equal(r2.history.alreadyPresent, 5);
  assert.match(r2.template, /kept the one already in MongoDB/);
  assert.equal(await d.collection(COLLECTIONS.history).countDocuments(), 5);

  const one = await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-2' });
  assert.equal(one.sentAtUtc.toISOString(), '2026-01-02T04:00:00.000Z', '09:30 India time = 04:00 UTC');
  assert.equal(one.legacy.timeZoneAssumed, 'Asia/Kolkata');
  assert.equal(one.status, 'Uncertain', 'uncertain records are preserved');
  assert.equal((await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-9' })).sentAtUtc.toISOString(), '2026-02-01T08:00:00.000Z');
  assert.ok(await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-3', 'legacy.source': 'pending-file' }), 'pending rows imported');
  assert.equal((await d.collection(COLLECTIONS.activity).countDocuments({ action: 'data_migrated' })), 2);
  assert.deepEqual({ xlsx: await hash('sent-emails.xlsx'), pending: await hash('sent-emails-pending.json') }, before, 'source files unchanged');

  // Missing or damaged sources don't crash.
  const empty = await makeTempDir();
  await fs.writeFile(path.join(empty, 'sent-emails.xlsx'), 'not a workbook');
  const r3 = await migrate({ db: d, dataDir: empty, legacyTimeZone: 'UTC', historyJsonPath: path.join(empty, 'missing.json'), dryRun: true });
  assert.equal(r3.history.candidates, 0);
  assert.ok(r3.problems.some((p) => /sent-emails.xlsx could not be read/.test(p)));
  assert.ok(r3.problems.some((p) => /missing.json could not be read/.test(p)));
});

test('legacy time conversion handles time zones and daylight saving', () => {
  assert.equal(legacyLocalToUtc('2026-01-01 10:00:00', 'UTC').toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(legacyLocalToUtc('2026-01-01 10:00:00', 'Asia/Kolkata').toISOString(), '2026-01-01T04:30:00.000Z');
  assert.equal(legacyLocalToUtc('2026-07-01 12:00:00', 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z'); // EDT
  assert.equal(legacyLocalToUtc('2026-01-01 12:00:00', 'America/New_York').toISOString(), '2026-01-01T17:00:00.000Z'); // EST
  assert.equal(legacyLocalToUtc('not a date', 'UTC'), null);
});

test('User-Agent parsing and reported client IP', () => {
  assert.deepEqual(parseUserAgent(CHROME_WIN), { os: 'Windows', osVersion: '10 or 11', browser: 'Chrome', browserVersion: '131.0.0.0', deviceType: 'desktop or laptop' });
  assert.deepEqual(parseUserAgent(SAFARI_IPHONE), { os: 'iOS', osVersion: '17.5', browser: 'Safari', browserVersion: '17.5', deviceType: 'mobile' });
  assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70').browser, 'Edge');
  assert.equal(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36').deviceType, 'tablet');
  assert.equal(parseUserAgent('').browser, 'Unknown');
  const req = (xff, remote) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } });
  // Production chain: client (as Vercel reports it), Vercel egress; then Render's proxy connects.
  assert.equal(reportedClientIp(req('198.51.100.7, 76.76.21.1', '10.0.0.5'), 2), '198.51.100.7');
  assert.equal(reportedClientIp(req('', '::ffff:127.0.0.1'), 0), '127.0.0.1');
  assert.equal(reportedClientIp(req('1.1.1.1', '10.0.0.5'), 5), '1.1.1.1', 'clamped to the first entry');
});
