#!/usr/bin/env node
// Initialise a FRESH app database: create the app's collections and indexes.
// Imports nothing (no migration), and changes no documents. Safe to re-run:
// existing indexes are left as they are.
//
//   npm run db:init                                    -> shows the target and the database user's access
//   npm run db:init -- --confirm-target <db@fingerprint> [--production]
//
// The connection string is never printed.
import { COLLECTIONS, ensureIndexes } from '../src/storage/mongo.js';
import { verifyDatabase } from '../src/dbops.js';
import { appTarget, connect, errorText, fail, out, parseArgs, printTarget, loadSettings, requireWriteConfirmation } from './lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
const t = appTarget(settings);
if (!t) fail('MONGODB_URI is not set in the env file.');

/** Describe the database user's access (read-only command). */
async function userAccess(client, dbName) {
  const s = await client.db('admin').command({ connectionStatus: 1 });
  const roles = s.authInfo?.authenticatedUserRoles || [];
  const broad = roles.filter((r) => ['atlasAdmin', 'root', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterAdmin'].includes(r.role));
  const onDb = roles.filter((r) => r.db === dbName);
  return { roles, broad, onDb };
}

const client = await connect(t, 'zodiacpatent-init');
try {
  printTarget('Initialising', t, settings);
  const access = await userAccess(client, t.dbName);
  out(`  database user roles: ${access.roles.map((r) => `${r.role}@${r.db}`).join(', ') || '(none reported)'}`);
  if (access.broad.length) out(`  WARNING: this user has cluster-wide access (${access.broad.map((r) => r.role).join(', ')}). Use a user with readWrite on "${t.dbName}" only.`);
  if (!args.flag('allow-broad-user') && access.broad.length) fail('Refusing to initialise with a cluster-wide database user. Configure a dedicated user (readWrite on this database only), or add --allow-broad-user.', 3);
  const db = client.db(t.dbName);
  const before = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  out(`  existing collections: ${before.join(', ') || '(none)'}`);
  requireWriteConfirmation(t, args, settings, 'create the app collections and indexes in this database');

  await ensureIndexes(db, { activityRetentionDays: settings.config.mongodb.activityRetentionDays ?? null });
  // Collections without a secondary index (templates, mappings) are created explicitly.
  const now = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of Object.values(COLLECTIONS)) if (!now.has(name)) await db.createCollection(name);

  out('\nCollections and indexes:');
  for (const name of Object.values(COLLECTIONS)) {
    const idx = (await db.collection(name).indexes()).map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`);
    out(`  ${name}: ${await db.collection(name).countDocuments({})} documents; indexes: ${idx.join(', ')}`);
  }
  const others = [...now].filter((n) => !Object.values(COLLECTIONS).includes(n));
  if (others.length) out(`  not used by the app (left untouched): ${others.join(', ')}`);
  const v = await verifyDatabase(db);
  out(`\nVerification: ${v.ok ? 'OK' : 'PROBLEMS FOUND'}`);
  for (const p of v.problems) out(`  problem: ${p}`);
  for (const w of v.warnings) out(`  note: ${w}`);
  if (!v.ok) process.exitCode = 1;
} catch (err) {
  fail(`Initialisation stopped: ${errorText(err)}`);
} finally {
  await client.close().catch(() => {});
}
