#!/usr/bin/env node
// Check a MongoDB database's counts and relationships. READ-ONLY.
//
//   npm run db:verify                      (the app's configured database)
//   npm run db:verify -- --db <name>       (another database on the same cluster, e.g. a restore)
//   npm run db:verify -- --json            (machine-readable output)
// Exit code 1 when integrity problems are found.
import { verifyDatabase } from '../src/dbops.js';
import { appTarget, connect, errorText, fail, otherTarget, out, parseArgs, printTarget, loadSettings } from './lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
const t = args.opt('db') ? otherTarget(settings, args, args.opt('db')) : appTarget(settings);
if (!t) fail('MONGODB_URI is not set: there is no database to verify.');

let client = null;
try {
  if (!args.flag('json')) printTarget('Verifying (read-only)', t, settings);
  client = await connect(t, 'zodiacpatent-verify');
  const v = await verifyDatabase(client.db(t.dbName));
  if (args.flag('json')) {
    out(JSON.stringify({ target: t.label, ...v }, null, 2));
  } else {
    out(`\nDocuments: ${JSON.stringify(v.counts)}`);
    out(`History by status: ${JSON.stringify(v.history.byStatus)}`);
    out(`Current workbook: ${v.workbook.current ? `${v.workbook.rows} rows, ${v.workbook.complete ? 'complete' : 'INCOMPLETE'}` : 'none'}`);
    out(`Result: ${v.ok ? 'OK' : 'PROBLEMS FOUND'}`);
    for (const p of v.problems) out(`  problem: ${p}`);
    for (const w of v.warnings) out(`  note: ${w}`);
  }
  if (!v.ok) process.exitCode = 1;
} catch (err) {
  fail(`Verification failed: ${errorText(err)}`);
} finally {
  await client?.close().catch(() => {});
}
