#!/usr/bin/env node
// Live smoke test of the MongoDB version against a REAL database (e.g. Atlas),
// in a dedicated "<MONGODB_DB>_smoketest" database. No email is ever sent: the
// mail transport is fake. The attorneys are fictional (@example.com) and unique
// to each run, so the test can be repeated; all counts are compared with the
// state before the run. Nothing is deleted afterwards.
//
//   node testing/atlas-smoke.js                                  -> shows the target, changes nothing
//   node testing/atlas-smoke.js --confirm-target <db@fingerprint>
//
// Two app instances on the same database stand in for two team members' servers.
import { ObjectId } from 'mongodb';
import { createMongoStorage, COLLECTIONS } from '../src/storage/mongo.js';
import { verifyDatabase } from '../src/dbops.js';
import { fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, startTestServer, testConfig } from '../test/helpers.js';
import { connect, errorText, fail, otherTarget, out, parseArgs, printTarget, loadSettings, requireWriteConfirmation } from '../scripts/lib/cli.js';

const args = parseArgs();
const settings = loadSettings(args);
if (!settings.config.mongodb) fail('MONGODB_URI is not set in the env file.');
const dbName = `${String(settings.env.MONGODB_DB || '').trim()}_smoketest`;
if (dbName === '_smoketest') fail('MONGODB_DB is not set in the env file.');
const t = otherTarget(settings, args, dbName);
printTarget('Smoke-test database', t, settings);
if (!/_smoketest$/.test(t.dbName)) fail('The smoke test only runs in a database whose name ends with _smoketest.', 3);
requireWriteConfirmation(t, args, settings, 'run the smoke test in this database');

const results = [];
const check = (name, ok, detail) => {
  results.push(Boolean(ok));
  out(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  (${JSON.stringify(detail).slice(0, 300)})` : ''}`);
};

const admin = await connect(t, 'zodiacpatent-smoke');
const servers = [];
try {
  const db = admin.db(t.dbName);
  const count = (c, f = {}) => db.collection(COLLECTIONS[c]).countDocuments(f);
  const TEAM = settings.config.teamMembers;
  const config = testConfig({ TEAM_MEMBERS: TEAM.join(',') });
  const instance = async (operator) => {
    const dataDir = await makeTempDir();
    const storage = createMongoStorage({ uri: t.uri, dbName: t.dbName, dataDir });
    const smtp = fakeTransport();
    const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp, config), config, storage, headers: { 'x-operator': operator } });
    servers.push({ srv, storage });
    return { srv, smtp, storage };
  };
  const a = await instance(TEAM[0]);
  const b = await instance(TEAM[1] || TEAM[0]);
  const run = Date.now().toString(36);
  const rid = (() => { let i = 0; return () => `smoke-${run}-${(i += 1)}`; })();
  const SUBJECT = `Smoke test ${run}`;
  const sendReq = (srv, rowNumber, extra = {}) => srv.request('POST', '/api/send', { json: { rowNumber, subject: SUBJECT, body: 'Smoke test body', requestId: rid(), ...extra } });
  const selection = async (srv, rowNumber) => {
    const p = (await srv.request('POST', '/api/preview', { json: { rowNumber } })).data.data;
    return { workbookVersion: p.workbookVersion, mappingVersion: p.mappingVersion, recordId: p.recordId, recipientEmail: p.recipientEmail };
  };
  await a.storage.init();
  const before = { success: await count('history', { status: 'Success' }), manual: await count('history', { sendMethod: 'Manual' }), activity: await count('activity') };

  const cfg = (await a.srv.request('GET', '/api/app/config')).data.data;
  check('1. app runs in MongoDB mode (not file storage), on the smoke-test database', cfg.storage === 'mongodb' && cfg.features.persistentWorkbook && cfg.database === t.dbName, cfg);
  check('2. team members come from TEAM_MEMBERS', JSON.stringify(cfg.teamMembers) === JSON.stringify(TEAM), cfg.teamMembers);

  const reg = (n) => `SMOKE-${run}-${n}`.toUpperCase();
  const mail = (n) => `smoke${n}.${run}@example.com`;
  const rows = [
    ['Full Name', 'Reg No', 'E-mail', 'Firm', 'City', 'State'],
    [`Smoke Attorney One ${run}`, reg(1), mail(1), 'Example LLP', 'Springfield', 'IL'],
    [`Smoke Attorney Two ${run}`, reg(2), mail(2), 'Example LLP', 'Springfield', 'IL'],
    [`Smoke Attorney Three ${run}`, '', mail(3), 'Sample & Co', '', ''],
  ];
  const up = await a.srv.upload(makeWorkbookBuffer(rows), 'smoke-attorneys.xlsx');
  check('3. fresh Excel upload is stored in MongoDB', up.status === 200 && up.data.data.totalRecords === 3, up.data);
  check('4. stored rows and workbook metadata', (await db.collection(COLLECTIONS.attorneys).countDocuments({ workbookId: up.data.data.workbookVersion })) === 3 && (await db.collection(COLLECTIONS.workbooks).findOne({ _id: 'current' }))?.workbookId === up.data.data.workbookVersion);

  const listB = (await b.srv.request('GET', '/api/excel/records')).data.data;
  check('5. the second instance sees the same workbook (shared)', listB.loaded && listB.workbookVersion === up.data.data.workbookVersion && listB.records.rows.length === 3);
  const pr = await b.srv.request('POST', '/api/preview', { json: { rowNumber: 2 } });
  check('6. attorney selection and email preview', pr.status === 200 && pr.data.data.recipientEmail === mail(1) && pr.data.data.body.includes(`Smoke Attorney One ${run}`), pr.data);

  // A send through the app: the response and the stored record, read straight from the database.
  const s1 = await sendReq(a.srv, 2);
  const d = s1.data?.data || {};
  check('7. send via the FAKE provider: accepted, and the app confirms it is recorded in MongoDB', s1.status === 200 && d.historySaved === true && d.historyStore === 'mongodb' && ObjectId.isValid(String(d.historyId)) && a.smtp.state.sent.length === 1, s1.data);
  const doc = d.historyId ? await db.collection(COLLECTIONS.history).findOne({ _id: new ObjectId(String(d.historyId)) }) : null;
  check('8. the email_history document exists in the database', Boolean(doc));
  if (doc) {
    const fields = {
      status: doc.status === 'Success',
      recipientEmail: doc.recipientEmail === mail(1),
      attorneyName: doc.attorneyName === `Smoke Attorney One ${run}`,
      registrationNumber: doc.registrationNumber === reg(1) && doc.recordId === reg(1),
      firm: doc.firmName === 'Example LLP' && doc.city === 'Springfield' && doc.state === 'IL',
      subject: doc.subject === SUBJECT,
      timestamp: doc.sentAtUtc instanceof Date && Math.abs(Date.now() - doc.sentAtUtc.valueOf()) < 10 * 60 * 1000 && Boolean(doc.sentAt),
      operator: doc.operator?.name === TEAM[0] && doc.operator?.idType === 'self-declared',
      sendType: doc.sendType === 'First Send',
      sendMethod: doc.sendMethod === 'SMTP',
      sender: doc.senderEmail === config.smtp.from,
      providerMessageId: doc.messageId === '<test-message@example.com>',
      requestAndClaim: typeof doc.requestId === 'string' && typeof doc.claimId === 'string',
      workbook: doc.workbookId === up.data.data.workbookVersion,
    };
    const bad = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
    check('9. stored fields: recipient, attorney, registration, firm, subject, timestamp, operator, status, method, message id', bad.length === 0, bad);
    const act = await db.collection(COLLECTIONS.activity).findOne({ action: 'email_sent', historyId: doc._id });
    check('10. team_activity entry linked to the record', act && act.operator?.name === TEAM[0] && act.attorney?.recipientEmail === mail(1));
  }
  check('11. the send claim was released after recording', (await count('pending')) === 0);
  check('12. duplicate protection across instances: the other server warns', (await sendReq(b.srv, 2)).data.error?.code === 'ALREADY_SENT');

  const mark = await b.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 3, expected: await selection(b.srv, 3), note: 'Smoke test manual mark' } });
  check('13. manual "Mark as sent"', mark.status === 200 && mark.data.data.entry.sendMethod === 'Manual', mark.data);
  check('14. a manually marked attorney is protected from an app send', (await sendReq(a.srv, 3)).data.error?.code === 'ALREADY_SENT');
  const again = await a.srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 3, expected: await selection(a.srv, 3) } });
  check('15. it cannot be marked twice', again.data.error?.code === 'ALREADY_SENT');

  const hist = (await b.srv.request('GET', '/api/history')).data.data.entries.filter((e) => e.subject === SUBJECT || e.recipientEmail.includes(run));
  check('16. shared history (seen by the other instance)', hist.length === 2 && hist.every((e) => e.id && e.sentAtUtc));
  const sentList = (await a.srv.request('GET', `/api/sent?q=${encodeURIComponent(run)}`)).data.data;
  check('17. shared Sent Emails list', sentList.total === 2, sentList.total);
  const acts = (await b.srv.request('GET', '/api/activity?pageSize=50')).data.data.items.map((i) => i.action);
  check('18. shared team activity', ['workbook_uploaded', 'email_sent', 'manual_mark_sent'].every((x) => acts.includes(x)), acts.slice(0, 8));

  // Two simultaneous sends of the same new attorney from both instances: one email.
  a.smtp.state.sendQueue.push({ delayMs: 400 });
  b.smtp.state.sendQueue.push({ delayMs: 400 });
  const pair = await Promise.all([sendReq(a.srv, 4), sendReq(b.srv, 4)]);
  const emailsTo3 = [...a.smtp.state.sent, ...b.smtp.state.sent].filter((m) => m.to === mail(3)).length;
  check('19. simultaneous sends from both instances: exactly one email', pair.filter((r) => r.status === 200).length === 1 && emailsTo3 === 1, pair.map((r) => r.data.error?.code || 'SENT'));

  const after = { success: await count('history', { status: 'Success' }), manual: await count('history', { sendMethod: 'Manual' }), activity: await count('activity') };
  check('20. counts: exactly 3 new Success records (2 app sends + 1 manual), 1 of them manual', after.success - before.success === 3 && after.manual - before.manual === 1, { before, after });
  check('21. no send claims left behind', (await count('pending')) === 0);
  const v = await verifyDatabase(db);
  check('22. database verification', v.ok, v.problems);
  check('23. no secrets stored', !JSON.stringify(await db.collection(COLLECTIONS.activity).find({}).toArray()).includes('fake-app-password-for-tests'));
  check('24. only fictional @example.com recipients were used', [...a.smtp.state.sent, ...b.smtp.state.sent].every((m) => /@example\.com$/.test(m.to)));
} catch (err) {
  results.push(false);
  out(`ERROR ${errorText(err)}`);
} finally {
  for (const { srv, storage } of servers) {
    await srv.close().catch(() => {});
    await storage.close().catch(() => {});
  }
  await admin.close().catch(() => {});
}
const failed = results.filter((r) => !r).length;
out(`\n# checks ${results.length}\n# pass ${results.length - failed}\n# fail ${failed}`);
out(`The smoke-test data was left in ${t.label}; it is not deleted automatically.`);
process.exit(failed ? 1 : 0);
