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

/** A send claim older than this is assumed to belong to a server that stopped mid-send. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
const INSERT_BATCH = 1000;

/** Create all indexes (idempotent: safe on every start-up). */
export async function ensureIndexes(db) {
  const c = (n) => db.collection(COLLECTIONS[n]);
  await Promise.all([
    c('attorneys').createIndex({ workbookId: 1, rowNumber: 1 }, { unique: true, name: 'workbook_row_unique' }),
    c('workbooks').createIndex({ uploadedAt: -1 }, { name: 'uploadedAt' }),
    c('history').createIndex({ recordKey: 1, sentAtUtc: -1 }, { name: 'record_date' }),
    c('history').createIndex({ emailKey: 1 }, { name: 'email' }),
    c('history').createIndex({ nameKey: 1 }, { name: 'name' }),
    c('history').createIndex({ sentAtUtc: -1 }, { name: 'date' }),
    c('history').createIndex({ status: 1, sendMethod: 1, sentAtUtc: -1 }, { name: 'status_method_date' }),
    c('history').createIndex({ 'operator.name': 1, sentAtUtc: -1 }, { name: 'operator_date' }),
    // A send request can be recorded as successful at most once (also across processes).
    c('history').createIndex({ requestId: 1 }, { unique: true, name: 'success_request_unique', partialFilterExpression: { status: 'Success', requestId: { $type: 'string' } } }),
    // Re-running the migration never imports the same legacy row twice.
    c('history').createIndex({ legacyKey: 1 }, { unique: true, name: 'legacy_unique', partialFilterExpression: { legacyKey: { $type: 'string' } } }),
    // Cross-process send claims: one in-flight send per attorney AND per address.
    c('pending').createIndex({ recordKey: 1 }, { unique: true, name: 'record_unique' }),
    c('pending').createIndex({ emailKey: 1 }, { unique: true, name: 'email_unique' }),
    c('pending').createIndex({ startedAt: 1 }, { name: 'startedAt' }),
    c('activity').createIndex({ at: -1 }, { name: 'date' }),
    c('activity').createIndex({ action: 1, at: -1 }, { name: 'action_date' }),
    c('activity').createIndex({ 'operator.name': 1, at: -1 }, { name: 'operator_date' }),
    c('activity').createIndex({ historyId: 1 }, { name: 'history' }),
    c('activity').createIndex({ 'attorney.recordKey': 1, at: -1 }, { name: 'attorney_date' }),
  ]);
}

const isDuplicateKey = (e) => e?.code === 11000;
const isMongoError = (e) => /^Mongo/.test(String(e?.name || ''));
export const dbUnavailable = () =>
  new AppError(503, 'DB_UNAVAILABLE', 'The shared database (MongoDB) is not reachable right now. Nothing was changed. Please try again in a minute.');

const iso = (d) => (d instanceof Date && !Number.isNaN(d.valueOf()) ? d.toISOString() : null);

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
    note: doc.note ?? '',
    source: doc.source ?? 'app',
    voided: Boolean(doc.void),
    void: doc.void ? { reason: doc.void.reason, operator: doc.void.operator?.name ?? '', atUtc: iso(doc.void.at) } : null,
    resolution: doc.resolution
      ? { previousStatus: doc.resolution.previousStatus, resolvedAs: doc.resolution.resolvedAs, reason: doc.resolution.reason, operator: doc.resolution.operator?.name ?? '', atUtc: iso(doc.resolution.at) }
      : null,
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
    operator: entry.operator ? { name: entry.operator, idType: 'self-declared' } : null,
    source: entry.source || 'app',
  };
  for (const k of ['requestId', 'messageId', 'activityId', 'workbookId', 'note', 'legacyKey', 'legacy']) if (entry[k] != null && entry[k] !== '') doc[k] = entry[k];
  return doc;
}

/**
 * @param {{ uri?: string, dbName: string, dataDir: string, client?: MongoClient }} options
 */
export function createMongoStorage({ uri, dbName, dataDir, client: injected }) {
  const client = injected || new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'zodiacpatent-email-automation', maxPoolSize: 10 });
  const db = client.db(dbName);
  const col = (n) => db.collection(COLLECTIONS[n]);
  const fallbackPath = path.join(dataDir, 'mongo-history-fallback.json');
  const fallbackMutex = new Mutex();
  let ready = null;

  /** Connect and create indexes once; retried after a failure. */
  function init() {
    if (!ready) {
      ready = (async () => {
        await client.connect();
        await ensureIndexes(db);
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
  // (only used when an email was already sent but MongoDB failed afterwards)
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
          await col('history').insertOne(toHistoryDoc(entry));
        } catch (e) {
          if (!isDuplicateKey(e)) left.push(entry);
        }
      }
      await writeJsonFile(fallbackPath, left);
    });
  }

  async function recordActivity(evt) {
    try {
      await init();
      const doc = {
        at: new Date(),
        action: evt.action,
        summary: evt.summary || '',
        outcome: evt.outcome || 'ok',
        operator: { name: evt.ctx?.operator || null, idType: 'self-declared' },
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
        historyId: evt.historyId ? new ObjectId(String(evt.historyId)) : null,
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
        const pending = (await readFallback()).map((e) => ({ ...e, pendingSave: true }));
        return [...docs.map(toEntry), ...pending];
      });
    },
    async readAll() {
      return (await history.entriesInOrder()).reverse();
    },
    /** Never throws for write failures: the caller may already have sent the email. */
    async append(entry) {
      try {
        await init();
        const r = await col('history').insertOne(toHistoryDoc(entry));
        return { saved: true, id: String(r.insertedId) };
      } catch (e) {
        if (isDuplicateKey(e)) return { saved: true, duplicate: true }; // already recorded (same request)
        await fallbackMutex.run(async () => writeJsonFile(fallbackPath, [...(await readFallback()), entry])).catch(() => {});
        console.error(`[db] Could not write history to MongoDB (${e?.name || 'error'}); kept locally until it can be written`);
        return {
          saved: false,
          keptPending: true,
          warning: 'The email was accepted, but the shared database could not be updated right now. The record was kept on the server and will be added to the shared history automatically.',
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
     * counting; resolving an Uncertain record changes its status and keeps the old one.
     */
    async correct(id, { action, reason, operator, activityId }) {
      return guard(async () => {
        if (!ObjectId.isValid(String(id))) throw new AppError(404, 'NOT_FOUND', 'That history record was not found.');
        const _id = new ObjectId(String(id));
        const before = await col('history').findOne({ _id });
        if (!before) throw new AppError(404, 'NOT_FOUND', 'That history record was not found.');
        if (before.void) throw new AppError(409, 'ALREADY_VOIDED', 'This record has already been voided.');
        const who = { name: operator, idType: 'self-declared' };
        const at = new Date();
        let update;
        if (action === 'void') {
          update = { $set: { void: { at, operator: who, reason, activityId } } };
        } else if (action === 'confirm-sent' || action === 'confirm-not-sent') {
          if (before.status !== 'Uncertain') throw new AppError(409, 'NOT_UNCERTAIN', 'Only "Uncertain" records can be confirmed as sent or not sent.');
          const resolvedAs = action === 'confirm-sent' ? 'Sent' : 'Not sent';
          update = {
            $set: { status: action === 'confirm-sent' ? 'Success' : 'Failed', resolution: { previousStatus: 'Uncertain', resolvedAs, reason, at, operator: who, activityId } },
          };
        } else {
          throw new AppError(400, 'INVALID_ACTION', 'Unknown correction.');
        }
        // Conditional update: two people correcting the same record at once can't both win.
        const r = await col('history').findOneAndUpdate({ _id, void: { $exists: false }, status: before.status }, update, { returnDocument: 'after' });
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

  const workbooks = {
    /** The current shared workbook version (null when none). */
    async currentVersion() {
      return guard(async () => (await col('workbooks').findOne({ _id: 'current' }, { projection: { workbookId: 1 } }))?.workbookId ?? null);
    },
    async loadCurrent() {
      return guard(async () => {
        const id = (await col('workbooks').findOne({ _id: 'current' }))?.workbookId;
        if (!id) return null;
        const meta = await col('workbooks').findOne({ _id: id });
        if (!meta) return null;
        const rows = await col('attorneys').find({ workbookId: id }, { projection: { _id: 0, rowNumber: 1, cells: 1 } }).sort({ rowNumber: 1 }).toArray();
        return {
          sheetName: meta.sheetName,
          headers: meta.headers,
          rows,
          fileName: meta.fileName,
          uploadedAt: iso(meta.uploadedAt),
          uploadedBy: meta.uploadedBy || null,
          version: id,
          derived: null,
        };
      });
    },
    /** Store a new workbook and make it the current one for everyone. */
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
        for (let i = 0; i < wb.rows.length; i += INSERT_BATCH) {
          const batch = wb.rows.slice(i, i + INSERT_BATCH).map((r) => ({ workbookId: id, rowNumber: r.rowNumber, cells: r.cells }));
          await col('attorneys').insertMany(batch, { ordered: false });
        }
        await col('workbooks').updateOne({ _id: id }, { $set: { status: 'ready' } });
        // Switch the pointer atomically; then remove the previous workbook's rows.
        const prev = await col('workbooks').findOneAndUpdate({ _id: 'current' }, { $set: { workbookId: id, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before' });
        if (prev?.workbookId && prev.workbookId !== id) await retire(prev.workbookId);
      });
    },
    async clear() {
      return guard(async () => {
        const prev = await col('workbooks').findOneAndUpdate({ _id: 'current' }, { $set: { workbookId: null, updatedAt: new Date() } }, { upsert: true, returnDocument: 'before' });
        if (prev?.workbookId) await retire(prev.workbookId);
      });
    },
  };
  async function retire(id) {
    await col('workbooks').updateOne({ _id: id }, { $set: { status: 'superseded', supersededAt: new Date() } });
    await col('attorneys').deleteMany({ workbookId: id });
  }

  const locks = {
    /**
     * Claim the right to send to this attorney and address, across ALL server
     * processes (unique indexes). The claim stores the draft history entry so a
     * crash mid-send can later be recorded as "Uncertain".
     */
    async acquire({ recordKey, emailKey, requestId, kind = 'send', entry = null }) {
      return guard(async () => {
        const doc = {
          _id: `${kind}:${requestId || crypto.randomUUID()}`,
          kind,
          recordKey: normalizeId(recordKey),
          emailKey: normalizeEmail(emailKey) || `none:${crypto.randomUUID()}`,
          requestId: requestId || null,
          startedAt: new Date(),
          entry,
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await col('pending').insertOne(doc);
            return { release: () => col('pending').deleteOne({ _id: doc._id }).catch(() => {}) };
          } catch (e) {
            if (!isDuplicateKey(e)) throw e;
            if (attempt === 0 && (await locks.sweep())) continue; // a stale claim was cleared: try once more
            throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney or address is already being sent or recorded by a team member. Please wait a moment and refresh.');
          }
        }
        throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney is already being sent. Please wait.');
      });
    },
    /** Turn claims left by a server that stopped mid-send into "Uncertain" history. */
    async sweep(now = Date.now()) {
      return guard(async () => {
        const stale = await col('pending').find({ startedAt: { $lt: new Date(now - LOCK_STALE_MS) } }).toArray();
        let n = 0;
        for (const p of stale) {
          if (p.kind === 'send' && p.entry) {
            const already = p.requestId ? await col('history').findOne({ requestId: p.requestId }) : null;
            if (!already) {
              const entry = { ...p.entry, status: 'Uncertain', sentAtUtc: p.startedAt, note: 'The server stopped while this email was being sent. It may or may not have been delivered.' };
              const r = await col('history').insertOne(toHistoryDoc(entry)).catch(() => null);
              await recordActivity({ action: 'send_uncertain_recovered', summary: 'An interrupted send was recorded as Uncertain', outcome: 'uncertain', attorney: p.entry, historyId: r?.insertedId, ctx: { operator: p.entry.operator || null } });
            }
          }
          const d = await col('pending').deleteOne({ _id: p._id, startedAt: p.startedAt });
          n += d.deletedCount;
        }
        return n;
      });
    },
    async list() {
      return guard(async () => (await col('pending').find({}).sort({ startedAt: 1 }).toArray()).map((p) => ({ kind: p.kind, startedAtUtc: iso(p.startedAt), attorneyName: p.entry?.attorneyName || '', recipientEmail: p.entry?.recipientEmail || '' })));
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
    features: { persistentWorkbook: true, manualMarking: true, corrections: true, activity: true, operatorRequired: true },
    historyLabel: `MongoDB collection "${COLLECTIONS.history}"`,
    client,
    db,
    init,
    history,
    templates,
    mappings,
    workbooks,
    locks,
    activity,
    async close() {
      await client.close().catch(() => {});
    },
  };
}
