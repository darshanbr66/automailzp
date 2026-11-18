// Backup and migration of the existing file-based data into MongoDB.
// Safe to run more than once, never deletes or changes the source files, and
// copes with missing or unreadable sources (reported, not fatal).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupCollections } from './dbops.js';
import { HistoryStore } from './history.js';
import { validateTemplate } from './template.js';
import { sanitizeMapping } from './excel.js';
import { isPlainObject, readFileIfExists, readJsonFile } from './utils.js';
import { COLLECTIONS, ensureIndexes, toHistoryDoc } from './storage/mongo.js';

// ---- Time zones -------------------------------------------------------------------------
/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
function tzOffsetMs(ts, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ts;
}

/**
 * Convert a legacy "YYYY-MM-DD HH:mm:ss" (written without a time zone) to UTC,
 * assuming it was written in `timeZone`. Returns null if it can't be parsed.
 */
export function legacyLocalToUtc(text, timeZone = 'UTC') {
  const m = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (timeZone === 'UTC') return new Date(guess);
  let ts = guess - tzOffsetMs(guess, timeZone);
  const second = tzOffsetMs(ts, timeZone); // DST edge: re-check with the offset at the result
  ts = guess - second;
  return new Date(ts);
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- Reading legacy sources ---------------------------------------------------------------
/** Fingerprint of a legacy history row; `occurrence` separates identical rows. */
export function legacyKeyFor(e, occurrence) {
  const basis = JSON.stringify([e.recordId, e.sentAt, e.recipientEmail, e.subject, e.status, e.sendType, e.senderEmail].map((v) => String(v ?? '').trim()));
  return `${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}:${occurrence}`;
}

function withLegacyKeys(rows) {
  const seen = new Map();
  return rows.map((e) => {
    const base = legacyKeyFor(e, 0).split(':')[0];
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...e, legacyKey: legacyKeyFor(e, n) };
  });
}

/**
 * Read everything that may need migrating. Never writes. Each item:
 * { entry, source, timeZone }. `problems` lists anything that couldn't be read.
 */
export async function readLegacySources({ dataDir, historyJsonPath = null, legacyTimeZone, historyJsonTimeZone = 'UTC' }) {
  const problems = [];
  const found = { excelRows: 0, pendingRows: 0, apiExportRows: 0, template: false, mapping: false };
  const items = [];

  // 1. sent-emails.xlsx + sent-emails-pending.json (read directly: no flushing)
  let pending = [];
  try {
    const p = await readJsonFile(path.join(dataDir, 'sent-emails-pending.json'));
    pending = Array.isArray(p) ? p : [];
  } catch {
    problems.push('sent-emails-pending.json could not be read (skipped).');
  }
  try {
    const all = await new HistoryStore(dataDir).entriesInOrder(); // workbook rows, then pending rows
    const excel = all.slice(0, Math.max(0, all.length - pending.length));
    found.excelRows = excel.length;
    for (const entry of excel) items.push({ entry, source: 'excel', timeZone: legacyTimeZone });
  } catch (err) {
    problems.push(`sent-emails.xlsx could not be read (${err.code || err.message}); it was skipped and left unchanged.`);
  }
  found.pendingRows = pending.length;
  for (const entry of pending) items.push({ entry, source: 'pending-file', timeZone: legacyTimeZone });

  // 2. Optional JSON export of the production history (GET /api/history, saved from the browser)
  if (historyJsonPath) {
    try {
      const raw = JSON.parse(await fs.readFile(historyJsonPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw?.data?.entries || raw?.entries || [];
      if (!Array.isArray(list)) throw new Error('no entries array');
      const chronological = [...list].reverse(); // the API returns newest first
      found.apiExportRows = chronological.length;
      for (const entry of chronological) items.push({ entry, source: 'api-export', timeZone: historyJsonTimeZone });
    } catch (err) {
      problems.push(`The history export ${path.basename(historyJsonPath)} could not be read (${err.message}); it was skipped.`);
    }
  }

  // 3. Template and column mapping
  let template = null;
  try {
    const t = await readJsonFile(path.join(dataDir, 'template.json'));
    if (t) {
      template = validateTemplate(t);
      found.template = true;
    }
  } catch {
    problems.push('template.json is missing fields or damaged (skipped).');
  }
  let mapping = null;
  try {
    const s = await readJsonFile(path.join(dataDir, 'settings.json'));
    if (isPlainObject(s?.mapping)) {
      mapping = sanitizeMapping(s.mapping);
      found.mapping = true;
    }
  } catch {
    problems.push('settings.json could not be read (skipped).');
  }

  // Identical rows are numbered WITHIN each source, so the same row present in
  // both the Excel file and the production export gets the same key (imported
  // once), while genuinely repeated rows in one source are all kept.
  const groups = new Map();
  items.forEach((it, idx) => {
    const g = it.source === 'api-export' ? 'api-export' : 'files';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(idx);
  });
  const keyed = [...items];
  for (const idxs of groups.values()) {
    const entries = withLegacyKeys(idxs.map((i) => items[i].entry));
    idxs.forEach((i, j) => {
      keyed[i] = { ...items[i], entry: entries[j] };
    });
  }
  // Rows present in both groups appear twice in the list with the same key: keep one.
  const seen = new Set();
  const unique = keyed.filter((it) => (seen.has(it.entry.legacyKey) ? false : seen.add(it.entry.legacyKey)));
  return { items: unique, template, mapping, found, problems, duplicatesAcrossSources: keyed.length - unique.length };
}

// ---- Backup ----------------------------------------------------------------------------------
/**
 * Copy the legacy files and export every MongoDB collection to `outDir`
 * (with a checksummed manifest; see dbops.js). Never changes the sources.
 */
export async function backup({ dataDir, db = null, outDir, historyJsonPath = null, target = null }) {
  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  for (const name of ['sent-emails.xlsx', 'sent-emails-pending.json', 'template.json', 'settings.json', 'mongo-history-fallback.json']) {
    const buf = await readFileIfExists(path.join(dataDir, name)).catch(() => null);
    if (buf) {
      await fs.writeFile(path.join(outDir, name), buf, { mode: 0o600 });
      files.push(name);
    }
  }
  if (historyJsonPath) {
    const buf = await readFileIfExists(historyJsonPath).catch(() => null);
    if (buf) {
      await fs.writeFile(path.join(outDir, `history-export-${path.basename(historyJsonPath)}`), buf, { mode: 0o600 });
      files.push(path.basename(historyJsonPath));
    }
  }
  let manifest = null;
  const collections = {};
  if (db) {
    manifest = await backupCollections({ db, outDir, target });
    for (const [name, info] of Object.entries(manifest.collections)) collections[name] = info.count;
  }
  await fs.writeFile(path.join(outDir, 'backup-info.json'), JSON.stringify({ createdAtUtc: new Date().toISOString(), dataDir, files, collections }, null, 2));
  return { outDir, files, collections, manifest };
}

// ---- Migration ---------------------------------------------------------------------------------
const KNOWN_STATUSES = ['Success', 'Failed', 'Uncertain'];
const EARLIEST_PLAUSIBLE = Date.UTC(2015, 0, 1);
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** History counts in the database (for the before/after comparison). */
export async function historyCounts(db) {
  const hist = db.collection(COLLECTIONS.history);
  const byStatus = Object.fromEntries((await hist.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()).map((g) => [String(g._id), g.n]));
  return { total: await hist.countDocuments({}), byStatus, migrated: await hist.countDocuments({ source: 'migration' }) };
}

/** The UTC instant of a legacy row: its recorded UTC time when valid, else its local text. */
function utcOf(entry, timeZone) {
  if (entry.sentAtUtc && ISO_UTC_RE.test(String(entry.sentAtUtc))) {
    const d = new Date(entry.sentAtUtc);
    if (!Number.isNaN(d.valueOf())) return { utc: d, recorded: true };
  }
  return { utc: legacyLocalToUtc(entry.sentAt, timeZone), recorded: false };
}

/**
 * Check the legacy rows before importing: dates, statuses, pending and
 * uncertain rows, and fingerprints. Never writes.
 */
export function preflight(src, { now = Date.now() } = {}) {
  const dates = { recordedUtc: 0, convertedFromLocal: 0, unparsable: [], invalidUtc: [], suspicious: [] };
  const statuses = {};
  let pendingRows = 0;
  const fingerprints = { candidates: src.items.length, repeatedIdenticalRows: 0, inBothSources: src.duplicatesAcrossSources || 0 };
  src.items.forEach(({ entry, source, timeZone }, i) => {
    const where = { index: i + 1, source, recordId: entry.recordId || '', sentAt: entry.sentAt || '', sentAtUtc: entry.sentAtUtc || '' };
    const s = entry.status || '(empty)';
    statuses[s] = (statuses[s] || 0) + 1;
    if (entry.pendingSave || source === 'pending-file') pendingRows += 1;
    if (!String(entry.legacyKey).endsWith(':0')) fingerprints.repeatedIdenticalRows += 1;
    if (entry.sentAtUtc && !ISO_UTC_RE.test(String(entry.sentAtUtc))) dates.invalidUtc.push(where);
    const { utc, recorded } = utcOf(entry, timeZone);
    if (!utc) dates.unparsable.push(where);
    else {
      if (recorded) dates.recordedUtc += 1;
      else dates.convertedFromLocal += 1;
      if (utc.valueOf() > now + 86400000 || utc.valueOf() < EARLIEST_PLAUSIBLE) dates.suspicious.push({ ...where, utc: utc.toISOString() });
    }
  });
  const unknownStatuses = Object.keys(statuses).filter((s) => !KNOWN_STATUSES.includes(s));
  return { dates, statuses, unknownStatuses, pendingRows, uncertainRows: statuses.Uncertain || 0, fingerprints };
}

/**
 * Import legacy data into MongoDB. Idempotent: history rows are upserted by
 * fingerprint; the template/mapping are only imported when the database has none
 * (unless forced). With dryRun nothing is written. Every imported row carries
 * the run id, so one run can be rolled back exactly (rollbackMigration).
 *
 * Refuses to write when a row's date can't be read (unless allowUnparsableDates)
 * and verifies afterwards that every legacy row is present.
 */
export async function migrate({ db, dataDir, historyJsonPath = null, legacyTimeZone, historyJsonTimeZone = 'UTC', dryRun = true, forceTemplate = false, forceMapping = false, allowUnparsableDates = false, runId = null }) {
  const src = await readLegacySources({ dataDir, historyJsonPath, legacyTimeZone, historyJsonTimeZone });
  const id = runId || `mig-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const checks = preflight(src);
  const report = {
    dryRun,
    runId: dryRun ? null : id,
    found: src.found,
    problems: [...src.problems],
    preflight: checks,
    history: { candidates: src.items.length, inserted: 0, alreadyPresent: 0, unparsableDates: checks.dates.unparsable.length },
    counts: { before: await historyCounts(db), after: null },
    verification: null,
    template: 'not found',
    mapping: 'not found',
  };
  if (checks.unknownStatuses.length) report.problems.push(`Rows with unexpected status values are imported unchanged: ${checks.unknownStatuses.join(', ')}.`);
  if (checks.dates.unparsable.length && !allowUnparsableDates) {
    report.blocked = `${checks.dates.unparsable.length} row(s) have a date that can't be read (see preflight.dates.unparsable). Fix them in the source, or re-run with --allow-unparsable-dates to import them dated 1970-01-01.`;
    if (!dryRun) return report;
  }
  if (!dryRun) await ensureIndexes(db);
  const hist = db.collection(COLLECTIONS.history);

  const keys = src.items.map((i) => i.entry.legacyKey);
  const existing = new Set((await hist.find({ legacyKey: { $in: keys } }, { projection: { legacyKey: 1 } }).toArray()).map((d) => d.legacyKey));
  const ops = [];
  for (const { entry, source, timeZone } of src.items) {
    if (existing.has(entry.legacyKey)) {
      report.history.alreadyPresent += 1;
      continue;
    }
    const { utc, recorded } = utcOf(entry, timeZone);
    const { pendingSave, ...rest } = entry;
    const doc = toHistoryDoc({
      ...rest,
      sentAtUtc: utc ? utc.toISOString() : new Date(0).toISOString(),
      source: 'migration',
      legacy: { source, sentAtText: entry.sentAt || '', timeZoneAssumed: recorded ? 'recorded in UTC' : timeZone, pendingSave: Boolean(pendingSave), unparsableDate: !utc, migrationRunId: id },
      legacyKey: entry.legacyKey,
    });
    ops.push({ updateOne: { filter: { legacyKey: entry.legacyKey }, update: { $setOnInsert: doc }, upsert: true } });
  }
  if (dryRun) {
    report.history.inserted = ops.length;
  } else if (ops.length) {
    const r = await hist.bulkWrite(ops, { ordered: false, writeConcern: { w: 'majority' } });
    report.history.inserted = r.upsertedCount;
    report.history.alreadyPresent += ops.length - r.upsertedCount;
  }

  const previous = {};
  for (const [kind, value, force, colName] of [['template', src.template, forceTemplate, COLLECTIONS.templates], ['mapping', src.mapping, forceMapping, COLLECTIONS.mappings]]) {
    if (!value) continue;
    const current = await db.collection(colName).findOne({ _id: 'active' });
    if (current && !force) {
      report[kind] = 'kept the one already in MongoDB (use --force-' + kind + ' to replace it)';
      continue;
    }
    report[kind] = dryRun ? 'would be imported' : 'imported';
    previous[kind] = current ? current[kind] : null;
    if (!dryRun) await db.collection(colName).updateOne({ _id: 'active' }, { $set: { [kind]: value, updatedAt: new Date(), updatedBy: 'migration', migrationRunId: id } }, { upsert: true });
  }

  if (!dryRun) {
    // Verify: every legacy row is present, and the totals add up.
    const after = await historyCounts(db);
    report.counts.after = after;
    const present = await hist.countDocuments({ legacyKey: { $in: keys } });
    const expectedTotal = report.counts.before.total + report.history.inserted;
    const missing = keys.length - present;
    report.verification = { ok: missing === 0 && after.total >= expectedTotal, legacyRowsPresent: present, legacyRowsExpected: keys.length, missing, expectedTotalAtLeast: expectedTotal, total: after.total };
    if (after.total > expectedTotal) report.verification.note = `${after.total - expectedTotal} record(s) were added by the app while the migration ran.`;
    if (!report.verification.ok) report.problems.push(`Verification failed: ${missing} legacy row(s) are missing after the import. Do not switch over; see the rollback procedure.`);
    await db.collection(COLLECTIONS.activity).insertOne({
      at: new Date(),
      action: 'data_migrated',
      summary: `Imported legacy data: ${report.history.inserted} history row(s) (run ${id})`,
      outcome: report.verification.ok ? 'ok' : 'failed',
      operator: { name: 'migration script', idType: 'system' },
      details: { runId: id, found: report.found, history: report.history, counts: report.counts, verification: report.verification, template: report.template, mapping: report.mapping, previous, problems: report.problems, legacyTimeZone, historyJsonTimeZone },
    });
  }
  return report;
}

/**
 * Undo one migration run: removes ONLY the history rows that run inserted and
 * that nobody has corrected since, and puts back the template/mapping it
 * replaced (if unchanged since). Corrected rows are listed and kept.
 * With dryRun nothing is written.
 */
export async function rollbackMigration({ db, runId, dryRun = true }) {
  if (!/^mig-[A-Za-z0-9-]{6,60}$/.test(String(runId || ''))) throw new Error('A valid migration run id (mig-...) is required; it is printed by the migration and kept in Team Activity.');
  const hist = db.collection(COLLECTIONS.history);
  const run = await db.collection(COLLECTIONS.activity).findOne({ action: 'data_migrated', 'details.runId': runId });
  const filter = { source: 'migration', 'legacy.migrationRunId': runId };
  const all = await hist.find(filter, { projection: { _id: 1, void: 1, resolution: 1, corrections: 1, recordId: 1, status: 1 } }).toArray();
  const isCorrected = (d) => Boolean(d.void || d.resolution || (Array.isArray(d.corrections) && d.corrections.length));
  const corrected = all.filter(isCorrected);
  const removable = all.filter((d) => !isCorrected(d)).map((d) => d._id);
  const report = { dryRun, runId, runFound: Boolean(run), rows: all.length, removable: removable.length, keptBecauseCorrected: corrected.map((d) => ({ id: String(d._id), recordId: d.recordId, status: d.status })), restored: [], deleted: 0 };
  for (const [kind, colName] of [['template', COLLECTIONS.templates], ['mapping', COLLECTIONS.mappings]]) {
    if (!run?.details?.previous || !(kind in run.details.previous)) continue;
    const current = await db.collection(colName).findOne({ _id: 'active' });
    if (current?.migrationRunId !== runId) {
      report.restored.push(`${kind}: changed since the migration, left as it is`);
      continue;
    }
    const prev = run.details.previous[kind];
    report.restored.push(`${kind}: ${prev ? 'previous one put back' : 'removed (there was none before)'}`);
    if (dryRun) continue;
    if (prev) await db.collection(colName).updateOne({ _id: 'active', migrationRunId: runId }, { $set: { [kind]: prev, updatedAt: new Date(), updatedBy: 'migration rollback' }, $unset: { migrationRunId: '' } });
    else await db.collection(colName).deleteOne({ _id: 'active', migrationRunId: runId });
  }
  if (!dryRun) {
    if (removable.length) {
      report.deleted = (await hist.deleteMany({ _id: { $in: removable }, ...filter, void: { $exists: false }, resolution: { $exists: false }, 'corrections.0': { $exists: false } })).deletedCount;
    }
    await db.collection(COLLECTIONS.activity).insertOne({
      at: new Date(),
      action: 'migration_rolled_back',
      summary: `Rolled back migration ${runId}: removed ${report.deleted} imported history row(s)`,
      outcome: corrected.length ? 'partial' : 'ok',
      operator: { name: 'migration script', idType: 'system' },
      details: report,
    });
  }
  return report;
}
