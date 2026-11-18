import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFromEnvFile } from './config.js';
import { createApp } from './app.js';
import { createMailer } from './mailer.js';
import { createStorage } from './storage/index.js';

const config = loadConfigFromEnvFile();
const where = config.isProduction ? 'the Render environment variables' : 'backend/.env';

if (config.fatal.length) {
  console.error(`[config] The server cannot start. Fix these in ${where}:`);
  for (const p of config.fatal) console.error(`  - ${p}`);
  process.exit(1);
}

// Data folder. When DATA_DIR is set explicitly in production (a mounted disk) it
// must already exist: it is never created, so a missing disk can't silently fall
// back to temporary storage. Without DATA_DIR the app folder is used (temporary
// on hosts without a disk, such as Render Free).
const dataDir = config.dataDir;
try {
  if (config.isProduction && config.explicitDataDir) {
    if (!fs.statSync(dataDir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (err) {
  console.error(
    `[config] The data folder ${dataDir} is not available (${err.code || err.message}). ` +
      (config.explicitDataDir
        ? 'Attach a persistent disk at this path, or remove the DATA_DIR environment variable to use temporary storage (e.g. on Render Free).'
        : 'Check that the app folder is writable.'),
  );
  process.exit(1);
}

for (const w of config.warnings) console.warn(`[config] ${w}`);
if (config.storageWarning) console.warn(`[config] WARNING: DATA_DIR is not set, so ${dataDir} is used. ${config.storageWarning}`);
console.log(`[config] ${config.isProduction ? 'Production' : 'Local'} mode. Data folder: ${dataDir} (${config.persistentStorage ? 'persistent' : 'TEMPORARY'})`);
console.log(`[config] Team login: ${config.auth.enabled ? 'required' : 'disabled (local use only)'}`);
if (config.isProduction) console.log(`[config] Allowed frontend origin: ${config.allowedOrigins.join(', ')}`);

const mailer = createMailer(config);
if (mailer && config.email.provider === 'resend') {
  console.log(`[config] Sending as ${config.email.from} via the Resend API (HTTPS)`);
} else if (mailer) {
  console.log(`[config] Sending as ${config.smtp.from} via ${config.smtp.host}:${config.smtp.port} (${config.smtp.secure ? 'SSL' : 'STARTTLS'})`);
} else {
  console.warn(`[config] Email sending is not configured. Fix these in ${where}, then restart:`);
  for (const p of config.problems) console.warn(`  - ${p}`);
}

// Shared database (MongoDB Atlas) when MONGODB_URI is set; otherwise the files above.
const storage = createStorage(config, dataDir);
if (storage.kind === 'mongodb') {
  console.log(`[db] Using MongoDB database "${config.mongodb.dbName}" for shared, permanent data (team members: ${config.teamMembers.join(', ')})`);
  if (config.isProduction) {
    // Production: connect BEFORE accepting requests. If the database can't be
    // reached (wrong password, Atlas Network Access not allowing Render, cluster
    // paused), stop with a clear message: Render then marks the deploy as failed
    // and keeps the previous version running, instead of serving a broken app.
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await storage.init();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`[db] Could not connect to MongoDB (attempt ${attempt} of 4: ${err?.name || 'error'}${err?.codeName ? ` ${err.codeName}` : ''})`);
        if (attempt < 4) await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (lastError) {
      const auth = /auth/i.test(`${lastError?.codeName || ''} ${lastError?.message || ''}`);
      console.error(
        `[db] The server cannot start without the database. ${auth ? 'The database user or password in MONGODB_URI was rejected.' : 'Check MONGODB_URI, and that Atlas Network Access allows connections from Render (0.0.0.0/0 on the free plan).'}`,
      );
      process.exit(1);
    }
    console.log('[db] Connected; indexes are in place');
  } else {
    // Locally the app still starts if Atlas is briefly unreachable (actions that
    // need the database then say so and retry).
    storage.init().then(
      () => console.log('[db] Connected; indexes are in place'),
      (err) => console.error(`[db] Could not connect to MongoDB yet (${err?.name || 'error'}). Sending and recording are refused until it is reachable.`),
    );
  }
  // Recovery of send claims, including those left by a previous run of this
  // server or by another process: finished sends whose history write failed are
  // recorded, and sends interrupted by a stopped server become "Uncertain" (never
  // resent automatically). Runs shortly after start-up, then every minute.
  const sweep = () => storage.locks.sweep().then((n) => n && console.warn(`[db] Recovered ${n} unfinished send claim(s); see Team Activity`)).catch(() => {});
  setTimeout(sweep, 5000).unref();
  setInterval(sweep, 60 * 1000).unref();
} else {
  console.log('[storage] Using local files (MONGODB_URI is not set)');
}

const app = createApp({ config, dataDir, mailer, storage });

const server = app.listen(config.port, config.host, () => {
  console.log(`Backend listening on ${config.host}:${config.port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Is the app already running? Run stop.bat first.`);
  else console.error(`Server error: ${err.message}`);
  process.exit(1);
});

// Render sends SIGTERM before stopping the instance: finish in-flight requests
// (including an email being sent and its history write) before exiting.
const shutdown = () => {
  server.close(() => storage.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 25000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
