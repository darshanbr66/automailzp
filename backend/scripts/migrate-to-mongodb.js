#!/usr/bin/env node
// Move existing data (Excel history, pending rows, template, column mapping and,
// optionally, a JSON export of the production history) into MongoDB.
//
//   npm run db:migrate                         # DRY RUN: shows what would happen
//   npm run db:migrate -- --apply              # backup first, then import
//
// Options:
//   --apply                     actually write (default is a dry run)
//   --data-dir <folder>         legacy data folder (default: DATA_DIR or backend/data)
//   --history-json <file>       production history saved from /api/history
//   --history-json-timezone <tz>  time zone of that export's "Sent At" (default UTC: Render's clock)
//   --legacy-timezone <tz>      time zone the local Excel rows were written in (default: this computer's)
//   --force-template / --force-mapping   replace what is already in MongoDB
//   --skip-backup               not recommended
//
// Safe to run more than once: rows already imported are recognised and skipped.
// Source files are never changed or deleted.
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { loadConfigFromEnvFile } from '../src/config.js';
import { backup, migrate, validTimeZone } from '../src/migrate.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfigFromEnvFile();
if (!config.mongodb) {
  console.error('MONGODB_URI is not set (backend/.env or the environment). Nothing to do.');
  process.exit(1);
}
const dataDir = path.resolve(opt('data-dir') || config.dataDir);
const legacyTimeZone = opt('legacy-timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
const historyJsonTimeZone = opt('history-json-timezone') || 'UTC';
for (const tz of [legacyTimeZone, historyJsonTimeZone]) {
  if (!validTimeZone(tz)) {
    console.error(`Unknown time zone "${tz}". Use an IANA name such as UTC or Asia/Kolkata.`);
    process.exit(1);
  }
}
const apply = flag('apply');
const historyJsonPath = opt('history-json') ? path.resolve(opt('history-json')) : null;

const client = new MongoClient(config.mongodb.uri, { serverSelectionTimeoutMS: 15000, appName: 'zodiacpatent-migration' });
try {
  await client.connect();
  const db = client.db(config.mongodb.dbName);
  console.log(`${apply ? 'MIGRATING' : 'DRY RUN (nothing is written; add --apply to import)'}`);
  console.log(`  database: "${config.mongodb.dbName}"  |  data folder: ${dataDir}`);
  console.log(`  legacy Excel time zone: ${legacyTimeZone}${historyJsonPath ? `  |  export: ${historyJsonPath} (${historyJsonTimeZone})` : ''}`);

  if (apply && !flag('skip-backup')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const b = await backup({ dataDir, db, outDir: path.join(dataDir, 'backups', `before-migration-${stamp}`), historyJsonPath });
    console.log(`\nBackup written to ${b.outDir}`);
    console.log(`  files: ${b.files.join(', ') || '(none found)'}  |  MongoDB documents: ${JSON.stringify(b.collections)}`);
  }

  const r = await migrate({ db, dataDir, historyJsonPath, legacyTimeZone, historyJsonTimeZone, dryRun: !apply, forceTemplate: flag('force-template'), forceMapping: flag('force-mapping') });
  console.log('\nFound:', JSON.stringify(r.found));
  console.log(`History: ${r.history.candidates} row(s) found, ${r.history.inserted} ${apply ? 'imported' : 'would be imported'}, ${r.history.alreadyPresent} already in MongoDB${r.history.unparsableDates ? `, ${r.history.unparsableDates} with an unreadable date` : ''}`);
  console.log(`Template: ${r.template}  |  Mapping: ${r.mapping}`);
  if (r.problems.length) console.log(`\nNotes:\n  - ${r.problems.join('\n  - ')}`);
  console.log(apply ? '\nDone. Source files were not changed.' : '\nDry run complete. Run again with --apply to import.');
} catch (err) {
  console.error(`\nMigration stopped: ${err?.name || 'Error'}: ${String(err?.message || err).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri hidden>')}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
