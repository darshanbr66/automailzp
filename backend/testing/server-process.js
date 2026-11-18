#!/usr/bin/env node
// Test fixture: ONE app server process on a shared (in-memory) MongoDB, used by
// test/claims.test.js to run two genuinely separate server processes.
// Never reads backend/.env and never sends email: the mail transport is fake and
// writes one line per accepted email to SENT_LOG.
//
// Environment (all required unless marked optional):
//   ZP_TEST_MONGO_URI   mongodb:// URI of the test server (mongodb-memory-server)
//   ZP_TEST_DB          database name (a throw-away test_* database)
//   ZP_TEST_DATA_DIR    temporary data folder
//   ZP_TEST_SENT_LOG    file that receives one line per email "sent"
//   ZP_TEST_SEND_DELAY_MS   (optional) delay inside the fake provider call
//   ZP_TEST_CRASH_ON_SEND   (optional) "1": exit abruptly inside the provider call,
//                           right after the provider accepted the email
//   ZP_TEST_CLAIM_STALE_MS / ZP_TEST_HEARTBEAT_MS / ZP_TEST_SWEEP_MS (optional)
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SmtpMailer } from '../src/email.js';
import { createMongoStorage } from '../src/storage/mongo.js';

const env = process.env;
for (const k of ['ZP_TEST_MONGO_URI', 'ZP_TEST_DB', 'ZP_TEST_DATA_DIR', 'ZP_TEST_SENT_LOG']) {
  if (!env[k]) {
    console.error(`missing ${k}`);
    process.exit(2);
  }
}
// Refuse anything but a local test server and a test database.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?/.test(env.ZP_TEST_MONGO_URI) || !/^test_/.test(env.ZP_TEST_DB)) {
  console.error('refusing: this fixture only runs against a local test database');
  process.exit(2);
}

const config = loadConfig({
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'sender@example.com',
  SMTP_PASS: 'fake-app-password-for-tests',
  SMTP_FROM: 'sender@example.com',
  MONGODB_URI: env.ZP_TEST_MONGO_URI,
  MONGODB_DB: env.ZP_TEST_DB,
});

const delayMs = Number(env.ZP_TEST_SEND_DELAY_MS || 0);
const createTransport = () => ({
  verify: async () => true,
  close: () => {},
  sendMail: async (message) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    fs.appendFileSync(env.ZP_TEST_SENT_LOG, `${process.pid} ${message.to}\n`);
    if (env.ZP_TEST_CRASH_ON_SEND === '1') process.exit(137); // "power cut" after the provider accepted it
    return { accepted: [message.to], rejected: [], messageId: `<proc-${process.pid}-${Date.now()}@example.com>`, response: '250 OK' };
  },
});

const storage = createMongoStorage({
  uri: config.mongodb.uri,
  dbName: config.mongodb.dbName,
  dataDir: env.ZP_TEST_DATA_DIR,
  claimStaleMs: Number(env.ZP_TEST_CLAIM_STALE_MS || 120000),
  heartbeatMs: Number(env.ZP_TEST_HEARTBEAT_MS || 20000),
});
await storage.init();
// Recovery as in server.js, just faster.
const sweep = () => storage.locks.sweep().catch(() => {});
setInterval(sweep, Number(env.ZP_TEST_SWEEP_MS || 1000)).unref();
sweep();

const app = createApp({ config, dataDir: env.ZP_TEST_DATA_DIR, mailer: new SmtpMailer(config.smtp, { createTransport }), storage });
const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
process.on('SIGTERM', () => server.close(() => storage.close().finally(() => process.exit(0))));
