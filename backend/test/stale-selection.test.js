// Wrong-recipient protection: a send only goes out if the attorney and recipient
// the user selected are still the same in the current shared workbook and mapping.
// Two "team members" (Alice and Bob) share one server. Mail is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResendMailer } from '../src/resend.js';
import { fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, startTestServer, testConfig } from './helpers.js';

const HEAD = ['Full Name', 'Reg No', 'E-mail', 'Firm'];
const X = ['Attorney X', 'REG-X', 'x@example.com', 'X LLP'];
const Y = ['Attorney Y', 'REG-Y', 'y@example.com', 'Y LLP'];
const Z = ['Attorney Z', '', 'z@example.com', 'Z LLP'];
const ORIGINAL = [HEAD, X, Y, Z];
const REORDERED = [HEAD, Y, X, Z]; // row 2 is now Y
let n = 0;
const rid = () => `stale-test-${Date.now()}-${(n += 1)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup({ mailer } = {}) {
  const dataDir = await makeTempDir();
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: mailer || makeMailer(smtp) });
  assert.equal((await srv.upload(makeWorkbookBuffer(ORIGINAL))).status, 200);
  return { srv, smtp, dataDir };
}

/** What the browser captures when the user clicks a row (preview). */
async function select(srv, rowNumber) {
  const list = (await srv.request('GET', '/api/excel/records')).data.data;
  const p = await srv.request('POST', '/api/preview', { json: { rowNumber, workbookVersion: list.workbookVersion, mappingVersion: list.mappingVersion } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const { workbookVersion, mappingVersion, recordId, recipientEmail, attorneyName, body } = p.data.data;
  return { expected: { workbookVersion, mappingVersion, recordId, recipientEmail }, attorneyName, body, rowNumber };
}
const send = (srv, sel, extra = {}) =>
  srv.request('POST', '/api/send', { json: { rowNumber: sel.rowNumber, subject: 'Subject', body: sel.body, requestId: rid(), expected: sel.expected, ...extra } });
const historyCount = async (dataDir) => {
  try {
    await fs.access(path.join(dataDir, 'sent-emails.xlsx'));
  } catch {
    return 0;
  }
  const XLSX = await import('xlsx');
  return XLSX.utils.sheet_to_json(XLSX.read(await fs.readFile(path.join(dataDir, 'sent-emails.xlsx'))).Sheets['Sent Emails']).length;
};
const assertStale = (r, reason) => {
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'STALE_SELECTION');
  assert.match(r.data.error.message, /No email was sent\. Please reload the page and select the attorney again\./);
  if (reason) assert.equal(r.data.error.details.reason, reason);
};

// ---------------------------------------------------------------------------
test('the list and preview carry the workbook and mapping versions; preview returns the selection', async () => {
  const { srv } = await setup();
  try {
    const list = (await srv.request('GET', '/api/excel/records')).data.data;
    assert.match(list.workbookVersion, /^[0-9a-f-]{36}$/);
    assert.match(list.mappingVersion, /^[0-9a-f]{16}$/);
    const sel = await select(srv, 2);
    assert.deepEqual(sel.expected, { workbookVersion: list.workbookVersion, mappingVersion: list.mappingVersion, recordId: 'REG-X', recipientEmail: 'x@example.com' });
    // Uploading again, even the same file, gives a new version.
    await srv.upload(makeWorkbookBuffer(ORIGINAL));
    assert.notEqual((await srv.request('GET', '/api/excel/records')).data.data.workbookVersion, list.workbookVersion);
  } finally {
    await srv.close();
  }
});

test('a send without a selection, or with any mismatching field, is refused and nothing is sent', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    const sel = await select(srv, 2);
    assertStale(await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() }, select: false }), 'missing');
    assertStale(await send(srv, sel, { expected: { ...sel.expected, workbookVersion: 'old-version' } }), 'workbook');
    assertStale(await send(srv, sel, { expected: { ...sel.expected, mappingVersion: '0000000000000000' } }), 'mapping');
    assertStale(await send(srv, sel, { expected: { ...sel.expected, recordId: 'REG-Y' } }), 'record');
    assertStale(await send(srv, sel, { expected: { ...sel.expected, recipientEmail: 'y@example.com' } }), 'recipient');
    assertStale(await send(srv, sel, { expected: 'not an object' }), 'missing');
    assert.equal(smtp.state.sent.length, 0);
    assert.equal(smtp.state.options.length, 0, 'no mail connection is even opened');
    assert.equal(await historyCount(dataDir), 0, 'stale requests are not recorded in Sent History');
    // Capitalisation/whitespace differences in the recipient are not "changes".
    const ok = await send(srv, sel, { expected: { ...sel.expected, recipientEmail: ' X@Example.com ' } });
    assert.equal(ok.status, 200);
    assert.equal(smtp.state.sent[0].to, 'x@example.com');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
test('Alice previews X, Bob uploads a re-ordered workbook: Alice\'s send is refused, then works after re-selecting', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    const alice = await select(srv, 2);
    assert.equal(alice.attorneyName, 'Attorney X');
    assert.equal((await srv.upload(makeWorkbookBuffer(REORDERED))).status, 200); // Bob

    assertStale(await send(srv, alice), 'workbook');
    assertStale(await srv.request('POST', '/api/history/check', { json: { rowNumber: 2, expected: alice.expected } }), 'workbook');
    assert.equal(smtp.state.sent.length, 0, 'Y did NOT receive "Dear Attorney X"');
    assert.equal(await historyCount(dataDir), 0);

    // Clicking a row in her old list is refused too, instead of quietly showing Y.
    const stalePreview = await srv.request('POST', '/api/preview', { json: { rowNumber: 2, workbookVersion: alice.expected.workbookVersion, mappingVersion: alice.expected.mappingVersion } });
    assertStale(stalePreview, 'workbook');

    // After reloading, X is row 3; selecting and sending works and reaches X.
    const again = await select(srv, 3);
    assert.equal(again.attorneyName, 'Attorney X');
    assert.equal((await send(srv, again)).status, 200);
    assert.equal(smtp.state.sent.length, 1);
    assert.equal(smtp.state.sent[0].to, 'x@example.com');
  } finally {
    await srv.close();
  }
});

test('Bob changes the column mapping after Alice previews: Alice\'s send is refused', async () => {
  const { srv, smtp } = await setup();
  try {
    const alice = await select(srv, 2);
    const mapping = (await srv.request('GET', '/api/mapping')).data.data.mapping;
    // Bob maps "Firm Name" to a different column (an empty optional field would just fall back to the guessed column).
    assert.equal((await srv.request('PUT', '/api/mapping', { json: { mapping: { ...mapping, firmName: 'Full Name' } } })).status, 200); // Bob
    assertStale(await send(srv, alice), 'mapping');
    assert.equal(smtp.state.sent.length, 0);
    // Saving the same mapping again is not a change.
    const fresh = await select(srv, 2);
    const same = (await srv.request('GET', '/api/mapping')).data.data.mapping;
    await srv.request('PUT', '/api/mapping', { json: { mapping: same } });
    assert.equal((await send(srv, fresh)).status, 200);
  } finally {
    await srv.close();
  }
});

test('a send waiting behind another member\'s send is refused if the workbook is replaced meanwhile', async () => {
  const { srv, smtp, dataDir } = await setup();
  try {
    const bob = await select(srv, 3); // Y
    const alice = await select(srv, 2); // X
    smtp.state.sendQueue.push({ delayMs: 400 }); // Bob's send is slow and holds the send queue
    const bobSend = send(srv, bob);
    await sleep(80);
    const aliceSend = send(srv, alice); // passes the first check, then waits in the queue
    await sleep(80);
    assert.equal((await srv.upload(makeWorkbookBuffer(REORDERED))).status, 200); // workbook replaced while Alice waits
    const [b, a] = await Promise.all([bobSend, aliceSend]);
    assert.equal(b.status, 200, 'Bob\'s send was already in progress and completes');
    assertStale(a, 'workbook');
    assert.deepEqual(smtp.state.sent.map((m) => m.to), ['y@example.com']);
    assert.equal(await historyCount(dataDir), 1);
  } finally {
    await srv.close();
  }
});

test('two members composing different attorneys at the same time do not affect each other', async () => {
  const { srv, smtp } = await setup();
  try {
    const [alice, bob] = await Promise.all([select(srv, 2), select(srv, 4)]);
    smtp.state.sendQueue.push({ delayMs: 150 });
    const [a, b] = await Promise.all([send(srv, alice), send(srv, bob)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const byRecipient = Object.fromEntries(smtp.state.sent.map((m) => [m.to, m.text]));
    assert.match(byRecipient['x@example.com'], /Dear Attorney X/);
    assert.match(byRecipient['z@example.com'], /Dear Attorney Z/);
    // And the same attorney at the same time still sends only once.
    await srv.upload(makeWorkbookBuffer(ORIGINAL));
    const [s1, s2] = [await select(srv, 3), await select(srv, 3)];
    smtp.state.sendQueue.push({ delayMs: 150 });
    const codes = (await Promise.all([send(srv, s1), send(srv, s2)])).map((r) => r.data.error?.code || 'SENT').sort();
    assert.deepEqual(codes, ['SEND_IN_PROGRESS', 'SENT']);
  } finally {
    await srv.close();
  }
});

test('with Resend, a stale selection never reaches the Resend API', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    return { status: 200, json: async () => ({ id: 'email-1' }) };
  };
  const config = testConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_1234567890abcdef', SMTP_FROM: 'vikram@zodiacpatent.example' });
  const { srv } = await setup({ mailer: new ResendMailer({ apiKey: config.email.resendApiKey, from: config.email.from }, { fetch }) });
  try {
    const alice = await select(srv, 2);
    await srv.upload(makeWorkbookBuffer(REORDERED));
    assertStale(await send(srv, alice), 'workbook');
    assert.deepEqual(calls, []);
    const fresh = await select(srv, 3);
    assert.equal((await send(srv, fresh)).status, 200);
    assert.deepEqual(calls, ['https://api.resend.com/emails']);
  } finally {
    await srv.close();
  }
});
