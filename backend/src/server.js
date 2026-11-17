import fs from 'node:fs';
import { DEFAULT_DATA_DIR, loadConfigFromEnvFile } from './config.js';
import { createApp } from './app.js';
import { SmtpMailer } from './email.js';

const config = loadConfigFromEnvFile();
fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });

for (const w of config.warnings) console.warn(`[config] ${w}`);

let mailer = null;
if (config.smtpConfigured) {
  mailer = new SmtpMailer(config.smtp);
  console.log(`[config] Sending as ${config.smtp.from} via ${config.smtp.host}:${config.smtp.port} (${config.smtp.secure ? 'SSL' : 'STARTTLS'})`);
} else {
  console.warn('[config] Email sending is not configured. Fix these in backend/.env, then restart:');
  for (const p of config.problems) console.warn(`  - ${p}`);
}

const app = createApp({ config, dataDir: DEFAULT_DATA_DIR, mailer });

const server = app.listen(config.port, config.host, () => {
  console.log(`Backend running at http://localhost:${config.port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Is the app already running? Run stop.bat first.`);
  else console.error(`Server error: ${err.message}`);
  process.exit(1);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
