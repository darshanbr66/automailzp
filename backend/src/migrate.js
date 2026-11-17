// Backup and migration of the existing file-based data into MongoDB.
// Safe to run more than once, never deletes or changes the source files, and
// copes with missing or unreadable sources (reported, not fatal).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BSON } from 'mongodb';
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
/** Copy the legacy files and export every MongoDB collection to `outDir`. */
export async function backup({ dataDir, db = null, outDir, historyJsonPath = null }) {
  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  for (const name of ['sent-emails.xlsx', 'sent-emails-pending.json', 'template.json', 'settings.json', 'mongo-history-fallback.json']) {
    const buf = await readFileIfExists(path.join(dataDir, name)).catch(() => null);
    if (buf) {
      await fs.writeFile(path.join(outDir, name), buf);
      files.push(name);
    }
  }
  if (historyJsonPath) {
    const buf = await readFileIfExists(historyJsonPath).catch(() => null);
    if (buf) {
      await fs.writeFile(path.join(outDir, `history-export-${path.basename(historyJsonPath)}`), buf);
      files.push(path.basename(historyJsonPath));
    }
  }
  const collections = {};
  if (db) {
    for (const name of Object.values(COLLECTIONS)) {
      const docs = await db.collection(name).find({}).toArray();
      await fs.writeFile(path.join(outDir, `mongodb-${name}.json`), BSON.EJSON.stringify(docs, { relaxed: false }, 2));
      collections[name] = docs.length;
    }
  }
  await fs.writeFile(path.join(outDir, 'backup-info.json'), JSON.stringify({ createdAtUtc: new Date().toISOString(), dataDir, files, collections }, null, 2));
  return { outDir, files, collections };
}

// ---- Migration ---------------------------------------------------------------------------------
/**
 * Import legacy data into MongoDB. Idempotent: history rows are upserted by
 * fingerprint; the template/mapping are only imported when the database has none
 * (unless forced). With dryRun nothing is written.
 */
export async function migrate({ db, dataDir, historyJsonPath = null, legacyTimeZone, historyJsonTimeZone = 'UTC', dryRun = true, forceTemplate = false, forceMapping = false }) {
  const src = await readLegacySources({ dataDir, historyJsonPath, legacyTimeZone, historyJsonTimeZone });
  const report = { dryRun, found: src.found, problems: [...src.problems], history: { candidates: src.items.length, inserted: 0, alreadyPresent: 0, unparsableDates: 0 }, template: 'not found', mapping: 'not found' };
  if (!dryRun) await ensureIndexes(db);
  const hist = db.collection(COLLECTIONS.history);

  const existing = new Set((await hist.find({ legacyKey: { $in: src.items.map((i) => i.entry.legacyKey) } }, { projection: { legacyKey: 1 } }).toArray()).map((d) => d.legacyKey));
  const ops = [];
  for (const { entry, source, timeZone } of src.items) {
    if (existing.has(entry.legacyKey)) {
      report.history.alreadyPresent += 1;
      continue;
    }
    const utc = entry.sentAtUtc ? new Date(entry.sentAtUtc) : legacyLocalToUtc(entry.sentAt, timeZone);
    if (!utc || Number.isNaN(utc.valueOf())) report.history.unparsableDates += 1;
    const doc = toHistoryDoc({
      ...entry,
      sentAtUtc: utc && !Number.isNaN(utc.valueOf()) ? utc.toISOString() : new Date(0).toISOString(),
      source: 'migration',
      legacy: { source, sentAtText: entry.sentAt || '', timeZoneAssumed: entry.sentAtUtc ? 'recorded in UTC' : timeZone, pendingSave: Boolean(entry.pendingSave) },
      legacyKey: entry.legacyKey,
    });
    ops.push({ updateOne: { filter: { legacyKey: entry.legacyKey }, update: { $setOnInsert: doc }, upsert: true } });
  }
  if (dryRun) {
    report.history.inserted = ops.length;
  } else if (ops.length) {
    const r = await hist.bulkWrite(ops, { ordered: false });
    report.history.inserted = r.upsertedCount;
    report.history.alreadyPresent += ops.length - r.upsertedCount;
  }

  for (const [kind, value, force, colName] of [['template', src.template, forceTemplate, COLLECTIONS.templates], ['mapping', src.mapping, forceMapping, COLLECTIONS.mappings]]) {
    if (!value) continue;
    const current = await db.collection(colName).findOne({ _id: 'active' });
    if (current && !force) {
      report[kind] = 'kept the one already in MongoDB (use --force-' + kind + ' to replace it)';
      continue;
    }
    report[kind] = dryRun ? 'would be imported' : 'imported';
    if (!dryRun) await db.collection(colName).updateOne({ _id: 'active' }, { $set: { [kind]: value, updatedAt: new Date(), updatedBy: 'migration' } }, { upsert: true });
  }

  if (!dryRun) {
    await db.collection(COLLECTIONS.activity).insertOne({
      at: new Date(),
      action: 'data_migrated',
      summary: `Imported legacy data: ${report.history.inserted} history row(s)`,
      outcome: 'ok',
      operator: { name: 'migration script', idType: 'system' },
      details: { found: report.found, history: report.history, template: report.template, mapping: report.mapping, problems: report.problems, legacyTimeZone, historyJsonTimeZone },
    });
  }
  return report;
}
