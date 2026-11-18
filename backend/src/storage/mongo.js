// MongoDB storage (Atlas M0 Free). Shared, permanent data for the whole team:
// the uploaded workbook, sending history, template, column mapping, in-flight
// sends and the team activity log. Credentials are never stored here.
import crypto from 'node:crypto';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { AppError, Mutex, normalizeId, readJsonFile, writeJsonFile } from '../utils.js';
import { DEFAULT_TEMPLATE, validateTemplate } from '../template.js';
import { sanitizeMapping } from '../excel.js';
import { normalizeEmail, normalizeText } from '../identity.js';

export const COLLECTIONS = {
  attorneys: 'attorneys',
  history: 'email_history',
  templates: 'email_templates',
  mappings: 'column_mappings',
  pending: 'pending_emails',
  workbooks: 'workbook_metadata',
  activity: 'team_activity',
};

// ---- Send claims ----------------------------------------------------------------------
// Every app send first writes a durable claim to `pending_emails` (unique per
// attorney and per address, so no other user or server process can send to them
// meanwhile). Its state only moves forward:
//
//   claimed   -> checks are running; the email provider has NOT been called
//   sending   -> written (and acknowledged) BEFORE the provider is called
//   accepted  -> the provider confirmed acceptance (message id stored)
//   failed    -> the provider confirmed the email was NOT sent
//   uncertain -> the provider's answer is unknown
//
// The claim is deleted only once the outcome is in `email_history` (which then
// blocks duplicates), or when nothing was sent. If the history write fails, the
// claim stays and keeps blocking; recovery (any process, also after a restart)
// writes the outcome later:
//   accepted -> Success (provider-confirmed), failed -> Failed,
//   sending / uncertain / unknown -> Uncertain (never resent automatically),
//   claimed -> deleted (the provider was never called).
// A claim in "claimed" or "sending" belongs to a live process while its
// heartbeat is fresh; it is only recovered once the heartbeat is stale.
export const CLAIM_STALE_MS = 2 * 60 * 1000;
export const CLAIM_HEARTBEAT_MS = 20 * 1000;
/** Kept for compatibility: a claim whose heartbeat is older than this is recovered. */
export const LOCK_STALE_MS = CLAIM_STALE_MS;
const TERMINAL_STATES = ['accepted', 'failed', 'uncertain'];
const SYSTEM_OPERATOR = { name: 'system (automatic recovery)', idType: 'system' };
const INSERT_BATCH = 1000;
const WORKBOOK_ABANDON_MS = 60 * 60 * 1000;
const MAJORITY = { writeConcern: { w: 'majority' } };

/** Create all indexes (idempotent: safe on every start-up). */
export async function ensureIndexes(db, { activityRetentionDays = null } = {}) {
  const c = (n) => db.collection(COLLECTIONS[n]);
  await Promise.all([
    c('attorneys').createIndex({ workbookId: 1, rowNumber: 1 }, { unique: true, name: 'workbook_row_unique' }),
    c('workbooks').createIndex({ uploadedAt: -1 }, { name: 'uploadedAt' }),
    c('workbooks').createIndex({ status: 1, uploadedAt: 1 }, { name: 'status_uploadedAt' }),
    c('history').createIndex({ recordKey: 1, sentAtUtc: -1 }, { name: 'record_date' }),
    c('history').createIndex({ emailKey: 1 }, { name: 'email' }),
    c('history').createIndex({ nameKey: 1 }, { name: 'name' }),
    c('history').createIndex({ sentAtUtc: -1 }, { name: 'date' }),
    c('history').createIndex({ status: 1, sendMethod: 1, sentAtUtc: -1 }, { name: 'status_method_date' }),
    c('history').createIndex({ 'operator.name': 1, sentAtUtc: -1 }, { name: 'operator_date' }),
    // A send request can be recorded as successful at most once (also across processes).
    c('history').createIndex({ requestId: 1 }, { unique: true, name: 'success_request_unique', partialFilterExpression: { status: 'Success', requestId: { $type: 'string' } } }),
    // One outcome per send claim: the sending process, recovery by other
    // processes and the local fallback can never record the same send twice.
    c('history').createIndex({ claimId: 1 }, { unique: true, name: 'claim_unique', partialFilterExpression: { claimId: { $type: 'string' } } }),
    // Re-running the migration never imports the same legacy row twice.
    c('history').createIndex({ legacyKey: 1 }, { unique: true, name: 'legacy_unique', partialFilterExpression: { legacyKey: { $type: 'string' } } }),
    c('history').createIndex({ 'legacy.migrationRunId': 1 }, { name: 'migration_run', partialFilterExpression: { 'legacy.migrationRunId': { $type: 'string' } } }),
    // Cross-process send claims: one in-flight send per attorney AND per address.
    c('pending').createIndex({ recordKey: 1 }, { unique: true, name: 'record_unique' }),
    c('pending').createIndex({ emailKey: 1 }, { unique: true, name: 'email_unique' }),
    c('pending').createIndex({ startedAt: 1 }, { name: 'startedAt' }),
    c('pending').createIndex({ state: 1, heartbeatAt: 1 }, { name: 'state_heartbeat' }),
    c('activity').createIndex({ at: -1 }, { name: 'date' }),
    c('activity').createIndex({ action: 1, at: -1 }, { name: 'action_date' }),
    c('activity').createIndex({ 'operator.name': 1, at: -1 }, { name: 'operator_date' }),
    c('activity').createIndex({ historyId: 1 }, { name: 'history' }),
    c('activity').createIndex({ 'attorney.recordKey': 1, at: -1 }, { name: 'attorney_date' }),
  ]);
  await ensureActivityRetention(db, activityRetentionDays);
}

/**
 * Optional automatic removal of old team-activity entries (ACTIVITY_RETENTION_DAYS).
 * Off by default: nothing is deleted unless it is configured. The sending
 * history is never subject to retention.
 */
async function ensureActivityRetention(db, days) {
  const activity = db.collection(COLLECTIONS.activity);
  const name = 'activity_ttl';
  const existing = (await activity.indexes().catch(() => [])).find((i) => i.name === name);
  if (!days) {
    if (existing) await activity.dropIndex(name).catch(() => {});
    return;
  }
  const seconds = Math.round(days * 86400);
  if (!existing) await activity.createIndex({ at: 1 }, { name, expireAfterSeconds: seconds });
  else if (existing.expireAfterSeconds !== seconds) await db.command({ collMod: COLLECTIONS.activity, index: { name, expireAfterSeconds: seconds } });
}

const isDuplicateKey = (e) => e?.code === 11000;
const isMongoError = (e) => /^Mongo/.test(String(e?.name || ''));
export const dbUnavailable = () =>
  new AppError(503, 'DB_UNAVAILABLE', 'The shared database (MongoDB) is not reachable right now. Nothing was changed. Please try again in a minute.');

const iso = (d) => (d instanceof Date && !Number.isNaN(d.valueOf()) ? d.toISOString() : null);
const selfDeclared = (name) => ({ name, idType: 'self-declared' });

/** History document -> the plain entry shape the app and UI use. */
export function toEntry(doc) {
  return {
    id: String(doc._id),
    recordId: doc.recordId ?? '',
    registrationNumber: doc.registrationNumber ?? '',
    attorneyName: doc.attorneyName ?? '',
    recipientEmail: doc.recipientEmail ?? '',
    firmName: doc.firmName ?? '',
    city: doc.city ?? '',
    state: doc.state ?? '',
    subject: doc.subject ?? '',
    sentAt: doc.sentAt ?? '',
    sentAtUtc: iso(doc.sentAtUtc),
    senderEmail: doc.senderEmail ?? '',
    status: doc.status ?? '',
    sendType: doc.sendType ?? '',
    sendMethod: doc.sendMethod ?? '',
    operator: doc.operator?.name ?? '',
    operatorIdType: doc.operator?.idType ?? '',
    requestId: doc.requestId ?? null,
    messageId: doc.messageId ?? null,
    claimId: doc.claimId ?? null,
    note: doc.note ?? '',
    source: doc.source ?? 'app',
    voided: Boolean(doc.void),
    void: doc.void ? { reason: doc.void.reason, operator: doc.void.operator?.name ?? '', atUtc: iso(doc.void.at) } : null,
    resolution: doc.resolution
      ? { previousStatus: doc.resolution.previousStatus, resolvedAs: doc.resolution.resolvedAs, reason: doc.resolution.reason, operator: doc.resolution.operator?.name ?? '', atUtc: iso(doc.resolution.at) }
      : null,
    corrections: Array.isArray(doc.corrections) ? doc.corrections.map((c) => ({ action: c.action, reason: c.reason, operator: c.operator?.name ?? '', atUtc: iso(c.at) })) : [],
    legacy: doc.legacy ?? null,
  };
}

/** Entry (from the app) -> history document. */
export function toHistoryDoc(entry) {
  const sentAtUtc = entry.sentAtUtc ? new Date(entry.sentAtUtc) : new Date();
  const doc = {
    recordId: entry.recordId ?? '',
    recordKey: normalizeId(entry.recordId),
    registrationNumber: entry.registrationNumber ?? '',
    attorneyName: entry.attorneyName ?? '',
    nameKey: normalizeText(entry.attorneyName),
    recipientEmail: entry.recipientEmail ?? '',
    emailKey: normalizeEmail(entry.recipientEmail),
    firmName: entry.firmName ?? '',
    city: entry.city ?? '',
    state: entry.state ?? '',
    subject: entry.subject ?? '',
    sentAt: entry.sentAt ?? '',
    sentAtUtc,
    senderEmail: entry.senderEmail ?? '',
    status: entry.status,
    sendType: entry.sendType ?? '',
    sendMethod: entry.sendMethod ?? '',
    operator: entry.operator ? selfDeclared(entry.operator) : null,
    source: entry.source || 'app',
  };
  for (const k of ['requestId', 'messageId', 'claimId', 'activityId', 'workbookId', 'note', 'legacyKey', 'legacy']) if (entry[k] != null && entry[k] !== '') doc[k] = entry[k];
  return doc;
}

/**
 * @param {{ uri?: string, dbName: string, dataDir: string, client?: MongoClient,
 *           claimStaleMs?: number, heartbeatMs?: number, activityRetentionDays?: number|null }} options
 */
export function createMongoStorage({ uri, dbName, dataDir, client: injected, claimStaleMs = CLAIM_STALE_MS, heartbeatMs = CLAIM_HEARTBEAT_MS, activityRetentionDays = null }) {
  const client = injected || new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'zodiacpatent-email-automation', maxPoolSize: 10 });
  const db = client.db(dbName);
  const col = (n) => db.collection(COLLECTIONS[n]);
  const fallbackPath = path.join(dataDir, 'mongo-history-fallback.json');
  const fallbackMutex = new Mutex();
  // Identifies this server process on its claims (random; no host names or secrets).
  const instanceId = crypto.randomUUID();
  let ready = null;

  /** Connect and create indexes once; retried after a failure. */
  function init() {
    if (!ready) {
      ready = (async () => {
        await client.connect();
        await ensureIndexes(db, { activityRetentionDays });
      })().catch((e) => {
        ready = null;
        throw e;
      });
    }
    return ready;
  }

  /** Run a DB operation; connection problems become a clear 503 for the user. */
  async function guard(fn) {
    try {
      await init();
      return await fn();
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (isMongoError(e)) {
        console.error(`[db] ${e.name}${e.code ? ` ${e.code}` : ''}`);
        throw dbUnavailable();
      }
      throw e;
    }
  }

  // ---- Local fallback for history rows that could not be written -------------
  // Only used when an email was already handed to the provider but MongoDB
  // failed afterwards. It is a secondary copy: the claim kept in MongoDB is what
  // keeps blocking duplicates (this file is lost when a Render instance restarts).
  const readFallback = async () => {
    try {
      const d = await readJsonFile(fallbackPath);
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  };
  async function flushFallback() {
    await fallbackMutex.run(async () => {
      const pending = await readFallback();
      if (!pending.length) return;
      const left = [];
      for (const entry of pending) {
        try {
          await writeOutcome(entry);
          // The outcome is now in the history: the finished claim is no longer needed.
          if (entry.claimId) await col('pending').deleteOne({ _id: entry.claimId, state: { $in: TERMINAL_STATES } }).catch(() => {});
        } catch {
          left.push(entry);
        }
      }
      await writeJsonFile(fallbackPath, left);
    });
  }

  /**
   * Write one send outcome. Idempotent per claim: if the outcome of this claim is
   * already recorded, nothing is added. A recorded "Uncertain" is upgraded only
   * when the email provider itself confirmed the result (never by guessing).
   * Throws on database errors.
   */
  async function writeOutcome(entry) {
    await init();
    try {
      const r = await col('history').insertOne(toHistoryDoc(entry), MAJORITY);
      return { saved: true, id: String(r.insertedId), inserted: true };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }
    const or = [];
    if (entry.claimId) or.push({ claimId: entry.claimId });
    if (entry.requestId && entry.status === 'Success') or.push({ requestId: entry.requestId, status: 'Success' });
    if (entry.legacyKey) or.push({ legacyKey: entry.legacyKey });
    const existing = or.length ? await col('history').findOne({ $or: or }) : null;
    if (!existing) return { saved: true, duplicate: true };
    if (entry.providerConfirmed && ['Success', 'Failed'].includes(entry.status) && existing.status === 'Uncertain' && !existing.void && !existing.resolution) {
      const resolvedAs = entry.status === 'Success' ? 'Sent' : 'Not sent';
      const at = new Date();
      const upgraded = await col('history').findOneAndUpdate(
        { _id: existing._id, status: 'Uncertain', void: { $exists: false }, resolution: { $exists: false } },
        {
          $set: {
            status: entry.status,
            ...(entry.messageId ? { messageId: entry.messageId } : {}),
            resolution: { previousStatus: 'Uncertain', resolvedAs, reason: 'The email provider confirmed the result after the send had been recorded as Uncertain.', at, operator: SYSTEM_OPERATOR },
          },
          $push: { corrections: { action: 'provider-confirmed', reason: `Provider confirmed: ${resolvedAs}`, at, operator: SYSTEM_OPERATOR } },
        },
        { returnDocument: 'after', ...MAJORITY },
      );
      if (upgraded) return { saved: true, id: String(existing._id), duplicate: true, upgraded: true };
    }
    return { saved: true, id: String(existing._id), duplicate: true };
  }

  async function recordActivity(evt) {
    try {
      await init();
      const doc = {
        at: new Date(),
        action: evt.action,
        summary: evt.summary || '',
        outcome: evt.outcome || 'ok',
        operator: evt.system ? SYSTEM_OPERATOR : { name: evt.ctx?.operator || null, idType: 'self-declared' },
        ip: evt.ctx?.ip || null,
        ipNote: evt.ctx?.ipNote || null,
        location: evt.ctx?.location || { available: false },
        os: evt.ctx?.os || null,
        osVersion: evt.ctx?.osVersion || null,
        browser: evt.ctx?.browser || null,
        browserVersion: evt.ctx?.browserVersion || null,
        deviceType: evt.ctx?.deviceType || null,
        attorney: evt.attorney
          ? {
              name: evt.attorney.attorneyName || '',
              registrationNumber: evt.attorney.registrationNumber || '',
              recipientEmail: evt.attorney.recipientEmail || '',
              recordId: evt.attorney.recordId || '',
              recordKey: normalizeId(evt.attorney.recordId),
            }
          : null,
        historyId: evt.historyId && ObjectId.isValid(String(evt.historyId)) ? new ObjectId(String(evt.historyId)) : null,
        details: evt.details || null,
      };
      const r = await col('activity').insertOne(doc);
      return r.insertedId;
    } catch (e) {
      console.error(`[db] Could not record team activity (${e?.name || 'error'})`);
      return null;
    }
  }

  const history = {
    async entriesInOrder() {
      return guard(async () => {
        await flushFallback().catch(() => {});
        const docs = await col('history').find({}).sort({ sentAtUtc: 1, _id: 1 }).toArray();
        const recorded = new Set(docs.map((d) => d.claimId).filter(Boolean));
        const pending = (await readFallback()).filter((e) => !e.claimId || !recorded.has(e.claimId)).map((e) => ({ ...e, pendingSave: true }));
        return [...docs.map(toEntry), ...pending];
      });
    },
    async readAll() {
      return (await history.entriesInOrder()).reverse();
    },
    /**
     * Record a send outcome. Never throws for write failures, because the email
     * may already have been handed to the provider. With `fallback` (the default)
     * the entry is also kept locally until it can be written.
     */
    async append(entry, { fallback = true } = {}) {
      try {
        return await writeOutcome(entry);
      } catch (e) {
        console.error(`[db] Could not write history to MongoDB (${e?.name || 'error'})${fallback ? '; kept locally until it can be written' : ''}`);
        if (!fallback) return { saved: false, keptPending: false };
        await fallbackMutex.run(async () => writeJsonFile(fallbackPath, [...(await readFallback()), entry])).catch(() => {});
        return {
          saved: false,
          keptPending: true,
          warning:
            'The email was accepted, but the shared database could not be updated right now. This attorney stays blocked for everyone, and the record will be added to the shared history automatically when the database is reachable again.',
        };
      }
    },
    async get(id) {
      return guard(async () => {
        if (!ObjectId.isValid(String(id))) return null;
        const doc = await col('history').findOne({ _id: new ObjectId(String(id)) });
        return doc ? toEntry(doc) : null;
      });
    },
    /**
     * Audited correction. Nothing is deleted: a void marks the record as not
     * counting; resolving an Uncertain record changes its status and keeps the old
     * one; "undo" reverses the latest void or resolution. Every change is appended
     * to the record's `corrections` list.
     */
    async correct(id, { action, reason, operator, activityId }) {
      return guard(async () => {
        if (!ObjectId.isValid(String(id))) throw new AppError(404, 'NOT_FOUND', 'That history record was not found.');
        const _id = new ObjectId(String(id));
        const before = await col('history').findOne({ _id });
        if (!before) throw new AppError(404, 'NOT_FOUND', 'That history record was not found.');
        const by = selfDeclared(operator);
        const at = new Date();
        const log = (kind, extra = {}) => ({ action: kind, reason, at, operator: by, ...(activityId ? { activityId } : {}), ...extra });
        let filter;
        let update;
        if (action === 'undo') {
          if (before.void) {
            filter = { _id, 'void.at': before.void.at };
            update = { $unset: { void: '' }, $push: { corrections: log('undo-void', { undone: before.void }) } };
          } else if (before.resolution) {
            filter = { _id, status: before.status, 'resolution.at': before.resolution.at };
            update = {
              $set: { status: before.resolution.previousStatus || 'Uncertain' },
              $unset: { resolution: '' },
              $push: { corrections: log('undo-resolution', { undone: before.resolution, statusBefore: before.status }) },
            };
          } else {
            throw new AppError(409, 'NOTHING_TO_UNDO', 'This record has no correction to undo.');
          }
        } else {
          if (before.void) throw new AppError(409, 'ALREADY_VOIDED', 'This record has already been voided.');
          filter = { _id, void: { $exists: false }, status: before.status, resolution: { $exists: Boolean(before.resolution) } };
          if (action === 'void') {
            if (before.status === 'Uncertain') {
              throw new AppError(409, 'RESOLVE_UNCERTAIN', 'The outcome of this send is unknown. Check the email provider, then confirm whether it was sent or not instead of voiding it.');
            }
            update = { $set: { void: { at, operator: by, reason, activityId } }, $push: { corrections: log('void') } };
          } else if (action === 'confirm-sent' || action === 'confirm-not-sent') {
            if (before.status !== 'Uncertain') throw new AppError(409, 'NOT_UNCERTAIN', 'Only "Uncertain" records can be confirmed as sent or not sent.');
            const resolvedAs = action === 'confirm-sent' ? 'Sent' : 'Not sent';
            update = {
              $set: { status: action === 'confirm-sent' ? 'Success' : 'Failed', resolution: { previousStatus: 'Uncertain', resolvedAs, reason, at, operator: by, activityId } },
              $push: { corrections: log(action) },
            };
          } else {
            throw new AppError(400, 'INVALID_ACTION', 'Unknown correction.');
          }
        }
        // Conditional update: two people correcting the same record at once can't both win.
        let r;
        try {
          r = await col('history').findOneAndUpdate(filter, update, { returnDocument: 'after', ...MAJORITY });
        } catch (e) {
          if (isDuplicateKey(e)) throw new AppError(409, 'CONFLICT', 'This send is already recorded as successful in another history record. Please refresh.');
          throw e;
        }
        if (!r) throw new AppError(409, 'CHANGED', 'This record was just changed by someone else. Please refresh and try again.');
        return { before: toEntry(before), after: toEntry(r) };
      });
    },
  };

  const templates = {
    async load() {
      return guard(async () => {
        const doc = await col('templates').findOne({ _id: 'active' });
        if (!doc) return { template: { ...DEFAULT_TEMPLATE } };
        try {
          return { template: validateTemplate(doc.template) };
        } catch {
          return { template: { ...DEFAULT_TEMPLATE }, warning: 'The saved template was invalid, so the default template is shown. Save to replace it.' };
        }
      });
    },
    async save(input, ctx = {}) {
      const tpl = validateTemplate(input);
      await guard(() => col('templates').updateOne({ _id: 'active' }, { $set: { template: tpl, updatedAt: new Date(), updatedBy: ctx.operator || null } }, { upsert: true }));
      return tpl;
    },
  };

  const mappings = {
    async load() {
      return guard(async () => {
        const doc = await col('mappings').findOne({ _id: 'active' });
        try {
          return doc?.mapping ? sanitizeMapping(doc.mapping) : null;
        } catch {
          return null;
        }
      });
    },
    async save(mapping, ctx = {}) {
      await guard(() => col('mappings').updateOne({ _id: 'active' }, { $set: { mapping, updatedAt: new Date(), updatedBy: ctx.operator || null } }, { upsert: true }));
    },
  };

  const incompleteWorkbook = () =>
    new AppError(503, 'WORKBOOK_INCOMPLETE', 'The shared workbook could not be loaded completely. Please try again; if this continues, upload the workbook again.');

  const workbooks = {
    /** The current shared workbook version (null when none). */
    async currentVersion() {
      return guard(async () => (await col('workbooks').findOne({ _id: 'current' }, { projection: { workbookId: 1 } }))?.workbookId ?? null);
    },
    /**
     * The current workbook, only if it is complete (every row present). A
     * workbook replaced at the same moment is re-read rather than returned half-deleted.
     */
    async loadCurrent() {
      return guard(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const id = (await col('workbooks').findOne({ _id: 'current' }))?.workbookId;
          if (!id) return null;
          const meta = await col('workbooks').findOne({ _id: id });
          const rows = meta ? await col('attorneys').find({ workbookId: id }, { projection: { _id: 0, rowNumber: 1, cells: 1 } }).sort({ rowNumber: 1 }).toArray() : [];
          if (meta && (meta.status === undefined || meta.status === 'ready') && rows.length === meta.rowCount) {
            return { sheetName: meta.sheetName, headers: meta.headers, rows, fileName: meta.fileName, uploadedAt: iso(meta.uploadedAt), uploadedBy: meta.uploadedBy || null, version: id, derived: null };
          }
          const nowCurrent = (await col('workbooks').findOne({ _id: 'current' }))?.workbookId;
          if (nowCurrent === id) throw incompleteWorkbook(); // the current workbook itself is damaged
        }
        throw incompleteWorkbook();
      });
    },
    /**
     * Store a new workbook and make it the current one for everyone. The switch
     * happens only after every row is stored and counted; a failed upload removes
     * its partial rows and leaves the previous workbook in place.
     */
    async save(wb, ctx = {}) {
      return guard(async () => {
        const id = wb.version;
        await col('workbooks').insertOne({
          _id: id,
          fileName: wb.fileName,
          sheetName: wb.sheetName,
          headers: wb.headers,
          rowCount: wb.rows.length,
          uploadedAt: new Date(wb.uploadedAt),
          uploadedBy: ctx.operator || null,
          status: 'uploading',
        });
        try {
          for (let i = 0; i < wb.rows.length; i += INSERT_BATCH) {
            const batch = wb.rows.slice(i, i + INSERT_BATCH).map((r) => ({ workbookId: id, rowNumber: r.rowNumber, cells: r.cells }));
            await col('attorneys').insertMany(batch, { ordered: true });
          }
          const stored = await col('attorneys').countDocuments({ workbookId: id });
          if (stored !== wb.rows.length) throw incompleteWorkbook();
          await col('workbooks').updateOne({ _id: id }, { $set: { status: 'ready', readyAt: new Date() } }, MAJORITY);
        } catch (e) {
          await col('attorneys').deleteMany({ workbookId: id }).catch(() => {});
          await col('workbooks').updateOne({ _id: id }, { $set: { status: 'failed', failedAt: new Date(), rowsRemoved: true } }).catch(() => {});
          throw e;
        }
        // Switch the pointer atomically; then remove the previous workbook's rows
        // (finished later by the maintenance sweep if this step is interrupted).
        const prev = await col('workbooks').findOneAndUpdate({ _id: 'current' }, { $set: { workbookId: id, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before', ...MAJORITY });
        if (prev?.workbookId && prev.workbookId !== id) await retire(prev.workbookId).catch(() => {});
      });
    },
    async clear() {
      return guard(async () => {
        const prev = await col('workbooks').findOneAndUpdate({ _id: 'current' }, { $set: { workbookId: null, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before' });
        if (prev?.workbookId) await retire(prev.workbookId).catch(() => {});
      });
    },
  };
  async function retire(id) {
    await col('workbooks').updateOne({ _id: id }, { $set: { status: 'superseded', supersededAt: new Date() } });
    await col('attorneys').deleteMany({ workbookId: id });
    await col('workbooks').updateOne({ _id: id }, { $set: { rowsRemoved: true } });
  }
  /** Remove rows of failed, abandoned or replaced uploads (never the current workbook). */
  async function cleanupWorkbooks(now = Date.now()) {
    const current = (await col('workbooks').findOne({ _id: 'current' }))?.workbookId ?? null;
    const metas = await col('workbooks')
      .find(
        { _id: { $ne: 'current' }, rowsRemoved: { $ne: true }, $or: [{ status: { $in: ['failed', 'superseded'] } }, { status: 'uploading', uploadedAt: { $lt: new Date(now - WORKBOOK_ABANDON_MS) } }] },
        { projection: { _id: 1, status: 1 } },
      )
      .toArray();
    let removed = 0;
    for (const m of metas) {
      if (m._id === current) continue;
      removed += (await col('attorneys').deleteMany({ workbookId: m._id })).deletedCount;
      await col('workbooks').updateOne({ _id: m._id }, { $set: { rowsRemoved: true, ...(m.status === 'uploading' ? { status: 'failed', failedAt: new Date() } : {}) } });
    }
    return removed;
  }

  /** The handle the app uses to move a claim through its states. */
  function claimHandle(_id) {
    let timer = setInterval(() => {
      col('pending').updateOne({ _id, owner: instanceId, state: { $in: ['claimed', 'sending'] } }, { $set: { heartbeatAt: new Date() } }).catch(() => {});
    }, heartbeatMs);
    timer.unref?.();
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    return {
      id: _id,
      durable: true, // kept in MongoDB until the outcome is in the history
      /**
       * Durably mark the claim as "sending". Must succeed BEFORE the email
       * provider is called: if it throws, nothing may be sent.
       */
      async begin(entryPatch = {}) {
        const set = { state: 'sending', sendingAt: new Date(), heartbeatAt: new Date() };
        for (const [k, v] of Object.entries(entryPatch)) set[`entry.${k}`] = v;
        const r = await guard(() => col('pending').updateOne({ _id, state: 'claimed', owner: instanceId }, { $set: set }, MAJORITY));
        if (r.matchedCount !== 1) {
          throw new AppError(409, 'CLAIM_LOST', 'This send could not be confirmed as in progress, so no email was sent. Please refresh and try again.');
        }
      },
      /** Store the provider's answer on the claim. Best effort; false if the database failed. */
      async finish(state, { messageId = null } = {}) {
        stop();
        try {
          await col('pending').updateOne({ _id, state: { $in: ['claimed', 'sending'] } }, { $set: { state, finishedAt: new Date(), ...(messageId ? { messageId } : {}) } }, MAJORITY);
          return true;
        } catch {
          return false;
        }
      },
      /**
       * Delete the claim: only once the outcome is in the history, or when the
       * provider was never called. Best effort: a claim that can't be deleted is
       * resolved by the recovery sweep.
       */
      async release() {
        stop();
        try {
          await col('pending').deleteOne({ _id });
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  /** Resolve one claim left behind (see the state description at the top). True when resolved. */
  async function recoverClaim(p, cutoff) {
    const state = p.state || 'sending'; // claims written before states existed: possibly sent
    const unchanged = { _id: p._id, state: p.state ? p.state : { $exists: false } };
    if (!TERMINAL_STATES.includes(state)) {
      // Not finished: only once the owner's heartbeat is stale (it stopped).
      Object.assign(unchanged, p.heartbeatAt ? { heartbeatAt: { $lt: cutoff } } : { heartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } });
    }
    if (p.kind !== 'send' || !p.entry || state === 'claimed') {
      // The email provider was never called for this claim.
      return (await col('pending').deleteOne(unchanged)).deletedCount === 1;
    }
    const status = state === 'accepted' ? 'Success' : state === 'failed' ? 'Failed' : 'Uncertain';
    const notes = {
      Success: 'The email provider accepted this email (its message id is stored). The history entry was written by automatic recovery because the database could not be updated at the time.',
      Failed: 'The email provider refused this email. Recorded by automatic recovery.',
      Uncertain:
        'The server stopped, or lost the database, while this email was being sent. It may or may not have been delivered. It is never resent automatically: check the email provider and record the outcome in Sent History.',
    };
    const at = p.sendingAt || p.startedAt || new Date();
    const entry = { ...p.entry, status, sentAtUtc: at.toISOString(), messageId: p.messageId || p.entry.messageId || null, claimId: p._id, note: notes[status], providerConfirmed: status !== 'Uncertain' };
    let r;
    try {
      r = await writeOutcome(entry);
    } catch {
      return false; // database still failing: keep the claim (it keeps blocking)
    }
    if (r.inserted) {
      await recordActivity({
        action: status === 'Uncertain' ? 'send_uncertain_recovered' : 'send_outcome_recovered',
        summary: status === 'Uncertain' ? 'An interrupted send was recorded as Uncertain' : `A send confirmed by the provider was recorded by automatic recovery (${status})`,
        outcome: status.toLowerCase(),
        system: true,
        attorney: p.entry,
        historyId: r.id,
        details: { claimState: state, requestId: p.requestId || null, messageId: entry.messageId, sendOperator: p.entry.operator || null },
      });
    }
    await col('pending').deleteOne(unchanged);
    return true;
  }

  const sweepMutex = new Mutex();
  const locks = {
    /**
     * Claim the right to send to this attorney and address, across ALL server
     * processes (unique indexes). The claim stores the draft history entry so an
     * interrupted send can be recorded later.
     */
    async acquire({ recordKey, emailKey, requestId, kind = 'send', entry = null }) {
      return guard(async () => {
        const now = new Date();
        const _id = `${kind}:${requestId || crypto.randomUUID()}:${crypto.randomBytes(4).toString('hex')}`;
        const doc = {
          _id,
          kind,
          state: 'claimed',
          recordKey: normalizeId(recordKey),
          emailKey: normalizeEmail(emailKey) || `none:${crypto.randomUUID()}`,
          requestId: requestId || null,
          owner: instanceId,
          startedAt: now,
          heartbeatAt: now,
          entry: entry ? { ...entry, claimId: _id } : null,
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await col('pending').insertOne(doc, MAJORITY);
            return claimHandle(_id);
          } catch (e) {
            if (!isDuplicateKey(e)) throw e;
            if (attempt === 0 && (await locks.sweep())) continue; // a finished or stale claim was resolved: try once more
            throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney or address is already being sent or recorded by a team member. Please wait a moment and refresh.');
          }
        }
        throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney is already being sent. Please wait.');
      });
    },
    /**
     * Resolve claims that are finished or whose process stopped (restart, crash,
     * lost database), and tidy up abandoned workbook uploads. Safe to run in
     * several processes at once.
     */
    async sweep(now = Date.now()) {
      return sweepMutex.run(() => guard(async () => {
        const cutoff = new Date(now - claimStaleMs);
        const candidates = await col('pending')
          .find({ $or: [{ state: { $in: TERMINAL_STATES } }, { heartbeatAt: { $lt: cutoff } }, { heartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } }] })
          .sort({ startedAt: 1 })
          .toArray();
        let n = 0;
        for (const p of candidates) if (await recoverClaim(p, cutoff)) n += 1;
        await cleanupWorkbooks(now).catch(() => {});
        return n;
      }));
    },
    async list() {
      return guard(async () =>
        (await col('pending').find({}).sort({ startedAt: 1 }).toArray()).map((p) => ({
          kind: p.kind,
          state: p.state || 'sending',
          startedAtUtc: iso(p.startedAt),
          attorneyName: p.entry?.attorneyName || '',
          recipientEmail: p.entry?.recipientEmail || '',
        })),
      );
    },
  };

  const activity = {
    record: recordActivity,
    async link(activityId, historyId) {
      if (!activityId || !historyId) return;
      await col('activity').updateOne({ _id: activityId }, { $set: { historyId: new ObjectId(String(historyId)) } }).catch(() => {});
    },
    async list({ page = 1, pageSize = 20, q = '', action = '', operator = '' } = {}) {
      return guard(async () => {
        const filter = {};
        if (action) filter.action = action;
        if (operator) filter['operator.name'] = operator;
        if (q) {
          const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          filter.$or = [{ 'attorney.name': re }, { 'attorney.recipientEmail': re }, { 'attorney.registrationNumber': re }, { summary: re }];
        }
        const total = await col('activity').countDocuments(filter);
        const docs = await col('activity').find(filter).sort({ at: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
        return {
          total,
          items: docs.map((d) => ({
            id: String(d._id),
            atUtc: iso(d.at),
            action: d.action,
            summary: d.summary,
            outcome: d.outcome,
            operator: d.operator?.name || '',
            operatorIdType: d.operator?.idType || 'self-declared',
            ip: d.ip,
            ipNote: d.ipNote,
            location: d.location,
            os: [d.os, d.osVersion].filter(Boolean).join(' '),
            browser: [d.browser, d.browserVersion].filter(Boolean).join(' '),
            deviceType: d.deviceType,
            attorney: d.attorney,
            historyId: d.historyId ? String(d.historyId) : null,
            details: d.details,
          })),
        };
      });
    },
  };

  return {
    kind: 'mongodb',
    features: { persistentWorkbook: true, manualMarking: true, corrections: true, activity: true, operatorRequired: true, blocksUncertain: true },
    historyLabel: `MongoDB collection "${COLLECTIONS.history}"`,
    client,
    db,
    init,
    instanceId,
    history,
    templates,
    mappings,
    workbooks,
    locks,
    activity,
    maintenance: { cleanupWorkbooks: (now) => guard(() => cleanupWorkbooks(now)) },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
