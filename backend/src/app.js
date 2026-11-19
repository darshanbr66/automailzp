import path from 'node:path';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { AppError, Mutex, isPlainObject, normalizeId, formatDateTime } from './utils.js';
import { FileSessionStore, LoginLimiter, parseCookies, safeEqual, sessionCookie, verifyPassword } from './auth.js';
import {
  MAPPING_FIELDS, MAX_UPLOAD_BYTES, getRecordValues, listPlaceholders, parseWorkbook,
  resolveMapping, sanitizeMapping, validateExcelFile, validateMapping,
} from './excel.js';
import { DEFAULT_TEMPLATE, renderEmail } from './template.js';
import { buildHistoryWorkbookBuffer } from './history.js';
import { createFileStorage } from './storage/file.js';
import { auditContext, requireOperator } from './audit.js';
import { isValidEmail, validateMessage } from './email.js';
import { providerLabel } from './mailer.js';
import { countsAsSent, matchHistory, normalizeEmail, normalizeText, recordIdentity } from './identity.js';

const CSRF_HEADER = 'x-oea-request';
const CSRF_TOKEN_HEADER = 'x-csrf-token';
const AUTH_PUBLIC_PATHS = new Set(['/health', '/auth/session', '/auth/login', '/auth/logout']);
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,100}$/;
export const PAGE_SIZE = 10;
const MAX_QUERY = 200;

/**
 * Build the Express application.
 * @param {object} deps
 * @param {object} deps.config       result of loadConfig()
 * @param {string} deps.dataDir      directory for template, mapping and history files
 * @param {import('./email.js').SmtpMailer|null} deps.mailer  null when SMTP is not configured
 * @param {object} [deps.loginLimiter]  replaced in tests
 * @param {object} [deps.storage]  file storage (default) or MongoDB storage (src/storage)
 */
export function createApp({ config, dataDir, mailer, loginLimiter = new LoginLimiter(), storage = createFileStorage(dataDir) }) {
  const app = express();
  const history = storage.history;
  const templates = storage.templates;
  const persistent = Boolean(storage.features.persistentWorkbook);
  const teamMembers = config.teamMembers || ['Team Member 1', 'Team Member 2'];
  const auditOpts = { teamMembers, clientIpHops: config.clientIpHops ?? 0 };
  /** Who/where/what for the activity log (collected here, from the request). */
  const ctxOf = (req) => auditContext(req, auditOpts);
  /** Operator for audited actions: required when the shared database is used. */
  const operatorFor = (req) => (storage.features.operatorRequired ? requireOperator(req, teamMembers) : ctxOf(req).operator);

  // The uploaded workbook, shared by everyone signed in: uploading a workbook
  // replaces it for the team. File storage keeps it in memory only; MongoDB
  // storage persists it and this is a cache that follows the shared version.
  let workbook = null;
  // One send at a time across the whole team: the duplicate check, the SMTP send
  // and the history write happen as one serialized step (single service instance).
  const sendMutex = new Mutex();
  const sendRequests = new Map(); // requestId -> { status, response, at }
  let lastSmtpTest = null; // { ok, at, message, code }
  let smtpTestRunning = null;

  const allowedOrigins = new Set(config.allowedOrigins);
  const authEnabled = Boolean(config.auth?.enabled);
  const cookie = sessionCookie(config.isProduction);
  const sessions = authEnabled
    ? new FileSessionStore(path.join(dataDir, 'sessions'), { secret: config.auth.sessionSecret, idleMs: config.auth.idleMs, maxAgeMs: config.auth.maxAgeMs })
    : null;
  if (sessions) {
    const sweep = setInterval(() => sessions.sweep().catch(() => {}), 30 * 60 * 1000);
    sweep.unref();
  }
  const envWhere = config.isProduction ? 'the Render environment variables' : 'backend/.env (see README)';
  const historyFileLabel =
    storage.kind === 'file' ? (config.isProduction && config.explicitDataDir ? path.posix.join(dataDir, 'sent-emails.xlsx') : 'backend/data/sent-emails.xlsx') : storage.historyLabel;

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  // ---- Health check (Render) -----------------------------------------------
  // Public and minimal: reports only whether the service and its data folder are usable.
  const dataDirWritable = () => fs.access(dataDir, fs.constants.W_OK).then(() => true, () => false);
  app.get('/healthz', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (await dataDirWritable()) res.json({ ok: true });
    else res.status(503).json({ ok: false });
  });

  // ---- Host check and security headers ---------------------------------------
  app.use((req, res, next) => {
    // Only answer to known host names (DNS-rebinding protection).
    const host = String(req.headers.host || '').toLowerCase();
    const port = req.socket.localPort;
    const okHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...config.allowedHosts]);
    try {
      const fe = new URL(config.frontendUrl).host;
      if (!config.isProduction) okHosts.add(fe).add(fe.replace('localhost', '127.0.0.1'));
    } catch {
      /* validated at start-up */
    }
    if (!okHosts.has(host) && !okHosts.has(host.replace(/:\d+$/, ''))) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN_HOST', message: 'Forbidden' } });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- CORS: exactly one allowed frontend origin, with credentials ----------------
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = origin && allowedOrigins.has(origin);
    res.setHeader('Vary', 'Origin');
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OEA-Request, X-CSRF-Token, X-Operator');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // State-changing requests must come from our own frontend: a custom header
    // (which forces a CORS preflight) and, when sent, an allowed Origin. In
    // production the Origin header is required.
    const origin = req.headers.origin;
    if (req.headers[CSRF_HEADER] !== '1' || (origin && !allowedOrigins.has(origin)) || (config.isProduction && !origin)) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Request blocked for security reasons. Please use the application page.' } });
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // ---- Shared team login --------------------------------------------------------
  async function currentSession(req) {
    if (!sessions) return null;
    const id = parseCookies(req.headers.cookie)[cookie.name];
    if (!id) return null;
    const session = await sessions.get(id);
    return session ? { id, session } : null;
  }

  // Readiness check for the sign-in page, reachable through the frontend's /api
  // proxy (Vercel only forwards /api/*). Same check and same minimal answer as
  // /healthz; it never touches sessions or credentials.
  app.get('/api/health', async (req, res) => {
    if (await dataDirWritable()) res.json({ ok: true, data: { ready: true } });
    else res.status(503).json({ ok: false, error: { code: 'NOT_READY', message: 'The server is starting.' } });
  });

  app.get('/api/auth/session', async (req, res) => {
    if (!authEnabled) return res.json({ ok: true, data: { authRequired: false, authenticated: true } });
    const found = await currentSession(req);
    if (!found) return res.json({ ok: true, data: { authRequired: true, authenticated: false } });
    res.json({ ok: true, data: { authRequired: true, authenticated: true, username: found.session.username, csrfToken: found.session.csrfToken } });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!authEnabled) throw new AppError(400, 'AUTH_DISABLED', 'Login is not enabled on this server.');
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const wait = loginLimiter.retryAfter(ip);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-in attempts. Please wait ${Math.ceil(wait / 60)} minute(s) and try again.`);
    }
    const { username, password } = req.body || {};
    const u = typeof username === 'string' ? username.trim().slice(0, 200) : '';
    const pw = typeof password === 'string' ? password.slice(0, 1024) : '';
    // Always run the (slow) password check so timing doesn't reveal a correct username.
    const passwordOk = await verifyPassword(pw, config.auth.passwordHash);
    const userOk = safeEqual(u.toLowerCase(), config.auth.username.toLowerCase());
    if (!passwordOk || !userOk) {
      loginLimiter.fail(ip);
      console.warn('[auth] Failed sign-in attempt');
      throw new AppError(401, 'INVALID_LOGIN', 'Incorrect username or password.');
    }
    loginLimiter.succeed(ip);
    const previous = await currentSession(req);
    if (previous) await sessions.destroy(previous.id); // new session ID on every login
    const { id, session } = await sessions.create(config.auth.username);
    res.cookie(cookie.name, id, { ...cookie.options, maxAge: sessions.remainingMs(session) });
    console.log('[auth] Signed in');
    res.json({ ok: true, data: { authRequired: true, authenticated: true, username: session.username, csrfToken: session.csrfToken } });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (sessions) {
      const found = await currentSession(req);
      if (found) await sessions.destroy(found.id);
      res.clearCookie(cookie.name, cookie.options);
    }
    res.json({ ok: true, data: { authenticated: false } });
  });

  // Every other API endpoint requires a valid session and, for changes, the
  // session's CSRF token.
  app.use('/api', async (req, res, next) => {
    if (!authEnabled || AUTH_PUBLIC_PATHS.has(req.path)) return next();
    const found = await currentSession(req);
    if (!found) return res.status(401).json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Your session has ended. Please sign in again.' } });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !safeEqual(String(req.headers[CSRF_TOKEN_HEADER] || ''), found.session.csrfToken)) {
      return res.status(403).json({ ok: false, error: { code: 'CSRF_FAILED', message: 'Your session could not be verified. Please reload the page.' } });
    }
    req.teamSession = found.session;
    next();
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

  async function loadSavedMapping() {
    return storage.mappings.load();
  }

  /**
   * MongoDB storage: make sure this process uses the workbook the team currently
   * shares (another team member, or another server process, may have replaced it).
   */
  async function syncWorkbook() {
    if (!persistent) return;
    const version = await storage.workbooks.currentVersion();
    if (version === (workbook?.version ?? null)) return;
    workbook = version ? await storage.workbooks.loadCurrent() : null;
  }

  /** The workbook version this request must still match (from the shared store when persistent). */
  async function liveWorkbookVersion() {
    return persistent ? storage.workbooks.currentVersion() : workbook?.version ?? null;
  }

  async function currentMapping() {
    const saved = await loadSavedMapping();
    return workbook ? resolveMapping(saved, workbook.headers) : saved || Object.fromEntries(MAPPING_FIELDS.map((f) => [f.key, '']));
  }

  function requireWorkbook() {
    if (!workbook) throw new AppError(400, 'NO_WORKBOOK', 'Please upload the attorney Excel workbook first.');
    return workbook;
  }

  /** Fingerprint of a column mapping: changes whenever the mapping changes. */
  function mappingVersionOf(mapping) {
    return crypto.createHash('sha256').update(JSON.stringify(mapping)).digest('hex').slice(0, 16);
  }

  /**
   * One consistent view of the shared workbook and mapping for this request.
   * The workbook object is captured once, so a concurrent upload by another team
   * member can't mix rows from one workbook with the mapping of another.
   */
  async function snapshot() {
    await syncWorkbook();
    const wb = requireWorkbook();
    const mapping = resolveMapping(await loadSavedMapping(), wb.headers);
    const errors = validateMapping(mapping, wb.headers);
    if (errors.length) throw new AppError(400, 'INVALID_MAPPING', errors.join(' '), { errors });
    return { wb, mapping, mappingVersion: mappingVersionOf(mapping) };
  }

  const STALE_MESSAGE =
    'Another team member uploaded a different workbook or changed the column mapping after you selected this attorney. ' +
    'No email was sent. Please reload the page and select the attorney again.';
  const stale = (reason) => new AppError(409, 'STALE_SELECTION', STALE_MESSAGE, { reason });

  /** Is the client's selection still for this workbook and mapping? (versions only) */
  function assertVersions(expected, wb, mappingVersion) {
    if (expected?.workbookVersion !== wb.version) throw stale('workbook');
    if (expected?.mappingVersion !== mappingVersion) throw stale('mapping');
  }

  /**
   * Verify that what the user selected (and previewed) is still exactly this
   * attorney and recipient in the current workbook and mapping.
   */
  function assertSelection(expected, wb, mappingVersion, values) {
    if (!isPlainObject(expected) || ['workbookVersion', 'mappingVersion', 'recordId', 'recipientEmail'].some((k) => typeof expected[k] !== 'string')) {
      throw stale('missing');
    }
    assertVersions(expected, wb, mappingVersion);
    if (normalizeId(recordIdentity(values).recordId) !== normalizeId(expected.recordId)) throw stale('record');
    if (normalizeEmail(values.get('recipientEmail')) !== normalizeEmail(expected.recipientEmail)) throw stale('recipient');
  }

  function findRow(rowNumber, wb = requireWorkbook()) {
    const n = Number(rowNumber);
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'INVALID_ROW', 'Please select an attorney.');
    const row = wb.rows.find((r) => r.rowNumber === n);
    if (!row) throw new AppError(404, 'ROW_NOT_FOUND', 'That attorney row was not found. Please upload the workbook again.');
    return row;
  }

  // The registration number is optional: a missing one is never a problem.
  function recordProblems(values) {
    const problems = [];
    if (!values.get('attorneyName')) problems.push('Missing attorney name');
    const email = values.get('recipientEmail');
    if (!email) problems.push('Missing email address');
    else if (!isValidEmail(email)) problems.push('Invalid email address');
    return problems;
  }

  /**
   * Derived per-row data (mapped values and record identifier) for the current
   * workbook and mapping. Cached until the workbook or mapping changes.
   */
  function derivedRecords(mapping) {
    const key = JSON.stringify(mapping);
    if (workbook.derived?.key === key) return workbook.derived.records;
    const records = workbook.rows.map((row, i) => {
      const values = getRecordValues(row, workbook.headers, mapping);
      const identity = recordIdentity(values);
      const rec = {
        recordNumber: i + 1, // 1..N as shown to the user (rowNumber is the Excel row, used internally)
        rowNumber: row.rowNumber,
        attorneyName: values.get('attorneyName'),
        registrationNumber: values.get('registrationNumber'),
        recipientEmail: values.get('recipientEmail'),
        firmName: values.get('firmName'),
        city: values.get('city'),
        state: values.get('state'),
        recordId: identity.recordId,
        idType: identity.idType,
        problems: recordProblems(values),
      };
      rec.search = normalizeText([rec.attorneyName, rec.registrationNumber, rec.recipientEmail, rec.firmName, rec.city, rec.state].join(' | '));
      return rec;
    });
    workbook.derived = { key, records };
    return records;
  }

  function parsePaging(input = {}) {
    const q = typeof input.q === 'string' ? input.q.slice(0, MAX_QUERY) : '';
    const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
    return { q, page };
  }

  /**
   * Workbook summary plus ONE page of records (at most PAGE_SIZE). Search runs
   * over the whole workbook on the server, so the browser never has to hold or
   * render every row.
   */
  async function workbookPayload({ q = '', page = 1 } = {}) {
    await syncWorkbook();
    if (!workbook) return { loaded: false, fields: MAPPING_FIELDS.map(({ hints, ...f }) => f), mapping: await currentMapping(), placeholders: listPlaceholders() };
    const mapping = await currentMapping();
    const mappingErrors = validateMapping(mapping, workbook.headers);
    const base = {
      loaded: true,
      fileName: workbook.fileName,
      sheetName: workbook.sheetName,
      uploadedAt: workbook.uploadedAt,
      headers: workbook.headers,
      fields: MAPPING_FIELDS.map(({ hints, ...f }) => f),
      mapping,
      mappingErrors,
      historyError: null,
      placeholders: listPlaceholders(workbook.headers),
      totalRecords: workbook.rows.length,
      workbookVersion: workbook.version,
      mappingVersion: mappingVersionOf(mapping),
      records: null,
    };
    if (mappingErrors.length) return base;

    let sentCounts = null;
    let sentEmails = null;
    let sentInfo = null;
    try {
      sentCounts = new Map();
      sentEmails = new Set();
      sentInfo = new Map();
      for (const e of await history.entriesInOrder()) {
        if (!countsAsSent(e.status) || e.voided) continue;
        const id = normalizeId(e.recordId);
        sentCounts.set(id, (sentCounts.get(id) || 0) + 1);
        if (e.recipientEmail) sentEmails.add(normalizeEmail(e.recipientEmail));
        const info = sentInfo.get(id) || { uncertain: 0, manual: 0 };
        if (e.status === 'Uncertain') info.uncertain += 1;
        if (e.sendMethod === 'Manual') info.manual += 1;
        info.lastMethod = e.sendMethod || '';
        info.lastAtUtc = e.sentAtUtc || null;
        info.lastAt = e.sentAt || '';
        info.lastOperator = e.operator || '';
        sentInfo.set(id, info);
      }
    } catch (err) {
      sentCounts = null;
      sentEmails = null;
      sentInfo = null;
      base.historyError = err instanceof AppError ? err.message : 'Could not read the sending history.';
    }

    const all = derivedRecords(mapping);
    const needle = normalizeText(q);
    const matches = needle ? all.filter((r) => r.search.includes(needle)) : all;
    const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const current = Math.min(page, pageCount);
    const rows = matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map(({ search, ...r }) => {
      const sentCount = sentCounts ? sentCounts.get(normalizeId(r.recordId)) || 0 : null;
      const possiblySent = Boolean(sentEmails && !sentCount && r.idType === 'fallback' && r.recipientEmail && sentEmails.has(normalizeEmail(r.recipientEmail)));
      return { ...r, sentCount, possiblySent, sentInfo: sentInfo?.get(normalizeId(r.recordId)) || null };
    });
    base.records = { query: q, page: current, pageSize: PAGE_SIZE, pageCount, matched: matches.length, rows };
    return base;
  }

  // ---- Status --------------------------------------------------------------
  function smtpStatus() {
    // Never includes the password.
    return {
      configured: Boolean(mailer),
      ...(mailer
        ? mailer.publicInfo()
        : { provider: config.email?.provider || 'smtp', host: config.email?.provider === 'resend' ? 'api.resend.com' : config.smtp.host, port: config.email?.provider === 'resend' ? 443 : config.smtp.port, secure: config.email?.provider === 'resend' ? true : config.smtp.secure, user: config.email?.provider === 'resend' ? null : config.smtp.user, from: config.smtp.from }),
      problems: config.problems,
      warnings: config.warnings,
      hosted: Boolean(config.isProduction),
      storageWarning: config.storageWarning || null,
      lastTest: lastSmtpTest,
    };
  }

  // App capabilities for the frontend (no secrets: never the connection string).
  app.get('/api/app/config', (req, res) => {
    ok(res, {
      storage: storage.kind,
      features: storage.features,
      teamMembers,
      operatorIdentification: 'self-declared',
      // Which shared database is in use (its name only; never the connection string).
      database: storage.kind === 'mongodb' ? storage.db?.databaseName ?? null : null,
      historyLabel: historyFileLabel,
    });
  });

  app.get('/api/status', (req, res) => {
    ok(res, { app: 'outlook-email-automation', smtpConfigured: Boolean(mailer), configProblems: config.problems, workbookLoaded: Boolean(workbook) });
  });

  // ---- SMTP (Hostinger) ----------------------------------------------------
  app.get('/api/smtp/status', (req, res) => ok(res, smtpStatus()));

  app.post('/api/smtp/test', async (req, res) => {
    if (!mailer) throw new AppError(503, 'SMTP_NOT_CONFIGURED', `Email sending is not configured: ${config.problems.join('; ')}. Update ${envWhere} and restart the app.`, { problems: config.problems });
    // Concurrent clicks share one connection attempt.
    if (!smtpTestRunning) {
      smtpTestRunning = mailer
        .verify()
        .then((result) => {
          lastSmtpTest = { ok: true, at: formatDateTime(), message: result?.message || `Connected and logged in to ${config.smtp.host} as ${config.smtp.user}.` };
          console.log('[email] Connection test succeeded');
        })
        .catch((err) => {
          const e = err instanceof AppError ? err : new AppError(502, 'SMTP_ERROR', 'The connection test failed.');
          lastSmtpTest = { ok: false, at: formatDateTime(), code: e.code, message: e.message };
        })
        .finally(() => {
          smtpTestRunning = null;
        });
    }
    await smtpTestRunning;
    ok(res, smtpStatus());
  });

  // ---- Excel workbook --------------------------------------------------------
  app.post('/api/excel/upload', (req, res, next) => {
    upload.single('file')(req, res, async (err) => {
      try {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') throw new AppError(400, 'FILE_TOO_LARGE', 'The file is larger than 10 MB.');
          throw new AppError(400, 'UPLOAD_FAILED', 'The file could not be uploaded.');
        }
        if (!req.file) throw new AppError(400, 'NO_FILE', 'Please choose an Excel file to upload.');
        const fileName = path.basename(req.file.originalname || 'workbook.xlsx').slice(0, 200);
        validateExcelFile(fileName, req.file.buffer);
        const parsed = parseWorkbook(req.file.buffer);
        const operator = operatorFor(req);
        // A new version for every upload (even of the same file): selections made
        // against an earlier upload are then recognised as stale.
        const wb = { ...parsed, fileName, uploadedAt: new Date().toISOString(), derived: null, version: crypto.randomUUID(), uploadedBy: operator };
        await storage.workbooks.save(wb, { operator }); // MongoDB: stored and shared before anyone uses it
        workbook = wb;
        await storage.activity.record({
          action: 'workbook_uploaded',
          summary: `Uploaded workbook "${fileName}" (${wb.rows.length} attorneys), replacing the previous one for the team`,
          ctx: ctxOf(req),
          details: { fileName, sheetName: wb.sheetName, rows: wb.rows.length, workbookVersion: wb.version },
        });
        ok(res, await workbookPayload());
      } catch (e) {
        next(e);
      }
    });
  });

  app.get('/api/excel/records', async (req, res) => ok(res, await workbookPayload(parsePaging(req.query))));

  app.delete('/api/excel', async (req, res) => {
    operatorFor(req);
    await storage.workbooks.clear();
    workbook = null;
    await storage.activity.record({ action: 'workbook_removed', summary: 'Removed the shared workbook', ctx: ctxOf(req) });
    ok(res, { loaded: false });
  });

  // ---- Column mapping ----------------------------------------------------------
  app.get('/api/mapping', async (req, res) => {
    await syncWorkbook();
    ok(res, { fields: MAPPING_FIELDS.map(({ hints, ...f }) => f), mapping: await currentMapping(), saved: await loadSavedMapping() });
  });

  app.put('/api/mapping', async (req, res) => {
    const mapping = sanitizeMapping(req.body?.mapping);
    const operator = operatorFor(req);
    await syncWorkbook();
    if (workbook) {
      const errors = validateMapping(mapping, workbook.headers);
      if (errors.length) throw new AppError(400, 'INVALID_MAPPING', errors.join(' '), { errors });
    }
    const before = await loadSavedMapping();
    await storage.mappings.save(mapping, { operator });
    await storage.activity.record({ action: 'mapping_updated', summary: 'Updated the column mapping', ctx: ctxOf(req), details: { before, after: mapping } });
    ok(res, await workbookPayload());
  });

  // ---- Template ------------------------------------------------------------------
  app.get('/api/template', async (req, res) => {
    await syncWorkbook();
    const { template, warning } = await templates.load();
    ok(res, { template, defaultTemplate: DEFAULT_TEMPLATE, placeholders: listPlaceholders(workbook?.headers), warning: warning || null });
  });

  app.put('/api/template', async (req, res) => {
    const operator = operatorFor(req);
    const template = await templates.save(req.body?.template, { operator });
    await storage.activity.record({ action: 'template_updated', summary: 'Updated the email template', ctx: ctxOf(req), details: { subject: template.subject } });
    ok(res, { template });
  });

  // ---- Compose / preview -------------------------------------------------------
  async function buildEmailForRow(rowNumber, expected) {
    const { wb, mapping, mappingVersion } = await snapshot();
    // The attorney list the user clicked on must still be the current one.
    if (expected?.workbookVersion !== undefined || expected?.mappingVersion !== undefined) assertVersions(expected, wb, mappingVersion);
    const row = findRow(rowNumber, wb);
    const values = getRecordValues(row, wb.headers, mapping);
    const { template } = await templates.load();
    const rendered = renderEmail(template, values);
    const identity = recordIdentity(values);
    return {
      workbookVersion: wb.version,
      mappingVersion,
      recordNumber: wb.rows.indexOf(row) + 1,
      rowNumber: row.rowNumber,
      attorneyName: values.get('attorneyName'),
      registrationNumber: values.get('registrationNumber'),
      recipientEmail: values.get('recipientEmail'),
      firmName: values.get('firmName'),
      city: values.get('city'),
      state: values.get('state'),
      recordId: identity.recordId,
      idType: identity.idType,
      problems: recordProblems(values),
      ...rendered,
    };
  }

  app.post('/api/preview', async (req, res) => ok(res, await buildEmailForRow(req.body?.rowNumber, req.body)));

  // ---- History -------------------------------------------------------------------
  app.post('/api/history/check', async (req, res) => {
    const { wb, mapping, mappingVersion } = await snapshot();
    const row = findRow(req.body?.rowNumber, wb);
    const values = getRecordValues(row, wb.headers, mapping);
    if (req.body?.expected !== undefined) assertSelection(req.body.expected, wb, mappingVersion, values);
    const identity = recordIdentity(values);
    const { exact, possible } = matchHistory(await history.entriesInOrder(), identity, values);
    const uncertain = storage.features.blocksUncertain ? unresolvedUncertain([...exact, ...possible]) : [];
    ok(res, {
      recordId: identity.recordId,
      idType: identity.idType,
      reliable: identity.reliable,
      attorneyName: values.get('attorneyName'),
      // An unresolved "Uncertain" send blocks sending until it is reconciled.
      uncertainUnresolved: uncertain.length > 0,
      uncertain: [...uncertain].reverse(),
      alreadySent: exact.length > 0,
      possibleDuplicate: exact.length === 0 && possible.length > 0,
      previous: exact.reverse(),
      possible: possible.reverse(),
    });
  });

  app.get('/api/history', async (req, res) => {
    ok(res, { entries: await history.readAll(), file: historyFileLabel, sender: config.smtp.from || null });
  });

  // ---- Send -----------------------------------------------------------------------
  app.post('/api/send', async (req, res) => {
    const { rowNumber, subject, body, confirmResend, requestId, expected } = req.body || {};
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new AppError(400, 'INVALID_REQUEST', 'Invalid send request. Please reload the page.');

    // Idempotency: the same request ID never sends twice.
    for (const [id, entry] of sendRequests) if (Date.now() - entry.at > 60 * 60 * 1000) sendRequests.delete(id);
    const existing = sendRequests.get(requestId);
    if (existing?.status === 'pending') throw new AppError(409, 'SEND_IN_PROGRESS', 'This email is already being sent. Please wait.');
    if (existing?.status === 'done') return ok(res, { ...existing.response, repeatedRequest: true });

    const { wb, mapping, mappingVersion } = await snapshot();
    const row = findRow(rowNumber, wb);
    const values = getRecordValues(row, wb.headers, mapping);
    // The recipient comes from the server's copy of the workbook. Make sure it is
    // still exactly the attorney and address the user selected and previewed.
    assertSelection(expected, wb, mappingVersion, values);
    const identity = recordIdentity(values);
    const { recordId } = identity;
    const to = values.get('recipientEmail');
    validateMessage({ to, subject, body });

    if (!mailer) throw new AppError(503, 'SMTP_NOT_CONFIGURED', `Email sending is not configured yet. Add the Hostinger SMTP settings and App Password to ${envWhere} and restart the app.`);
    const operator = operatorFor(req);
    const ctx = ctxOf(req);

    // The sender is whatever mailbox the environment configured at start-up.
    const senderEmail = mailer.publicInfo().from;
    const sendMethod = mailer.publicInfo().provider === 'resend' ? 'Resend' : 'SMTP';
    const draft = (status, sendType) => historyEntry({ identity, values, subject, senderEmail, status, sendType, sendMethod, operator, requestId, workbookId: wb.version });
    // Claim this attorney (and, with MongoDB, this address) for this send. With
    // MongoDB the claim is durable and shared by every server process. It is
    // removed only once the outcome is in the history; if the server stops or the
    // database fails, recovery records the outcome later (see storage/mongo.js).
    const claim = await storage.locks.acquire({ recordKey: recordId, emailKey: to, requestId, kind: 'send', entry: draft('Uncertain', '') });
    sendRequests.set(requestId, { status: 'pending', at: Date.now() });
    // Wait for any other team member's send to finish, so duplicate checks always
    // see the latest history.
    await sendMutex.run(async () => {
    let sendType = 'First Send';
    let handedToProvider = false;
    let sent;
    try {
      // Re-check after waiting for other team members' sends: the workbook or
      // mapping may have been replaced in the meantime.
      if (workbook !== wb || (persistent && (await liveWorkbookVersion()) !== wb.version)) throw stale('workbook');
      if (mappingVersionOf(resolveMapping(await loadSavedMapping(), wb.headers)) !== mappingVersion) throw stale('mapping');
      const { exact, possible } = matchHistory(await history.entriesInOrder(), identity, values);
      // An "Uncertain" send is never repeated, not even with "Send again": its
      // outcome must first be reconciled (Sent History -> Correct).
      const uncertain = storage.features.blocksUncertain ? unresolvedUncertain([...exact, ...possible]) : [];
      if (uncertain.length) throw uncertainError(uncertain, recordId, identity.idType);
      if (exact.length && confirmResend !== true) {
        throw new AppError(409, 'ALREADY_SENT', 'This attorney has already received an email.', { previous: exact.reverse(), recordId, idType: identity.idType });
      }
      if (!exact.length && possible.length && confirmResend !== true) {
        throw new AppError(
          409,
          'POSSIBLE_DUPLICATE',
          'This attorney has no registration number, and an earlier email in the history may have gone to the same person.',
          { possible: possible.reverse(), recordId, idType: identity.idType },
        );
      }
      sendType = exact.length ? 'Resend' : 'First Send';

      // Durably record "sending" BEFORE the provider is called. If this can't be
      // written, nothing is sent (the error below says so).
      await claim.begin({ sendType });
      handedToProvider = true;
      // The send request ID doubles as the provider's idempotency key (Resend), so a
      // retried request can never produce a second email there.
      sent = await mailer.send({ to, subject, body, idempotencyKey: `zp-send-${requestId}` });
    } catch (err) {
      sendRequests.delete(requestId); // allow a retry after a failure
      if (err?.code === 'SMTP_AUTH_FAILED') lastSmtpTest = { ok: false, at: formatDateTime(), code: err.code, message: err.message };
      if (!handedToProvider) {
        await claim.release(); // the provider was never called: nothing to record
        throw err;
      }
      // The provider refused the email, or its answer is unknown. Only a definite
      // refusal is "Failed"; anything else is "Uncertain" (never marked as sent).
      const status = err instanceof AppError && err.code !== 'SMTP_UNCERTAIN' ? 'Failed' : 'Uncertain';
      await claim.finish(status === 'Failed' ? 'failed' : 'uncertain');
      const failed = { ...draft(status, sendType), claimId: claim.id, providerConfirmed: status === 'Failed' };
      const saved = await history.append(failed);
      // Keep the claim when the outcome could not be recorded: it keeps blocking
      // this attorney until recovery writes the outcome.
      if (saved.saved || !claim.durable) await claim.release();
      else console.error('[history] Could not record the failed send attempt; the send claim is kept until it is recorded');
      await storage.activity.record({
        action: status === 'Uncertain' ? 'email_uncertain' : 'email_failed',
        summary: `${status === 'Uncertain' ? 'Send outcome uncertain' : 'Send failed'} via ${sendMethod}`,
        outcome: status.toLowerCase(),
        ctx,
        attorney: failed,
        historyId: saved.id,
        details: { sendMethod, sendType, errorCode: err?.code || null },
      });
      throw err;
    }

    // The provider confirmed acceptance.
    if (lastSmtpTest && !lastSmtpTest.ok && lastSmtpTest.code === 'SMTP_AUTH_FAILED') lastSmtpTest = null;
    await claim.finish('accepted', { messageId: sent.messageId || null });
    const { providerConfirmed, ...entry } = { ...draft('Success', sendType), messageId: sent.messageId || null, claimId: claim.id, providerConfirmed: true };
    console.log(`[send] Email accepted by the ${sendMethod} service (${entry.sendType}, row ${row.rowNumber})`);
    let saved = await history.append({ ...entry, providerConfirmed });
    // MongoDB: read the record back, so "saved" means it is really in email_history.
    if (saved.saved && history.get) {
      const stored = saved.id ? await history.get(saved.id).catch(() => null) : null;
      const verified = Boolean(stored && stored.status === 'Success' && stored.claimId === entry.claimId && stored.recipientEmail === entry.recipientEmail);
      if (verified) {
        console.log(`[send] Recorded in ${storage.historyLabel} (record ${saved.id})`);
      } else {
        console.error('[send] The history record could not be read back after the send; the send claim is kept until recovery records it');
        saved = { saved: false, keptPending: true, warning: 'The email was accepted, but its record could not be confirmed in the shared database yet. This attorney stays blocked for everyone, and the record is added automatically.' };
      }
    }
    // Only release once the Success is in the history. Otherwise the claim (now
    // "accepted", with the provider's message id) keeps blocking every user and
    // process until recovery records it.
    if (saved.saved || !claim.durable) await claim.release();
    const activityId = await storage.activity.record({
      action: 'email_sent',
      summary: `Sent an email via ${sendMethod} (${sendType})`,
      ctx,
      attorney: entry,
      historyId: saved.id,
      details: { sendMethod, sendType, messageId: sent.messageId || null, subject: entry.subject },
    });
    if (saved.id && activityId) await storage.activity.link?.(activityId, saved.id);
    const response = {
      accepted: true,
      message: `${providerLabel(mailer.publicInfo().provider)} accepted the email for delivery to ${to}.`,
      messageId: sent.messageId,
      entry: { ...entry, id: saved.id || null },
      historySaved: saved.saved,
      historyId: saved.id || null,
      historyStore: storage.kind,
      historyWarning: saved.saved ? null : saved.warning,
    };
    sendRequests.set(requestId, { status: 'done', response, at: Date.now() });
    ok(res, response);
    });
  });

  /** Unresolved "Uncertain" sends among history matches (they are never resent automatically). */
  const unresolvedUncertain = (list) => list.filter((e) => e.status === 'Uncertain' && !e.voided);
  const uncertainError = (list, recordId, idType) =>
    new AppError(
      409,
      'UNCERTAIN_UNRESOLVED',
      'An earlier email to this attorney (or this address) has an unknown outcome ("Uncertain"), so it is not sent again, not even with "Send again". ' +
        'Check the email provider (the Resend dashboard, or the Sent folder in Hostinger Webmail), then record the result in Sent History ("Correct…": it was sent / it was not sent). After that you can send if needed.',
      { uncertain: [...list].reverse(), recordId, idType },
    );

  function historyEntry({ identity, values, subject, senderEmail, status, sendType, sendMethod = '', operator = null, requestId = null, workbookId = null, note = '' }) {
    const now = new Date();
    return {
      recordId: identity.recordId,
      registrationNumber: values.get('registrationNumber') || '',
      attorneyName: values.get('attorneyName'),
      recipientEmail: String(values.get('recipientEmail') || '').trim(),
      firmName: values.get('firmName') || '',
      city: values.get('city') || '',
      state: values.get('state') || '',
      subject: String(subject).trim(),
      sentAt: formatDateTime(now),
      sentAtUtc: now.toISOString(),
      senderEmail,
      status,
      sendType,
      sendMethod,
      operator: operator || '',
      requestId,
      workbookId,
      note,
    };
  }

  // ---- Shared views: Sent Emails, statistics, team activity -----------------------
  const isSent = (e) => e.status === 'Success' && !e.voided;
  const methodOf = (e) => e.sendMethod || 'Unknown';
  function safeTimeZone(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  }
  /** Calendar day of an entry in the viewer's time zone ("YYYY-MM-DD"). */
  function dayOf(e, tz) {
    if (e.sentAtUtc) return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.sentAtUtc));
    return String(e.sentAt || '').slice(0, 10); // legacy row without a UTC timestamp
  }

  app.get('/api/sent', async (req, res) => {
    const tz = safeTimeZone(String(req.query.tz || 'UTC'));
    const q = normalizeText(String(req.query.q || '').slice(0, MAX_QUERY));
    const method = String(req.query.method || '');
    const operator = String(req.query.operator || '');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const pageSize = Math.min(50, Math.max(5, Number.parseInt(req.query.pageSize, 10) || 20));
    const all = (await history.readAll()).filter(isSent);
    const items = all.filter((e) => {
      if (method && methodOf(e) !== method) return false;
      if (operator && (e.operator || '') !== operator) return false;
      const day = dayOf(e, tz);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (q && !normalizeText([e.attorneyName, e.recipientEmail, e.registrationNumber].join(' ')).includes(q)) return false;
      return true;
    });
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pageCount);
    ok(res, {
      total: items.length,
      page,
      pageSize,
      pageCount,
      items: items.slice((page - 1) * pageSize, page * pageSize),
      methods: [...new Set(all.map(methodOf))].sort(),
      operators: [...new Set(all.map((e) => e.operator).filter(Boolean))].sort(),
    });
  });

  app.get('/api/stats', async (req, res) => {
    const tz = safeTimeZone(String(req.query.tz || 'UTC'));
    const entries = await history.entriesInOrder();
    const sent = entries.filter(isSent);
    const byOperator = new Map();
    const bump = (name, key) => {
      const k = name || '(not recorded)';
      const o = byOperator.get(k) || { operator: k, sent: 0, manual: 0, failed: 0, uncertain: 0 };
      o[key] += 1;
      byOperator.set(k, o);
    };
    for (const e of entries) {
      if (e.voided) continue;
      if (e.status === 'Success') bump(e.operator, e.sendMethod === 'Manual' ? 'manual' : 'sent');
      else if (e.status === 'Failed') bump(e.operator, 'failed');
      else if (e.status === 'Uncertain') bump(e.operator, 'uncertain');
    }
    const daily = new Map();
    for (const e of sent) {
      const d = dayOf(e, tz);
      if (d) daily.set(d, (daily.get(d) || 0) + 1);
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    ok(res, {
      timeZone: tz,
      totalSent: sent.length,
      manual: sent.filter((e) => e.sendMethod === 'Manual').length,
      resend: sent.filter((e) => e.sendMethod === 'Resend').length,
      smtp: sent.filter((e) => e.sendMethod === 'SMTP').length,
      unknownMethod: sent.filter((e) => !e.sendMethod).length,
      failed: entries.filter((e) => e.status === 'Failed' && !e.voided).length,
      uncertain: entries.filter((e) => e.status === 'Uncertain' && !e.voided).length,
      voided: entries.filter((e) => e.voided).length,
      today: daily.get(today) || 0,
      daily: [...daily.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30).map(([date, count]) => ({ date, count })),
      byOperator: [...byOperator.values()].sort((a, b) => b.sent + b.manual - (a.sent + a.manual)),
      inProgress: storage.locks.list ? await storage.locks.list() : [],
    });
  });

  app.get('/api/activity', async (req, res) => {
    if (!storage.features.activity) return ok(res, { available: false, items: [], total: 0, page: 1, pageCount: 1 });
    const pageSize = 20;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const r = await storage.activity.list({ page, pageSize, q: String(req.query.q || '').slice(0, MAX_QUERY), action: String(req.query.action || ''), operator: String(req.query.operator || '') });
    ok(res, { available: true, ...r, page, pageCount: Math.max(1, Math.ceil(r.total / pageSize)) });
  });

  // ---- All Attorneys: manual "Mark as sent" (MongoDB) --------------------------------
  app.post('/api/attorneys/mark-sent', async (req, res) => {
    if (!storage.features.manualMarking) throw new AppError(400, 'NOT_AVAILABLE', 'Marking attorneys as sent requires the shared database (MongoDB).');
    const { rowNumber, expected, note, confirmPossible } = req.body || {};
    const operator = requireOperator(req, teamMembers);
    const ctx = ctxOf(req);
    const noteText = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    const { wb, mapping, mappingVersion } = await snapshot();
    const row = findRow(rowNumber, wb);
    const values = getRecordValues(row, wb.headers, mapping);
    assertSelection(expected, wb, mappingVersion, values);
    const identity = recordIdentity(values);
    const requestId = `manual-${crypto.randomUUID()}`;
    const entry = historyEntry({ identity, values, subject: '(contacted outside the app)', senderEmail: '', status: 'Success', sendType: 'First Send', sendMethod: 'Manual', operator, requestId, workbookId: wb.version, note: noteText });
    const claim = await storage.locks.acquire({ recordKey: identity.recordId, emailKey: values.get('recipientEmail'), requestId, kind: 'manual' });
    await sendMutex.run(async () => {
      try {
        if ((await liveWorkbookVersion()) !== wb.version) throw stale('workbook');
        if (mappingVersionOf(resolveMapping(await loadSavedMapping(), wb.headers)) !== mappingVersion) throw stale('mapping');
        const { exact, possible } = matchHistory(await history.entriesInOrder(), identity, values);
        if (exact.length) {
          throw new AppError(409, 'ALREADY_SENT', 'This attorney is already recorded as sent. It was not marked again.', { previous: exact.reverse() });
        }
        if (possible.length && confirmPossible !== true) {
          throw new AppError(409, 'POSSIBLE_DUPLICATE', 'An email to this address is already in the history under a different record.', { possible: possible.reverse() });
        }
        // No local fallback here: a mark that could not be saved must not reappear later.
        const saved = await history.append(entry, { fallback: false });
        if (!saved.saved) throw new AppError(503, 'DB_UNAVAILABLE', 'The shared database could not be updated. The attorney was not marked as sent; please try again.');
        const activityId = await storage.activity.record({ action: 'manual_mark_sent', summary: 'Marked as sent manually (contacted outside the app)', ctx, attorney: entry, historyId: saved.id, details: { note: noteText } });
        if (saved.id && activityId) await storage.activity.link?.(activityId, saved.id);
        ok(res, { entry: { ...entry, id: saved.id } });
      } finally {
        await claim.release();
      }
    });
  });

  // ---- Audited corrections (never deletes history) -------------------------------------
  app.post('/api/history/:id/correct', async (req, res) => {
    if (!storage.features.corrections) throw new AppError(400, 'NOT_AVAILABLE', 'Corrections require the shared database (MongoDB).');
    const operator = requireOperator(req, teamMembers);
    const action = String(req.body?.action || '');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a short reason for the correction (it is kept in the activity log).');
    const result = await sendMutex.run(() => history.correct(req.params.id, { action, reason, operator }));
    const labels = {
      void: 'Voided a history record',
      'confirm-sent': 'Confirmed an uncertain send as sent',
      'confirm-not-sent': 'Confirmed an uncertain send as not sent',
      undo: result.before.voided ? 'Undid a void (the record counts again)' : 'Undid a confirmation (the send is Uncertain again)',
    };
    await storage.activity.record({
      action: 'history_corrected',
      summary: labels[action] || 'Corrected a history record',
      ctx: ctxOf(req),
      attorney: result.before,
      historyId: req.params.id,
      details: { correction: action, reason, before: { status: result.before.status, voided: result.before.voided }, after: { status: result.after.status, voided: result.after.voided } },
    });
    ok(res, { entry: result.after });
  });

  // ---- Excel export of the sending history (both storage modes) ------------------------
  app.get('/api/history/export', async (req, res) => {
    const buffer = buildHistoryWorkbookBuffer(await history.entriesInOrder());
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sent-history-${stamp}.xlsx"`);
    res.send(buffer);
  });

  // ---- Errors ---------------------------------------------------------------------
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'The request was invalid.' } });
    }
    console.error(`[error] ${req.method} ${req.path}: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server. Please try again.' } });
  });

  return app;
}
