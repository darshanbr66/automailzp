#!/usr/bin/env node
// Move existing data (Excel history, pending rows, template, column mapping and,
// optionally, a JSON export of the production history) into MongoDB.
// See DATABASE-OPERATIONS.md, "Production migration", for the full procedure.
//
//   npm run db:migrate -- --history-json <export.json>
//        DRY RUN: preflight checks and what would be imported; nothing is written
//   npm run db:migrate -- --history-json <export.json> --apply --confirm-target <db@fingerprint> [--production]
//        backup first, import, verify (prints the run id needed for a rollback)
//
// Options:
//   --apply                       actually write (default is a dry run)
//   --confirm-target <label>      required with --apply: the label the dry run prints
//   --production                  also required when the target is a production database
//   --data-dir <folder>           legacy data folder (default: DATA_DIR or backend/data)
//   --history-json <file>         production history saved from /api/history
//   --history-json-timezone <tz>  time zone of that export's "Sent At" (default UTC: Render's clock)
//   --legacy-timezone <tz>        time zone the local Excel rows were written in (default: this computer's)
//   --allow-unparsable-dates      import rows whose date can't be read (dated 1970-01-01, flagged)
//   --force-template / --force-mapping   replace what is already in MongoDB
//   --report <file>               also write the full report (JSON) to this file
//   --env-file <file>             settings from another env file (default backend/.env)
//
// Safe to run more than once: rows already imported are recognised and skipped.
// Source files are never changed or deleted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { backup, migrate, validTimeZone } from '../src/migrate.js';
import { appTarget, connect, errorText, fail, out, parseArgs, printTarget, loadSettings, requireWriteConfirmation } from './lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
const t = appTarget(settings);
if (!t) fail('MONGODB_URI is not set (in the env file). Nothing to do.');
const dataDir = path.resolve(args.opt('data-dir') || settings.config.dataDir);
const legacyTimeZone = args.opt('legacy-timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
const historyJsonTimeZone = args.opt('history-json-timezone') || 'UTC';
for (const tz of [legacyTimeZone, historyJsonTimeZone]) if (!validTimeZone(tz)) fail(`Unknown time zone "${tz}". Use an IANA name such as UTC or Asia/Kolkata.`);
const apply = args.flag('apply');
const historyJsonPath = args.opt('history-json') ? path.resolve(args.opt('history-json')) : null;

printTarget(apply ? 'MIGRATING into' : 'DRY RUN against (nothing is written; add --apply to import)', t, settings);
out(`  data folder: ${dataDir}  |  legacy Excel time zone: ${legacyTimeZone}${historyJsonPath ? `  |  export: ${historyJsonPath} (${historyJsonTimeZone})` : ''}`);
if (apply) requireWriteConfirmation(t, args, settings, 'import into this database');

const client = await connect(t, 'zodiacpatent-migration');
try {
  const db = client.db(t.dbName);
  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const b = await backup({ dataDir, db, outDir: path.join(dataDir, 'backups', `before-migration-${stamp}`), historyJsonPath, target: t });
    out(`\nBackup written to ${b.outDir}`);
    out(`  files: ${b.files.join(', ') || '(none found)'}  |  MongoDB documents: ${JSON.stringify(b.collections)}`);
  }

  const r = await migrate({
    db,
    dataDir,
    historyJsonPath,
    legacyTimeZone,
    historyJsonTimeZone,
    dryRun: !apply,
    forceTemplate: args.flag('force-template'),
    forceMapping: args.flag('force-mapping'),
    allowUnparsableDates: args.flag('allow-unparsable-dates'),
  });
  const p = r.preflight;
  out(`\nSources found: ${JSON.stringify(r.found)}`);
  out(`\nPreflight`);
  out(`  rows: ${p.fingerprints.candidates} unique (${p.fingerprints.inBothSources} present in both the files and the export, counted once; ${p.fingerprints.repeatedIdenticalRows} genuinely repeated identical rows kept)`);
  out(`  status: ${JSON.stringify(p.statuses)}  |  uncertain rows preserved: ${p.uncertainRows}  |  pending (not yet saved) rows: ${p.pendingRows}`);
  out(`  dates: ${p.dates.recordedUtc} with a UTC time, ${p.dates.convertedFromLocal} converted from local time, ${p.dates.unparsable.length} unreadable, ${p.dates.invalidUtc.length} with an invalid UTC value, ${p.dates.suspicious.length} outside 2015..tomorrow`);
  for (const x of [...p.dates.unparsable, ...p.dates.invalidUtc, ...p.dates.suspicious].slice(0, 20)) out(`    check row ${x.index} (${x.source}, record ${x.recordId}): "${x.sentAt}" ${x.sentAtUtc ? `/ "${x.sentAtUtc}"` : ''}${x.utc ? ` -> ${x.utc}` : ''}`);
  out(`\nCounts in MongoDB before: ${JSON.stringify(r.counts.before)}`);
  out(`History: ${r.history.candidates} row(s), ${r.history.inserted} ${apply ? 'imported' : 'would be imported'}, ${r.history.alreadyPresent} already in MongoDB`);
  if (r.counts.after) out(`Counts in MongoDB after:  ${JSON.stringify(r.counts.after)}`);
  if (r.verification) out(`Verification: ${r.verification.ok ? 'OK' : 'FAILED'} (${r.verification.legacyRowsPresent} of ${r.verification.legacyRowsExpected} legacy rows present${r.verification.note ? `; ${r.verification.note}` : ''})`);
  out(`Template: ${r.template}  |  Mapping: ${r.mapping}`);
  if (r.problems.length) out(`\nNotes:\n  - ${r.problems.join('\n  - ')}`);
  if (r.blocked) {
    out(`\nNOT IMPORTED: ${r.blocked}`);
    process.exitCode = 4;
  } else if (apply) {
    out(`\nDone. Migration run id: ${r.runId}  (needed for a rollback: npm run db:migrate:rollback -- --run ${r.runId})`);
    if (r.verification && !r.verification.ok) process.exitCode = 1;
  } else {
    out(`\nDry run complete. To import: add --apply --confirm-target ${t.label}`);
  }
  if (args.opt('report')) await fs.writeFile(path.resolve(args.opt('report')), JSON.stringify({ target: t.label, ...r }, null, 2), { mode: 0o600 });
} catch (err) {
  fail(`\nMigration stopped: ${errorText(err)}`);
} finally {
  await client.close().catch(() => {});
}
