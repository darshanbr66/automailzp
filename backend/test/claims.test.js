// Durable send claims and their recovery, against an in-memory MongoDB
// (mongodb-memory-server). Atlas is never contacted and no email is ever sent:
// the transports are fakes. Failures are injected at each step of a send:
// before the provider is called, during the provider call, after the provider
// accepted, and while the history is written. The last tests run two genuinely
// separate server processes (child processes) on one database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createMongoStorage, COLLECTIONS, CLAIM_STALE_MS } from '../src/storage/mongo.js';
import { SAMPLE_ROWS, fakeTransport, makeClient, makeMailer, makeTempDir, makeWorkbookBuffer, smtpError, startTestServer, testConfig } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'server-process.js');
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

const ALICE = { 'x-operator': 'Team Member 1' };
const BOB = { 'x-operator': 'Team Member 2' };
let n = 0;
const rid = () => `claim-test-${Date.now()}-${(n += 1)}`;
const dbName = () => `test_${crypto.randomBytes(6).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = () => Date.now() + CLAIM_STALE_MS + 1000; // "after the stale window"

async function instance(name, { headers = ALICE, smtp = fakeTransport(), storageOptions = {} } = {}) {
  const dataDir = await makeTempDir();
  const storage = createMongoStorage({ uri, dbName: name, dataDir, ...storageOptions });
  clients.push(storage.client);
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp), storage, headers });
  return { srv, smtp, storage, dataDir };
}
async function db(name) {
  const c = await MongoClient.connect(uri);
  clients.push(c);
  return c.db(name);
}
const send = (srv, rowNumber, extra = {}) => srv.request('POST', '/api/send', { json: { rowNumber, subject: 'Subject', body: 'Body', requestId: rid(), ...extra } });
const historyOf = async (srv) => (await srv.request('GET', '/api/history')).data.data.entries;
const reject = (d, collection, validator) => d.command({ collMod: collection, validator, validationAction: 'error' });
const allow = (d, collection) => d.command({ collMod: collection, validator: {} });

// ---------------------------------------------------------------------------
test('failure BEFORE sending: if "sending" cannot be recorded, nothing is sent and nothing is left behind', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const d = await db(name);
    await reject(d, COLLECTIONS.pending, { state: { $ne: 'sending' } }); // claim can be created, not moved to "sending"
    const r = await send(a.srv, 2);
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'DB_UNAVAILABLE');
    assert.equal(a.smtp.state.sent.length, 0, 'the provider was never called');
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0, 'claim removed');
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 0, 'no history row');
    await allow(d, COLLECTIONS.pending);
    assert.equal((await send(a.srv, 2)).status, 200, 'a retry works');
    assert.equal(a.smtp.state.sent.length, 1);
  } finally {
    await a.srv.close();
  }
});

test('failure DURING sending: an unknown provider answer is Uncertain, never Sent, and is never resent automatically', async () => {
  const name = dbName();
  const a = await instance(name);
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    a.smtp.state.sendQueue.push({ error: smtpError('ECONNRESET', { command: 'DATA', message: 'reset' }) });
    assert.equal((await send(a.srv, 2)).data.error.code, 'SMTP_UNCERTAIN');
    const [u] = await historyOf(a.srv);
    assert.equal(u.status, 'Uncertain');
    assert.ok(u.claimId, 'linked to its claim');
    for (const srv of [a.srv, b.srv]) {
      assert.equal((await send(srv, 2)).data.error.code, 'UNCERTAIN_UNRESOLVED');
      assert.equal((await send(srv, 2, { confirmResend: true })).data.error.code, 'UNCERTAIN_UNRESOLVED');
    }
    const check = (await b.srv.request('POST', '/api/history/check', { json: { rowNumber: 2 } })).data.data;
    assert.equal(check.uncertainUnresolved, true);
    assert.equal(check.uncertain[0].id, u.id);
    assert.equal(a.smtp.state.sent.length + b.smtp.state.sent.length, 0);
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('failure AFTER provider acceptance: history write fails, the process dies; another process records Success from the kept claim', async () => {
  const name = dbName();
  const a = await instance(name);
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const d = await db(name);
    await reject(d, COLLECTIONS.history, { subject: { $ne: 'Subject' } });
    const r = await send(a.srv, 2);
    assert.equal(r.status, 200);
    assert.equal(r.data.data.historySaved, false);
    // Process A "dies" now: its local fallback file is lost (as on a Render restart).
    await a.srv.close();
    await a.storage.close();
    await fs.rm(a.dataDir, { recursive: true, force: true });

    const claim = await d.collection(COLLECTIONS.pending).findOne({});
    assert.equal(claim.state, 'accepted');
    // B can't send meanwhile, with or without "Send again".
    assert.equal((await send(b.srv, 2, { confirmResend: true })).data.error.code, 'SEND_IN_PROGRESS');
    assert.equal(await b.storage.locks.sweep(), 0, 'history still failing: the claim is kept');
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 1);

    await allow(d, COLLECTIONS.history);
    assert.equal(await b.storage.locks.sweep(), 1);
    const h = await d.collection(COLLECTIONS.history).find({}).toArray();
    assert.equal(h.length, 1);
    assert.equal(h[0].status, 'Success', 'the provider confirmed it, so it is Success');
    assert.equal(h[0].messageId, '<test-message@example.com>');
    assert.equal(h[0].operator.name, 'Team Member 1', 'credited to who sent it');
    assert.equal(h[0].claimId, claim._id);
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0);
    const act = (await b.srv.request('GET', '/api/activity?action=send_outcome_recovered')).data.data.items;
    assert.equal(act.length, 1);
    assert.equal(act[0].operatorIdType, 'system');
    assert.equal((await send(b.srv, 2)).data.error.code, 'ALREADY_SENT');
    assert.equal(a.smtp.state.sent.length + b.smtp.state.sent.length, 1, 'exactly one email');
  } finally {
    await b.srv.close();
  }
});

test('failure during MongoDB updates after acceptance (claim AND history writes fail): Uncertain, then upgraded only by the provider confirmation', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const d = await db(name);
    await reject(d, COLLECTIONS.pending, { state: { $in: ['claimed', 'sending'] } }); // "accepted" can't be stored
    await reject(d, COLLECTIONS.history, { subject: { $ne: 'Subject' } });
    const r = await send(a.srv, 2);
    assert.equal(r.status, 200, 'the email was accepted, so the user is told so');
    assert.equal(r.data.data.historySaved, false);
    assert.equal((await d.collection(COLLECTIONS.pending).findOne({})).state, 'sending', 'the claim is still "sending"');
    assert.equal(await a.storage.locks.sweep(), 0, 'not stale yet: left alone');

    // Later the database recovers, but this process's local copy is not read yet:
    // recovery only knows "sending", so it records Uncertain (not Sent).
    await allow(d, COLLECTIONS.history);
    await allow(d, COLLECTIONS.pending);
    assert.equal(await a.storage.locks.sweep(later()), 1);
    let h = await d.collection(COLLECTIONS.history).find({}).toArray();
    assert.deepEqual(h.map((x) => x.status), ['Uncertain']);

    // The local copy holds the provider's confirmation: it upgrades the same record.
    await historyOf(a.srv);
    h = await d.collection(COLLECTIONS.history).find({}).toArray();
    assert.equal(h.length, 1, 'never two records for one send');
    assert.equal(h[0].status, 'Success');
    assert.equal(h[0].resolution.previousStatus, 'Uncertain');
    assert.equal(h[0].resolution.operator.idType, 'system');
    assert.equal(h[0].messageId, '<test-message@example.com>');
    assert.equal(a.smtp.state.sent.length, 1);
  } finally {
    await a.srv.close();
  }
});

test('a provider refusal whose history write fails stays blocked until recorded as Failed', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const d = await db(name);
    await reject(d, COLLECTIONS.history, { subject: { $ne: 'Subject' } });
    a.smtp.state.sendQueue.push({ error: smtpError('EENVELOPE', { responseCode: 550, command: 'RCPT TO', response: '550 no such user' }) });
    assert.equal((await send(a.srv, 2)).data.error.code, 'INVALID_RECIPIENT');
    assert.equal((await d.collection(COLLECTIONS.pending).findOne({})).state, 'failed');
    await allow(d, COLLECTIONS.history);
    await a.storage.locks.sweep();
    const h = await d.collection(COLLECTIONS.history).find({}).toArray();
    assert.equal(h.length, 1, 'recorded once (local copy and recovery agree)');
    assert.equal(h[0].status, 'Failed');
    assert.equal((await send(a.srv, 2)).status, 200, 'a refused email does not block a new attempt');
  } finally {
    await a.srv.close();
  }
});

test('late provider confirmation: a slow send marked Uncertain by another process becomes Success, and no one could resend meanwhile', async () => {
  const name = dbName();
  const slow = fakeTransport();
  slow.state.sendQueue.push({ delayMs: 900 });
  const a = await instance(name, { smtp: slow, storageOptions: { heartbeatMs: 60000 } });
  const b = await instance(name, { headers: BOB });
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const pendingSend = send(a.srv, 2);
    await sleep(300); // A is inside the provider call
    assert.equal(await b.storage.locks.sweep(later()), 1, 'B considers A stopped');
    assert.equal((await send(b.srv, 2, { confirmResend: true })).data.error.code, 'UNCERTAIN_UNRESOLVED');
    const r = await pendingSend;
    assert.equal(r.status, 200);
    const h = await historyOf(b.srv);
    assert.equal(h.length, 1);
    assert.equal(h[0].status, 'Success');
    assert.equal(h[0].resolution.resolvedAs, 'Sent');
    assert.equal(slow.state.sent.length + b.smtp.state.sent.length, 1);
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test('duplicate recovery sweeps (several processes at once) record one Uncertain and one activity entry', async () => {
  const name = dbName();
  const a = await instance(name);
  const others = await Promise.all([1, 2, 3].map(() => instance(name, { headers: BOB })));
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const entry = { recordId: 'REG-001', registrationNumber: 'REG-001', attorneyName: 'Test Attorney One', recipientEmail: 'one@example.com', subject: 'S', status: 'Uncertain', sendMethod: 'SMTP', operator: 'Team Member 1', requestId: 'r-dup-sweep' };
    const claim = await a.storage.locks.acquire({ recordKey: 'REG-001', emailKey: 'one@example.com', requestId: 'r-dup-sweep', entry });
    await claim.begin({ sendType: 'First Send' });
    const t = later();
    const results = await Promise.all([a, ...others].map((x) => x.storage.locks.sweep(t)));
    assert.ok(results.reduce((s, v) => s + v, 0) >= 1);
    const d = await db(name);
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 1);
    assert.equal(await d.collection(COLLECTIONS.activity).countDocuments({ action: 'send_uncertain_recovered' }), 1);
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0);
  } finally {
    for (const x of [a, ...others]) await x.srv.close();
  }
});

test('manual reconciliation: confirm, undo and void are audited; an Uncertain record cannot simply be voided', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    a.smtp.state.sendQueue.push({ error: smtpError('ETIMEDOUT', { command: 'DATA', message: 'Timeout' }) });
    await send(a.srv, 2);
    const [u] = await historyOf(a.srv);
    const correct = (action, reason = 'Checked the Resend dashboard') => a.srv.request('POST', `/api/history/${u.id}/correct`, { json: { action, reason } });
    assert.equal((await correct('void')).data.error.code, 'RESOLVE_UNCERTAIN');
    assert.equal((await correct('undo')).data.error.code, 'NOTHING_TO_UNDO');
    const c = await correct('confirm-not-sent');
    assert.equal(c.data.data.entry.status, 'Failed');
    // A mistaken confirmation can be undone: the send is Uncertain (and blocking) again.
    const un = await correct('undo', 'Wrong attorney checked');
    assert.equal(un.data.data.entry.status, 'Uncertain');
    assert.equal(un.data.data.entry.resolution, null);
    assert.equal((await send(a.srv, 2, { confirmResend: true })).data.error.code, 'UNCERTAIN_UNRESOLVED');
    assert.equal((await correct('confirm-not-sent', 'Not in the dashboard')).status, 200);
    assert.equal((await send(a.srv, 2)).status, 200, 'after "not sent" the attorney can be emailed');
    const finalEntry = (await historyOf(a.srv)).find((e) => e.id === u.id);
    assert.deepEqual(finalEntry.corrections.map((x) => x.action), ['confirm-not-sent', 'undo-resolution', 'confirm-not-sent']);
    assert.ok(finalEntry.corrections.every((x) => x.operator === 'Team Member 1'));

    // Void and undo of a Success record.
    const sent = (await historyOf(a.srv)).find((e) => e.status === 'Success');
    const v = await a.srv.request('POST', `/api/history/${sent.id}/correct`, { json: { action: 'void', reason: 'Recorded by mistake' } });
    assert.equal(v.data.data.entry.voided, true);
    const uv = await a.srv.request('POST', `/api/history/${sent.id}/correct`, { json: { action: 'undo', reason: 'It was correct after all' } });
    assert.equal(uv.data.data.entry.voided, false);
    assert.equal((await send(a.srv, 2)).data.error.code, 'ALREADY_SENT', 'counts again after the undo');
    const acts = (await a.srv.request('GET', '/api/activity?action=history_corrected')).data.data.items;
    assert.equal(acts.length, 5);
    assert.match(acts[0].summary, /Undid a void/);
  } finally {
    await a.srv.close();
  }
});

test('workbook upload is all-or-nothing: a failed upload leaves the previous workbook complete and removes partial rows', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    assert.equal((await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);
    const before = (await a.srv.request('GET', '/api/excel/records')).data.data;
    const d = await db(name);
    // Reject rows after the first few, so the upload fails half-way.
    await reject(d, COLLECTIONS.attorneys, { rowNumber: { $lt: 4 } });
    const bigger = [...SAMPLE_ROWS, ['Extra Person', 'REG-777', 'extra@example.com', '', '', '', '']];
    const r = await a.srv.upload(makeWorkbookBuffer(bigger));
    assert.equal(r.status, 503);
    await allow(d, COLLECTIONS.attorneys);
    const after = (await a.srv.request('GET', '/api/excel/records')).data.data;
    assert.equal(after.workbookVersion, before.workbookVersion, 'still the previous workbook');
    assert.equal(after.totalRecords, before.totalRecords);
    const failed = await d.collection(COLLECTIONS.workbooks).findOne({ status: 'failed' });
    assert.ok(failed);
    assert.equal(await d.collection(COLLECTIONS.attorneys).countDocuments({ workbookId: failed._id }), 0, 'partial rows removed');

    // An upload abandoned by a crashed process is cleaned up later; the current workbook never is.
    await d.collection(COLLECTIONS.workbooks).insertOne({ _id: 'abandoned', status: 'uploading', uploadedAt: new Date(Date.now() - 2 * 3600 * 1000), rowCount: 10 });
    await d.collection(COLLECTIONS.attorneys).insertOne({ workbookId: 'abandoned', rowNumber: 2, cells: [] });
    await a.storage.locks.sweep();
    assert.equal(await d.collection(COLLECTIONS.attorneys).countDocuments({ workbookId: 'abandoned' }), 0);
    assert.equal((await d.collection(COLLECTIONS.workbooks).findOne({ _id: 'abandoned' })).status, 'failed');
    assert.equal(await d.collection(COLLECTIONS.attorneys).countDocuments({ workbookId: before.workbookVersion }), before.totalRecords);

    // A current workbook with missing rows is refused rather than shown incomplete.
    await d.collection(COLLECTIONS.attorneys).deleteOne({ workbookId: before.workbookVersion });
    const b = await instance(name, { headers: BOB });
    try {
      const res = await b.srv.request('GET', '/api/excel/records');
      assert.equal(res.status, 503);
      assert.equal(res.data.error.code, 'WORKBOOK_INCOMPLETE');
    } finally {
      await b.srv.close();
    }
  } finally {
    await a.srv.close();
  }
});

test('activity retention is off unless configured, and never applies to the sending history', async () => {
  const name = dbName();
  const a = await instance(name);
  const d = await db(name);
  await a.storage.init();
  const ttl = async () => (await d.collection(COLLECTIONS.activity).indexes()).find((i) => i.name === 'activity_ttl');
  assert.equal(await ttl(), undefined);
  const b = await instance(name, { storageOptions: { activityRetentionDays: 400 } });
  await b.storage.init();
  assert.equal((await ttl()).expireAfterSeconds, 400 * 86400);
  assert.ok(!(await d.collection(COLLECTIONS.history).indexes()).some((i) => i.expireAfterSeconds !== undefined), 'history has no TTL');
  assert.equal(testConfig({ MONGODB_URI: 'mongodb://127.0.0.1:1', ACTIVITY_RETENTION_DAYS: '30' }).mongodb.activityRetentionDays, 90, 'minimum 90 days');
  assert.equal(testConfig({ MONGODB_URI: 'mongodb://127.0.0.1:1' }).mongodb.activityRetentionDays, undefined);
  await a.srv.close();
  await b.srv.close();
});

// ---- Two separate server processes ------------------------------------------------------
async function startProcess(name, dir, env = {}) {
  const dataDir = await fs.mkdtemp(path.join(dir, 'proc-'));
  const child = spawn(process.execPath, [FIXTURE], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ZP_TEST_MONGO_URI: uri,
      ZP_TEST_DB: name,
      ZP_TEST_DATA_DIR: dataDir,
      ZP_TEST_SENT_LOG: path.join(dir, 'sent.log'),
      ZP_TEST_CLAIM_STALE_MS: '1500',
      ZP_TEST_HEARTBEAT_MS: '250',
      ZP_TEST_SWEEP_MS: '300',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errText = '';
  child.stderr.on('data', (c) => (errText += c));
  const port = await new Promise((resolve, rejectStart) => {
    let buf = '';
    const timer = setTimeout(() => rejectStart(new Error(`process did not start: ${errText}`)), 30000);
    child.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/PORT (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => rejectStart(new Error(`process exited (${code}): ${errText}`)));
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, exited, client: (headers = ALICE) => makeClient(`http://127.0.0.1:${port}`, headers), stop: () => (child.exitCode === null ? (child.kill(), exited) : exited) };
}
const sentLines = async (dir) => ((await fs.readFile(path.join(dir, 'sent.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean));
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}

test('two server processes: simultaneous sends of the same attorney produce exactly one email', async () => {
  const name = dbName();
  const dir = await makeTempDir();
  const p1 = await startProcess(name, dir, { ZP_TEST_SEND_DELAY_MS: '400' });
  const p2 = await startProcess(name, dir, { ZP_TEST_SEND_DELAY_MS: '400' });
  try {
    const a = p1.client(ALICE);
    const b = p2.client(BOB);
    assert.equal((await a.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);
    const results = await Promise.all([send(a, 2), send(b, 2), send(a, 3), send(b, 3)]);
    assert.equal(results.filter((r) => r.status === 200).length, 2, JSON.stringify(results.map((r) => r.data.error?.code || 'SENT')));
    const lines = await sentLines(dir);
    assert.equal(lines.filter((l) => l.endsWith('one@example.com')).length, 1);
    assert.equal(lines.filter((l) => l.endsWith('two@example.com')).length, 1);
    const d = await db(name);
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({ status: 'Success' }), 2);
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0);
  } finally {
    await p1.stop();
    await p2.stop();
  }
});

test('two server processes: a process killed mid-send is recovered after restart as Uncertain, once, and never resent', async () => {
  const name = dbName();
  const dir = await makeTempDir();
  const d = await db(name);
  // Process 1 crashes right after the provider accepted the email (before it can record anything).
  const p1 = await startProcess(name, dir, { ZP_TEST_CRASH_ON_SEND: '1' });
  const a = p1.client(ALICE);
  assert.equal((await a.upload(makeWorkbookBuffer(SAMPLE_ROWS))).status, 200);
  const crashed = await send(a, 2).catch((e) => ({ status: 0, error: e }));
  assert.notEqual(crashed.status, 200, 'the request died with the process');
  assert.equal(await p1.exited, 137);
  assert.equal((await sentLines(dir)).length, 1, 'the provider got it once');
  const claim = await d.collection(COLLECTIONS.pending).findOne({});
  assert.equal(claim.state, 'sending');

  // Process 2 is running meanwhile: blocked while the claim is fresh, even with "Send again".
  const p2 = await startProcess(name, dir);
  const p3 = { stop: async () => {} };
  try {
    const b = p2.client(BOB);
    const blocked = await send(b, 2, { confirmResend: true });
    assert.ok(['SEND_IN_PROGRESS', 'UNCERTAIN_UNRESOLVED'].includes(blocked.data.error.code), blocked.data.error.code);

    // The crashed process is restarted ("application restart"); both processes sweep.
    Object.assign(p3, await startProcess(name, dir));
    const c = p3.client(ALICE);
    await waitFor(async () => (await d.collection(COLLECTIONS.pending).countDocuments({})) === 0);
    const h = await d.collection(COLLECTIONS.history).find({}).toArray();
    assert.equal(h.length, 1, 'one Uncertain record despite two processes recovering');
    assert.equal(h[0].status, 'Uncertain');
    assert.equal(h[0].operator.name, 'Team Member 1');
    assert.equal(await d.collection(COLLECTIONS.activity).countDocuments({ action: 'send_uncertain_recovered' }), 1);

    for (const client of [b, c]) {
      assert.equal((await send(client, 2)).data.error.code, 'UNCERTAIN_UNRESOLVED');
      assert.equal((await send(client, 2, { confirmResend: true })).data.error.code, 'UNCERTAIN_UNRESOLVED');
    }
    assert.equal((await sentLines(dir)).length, 1, 'never resent automatically');

    // Safe manual reconciliation: the team checks the provider and records the result.
    const id = String(h[0]._id);
    const r = await b.request('POST', `/api/history/${id}/correct`, { json: { action: 'confirm-sent', reason: 'Found it in the provider log' } });
    assert.equal(r.status, 200);
    assert.equal((await send(c, 2)).data.error.code, 'ALREADY_SENT', 'now a normal "already sent" warning in the other process too');
    assert.equal((await sentLines(dir)).length, 1);
  } finally {
    await p2.stop();
    await p3.stop();
  }
});

test('a successful send is stored in email_history with all its fields, confirmed by reading it back', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    assert.equal((await a.srv.request('GET', '/api/app/config')).data.data.database, name, 'the app reports which database it uses');
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const r = await send(a.srv, 2);
    assert.equal(r.status, 200);
    const res = r.data.data;
    assert.equal(res.historySaved, true);
    assert.equal(res.historyStore, 'mongodb');
    assert.equal(res.entry.id, res.historyId);
    const d = await db(name);
    const { ObjectId } = await import('mongodb');
    const doc = await d.collection(COLLECTIONS.history).findOne({ _id: new ObjectId(res.historyId) });
    assert.equal(doc.status, 'Success');
    assert.equal(doc.recipientEmail, 'one@example.com');
    assert.equal(doc.attorneyName, 'Test Attorney One');
    assert.equal(doc.registrationNumber, 'REG-001');
    assert.equal(doc.firmName, 'Example Law LLP');
    assert.equal(doc.subject, 'Subject');
    assert.ok(doc.sentAtUtc instanceof Date && doc.sentAt);
    assert.deepEqual(doc.operator, { name: 'Team Member 1', idType: 'self-declared' });
    assert.equal(doc.sendMethod, 'SMTP');
    assert.equal(doc.messageId, '<test-message@example.com>');
    assert.ok(await d.collection(COLLECTIONS.activity).findOne({ action: 'email_sent', historyId: doc._id }));
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0);
  } finally {
    await a.srv.close();
  }
});

test('if the record cannot be read back after a send, it is not reported as saved and the attorney stays blocked', async () => {
  const name = dbName();
  const a = await instance(name);
  try {
    await a.srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const realGet = a.storage.history.get;
    a.storage.history.get = async () => null; // e.g. a stale read right after the write
    const r = await send(a.srv, 2);
    a.storage.history.get = realGet;
    assert.equal(r.status, 200, 'the email was accepted');
    assert.equal(r.data.data.historySaved, false);
    assert.match(r.data.data.historyWarning, /stays blocked/);
    const d = await db(name);
    assert.equal((await d.collection(COLLECTIONS.pending).findOne({})).state, 'accepted', 'claim kept');
    // The next attempt resolves the kept claim (the record is there), then warns.
    assert.equal((await send(a.srv, 2)).data.error.code, 'ALREADY_SENT');
    assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 1, 'still exactly one record');
    assert.equal(await d.collection(COLLECTIONS.pending).countDocuments({}), 0);
    assert.equal(a.smtp.state.sent.length, 1, 'no second email');
  } finally {
    await a.srv.close();
  }
});
