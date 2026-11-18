// Database operations for the command-line scripts: target identification
// (without ever printing the connection string), backup, restore into a
// separate database, and verification of counts and relationships.
//
// Safety rules enforced here:
//  - connection strings are never printed; a target is shown as
//    "<database>@<fingerprint>" (fingerprint = hash of host names + database name,
//    no credentials), e.g. "zodiacpatent@3f9a1c2e";
//  - destructive or writing operations require that exact label to be confirmed;
//  - a restore only ever writes into a NEW, EMPTY database that is not the app's
//    configured database and not a production database. Nothing is dropped or
//    overwritten, ever.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BSON } from 'mongodb';
import { COLLECTIONS, ensureIndexes } from './storage/mongo.js';
import { AppError } from './utils.js';

export const BACKUP_FORMAT = 'zodiacpatent-mongodb-backup/1';
/** Database names always treated as production (add more with MONGODB_PRODUCTION_DBS). */
export const DEFAULT_PRODUCTION_DBS = ['zodiacpatent', 'automail'];
const URI_RE = /mongodb(?:\+srv)?:\/\/[^\s"'<>`]+/gi;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Remove connection strings (and with them any credentials) from text. */
export function redact(text) {
  return String(text ?? '').replace(URI_RE, '<connection string hidden>');
}

/** Host part of a MongoDB URI without credentials, lower-cased ("a.example.net,b.example.net:27017"). */
function hostsOf(uri) {
  const m = String(uri || '').match(/^mongodb(?:\+srv)?:\/\/(?:[^@/?#]*@)?([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * How a database target is shown and confirmed. Contains no credentials and not
 * the full host names.
 */
export function describeTarget(uri, dbName) {
  const hosts = hostsOf(uri);
  if (!hosts) throw new AppError(400, 'INVALID_URI', 'The MongoDB connection string is not valid.');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(String(dbName || ''))) throw new AppError(400, 'INVALID_DB_NAME', 'The database name may only contain letters, digits, "_" and "-".');
  const fingerprint = sha256(`${hosts}/${dbName}`).slice(0, 8);
  const hostHint = hosts
    .split(',')
    .map((h) => {
      const name = h.replace(/:\d+$/, '');
      const parts = name.split('.');
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
      return parts.length > 3 && !isIp ?`${parts[0]}.*.${parts.slice(-2).join('.')}` : name;
    })
    .join(', ');
  const local = hosts.split(',').every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h));
  return { dbName, hostHint, fingerprint, label: `${dbName}@${fingerprint}`, local, clusterFingerprint: sha256(hosts).slice(0, 8) };
}

/** Database names that must never be written by restore and need an extra flag for other writes. */
export function productionDbNames(env = {}) {
  const extra = String(env.MONGODB_PRODUCTION_DBS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_PRODUCTION_DBS, ...extra])];
}

export function isProductionTarget(target, env = {}) {
  return productionDbNames(env).some((n) => n.toLowerCase() === target.dbName.toLowerCase());
}

/** Throws unless `confirmation` is exactly the target's label. */
export function assertConfirmed(target, confirmation, action) {
  if (confirmation !== target.label) {
    throw new AppError(
      400,
      'CONFIRMATION_REQUIRED',
      confirmation
        ? `The confirmation "${confirmation}" does not match the target database ${target.label}. Nothing was changed.`
        : `To ${action}, confirm the target database by adding: --confirm-target ${target.label}`,
    );
  }
}

// ---- Verification ------------------------------------------------------------------------
/**
 * Check counts and relationships. Never writes. `problems` are integrity errors;
 * `warnings` are worth a look but not necessarily wrong.
 */
export async function verifyDatabase(db) {
  const c = (n) => db.collection(COLLECTIONS[n]);
  const problems = [];
  const warnings = [];
  const counts = {};
  for (const name of Object.values(COLLECTIONS)) counts[name] = await db.collection(name).countDocuments({});

  const group = async (collection, field, match = {}) =>
    collection.aggregate([{ $match: { ...match, [field]: { $type: 'string' } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'dups' }]).toArray();

  // History
  const byStatus = Object.fromEntries((await c('history').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()).map((g) => [String(g._id), g.n]));
  const unknownStatuses = Object.keys(byStatus).filter((s) => !['Success', 'Failed', 'Uncertain'].includes(s));
  if (unknownStatuses.length) warnings.push(`History has records with unexpected status values: ${unknownStatuses.join(', ')}.`);
  const unresolvedUncertain = await c('history').countDocuments({ status: 'Uncertain', void: { $exists: false } });
  if (unresolvedUncertain) warnings.push(`${unresolvedUncertain} send(s) are "Uncertain" and need reconciliation (npm run db:reconcile).`);
  const badDates = await c('history').countDocuments({ $or: [{ sentAtUtc: { $exists: false } }, { sentAtUtc: { $not: { $type: 'date' } } }] });
  if (badDates) problems.push(`${badDates} history record(s) have no valid UTC date.`);
  const epochDates = await c('history').countDocuments({ sentAtUtc: { $lt: new Date('2000-01-01T00:00:00Z') } });
  if (epochDates) warnings.push(`${epochDates} history record(s) are dated before 2000 (an unreadable legacy date was imported as 1970).`);
  for (const [field, match, label] of [
    ['claimId', {}, 'send claim'],
    ['requestId', { status: 'Success' }, 'successful send request'],
    ['legacyKey', {}, 'legacy fingerprint'],
  ]) {
    const [d] = await group(c('history'), field, match);
    if (d?.dups) problems.push(`${d.dups} ${label}(s) appear in more than one history record.`);
  }

  // Workbook: the current pointer must reference a complete workbook.
  const pointer = await c('workbooks').findOne({ _id: 'current' });
  const workbook = { current: pointer?.workbookId ?? null, rows: null, complete: null };
  if (pointer?.workbookId) {
    const meta = await c('workbooks').findOne({ _id: pointer.workbookId });
    const rows = await c('attorneys').countDocuments({ workbookId: pointer.workbookId });
    workbook.rows = rows;
    workbook.complete = Boolean(meta) && (meta.status === undefined || meta.status === 'ready') && rows === meta.rowCount;
    if (!meta) problems.push('The current workbook pointer refers to a workbook that does not exist.');
    else if (!workbook.complete) problems.push(`The current workbook is incomplete (${rows} of ${meta.rowCount} rows, status ${meta.status}).`);
  }
  const metaIds = new Set((await c('workbooks').find({ _id: { $ne: 'current' } }, { projection: { _id: 1, rowsRemoved: 1 } }).toArray()).map((m) => m._id));
  const rowOwners = await c('attorneys').distinct('workbookId');
  const orphanOwners = rowOwners.filter((id) => !metaIds.has(id));
  if (orphanOwners.length) problems.push(`Attorney rows exist for ${orphanOwners.length} workbook(s) that have no metadata.`);
  const staleOwners = rowOwners.filter((id) => metaIds.has(id) && id !== workbook.current);
  if (staleOwners.length) warnings.push(`Rows of ${staleOwners.length} replaced or failed workbook upload(s) are still stored (removed automatically by the app's maintenance).`);

  // Activity -> history links.
  const linked = (await c('activity').distinct('historyId', { historyId: { $type: 'objectId' } })) || [];
  let missingHistory = 0;
  for (let i = 0; i < linked.length; i += 500) {
    const ids = linked.slice(i, i + 500);
    missingHistory += ids.length - (await c('history').countDocuments({ _id: { $in: ids } }));
  }
  if (missingHistory) problems.push(`${missingHistory} activity entr(y/ies) refer to history records that do not exist.`);

  // In-flight claims (expected to be few; they are resolved automatically).
  const claims = Object.fromEntries((await c('pending').aggregate([{ $group: { _id: { $ifNull: ['$state', 'sending'] }, n: { $sum: 1 } } }]).toArray()).map((g) => [String(g._id), g.n]));
  if (counts[COLLECTIONS.pending]) warnings.push(`${counts[COLLECTIONS.pending]} send claim(s) are in progress or awaiting recovery: ${JSON.stringify(claims)}.`);

  if (!(await c('templates').findOne({ _id: 'active' }))) warnings.push('No email template is saved (the default template is used).');
  if (!(await c('mappings').findOne({ _id: 'active' }))) warnings.push('No column mapping is saved.');

  return { ok: problems.length === 0, counts, history: { byStatus, unresolvedUncertain }, workbook, claims, problems, warnings };
}

// ---- Backup ------------------------------------------------------------------------------
/**
 * Export every app collection (canonical Extended JSON, so dates and ids round-
 * trip exactly) with a manifest of counts and SHA-256 checksums. Read-only.
 */
export async function backupCollections({ db, outDir, target = null }) {
  await fs.mkdir(outDir, { recursive: true });
  const collections = {};
  const before = {};
  for (const name of Object.values(COLLECTIONS)) before[name] = await db.collection(name).countDocuments({});
  for (const name of Object.values(COLLECTIONS)) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    const text = BSON.EJSON.stringify(docs, { relaxed: false });
    const file = `mongodb-${name}.json`;
    await fs.writeFile(path.join(outDir, file), text, { mode: 0o600 });
    const indexes = (await db.collection(name).indexes().catch(() => [])).map(({ v, ns, ...i }) => i);
    collections[name] = { file, count: docs.length, sha256: sha256(text), indexes };
  }
  const changed = Object.values(COLLECTIONS).filter((n) => before[n] !== collections[n].count);
  const verification = await verifyDatabase(db);
  const manifest = {
    format: BACKUP_FORMAT,
    createdAtUtc: new Date().toISOString(),
    source: target ? { dbName: target.dbName, label: target.label, hostHint: target.hostHint, clusterFingerprint: target.clusterFingerprint } : null,
    collections,
    // Documents written while the backup ran (the app was in use): counts may differ slightly.
    changedDuringBackup: changed,
    verification: { ok: verification.ok, problems: verification.problems, warnings: verification.warnings, history: verification.history },
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/** Read a backup folder, checking its format, counts and checksums. */
export async function readBackup(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new AppError(400, 'BACKUP_INVALID', `No readable manifest.json in ${dir}. Is this a backup folder made by "npm run db:backup"?`);
  }
  if (manifest.format !== BACKUP_FORMAT) throw new AppError(400, 'BACKUP_INVALID', `Unknown backup format "${manifest.format}".`);
  const data = {};
  for (const [name, info] of Object.entries(manifest.collections || {})) {
    if (!Object.values(COLLECTIONS).includes(name)) throw new AppError(400, 'BACKUP_INVALID', `The backup contains an unexpected collection "${name}".`);
    const text = await fs.readFile(path.join(dir, path.basename(info.file)), 'utf8').catch(() => null);
    if (text === null) throw new AppError(400, 'BACKUP_INVALID', `The backup file ${info.file} is missing.`);
    if (sha256(text) !== info.sha256) throw new AppError(400, 'BACKUP_CORRUPT', `The backup file ${info.file} does not match its checksum (changed or damaged). Nothing was restored.`);
    const docs = BSON.EJSON.parse(text, { relaxed: false });
    if (!Array.isArray(docs) || docs.length !== info.count) throw new AppError(400, 'BACKUP_CORRUPT', `The backup file ${info.file} has ${docs?.length} documents, the manifest says ${info.count}.`);
    data[name] = docs;
  }
  return { manifest, data };
}

// ---- Restore -----------------------------------------------------------------------------
/**
 * Restore a backup into a separate, empty database. Refuses the app's own
 * database, production databases and any database that already holds app data.
 * Indexes (including the unique ones) are created first, then documents are
 * inserted with their original ids, then counts and relationships are verified.
 */
export async function restoreBackup({ client, backupDir, target, appTargets = [], env = {} }) {
  const { manifest, data } = await readBackup(backupDir);
  if (isProductionTarget(target, env)) {
    throw new AppError(400, 'RESTORE_TARGET_PROTECTED', `"${target.dbName}" is a production database. A restore never writes into it: restore into a new database name (e.g. ${target.dbName}_restore_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}) instead.`);
  }
  if (appTargets.some((t) => t.label === target.label)) {
    throw new AppError(400, 'RESTORE_TARGET_PROTECTED', `"${target.dbName}" is the database the app is configured to use. Restore into a new database name instead.`);
  }
  if (manifest.source?.label && manifest.source.label === target.label) {
    throw new AppError(400, 'RESTORE_TARGET_PROTECTED', 'The target is the database this backup was taken from. Restore into a new database name instead.');
  }
  const db = client.db(target.dbName);
  const existing = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of existing) {
    if ((await db.collection(name).estimatedDocumentCount()) > 0) {
      throw new AppError(400, 'TARGET_NOT_EMPTY', `The database "${target.dbName}" already contains data (collection "${name}"). A restore never overwrites data: choose a new, empty database name.`);
    }
  }
  await ensureIndexes(db);
  const restored = {};
  for (const name of Object.values(COLLECTIONS)) {
    const docs = data[name] || [];
    for (let i = 0; i < docs.length; i += 1000) await db.collection(name).insertMany(docs.slice(i, i + 1000), { ordered: true });
    restored[name] = await db.collection(name).countDocuments({});
  }
  const mismatched = Object.values(COLLECTIONS).filter((n) => restored[n] !== (manifest.collections[n]?.count ?? 0));
  const verification = await verifyDatabase(db);
  if (mismatched.length) verification.problems.unshift(`Restored counts differ from the backup for: ${mismatched.join(', ')}.`);
  return { manifest, restored, verification: { ...verification, ok: verification.problems.length === 0 } };
}
