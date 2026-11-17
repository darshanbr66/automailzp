#!/usr/bin/env node
// Back up the legacy data files and (if MONGODB_URI is set) every MongoDB
// collection used by the app, to backend/data/backups/<timestamp>/ (or --out).
//
//   npm run db:backup
//   npm run db:backup -- --out D:\backups\zodiac --history-json history.json
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { loadConfigFromEnvFile } from '../src/config.js';
import { backup } from '../src/migrate.js';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfigFromEnvFile();
const dataDir = path.resolve(opt('data-dir') || config.dataDir);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(opt('out') || path.join(dataDir, 'backups', `backup-${stamp}`));
const historyJsonPath = opt('history-json') ? path.resolve(opt('history-json')) : null;

let client = null;
try {
  let db = null;
  if (config.mongodb) {
    client = new MongoClient(config.mongodb.uri, { serverSelectionTimeoutMS: 15000, appName: 'zodiacpatent-backup' });
    await client.connect();
    db = client.db(config.mongodb.dbName);
  }
  const r = await backup({ dataDir, db, outDir, historyJsonPath });
  console.log(`Backup written to ${r.outDir}`);
  console.log(`  files: ${r.files.join(', ') || '(none found)'}`);
  console.log(`  MongoDB: ${db ? JSON.stringify(r.collections) : 'not configured (files only)'}`);
} catch (err) {
  console.error(`Backup failed: ${err?.name || 'Error'}: ${String(err?.message || err).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri hidden>')}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}
