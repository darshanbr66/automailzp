#!/usr/bin/env node
// List sends whose outcome is unknown ("Uncertain") and send claims still in
// progress, with what to look up at the email provider. READ-ONLY: the outcome is
// recorded by a team member in the app (Sent History -> Correct…), so it is
// audited with their name. See DATABASE-OPERATIONS.md, "Reconciling Uncertain sends".
//
//   npm run db:reconcile
import { COLLECTIONS } from '../src/storage/mongo.js';
import { appTarget, connect, errorText, fail, out, parseArgs, printTarget, loadSettings } from './lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
const t = appTarget(settings);
if (!t) fail('MONGODB_URI is not set: Uncertain sends are listed in the app (Sent History).');

let client = null;
try {
  printTarget('Reading (read-only)', t, settings);
  client = await connect(t, 'zodiacpatent-reconcile');
  const db = client.db(t.dbName);
  const uncertain = await db.collection(COLLECTIONS.history).find({ status: 'Uncertain', void: { $exists: false } }).sort({ sentAtUtc: 1 }).toArray();
  const claims = await db.collection(COLLECTIONS.pending).find({}).sort({ startedAt: 1 }).toArray();
  out(`\n${uncertain.length} send(s) with an unknown outcome (never resent automatically; each blocks its attorney until reconciled):`);
  for (const u of uncertain) {
    out(`- ${u.sentAtUtc?.toISOString?.() || u.sentAt}  ${u.attorneyName} <${u.recipientEmail}>  via ${u.sendMethod || '?'}  by ${u.operator?.name || '?'}`);
    out(`    history id: ${u._id}${u.requestId ? `   Resend idempotency key: zp-send-${u.requestId}` : ''}${u.messageId ? `   message id: ${u.messageId}` : ''}`);
  }
  out(`\n${claims.length} send claim(s) in progress or awaiting automatic recovery:`);
  for (const c of claims) out(`- ${c.startedAt?.toISOString?.()}  state ${c.state || 'sending (old format)'}  ${c.entry?.attorneyName || ''} <${c.entry?.recipientEmail || ''}>  last heartbeat ${c.heartbeatAt?.toISOString?.() || 'none'}`);
  out('\nTo reconcile: look the email up at the provider (Resend dashboard -> Emails, search the recipient; Hostinger: Sent folder),');
  out('then in the app open Sent History -> Send log -> "Correct…" and choose "It was sent" or "It was not sent", with a reason.');
} catch (err) {
  fail(`Could not read the database: ${errorText(err)}`);
} finally {
  await client?.close().catch(() => {});
}
