// Shared helpers for the database scripts. The connection string is never
// printed: targets are shown as "<database>@<fingerprint>" and every message
// passes through redact().
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { DEFAULT_ENV_FILE, loadConfigFromEnvFile } from '../../src/config.js';
import { assertConfirmed, describeTarget, isProductionTarget, redact } from '../../src/dbops.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const opt = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  return { flag, opt, argv };
}

export const out = (s = '') => process.stdout.write(`${redact(s)}\n`);
export function fail(message, code = 1) {
  process.stderr.write(`${redact(message)}\n`);
  process.exit(code);
}

/**
 * Settings for a script: the env file (default backend/.env; --env-file to use
 * another one) and the MongoDB target it names. Values are read from that file
 * only (plus the process environment for anything it doesn't set).
 */
export function loadSettings(args) {
  const envFile = path.resolve(args.opt('env-file') || DEFAULT_ENV_FILE);
  if (args.opt('env-file') && !fs.existsSync(envFile)) fail(`The env file ${envFile} does not exist.`);
  const config = loadConfigFromEnvFile(envFile, { ...process.env, NODE_ENV: '' });
  let fileEnv = {};
  try {
    fileEnv = dotenv.parse(fs.readFileSync(envFile));
  } catch {
    /* no file: the process environment only */
  }
  const env = { ...process.env, ...fileEnv };
  if (config.fatal.some((f) => /MONGODB_URI/.test(f))) fail('MONGODB_URI in the env file is not a valid MongoDB connection string.');
  return { envFile, config, env };
}

/**
 * The database the app is configured to use, as a target (null when MONGODB_URI
 * is unset). The database name must be stated explicitly (MONGODB_DB), so a
 * script never works on a database chosen by a default value.
 */
export function appTarget(settings) {
  if (!settings.config.mongodb) return null;
  if (!String(settings.env.MONGODB_DB || '').trim()) {
    fail(`MONGODB_DB is not set in ${path.basename(settings.envFile)}. Set it explicitly to the database name, so the scripts never act on an assumed database.`);
  }
  return { uri: settings.config.mongodb.uri, ...describeTarget(settings.config.mongodb.uri, settings.config.mongodb.dbName) };
}

/** A target on the same cluster as the app's database, or on the cluster named by --target-uri-env. */
export function otherTarget(settings, args, dbName) {
  const varName = args.opt('target-uri-env');
  let uri = settings.config.mongodb?.uri;
  if (varName) {
    if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(varName)) fail('--target-uri-env takes the NAME of an environment variable (e.g. MONGODB_RESTORE_URI), never a connection string.');
    uri = String(settings.env[varName] || '').trim();
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) fail(`The environment variable ${varName} is not set to a MongoDB connection string (in ${path.basename(settings.envFile)} or the environment).`);
  }
  if (!uri) fail('No MongoDB connection is configured (MONGODB_URI is not set in the env file).');
  return { uri, ...describeTarget(uri, dbName) };
}

export function printTarget(label, t, settings) {
  const production = isProductionTarget(t, settings.env);
  out(`${label}: database "${t.dbName}" on ${t.hostHint}${t.local ? ' (this computer)' : ''}`);
  out(`  confirmation label: ${t.label}${production ? '   [PRODUCTION DATABASE]' : ''}`);
}

/**
 * Writing operations: refuse unless the exact target label is confirmed, and
 * for a production database also --production.
 */
export function requireWriteConfirmation(t, args, settings, action) {
  try {
    assertConfirmed(t, args.opt('confirm-target'), action);
  } catch (e) {
    fail(e.message, 3);
  }
  if (isProductionTarget(t, settings.env) && !args.flag('production')) {
    fail(`"${t.dbName}" is a production database. To ${action} on it, add --production as well (and make sure a fresh backup exists).`, 3);
  }
}

export async function connect(t, appName) {
  const client = new MongoClient(t.uri, { serverSelectionTimeoutMS: 15000, appName });
  try {
    await client.connect();
  } catch (e) {
    fail(`Could not connect to ${t.label} (${e?.name || 'error'}). Check the network and the database user's permissions.`);
  }
  return client;
}

export function errorText(err) {
  return redact(`${err?.name || 'Error'}: ${err?.message || err}`);
}
