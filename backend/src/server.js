import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFromEnvFile } from './config.js';
import { createApp } from './app.js';
import { SmtpMailer } from './email.js';

const config = loadConfigFromEnvFile();
const where = config.isProduction ? 'the Render environment variables' : 'backend/.env';

if (config.fatal.length) {
  console.error(`[config] The server cannot start. Fix these in ${where}:`);
  for (const p of config.fatal) console.error(`  - ${p}`);
  process.exit(1);
}

// Persistent data folder. In production this must be the mounted Render disk:
// never create it, so a missing disk can't silently fall back to temporary storage.
const dataDir = config.dataDir;
try {
  if (config.isProduction) {
    if (!fs.statSync(dataDir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (err) {
  console.error(`[config] The data folder ${dataDir} is not available (${err.code || err.message}). In production, attach the Render persistent disk at this mount path.`);
  process.exit(1);
}

for (const w of config.warnings) console.warn(`[config] ${w}`);
console.log(`[config] ${config.isProduction ? 'Production' : 'Local'} mode. Data folder: ${dataDir}`);
console.log(`[config] Team login: ${config.auth.enabled ? 'required' : 'disabled (local use only)'}`);
if (config.isProduction) console.log(`[config] Allowed frontend origin: ${config.allowedOrigins.join(', ')}`);

let mailer = null;
if (config.smtpConfigured) {
  mailer = new SmtpMailer(config.smtp);
  console.log(`[config] Sending as ${config.smtp.from} via ${config.smtp.host}:${config.smtp.port} (${config.smtp.secure ? 'SSL' : 'STARTTLS'})`);
} else {
  console.warn(`[config] Email sending is not configured. Fix these in ${where}, then restart:`);
  for (const p of config.problems) console.warn(`  - ${p}`);
}

const app = createApp({ config, dataDir, mailer });

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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 25000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
