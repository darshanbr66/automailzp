import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isValidPasswordHash } from './auth.js';
import { parseTeamMembers } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_DATA_DIR = path.join(BACKEND_ROOT, 'data');

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const SIMPLE_EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Values copied unchanged from an example file are treated as "not set". */
function clean(value) {
  const v = String(value ?? '').trim();
  if (!v || /^(your[-_]|<|replace[-_]|change[-_]?me|paste[-_])/i.test(v)) return '';
  return v;
}

function parseBool(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'ssl'].includes(v)) return true;
  if (['false', '0', 'no', 'starttls'].includes(v)) return false;
  return fallback;
}

/**
 * Build the configuration object from environment variables.
 * Never throws: problems are reported in `problems` so the app can still start
 * and show a helpful message in the UI.
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const warnings = [];

  const fatal = []; // problems that must stop the server from starting
  const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';

  const port = Number.parseInt(env.PORT || '4000', 10);
  const frontendUrl = (clean(env.FRONTEND_URL) || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
  let frontendOrigin = '';
  try {
    const u = new URL(frontendUrl);
    frontendOrigin = u.origin;
    if (u.pathname !== '/' || u.search || u.hash) fatal.push('FRONTEND_URL must be an origin only, e.g. https://app.zodiacpatent.com (no path).');
    if (isProduction && u.protocol !== 'https:') fatal.push('FRONTEND_URL must use https:// in production.');
  } catch {
    fatal.push(isProduction ? 'FRONTEND_URL must be set to the exact frontend origin, e.g. https://app.zodiacpatent.com.' : 'FRONTEND_URL is not a valid URL.');
  }
  // Exact origins allowed to call the API with credentials (never a wildcard).
  const allowedOrigins = frontendOrigin ? [frontendOrigin] : [];
  if (!isProduction && frontendOrigin.includes('localhost')) allowedOrigins.push(frontendOrigin.replace('localhost', '127.0.0.1'));

  // Where templates, mapping, history and sessions are stored.
  // - DATA_DIR set (e.g. a Render persistent disk at /var/data): that folder must exist.
  // - DATA_DIR not set: backend/data inside the app. On this PC that folder is
  //   permanent; on a host without a disk (e.g. Render Free) it is TEMPORARY and
  //   is wiped on every restart, spin-down and redeploy.
  const explicitDataDir = clean(env.DATA_DIR);
  const dataDir = explicitDataDir || DEFAULT_DATA_DIR;
  if (explicitDataDir && isProduction && !path.posix.isAbsolute(dataDir) && !path.isAbsolute(dataDir)) fatal.push('DATA_DIR must be an absolute path (e.g. /var/data).');
  const persistentStorage = Boolean(explicitDataDir) || !isProduction;
  // Shared permanent database (MongoDB Atlas). Optional: without it the app keeps
  // using the files above. The connection string is never logged or sent to the browser.
  const mongodbUri = String(env.MONGODB_URI ?? '').trim();
  let mongodb = null;
  if (mongodbUri) {
    if (!/^mongodb(\+srv)?:\/\//.test(mongodbUri)) fatal.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
    else mongodb = { uri: mongodbUri, dbName: clean(env.MONGODB_DB) || 'zodiacpatent' };
  }
  // Names team members choose from in each browser session (self-declared).
  const teamMembers = parseTeamMembers(env.TEAM_MEMBERS);
  // Proxies in front of the backend, for the activity log's reported client IP
  // (production: Vercel + Render's load balancer).
  const hopsRaw = Number.parseInt(String(env.AUDIT_CLIENT_IP_HOPS ?? ''), 10);
  const clientIpHops = Number.isInteger(hopsRaw) && hopsRaw >= 0 && hopsRaw <= 5 ? hopsRaw : isProduction ? 2 : 0;

  const storageWarning =
    persistentStorage || mongodb
      ? null
      : 'Temporary storage: sending history, the email template, the column mapping and sign-in sessions are lost whenever the server restarts, sleeps or is redeployed. Duplicate warnings only cover emails sent since the last restart.';

  // Host names this server answers to (besides localhost). Render's own
  // *.onrender.com host name is added automatically.
  const allowedHosts = String(env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (clean(env.RENDER_EXTERNAL_HOSTNAME)) allowedHosts.push(clean(env.RENDER_EXTERNAL_HOSTNAME).toLowerCase());
  if (isProduction && !allowedHosts.length) fatal.push('ALLOWED_HOSTS must list the API host name, e.g. api.zodiacpatent.com.');

  const trustProxyRaw = String(env.TRUST_PROXY ?? (isProduction ? '1' : '')).trim().toLowerCase();
  const trustProxy = /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : false;

  // Shared team login.
  const username = String(env.APP_USERNAME ?? '').trim();
  const passwordHash = String(env.APP_PASSWORD_HASH ?? '').trim();
  const sessionSecret = String(env.SESSION_SECRET ?? '').trim();
  const authAny = Boolean(username || passwordHash || sessionSecret);
  const authErrors = [];
  if (!username) authErrors.push('APP_USERNAME is not set');
  if (!passwordHash) authErrors.push('APP_PASSWORD_HASH is not set (generate it with: npm run hash-password)');
  else if (!isValidPasswordHash(passwordHash)) authErrors.push('APP_PASSWORD_HASH is not a valid hash (generate it with: npm run hash-password)');
  if (!sessionSecret) authErrors.push('SESSION_SECRET is not set');
  else if (sessionSecret.length < 32) authErrors.push('SESSION_SECRET must be at least 32 characters');
  if ((isProduction || authAny) && authErrors.length) fatal.push(...authErrors.map((e) => `Login: ${e}.`));
  const hours = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const auth = {
    enabled: authAny && !authErrors.length,
    username,
    passwordHash,
    sessionSecret,
    idleMs: hours(env.SESSION_IDLE_HOURS, 2) * 3600 * 1000,
    maxAgeMs: hours(env.SESSION_MAX_AGE_HOURS, 12) * 3600 * 1000,
  };

  const host = clean(env.SMTP_HOST) || 'smtp.hostinger.com';
  const smtpPort = Number.parseInt(clean(env.SMTP_PORT) || '465', 10);
  const secure = parseBool(env.SMTP_SECURE, smtpPort === 465);
  const user = clean(env.SMTP_USER);
  // The password is never trimmed beyond surrounding whitespace and never logged.
  const pass = String(env.SMTP_PASS ?? '').trim();
  const from = clean(env.SMTP_FROM) || user;

  // Which service sends the emails: "smtp" (Hostinger SMTP, the default) or
  // "resend" (Resend HTTPS API, for hosts that block SMTP ports such as Render Free).
  const providerRaw = (clean(env.EMAIL_PROVIDER) || 'smtp').toLowerCase();
  const provider = ['smtp', 'resend'].includes(providerRaw) ? providerRaw : 'smtp';
  // The API key is never logged. Example values such as "re_your_api_key" count as not set.
  const resendApiKeyRaw = String(env.RESEND_API_KEY ?? '').trim();
  const resendApiKey = /^re_(your|x+$|\.\.\.|<)/i.test(resendApiKeyRaw) ? '' : resendApiKeyRaw;

  if (providerRaw !== provider) {
    problems.push('EMAIL_PROVIDER must be "smtp" or "resend"');
  } else if (provider === 'resend') {
    if (!resendApiKey) problems.push('RESEND_API_KEY is not set (create an API key in the Resend dashboard)');
    else if (!/^re_[A-Za-z0-9_-]{8,}$/.test(resendApiKey)) problems.push('RESEND_API_KEY does not look like a Resend API key (it starts with "re_")');
    if (!from) problems.push('SMTP_FROM is not set (the sender address, e.g. name@yourdomain.com, on a domain verified in Resend)');
    else if (!SIMPLE_EMAIL_RE.test(from)) problems.push('SMTP_FROM must be a plain email address');
  } else {
    if (!HOST_RE.test(host)) problems.push('SMTP_HOST is not a valid host name');
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) problems.push('SMTP_PORT is not a valid port number');
    if (smtpPort === 465 && !secure) problems.push('SMTP_SECURE must be true when SMTP_PORT is 465 (SSL)');
    if (smtpPort === 587 && secure) problems.push('SMTP_SECURE must be false when SMTP_PORT is 587 (STARTTLS)');
    if (!user) problems.push('SMTP_USER is not set');
    else if (!SIMPLE_EMAIL_RE.test(user)) problems.push('SMTP_USER must be the full mailbox address, e.g. name@yourdomain.com');
    if (!pass) problems.push('SMTP_PASS is empty (paste the Hostinger App Password after SMTP_PASS=)');
    if (from && !SIMPLE_EMAIL_RE.test(from)) problems.push('SMTP_FROM must be a plain email address');
    if (user && from && from.toLowerCase() !== user.toLowerCase()) {
      warnings.push('SMTP_FROM differs from SMTP_USER. Hostinger normally rejects a sender address that is not the signed-in mailbox.');
    }
  }

  return {
    isProduction,
    port: Number.isFinite(port) ? port : 4000,
    // Production listens on all interfaces (Render routes traffic to it); local use stays on loopback.
    host: clean(env.HOST) || (isProduction ? '0.0.0.0' : '127.0.0.1'),
    frontendUrl,
    allowedOrigins,
    allowedHosts,
    trustProxy,
    dataDir,
    explicitDataDir: Boolean(explicitDataDir),
    persistentStorage,
    storageWarning,
    mongodb,
    teamMembers,
    clientIpHops,
    auth,
    fatal,
    smtp: { host, port: smtpPort, secure, user, pass, from },
    email: { provider, from, resendApiKey },
    // Name kept for compatibility: true when the selected email provider is fully configured.
    smtpConfigured: problems.length === 0,
    problems,
    warnings,
  };
}

export const DEFAULT_ENV_FILE = path.join(BACKEND_ROOT, '.env');

/**
 * Load backend/.env (if present) and return the config.
 * Values in the .env file take precedence over variables already set in the
 * Windows environment, so switching mailboxes only ever needs a .env edit and
 * a restart. The sender address is never hard-coded in the source.
 *
 * In production (NODE_ENV=production set by the platform, e.g. Render) the .env
 * file is ignored entirely: only the platform's environment variables are used,
 * so a stray local file can never change the deployed configuration.
 */
export function loadConfigFromEnvFile(envPath = DEFAULT_ENV_FILE, baseEnv = process.env) {
  if (String(baseEnv.NODE_ENV || '').trim().toLowerCase() === 'production') return loadConfig({ ...baseEnv });
  let fileValues = {};
  try {
    fileValues = dotenv.parse(fs.readFileSync(envPath));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[config] Could not read ${path.basename(envPath)}: ${err.code || 'read error'}`);
  }
  return loadConfig({ ...baseEnv, ...fileValues });
}
