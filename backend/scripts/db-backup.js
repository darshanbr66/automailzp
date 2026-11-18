#!/usr/bin/env node
// Back up the legacy data files and every MongoDB collection used by the app.
// READ-ONLY on the database. Writes to backend/data/backups/<timestamp>/ (or --out):
// one canonical-JSON file per collection plus manifest.json (counts, SHA-256
// checksums, verification result). The connection string is never printed.
//
//   npm run db:backup
//   npm run db:backup -- --out D:\backups\zodiac
//   npm run db:backup -- --db zodiacpatent_restore_20261118   (another database on the same cluster)
//   npm run db:backup -- --env-file <file>                    (settings from another env file)
//   npm run db:backup -- --history-json history.json          (also keep a copy of an export)
import path from 'node:path';
import { backup } from '../src/migrate.js';
import { appTarget, connect, errorText, fail, otherTarget, out, parseArgs, printTarget, loadSettings } from './lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
const dataDir = path.resolve(args.opt('data-dir') || settings.config.dataDir);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(args.opt('out') || path.join(dataDir, 'backups', `backup-${stamp}`));
const historyJsonPath = args.opt('history-json') ? path.resolve(args.opt('history-json')) : null;

let client = null;
try {
  const t = args.opt('db') ? otherTarget(settings, args, args.opt('db')) : appTarget(settings);
  if (t) printTarget('Backing up (read-only)', t, settings);
  else out('MONGODB_URI is not set: backing up the local files only.');
  let db = null;
  if (t) {
    client = await connect(t, 'zodiacpatent-backup');
    db = client.db(t.dbName);
  }
  const r = await backup({ dataDir, db, outDir, historyJsonPath, target: t });
  out(`\nBackup written to ${r.outDir}`);
  out(`  files: ${r.files.join(', ') || '(none found)'}`);
  if (r.manifest) {
    out(`  MongoDB documents: ${JSON.stringify(r.collections)}`);
    if (r.manifest.changedDuringBackup.length) out(`  NOTE: ${r.manifest.changedDuringBackup.join(', ')} changed while the backup ran (the app was in use). Run it again when nobody is sending for an exact copy.`);
    const v = r.manifest.verification;
    out(`  verification: ${v.ok ? 'OK' : 'PROBLEMS FOUND'}`);
    for (const p of v.problems) out(`    problem: ${p}`);
    for (const w of v.warnings) out(`    note: ${w}`);
  }
  out('\nKeep this folder private: it contains attorney names and email addresses.');
} catch (err) {
  fail(`Backup failed: ${errorText(err)}`);
} finally {
  await client?.close().catch(() => {});
}
