import path from 'node:path';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { AppError, Mutex, isPlainObject, normalizeId, readJsonFile, writeJsonFile, formatDateTime } from './utils.js';
import { FileSessionStore, LoginLimiter, parseCookies, safeEqual, sessionCookie, verifyPassword } from './auth.js';
import {
  MAPPING_FIELDS, MAX_UPLOAD_BYTES, getRecordValues, listPlaceholders, parseWorkbook,
  resolveMapping, sanitizeMapping, validateExcelFile, validateMapping,
} from './excel.js';
import { DEFAULT_TEMPLATE, TemplateStore, renderEmail } from './template.js';
import { HistoryStore } from './history.js';
import { isValidEmail, validateMessage } from './email.js';
import { providerLabel } from './mailer.js';
import { countsAsSent, matchHistory, normalizeEmail, normalizeText, recordIdentity } from './identity.js';

const CSRF_HEADER = 'x-oea-request';
const CSRF_TOKEN_HEADER = 'x-csrf-token';
const AUTH_PUBLIC_PATHS = new Set(['/auth/session', '/auth/login', '/auth/logout']);
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
 */
export function createApp({ config, dataDir, mailer, loginLimiter = new LoginLimiter() }) {
  const app = express();
  const templates = new TemplateStore(dataDir);
  const history = new HistoryStore(dataDir);
  const settingsPath = path.join(dataDir, 'settings.json');

  // Attorney data lives only in memory; it is never written to disk. It is
  // shared by everyone signed in: uploading a workbook replaces it for the team.
  let workbook = null;
  // One send at a time across the whole team: the duplicate check, the SMTP send
  // and the history write happen as one serialized step (single service instance).
  const sendMutex = new Mutex();
  const settingsMutex = new Mutex();
  const sendingRecords = new Set(); // normalized record IDs currently being sent
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
  const historyFileLabel = config.isProduction && config.explicitDataDir ? path.posix.join(dataDir, 'sent-emails.xlsx') : 'backend/data/sent-emails.xlsx';

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  // ---- Health check (Render) -----------------------------------------------
  // Public and minimal: reports only whether the service and its data folder are usable.
  app.get('/healthz', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fs.access(dataDir, fs.constants.W_OK);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OEA-Request, X-CSRF-Token');
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
    try {
      const s = await readJsonFile(settingsPath);
      return isPlainObject(s?.mapping) ? sanitizeMapping(s.mapping) : null;
    } catch {
      return null;
    }
  }

  async function currentMapping() {
    const saved = await loadSavedMapping();
    return workbook ? resolveMapping(saved, workbook.headers) : saved || Object.fromEntries(MAPPING_FIELDS.map((f) => [f.key, '']));
  }

  function requireWorkbook() {
    if (!workbook) throw new AppError(400, 'NO_WORKBOOK', 'Please upload the attorney Excel workbook first.');
    return workbook;
  }

  async function requireValidMapping() {
    const wb = requireWorkbook();
    const mapping = await currentMapping();
    const errors = validateMapping(mapping, wb.headers);
    if (errors.length) throw new AppError(400, 'INVALID_MAPPING', errors.join(' '), { errors });
    return mapping;
  }

  function findRow(rowNumber) {
    const wb = requireWorkbook();
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
      records: null,
    };
    if (mappingErrors.length) return base;

    let sentCounts = null;
    let sentEmails = null;
    try {
      sentCounts = new Map();
      sentEmails = new Set();
      for (const e of await history.entriesInOrder()) {
        if (!countsAsSent(e.status)) continue;
        const id = normalizeId(e.recordId);
        sentCounts.set(id, (sentCounts.get(id) || 0) + 1);
        if (e.recipientEmail) sentEmails.add(normalizeEmail(e.recipientEmail));
      }
    } catch (err) {
      sentCounts = null;
      sentEmails = null;
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
      return { ...r, sentCount, possiblySent };
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
        workbook = { ...parsed, fileName, uploadedAt: new Date().toISOString(), derived: null };
        ok(res, await workbookPayload());
      } catch (e) {
        next(e);
      }
    });
  });

  app.get('/api/excel/records', async (req, res) => ok(res, await workbookPayload(parsePaging(req.query))));

  app.delete('/api/excel', (req, res) => {
    workbook = null;
    ok(res, { loaded: false });
  });

  // ---- Column mapping ----------------------------------------------------------
  app.get('/api/mapping', async (req, res) => {
    ok(res, { fields: MAPPING_FIELDS.map(({ hints, ...f }) => f), mapping: await currentMapping(), saved: await loadSavedMapping() });
  });

  app.put('/api/mapping', async (req, res) => {
    const mapping = sanitizeMapping(req.body?.mapping);
    if (workbook) {
      const errors = validateMapping(mapping, workbook.headers);
      if (errors.length) throw new AppError(400, 'INVALID_MAPPING', errors.join(' '), { errors });
    }
    await settingsMutex.run(async () => {
      const settings = (await readJsonFile(settingsPath).catch(() => null)) || {};
      await writeJsonFile(settingsPath, { ...(isPlainObject(settings) ? settings : {}), mapping });
    });
    ok(res, await workbookPayload());
  });

  // ---- Template ------------------------------------------------------------------
  app.get('/api/template', async (req, res) => {
    const { template, warning } = await templates.load();
    ok(res, { template, defaultTemplate: DEFAULT_TEMPLATE, placeholders: listPlaceholders(workbook?.headers), warning: warning || null });
  });

  app.put('/api/template', async (req, res) => {
    const template = await templates.save(req.body?.template);
    ok(res, { template });
  });

  // ---- Compose / preview -------------------------------------------------------
  async function buildEmailForRow(rowNumber) {
    const mapping = await requireValidMapping();
    const row = findRow(rowNumber);
    const values = getRecordValues(row, workbook.headers, mapping);
    const { template } = await templates.load();
    const rendered = renderEmail(template, values);
    const identity = recordIdentity(values);
    return {
      recordNumber: workbook.rows.indexOf(row) + 1,
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

  app.post('/api/preview', async (req, res) => ok(res, await buildEmailForRow(req.body?.rowNumber)));

  // ---- History -------------------------------------------------------------------
  app.post('/api/history/check', async (req, res) => {
    const mapping = await requireValidMapping();
    const row = findRow(req.body?.rowNumber);
    const values = getRecordValues(row, workbook.headers, mapping);
    const identity = recordIdentity(values);
    const { exact, possible } = matchHistory(await history.entriesInOrder(), identity, values);
    ok(res, {
      recordId: identity.recordId,
      idType: identity.idType,
      reliable: identity.reliable,
      attorneyName: values.get('attorneyName'),
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
    const { rowNumber, subject, body, confirmResend, requestId } = req.body || {};
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new AppError(400, 'INVALID_REQUEST', 'Invalid send request. Please reload the page.');

    // Idempotency: the same request ID never sends twice.
    for (const [id, entry] of sendRequests) if (Date.now() - entry.at > 60 * 60 * 1000) sendRequests.delete(id);
    const existing = sendRequests.get(requestId);
    if (existing?.status === 'pending') throw new AppError(409, 'SEND_IN_PROGRESS', 'This email is already being sent. Please wait.');
    if (existing?.status === 'done') return ok(res, { ...existing.response, repeatedRequest: true });

    const mapping = await requireValidMapping();
    const row = findRow(rowNumber);
    const values = getRecordValues(row, workbook.headers, mapping);
    const identity = recordIdentity(values);
    const { recordId } = identity;
    const to = values.get('recipientEmail');
    validateMessage({ to, subject, body });

    if (!mailer) throw new AppError(503, 'SMTP_NOT_CONFIGURED', `Email sending is not configured yet. Add the Hostinger SMTP settings and App Password to ${envWhere} and restart the app.`);

    // The sender is whatever mailbox the environment configured at start-up.
    const senderEmail = mailer.publicInfo().from;
    const lockKey = normalizeId(recordId);
    if (sendingRecords.has(lockKey)) throw new AppError(409, 'SEND_IN_PROGRESS', 'An email to this attorney is already being sent. Please wait.');
    sendingRecords.add(lockKey);
    sendRequests.set(requestId, { status: 'pending', at: Date.now() });
    let sendType = 'First Send';
    let attempted = false;
    // Wait for any other team member's send to finish, so duplicate checks always
    // see the latest history.
    await sendMutex.run(async () => {
    try {
      const { exact, possible } = matchHistory(await history.entriesInOrder(), identity, values);
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

      attempted = true;
      // The send request ID doubles as the provider's idempotency key (Resend), so a
      // retried request can never produce a second email there.
      const sent = await mailer.send({ to, subject, body, idempotencyKey: `zp-send-${requestId}` });
      if (lastSmtpTest && !lastSmtpTest.ok && lastSmtpTest.code === 'SMTP_AUTH_FAILED') lastSmtpTest = null;

      const entry = historyEntry({ identity, values, subject, senderEmail, status: 'Success', sendType });
      console.log(`[send] Email accepted by the SMTP server (${entry.sendType}, row ${row.rowNumber})`);
      const saved = await history.append(entry);
      const response = {
        accepted: true,
        message: `${providerLabel(mailer.publicInfo().provider)} accepted the email for delivery to ${to}.`,
        messageId: sent.messageId,
        entry,
        historySaved: saved.saved,
        historyWarning: saved.saved ? null : saved.warning,
      };
      sendRequests.set(requestId, { status: 'done', response, at: Date.now() });
      ok(res, response);
    } catch (err) {
      sendRequests.delete(requestId); // allow a retry after a failure
      if (err?.code === 'SMTP_AUTH_FAILED') lastSmtpTest = { ok: false, at: formatDateTime(), code: err.code, message: err.message };
      if (attempted) {
        // Record the failed attempt. It is never marked as a success and, unless
        // the outcome is uncertain, does not count as "already sent".
        const status = err?.code === 'SMTP_UNCERTAIN' ? 'Uncertain' : 'Failed';
        const saved = await history.append(historyEntry({ identity, values, subject, senderEmail, status, sendType }));
        if (!saved.saved) console.error('[history] Could not record the failed send attempt');
      }
      throw err;
    } finally {
      sendingRecords.delete(lockKey);
    }
    });
  });

  function historyEntry({ identity, values, subject, senderEmail, status, sendType }) {
    return {
      recordId: identity.recordId,
      registrationNumber: values.get('registrationNumber') || '',
      attorneyName: values.get('attorneyName'),
      recipientEmail: String(values.get('recipientEmail') || '').trim(),
      firmName: values.get('firmName') || '',
      city: values.get('city') || '',
      state: values.get('state') || '',
      subject: String(subject).trim(),
      sentAt: formatDateTime(),
      senderEmail,
      status,
      sendType,
    };
  }

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
