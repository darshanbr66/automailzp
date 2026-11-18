// Backup, restore, verification, migration safety and the database-target
// safeguards. Runs against an in-memory MongoDB only: Atlas is never contacted
// and backend/.env is never read (the CLI tests pass their own --env-file).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { COLLECTIONS, createMongoStorage } from '../src/storage/mongo.js';
import { assertConfirmed, backupCollections, describeTarget, readBackup, redact, restoreBackup, verifyDatabase } from '../src/dbops.js';
import { HistoryStore } from '../src/history.js';
import { migrate, rollbackMigration } from '../src/migrate.js';
import { SAMPLE_ROWS, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, smtpError, startTestServer } from './helpers.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mongod;
let uri;
let client;
before(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
  client = await MongoClient.connect(uri);
});
after(async () => {
  await client?.close();
  await mongod?.stop();
});
const dbName = (p = 'test') => `${p}_${crypto.randomBytes(5).toString('hex')}`;
let n = 0;
const rid = () => `dbops-${Date.now()}-${(n += 1)}`;

/** A database with real app data: workbook, sends (Success/Failed/Uncertain), a correction, activity. */
async function populated(name) {
  const dataDir = await makeTempDir();
  const storage = createMongoStorage({ uri, dbName: name, dataDir });
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp), storage, headers: { 'x-operator': 'Team Member 1' } });
  try {
    await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    const send = (rowNumber) => srv.request('POST', '/api/send', { json: { rowNumber, subject: 'Subject', body: 'Body', requestId: rid() } });
    assert.equal((await send(2)).status, 200);
    smtp.state.sendQueue.push({ error: smtpError('ETIMEDOUT', { command: 'DATA', message: 'Timeout' }) });
    await send(3);
    smtp.state.sendQueue.push({ error: smtpError('EENVELOPE', { responseCode: 550, command: 'RCPT TO' }) });
    await send(5);
    const ok = (await srv.request('GET', '/api/history')).data.data.entries.find((e) => e.status === 'Success');
    await srv.request('POST', `/api/history/${ok.id}/correct`, { json: { action: 'void', reason: 'Test correction' } });
    await srv.request('POST', `/api/history/${ok.id}/correct`, { json: { action: 'undo', reason: 'Undo the test correction' } });
  } finally {
    await srv.close();
    await storage.close();
  }
  return client.db(name);
}

// ---------------------------------------------------------------------------
test('targets are shown without credentials or full host names; confirmation must match exactly', () => {
  const secret = 'mongodb+srv://app_user:S3cr3t-Pa55@cluster0.ab1cd.mongodb.net/?retryWrites=true&w=majority';
  const t = describeTarget(secret, 'zodiacpatent');
  const shown = JSON.stringify(t);
  for (const bad of ['S3cr3t', 'app_user', 'ab1cd', 'mongodb+srv']) assert.ok(!shown.includes(bad), bad);
  assert.match(t.label, /^zodiacpatent@[0-9a-f]{8}$/);
  assert.equal(t.hostHint, 'cluster0.*.mongodb.net');
  assert.notEqual(describeTarget(secret, 'zodiacpatent_restore').fingerprint, t.fingerprint, 'the fingerprint covers the database name');
  assert.notEqual(describeTarget(secret.replace('ab1cd', 'zz9yy'), 'zodiacpatent').fingerprint, t.fingerprint, 'and the cluster');
  assert.equal(redact(`failed: ${secret} (timeout)`), 'failed: <connection string hidden> (timeout)');
  assert.throws(() => assertConfirmed(t, undefined, 'restore'), /--confirm-target zodiacpatent@/);
  assert.throws(() => assertConfirmed(t, 'zodiacpatent', 'restore'), /does not match/);
  assert.doesNotThrow(() => assertConfirmed(t, t.label, 'restore'));
  assert.throws(() => describeTarget(secret, 'bad name; drop'), /database name/);
});

test('backup -> restore into a separate test database: identical documents, counts and relationships verified', async () => {
  const source = await populated(dbName());
  const dir = await makeTempDir();
  const srcTarget = describeTarget(uri, source.databaseName);
  const manifest = await backupCollections({ db: source, outDir: dir, target: srcTarget });
  assert.equal(manifest.collections.email_history.count, 3);
  assert.equal(manifest.verification.ok, true, JSON.stringify(manifest.verification));

  const target = describeTarget(uri, dbName('restore'));
  const r = await restoreBackup({ client, backupDir: dir, target, appTargets: [srcTarget] });
  assert.equal(r.verification.ok, true, JSON.stringify(r.verification.problems));
  const restored = client.db(target.dbName);
  for (const name of Object.values(COLLECTIONS)) {
    const a = await source.collection(name).find({}).sort({ _id: 1 }).toArray();
    const b = await restored.collection(name).find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(b, a, `${name} restored exactly (ids, dates, nested fields)`);
  }
  // Unique indexes are in place in the restored database.
  const idx = (await restored.collection(COLLECTIONS.history).indexes()).map((i) => i.name);
  for (const i of ['claim_unique', 'success_request_unique', 'legacy_unique']) assert.ok(idx.includes(i), i);
  // The restored database works with the app: an uncertain send still blocks.
  const v = await verifyDatabase(restored);
  assert.equal(v.history.unresolvedUncertain, 1);
  assert.deepEqual(v.history.byStatus, await verifyDatabase(source).then((x) => x.history.byStatus));
  assert.equal(v.workbook.complete, true);
});

test('restore refuses production, the app database, the source database, non-empty databases and damaged backups', async () => {
  const source = await populated(dbName());
  const dir = await makeTempDir();
  const srcTarget = describeTarget(uri, source.databaseName);
  await backupCollections({ db: source, outDir: dir, target: srcTarget });
  const attempt = (dbn, extra = {}) => restoreBackup({ client, backupDir: dir, target: describeTarget(uri, dbn), appTargets: [], ...extra });

  await assert.rejects(attempt('zodiacpatent'), { code: 'RESTORE_TARGET_PROTECTED' });
  await assert.rejects(attempt('other_prod', { env: { MONGODB_PRODUCTION_DBS: 'other_prod' } }), { code: 'RESTORE_TARGET_PROTECTED' });
  const app = describeTarget(uri, dbName('app'));
  await assert.rejects(restoreBackup({ client, backupDir: dir, target: app, appTargets: [app] }), { code: 'RESTORE_TARGET_PROTECTED' });
  await assert.rejects(attempt(source.databaseName), { code: 'RESTORE_TARGET_PROTECTED' });
  const busy = dbName('busy');
  await client.db(busy).collection('anything').insertOne({ keep: true });
  await assert.rejects(attempt(busy), { code: 'TARGET_NOT_EMPTY' });
  assert.equal(await client.db(busy).collection('anything').countDocuments({ keep: true }), 1, 'untouched');
  assert.equal(await client.db('zodiacpatent').collection(COLLECTIONS.history).countDocuments({}), 0, 'nothing written to production');

  // A changed backup file is detected before anything is written.
  const file = path.join(dir, `mongodb-${COLLECTIONS.history}.json`);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Test Attorney One', 'Someone Else'));
  await assert.rejects(readBackup(dir), { code: 'BACKUP_CORRUPT' });
  const fresh = dbName('fresh');
  await assert.rejects(attempt(fresh), { code: 'BACKUP_CORRUPT' });
  assert.deepEqual(await client.db(fresh).listCollections().toArray(), [], 'nothing created');
});

test('verification reports broken relationships', async () => {
  const d = await populated(dbName());
  assert.equal((await verifyDatabase(d)).ok, true);
  await d.collection(COLLECTIONS.attorneys).insertOne({ workbookId: 'no-such-workbook', rowNumber: 2, cells: [] });
  await d.collection(COLLECTIONS.activity).insertOne({ at: new Date(), action: 'email_sent', historyId: new ObjectId() });
  const current = (await d.collection(COLLECTIONS.workbooks).findOne({ _id: 'current' })).workbookId;
  await d.collection(COLLECTIONS.attorneys).deleteOne({ workbookId: current });
  await d.collection(COLLECTIONS.history).insertOne({ status: 'Success', sentAtUtc: 'not a date' });
  const v = await verifyDatabase(d);
  assert.equal(v.ok, false);
  const text = v.problems.join(' | ');
  assert.match(text, /no metadata/);
  assert.match(text, /refer to history records that do not exist/);
  assert.match(text, /current workbook is incomplete/);
  assert.match(text, /no valid UTC date/);
});

// ---------------------------------------------------------------------------
async function legacyData() {
  const dataDir = await makeTempDir();
  const store = new HistoryStore(dataDir);
  const row = (o) => ({ recordId: 'REG-1', registrationNumber: 'REG-1', attorneyName: 'Old One', recipientEmail: 'old1@example.com', firmName: '', city: '', state: '', subject: 'Hi', sentAt: '2026-01-01 10:00:00', senderEmail: 'x@zodiacpatent.example', status: 'Success', sendType: 'First Send', ...o });
  await store.append(row());
  await store.append(row({ recordId: 'REG-2', attorneyName: 'Old Two', recipientEmail: 'old2@example.com', status: 'Uncertain', sentAt: '2026-01-02 09:30:00' }));
  await fs.writeFile(path.join(dataDir, 'sent-emails-pending.json'), JSON.stringify([row({ recordId: 'REG-3', attorneyName: 'Pending Three', recipientEmail: 'p3@example.com', sentAt: '2026-01-03 12:00:00' })]));
  await fs.writeFile(path.join(dataDir, 'template.json'), JSON.stringify({ subject: 'Legacy {{attorneyName}}', greeting: 'Hi', mainMessage: 'Text', closing: 'Bye', signature: 'ZodiacPatent Team' }));
  const exportPath = path.join(dataDir, 'prod-history.json');
  const exported = [
    { ...row({ recordId: 'REG-9', attorneyName: 'Prod Nine', recipientEmail: 'p9@example.com', sentAt: '2026-02-01 08:00:00' }), sentAtUtc: '2026-02-01T08:00:00.000Z' },
    { ...row({ recordId: 'REG-8', attorneyName: 'Prod Pending', recipientEmail: 'p8@example.com', sentAt: '2026-02-02 08:00:00', status: 'Uncertain' }), pendingSave: true },
    row(),
  ];
  await fs.writeFile(exportPath, JSON.stringify({ ok: true, data: { entries: exported } }));
  return { dataDir, exportPath, row };
}

test('migration: preflight checks, pre/post counts, nothing missing, pending and uncertain preserved; rollback removes only that run', async () => {
  const d = client.db(dbName());
  const { dataDir, exportPath } = await legacyData();
  // Something already in the database (written by the app): must survive a rollback.
  await d.collection(COLLECTIONS.history).insertOne({ recordId: 'APP-1', status: 'Success', sentAtUtc: new Date(), source: 'app' });
  await d.collection(COLLECTIONS.templates).insertOne({ _id: 'active', template: { subject: 'Current' } });

  const dry = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'Asia/Kolkata', dryRun: true, forceTemplate: true });
  assert.equal(dry.preflight.fingerprints.candidates, 5);
  assert.equal(dry.preflight.fingerprints.inBothSources, 1);
  assert.deepEqual(dry.preflight.statuses, { Success: 3, Uncertain: 2 });
  assert.equal(dry.preflight.pendingRows, 2, 'pending-file row and the export\'s pending row');
  assert.equal(dry.preflight.dates.unparsable.length, 0);
  assert.equal(dry.preflight.dates.recordedUtc, 1);
  assert.equal(dry.counts.before.total, 1);
  assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 1, 'dry run writes nothing');

  const r = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'Asia/Kolkata', dryRun: false, forceTemplate: true });
  assert.match(r.runId, /^mig-/);
  assert.equal(r.history.inserted, 5);
  assert.equal(r.counts.after.total, 6);
  assert.deepEqual(r.verification, { ok: true, legacyRowsPresent: 5, legacyRowsExpected: 5, missing: 0, expectedTotalAtLeast: 6, total: 6 });
  const pending = await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-8' });
  assert.equal(pending.status, 'Uncertain');
  assert.equal(pending.legacy.pendingSave, true);
  assert.equal('pendingSave' in pending, false);
  assert.equal((await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-9' })).sentAtUtc.toISOString(), '2026-02-01T08:00:00.000Z');
  assert.equal((await d.collection(COLLECTIONS.templates).findOne({ _id: 'active' })).migrationRunId, r.runId);

  // A team member corrects one imported row afterwards: the rollback keeps it.
  await d.collection(COLLECTIONS.history).updateOne({ recordId: 'REG-2' }, { $set: { status: 'Failed', resolution: { previousStatus: 'Uncertain' } } });
  const dryRb = await rollbackMigration({ db: d, runId: r.runId, dryRun: true });
  assert.equal(dryRb.removable, 4);
  assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 6, 'dry rollback changes nothing');
  const rb = await rollbackMigration({ db: d, runId: r.runId, dryRun: false });
  assert.equal(rb.deleted, 4);
  assert.equal(rb.keptBecauseCorrected.length, 1);
  assert.deepEqual((await d.collection(COLLECTIONS.history).find({}).toArray()).map((x) => x.recordId).sort(), ['APP-1', 'REG-2']);
  assert.equal((await d.collection(COLLECTIONS.templates).findOne({ _id: 'active' })).template.subject, 'Current', 'previous template put back');
  assert.equal(await d.collection(COLLECTIONS.activity).countDocuments({ action: 'migration_rolled_back' }), 1);
  await assert.rejects(rollbackMigration({ db: d, runId: 'drop everything' }), /valid migration run id/);
});

test('migration refuses to import rows with unreadable dates unless explicitly allowed', async () => {
  const d = client.db(dbName());
  const { dataDir, row } = await legacyData();
  const exportPath = path.join(dataDir, 'bad.json');
  await fs.writeFile(exportPath, JSON.stringify([row({ recordId: 'REG-X', sentAt: '01/02/2026 9am' }), { ...row({ recordId: 'REG-Y' }), sentAtUtc: '2026-13-45' }]));
  const r = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'UTC', dryRun: false });
  assert.match(r.blocked, /1 row\(s\) have a date that can't be read/);
  assert.equal(r.preflight.dates.invalidUtc.length, 1, 'an invalid UTC value is reported (its local text is used instead)');
  assert.equal(await d.collection(COLLECTIONS.history).countDocuments({}), 0, 'nothing imported');
  const forced = await migrate({ db: d, dataDir, historyJsonPath: exportPath, legacyTimeZone: 'UTC', dryRun: false, allowUnparsableDates: true });
  assert.equal(forced.verification.ok, true);
  assert.equal((await d.collection(COLLECTIONS.history).findOne({ recordId: 'REG-X' })).legacy.unparsableDate, true);
});

// ---- Command-line safeguards --------------------------------------------------------------
async function envFile(vars) {
  const dir = await makeTempDir();
  const file = path.join(dir, 'test.env');
  await fs.writeFile(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'));
  return { file, dir };
}
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BACKEND, 'scripts', script), ...args], {
      cwd: BACKEND,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('exit', (code) => resolve({ code, output }));
  });
}
const labelIn = (output) => output.match(/confirmation label: (\S+)/)?.[1];

test('scripts: the URI is never printed, writes need the exact target confirmed, restore never touches the app or production database', async () => {
  const source = await populated(dbName());
  const { file, dir } = await envFile({ MONGODB_URI: uri, MONGODB_DB: source.databaseName, DATA_DIR: await makeTempDir() });
  const backupDir = path.join(dir, 'backup');
  const noUri = (r) => assert.ok(!r.output.includes(uri) && !r.output.includes(uri.replace(/\/$/, '')) && !/mongodb:\/\//.test(r.output), r.output);

  const b = await run('db-backup.js', ['--env-file', file, '--out', backupDir]);
  assert.equal(b.code, 0, b.output);
  noUri(b);
  assert.match(b.output, /Backing up \(read-only\)/);
  assert.match(b.output, /verification: OK/);

  // Restore: first run only shows the target; a wrong label is refused.
  const target = dbName('restore');
  const show = await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', target]);
  assert.equal(show.code, 3, show.output);
  noUri(show);
  const label = labelIn(show.output);
  assert.match(label, new RegExp(`^${target}@[0-9a-f]{8}$`));
  assert.equal((await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', target, '--confirm-target', `${target}@00000000`])).code, 3);
  assert.deepEqual(await client.db(target).listCollections().toArray(), []);
  const done = await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', target, '--confirm-target', label]);
  assert.equal(done.code, 0, done.output);
  noUri(done);
  assert.match(done.output, /Verification: OK/);
  const verify = await run('db-verify.js', ['--env-file', file, '--db', target]);
  assert.equal(verify.code, 0, verify.output);

  // Never into the app's own database or a production one, even when "confirmed".
  const appLabel = describeTarget(uri, source.databaseName).label;
  const own = await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', source.databaseName, '--confirm-target', appLabel]);
  assert.equal(own.code, 3, own.output);
  const prodLabel = describeTarget(uri, 'zodiacpatent').label;
  const prod = await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', 'zodiacpatent', '--confirm-target', prodLabel, '--production']);
  assert.equal(prod.code, 3, prod.output);
  assert.match(prod.output, /production database/);
  assert.equal(await client.db('zodiacpatent').collection(COLLECTIONS.history).countDocuments({}), 0);

  // A URI passed where a variable NAME is expected is refused (and not echoed).
  const leaked = await run('db-restore.js', ['--env-file', file, '--from', backupDir, '--target-db', dbName('x'), '--target-uri-env', uri]);
  assert.notEqual(leaked.code, 0);
  noUri(leaked);

  // Migration --apply needs the label; production also needs --production.
  const m = await run('migrate-to-mongodb.js', ['--env-file', file, '--apply']);
  assert.equal(m.code, 3, m.output);
  assert.match(m.output, /--confirm-target /);
  const { file: prodEnv } = await envFile({ MONGODB_URI: uri, MONGODB_DB: 'zodiacpatent', DATA_DIR: await makeTempDir() });
  const mp = await run('migrate-to-mongodb.js', ['--env-file', prodEnv, '--apply', '--confirm-target', prodLabel]);
  assert.equal(mp.code, 3, mp.output);
  assert.match(mp.output, /add --production/);
  const dryProd = await run('migrate-to-mongodb.js', ['--env-file', prodEnv]);
  assert.equal(dryProd.code, 0, dryProd.output);
  assert.match(dryProd.output, /DRY RUN.*\n.*\[PRODUCTION DATABASE\]/);
  assert.equal(await client.db('zodiacpatent').collection(COLLECTIONS.history).countDocuments({}), 0, 'production untouched');

  // An env file without an explicit database name is refused (no assumed database).
  const { file: noDb } = await envFile({ MONGODB_URI: uri });
  const r = await run('db-verify.js', ['--env-file', noDb]);
  assert.equal(r.code, 1);
  assert.match(r.output, /MONGODB_DB is not set/);

  // Reconcile lists the uncertain send (read-only).
  const rec = await run('db-reconcile.js', ['--env-file', file]);
  assert.equal(rec.code, 0, rec.output);
  assert.match(rec.output, /1 send\(s\) with an unknown outcome/);
  noUri(rec);
});
