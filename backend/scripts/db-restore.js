#!/usr/bin/env node
// Restore a backup (made by "npm run db:backup") into a NEW, EMPTY database, then
// verify counts and relationships. It never writes into the app's configured
// database, a production database, the database the backup came from, or any
// database that already contains data. Nothing is ever dropped or overwritten.
//
//   npm run db:restore -- --from <backup folder> --target-db <new database name>
//        -> shows the target and its confirmation label, changes nothing
//   npm run db:restore -- --from <folder> --target-db <name> --confirm-target <name@fingerprint>
//        -> restores
//
// Options:
//   --target-uri-env <VAR>  restore onto the cluster in environment variable VAR
//                           (e.g. a separate free test cluster); default: the
//                           cluster of MONGODB_URI. Pass the variable's NAME only.
//   --env-file <file>       settings from another env file (default backend/.env)
import path from 'node:path';
import { restoreBackup, readBackup } from '../src/dbops.js';
import { appTarget, connect, errorText, fail, otherTarget, out, parseArgs, printTarget, loadSettings, requireWriteConfirmation } from './lib/cli.js';

const args = parseArgs();
const from = args.opt('from');
const targetDb = args.opt('target-db');
if (!from || !targetDb) fail('Usage: npm run db:restore -- --from <backup folder> --target-db <new database name> [--confirm-target <label>]', 2);
const settings = loadSettings(args);
const app = settings.config.mongodb ? appTarget(settings) : null;
const t = otherTarget(settings, args, targetDb);

let client = null;
try {
  const { manifest } = await readBackup(path.resolve(from)); // checksums verified before anything else
  out(`Backup: ${path.resolve(from)}`);
  out(`  taken ${manifest.createdAtUtc} from ${manifest.source?.label || 'an unknown database'}; documents: ${JSON.stringify(Object.fromEntries(Object.entries(manifest.collections).map(([k, v]) => [k, v.count])))}`);
  out('  checksums: OK');
  printTarget('Restore target', t, settings);
  if (app) out(`  (the app's own database ${app.label} is never written by a restore)`);
  requireWriteConfirmation(t, args, settings, 'restore into this database');
  client = await connect(t, 'zodiacpatent-restore');
  const r = await restoreBackup({ client, backupDir: path.resolve(from), target: t, appTargets: app ? [app] : [], env: settings.env });
  out(`\nRestored into ${t.label}: ${JSON.stringify(r.restored)}`);
  out(`Verification: ${r.verification.ok ? 'OK (counts match the backup; relationships checked)' : 'PROBLEMS FOUND'}`);
  for (const p of r.verification.problems) out(`  problem: ${p}`);
  for (const w of r.verification.warnings) out(`  note: ${w}`);
  out('\nThe app still uses its configured database. See DATABASE-OPERATIONS.md before pointing it at the restored one.');
  if (!r.verification.ok) process.exitCode = 1;
} catch (err) {
  fail(`Restore stopped: ${errorText(err)}`, err?.code === 'TARGET_NOT_EMPTY' || err?.code === 'RESTORE_TARGET_PROTECTED' ? 3 : 1);
} finally {
  await client?.close().catch(() => {});
}
