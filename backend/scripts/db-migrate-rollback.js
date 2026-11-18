#!/usr/bin/env node
// Roll back ONE migration run: removes only the history rows that run imported
// (and that nobody corrected since), and puts back the template/mapping it
// replaced. Records written by the app are never touched.
//
//   npm run db:migrate:rollback -- --run <mig-...>                       (dry run: shows what would happen)
//   npm run db:migrate:rollback -- --run <mig-...> --apply --confirm-target <db@fingerprint> [--production]
//
// Take a backup first (npm run db:backup). See DATABASE-OPERATIONS.md.
import { rollbackMigration } from '../src/migrate.js';
import { appTarget, connect, errorText, fail, out, parseArgs, printTarget, loadSettings, requireWriteConfirmation } from './lib/cli.js';

const args = parseArgs();
const runId = args.opt('run');
if (!runId) fail('Usage: npm run db:migrate:rollback -- --run <migration run id> [--apply --confirm-target <label>]', 2);
const settings = loadSettings(args);
const t = appTarget(settings);
if (!t) fail('MONGODB_URI is not set (in the env file).');
const apply = args.flag('apply');
printTarget(apply ? 'ROLLING BACK in' : 'DRY RUN against (nothing is changed; add --apply)', t, settings);
if (apply) requireWriteConfirmation(t, args, settings, 'roll back a migration in this database');

const client = await connect(t, 'zodiacpatent-rollback');
try {
  const r = await rollbackMigration({ db: client.db(t.dbName), runId, dryRun: !apply });
  if (!r.runFound) out(`\nNote: no "data_migrated" activity entry was found for ${runId}.`);
  out(`\nRun ${runId}: ${r.rows} imported row(s); ${r.removable} ${apply ? 'removed' : 'would be removed'}${apply ? ` (${r.deleted} deleted)` : ''}`);
  if (r.keptBecauseCorrected.length) out(`Kept because a team member corrected them since: ${r.keptBecauseCorrected.length} (review them in Sent History)`);
  for (const line of r.restored) out(`  ${line}`);
  if (!apply) out(`\nTo roll back: add --apply --confirm-target ${t.label}`);
} catch (err) {
  fail(`Rollback stopped: ${errorText(err)}`);
} finally {
  await client.close().catch(() => {});
}
