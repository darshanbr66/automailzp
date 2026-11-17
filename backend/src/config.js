import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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

  const port = Number.parseInt(env.PORT || '4000', 10);
  const frontendUrl = (clean(env.FRONTEND_URL) || 'http://localhost:5173').replace(/\/+$/, '');

  const host = clean(env.SMTP_HOST) || 'smtp.hostinger.com';
  const smtpPort = Number.parseInt(clean(env.SMTP_PORT) || '465', 10);
  const secure = parseBool(env.SMTP_SECURE, smtpPort === 465);
  const user = clean(env.SMTP_USER);
  // The password is never trimmed beyond surrounding whitespace and never logged.
  const pass = String(env.SMTP_PASS ?? '').trim();
  const from = clean(env.SMTP_FROM) || user;

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

  return {
    port: Number.isFinite(port) ? port : 4000,
    host: '127.0.0.1',
    frontendUrl,
    smtp: { host, port: smtpPort, secure, user, pass, from },
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
 */
export function loadConfigFromEnvFile(envPath = DEFAULT_ENV_FILE, baseEnv = process.env) {
  let fileValues = {};
  try {
    fileValues = dotenv.parse(fs.readFileSync(envPath));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[config] Could not read ${path.basename(envPath)}: ${err.code || 'read error'}`);
  }
  return loadConfig({ ...baseEnv, ...fileValues });
}
