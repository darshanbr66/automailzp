// Registration number optional, deterministic fallback identifiers, duplicate
// detection across restarts, pagination, sender configuration and branding.
// All data is fictional and SMTP is mocked: no email is ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { recordIdentity, matchHistory } from '../src/identity.js';
import { HistoryStore } from '../src/history.js';
import { loadConfigFromEnvFile } from '../src/config.js';
import { SAMPLE_ROWS, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, startTestServer, testConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let n = 0;
const rid = () => `test-identity-${Date.now()}-${(n += 1)}`;

const valuesOf = (obj) => new Map(Object.entries(obj));

const historyRows = async (dataDir) => {
  const wb = XLSX.read(await fs.readFile(path.join(dataDir, 'sent-emails.xlsx')));
  return XLSX.utils.sheet_to_json(wb.Sheets['Sent Emails'], { defval: '' });
};

async function server(dataDir, rows = SAMPLE_ROWS, config = testConfig()) {
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp, config), config });
  const up = await srv.upload(makeWorkbookBuffer(rows));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  return { srv, smtp };
}

const send = (srv, rowNumber, extra = {}) => srv.request('POST', '/api/send', { json: { rowNumber, subject: 'Hello', body: 'Body', requestId: rid(), ...extra } });

// ---------------------------------------------------------------------------
test('identifier: registration number when present, deterministic fallback otherwise', () => {
  const withReg = recordIdentity(valuesOf({ registrationNumber: ' REG-9 ', attorneyName: 'A', recipientEmail: 'a@example.com' }));
  assert.deepEqual(withReg, { recordId: 'REG-9', idType: 'registration', reliable: true });

  const base = { registrationNumber: '', attorneyName: 'Test Attorney Three', recipientEmail: 'three@example.com', firmName: 'Sample & Co', city: '', state: '' };
  const a = recordIdentity(valuesOf(base));
  assert.equal(a.idType, 'fallback');
  assert.equal(a.reliable, true);
  assert.match(a.recordId, /^AUTO-[0-9A-F]{16}$/);
  // Same record -> same ID every time; cosmetic differences are normalized away.
  assert.equal(recordIdentity(valuesOf(base)).recordId, a.recordId);
  assert.equal(recordIdentity(valuesOf({ ...base, attorneyName: '  test   ATTORNEY three ', recipientEmail: 'THREE@example.com ' })).recordId, a.recordId);
  // Different person -> different ID.
  assert.notEqual(recordIdentity(valuesOf({ ...base, recipientEmail: 'other@example.com' })).recordId, a.recordId);
  // Too little information is flagged as unreliable.
  assert.equal(recordIdentity(valuesOf({ ...base, attorneyName: '' })).reliable, false);
});

test('matchHistory: exact by ID, possible by email for fallback records, failed sends ignored', () => {
  const values = valuesOf({ registrationNumber: '', attorneyName: 'X', recipientEmail: 'x@example.com', firmName: 'New Firm' });
  const identity = recordIdentity(values);
  const entries = [
    { recordId: identity.recordId, status: 'Success', recipientEmail: 'x@example.com' },
    { recordId: identity.recordId, status: 'Failed', recipientEmail: 'x@example.com' },
    { recordId: 'AUTO-0000000000000000', status: 'Success', recipientEmail: 'X@example.com' },
    { recordId: 'AUTO-1111111111111111', status: 'Failed', recipientEmail: 'x@example.com' },
  ];
  const { exact, possible } = matchHistory(entries, identity, values);
  assert.equal(exact.length, 1);
  assert.equal(possible.length, 1);
  // Registration-number records only use exact matches.
  const reg = valuesOf({ registrationNumber: 'R1', attorneyName: 'X', recipientEmail: 'x@example.com' });
  assert.deepEqual(matchHistory(entries, recordIdentity(reg), reg), { exact: [], possible: [] });
});

// ---------------------------------------------------------------------------
test('a record without a registration number can be previewed and sent', async () => {
  const dataDir = await makeTempDir();
  const { srv, smtp } = await server(dataDir);
  try {
    const preview = await srv.request('POST', '/api/preview', { json: { rowNumber: 5 } });
    assert.equal(preview.status, 200);
    const p = preview.data.data;
    assert.equal(p.registrationNumber, '');
    assert.deepEqual(p.problems, []);
    assert.equal(p.idType, 'fallback');
    assert.equal(p.subject, 'Regarding Attorney Registration');
    assert.ok(!p.warnings.some((w) => /registrationNumber/.test(w)), 'no missing-registration warning');

    const res = await send(srv, 5, { subject: p.subject, body: p.body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.data.entry.recordId, p.recordId);
    assert.equal(smtp.state.sent.length, 1);
    assert.equal(smtp.state.sent[0].to, 'three@example.com');

    const [row] = await historyRows(dataDir);
    assert.equal(row['Record ID'], p.recordId);
    assert.equal(row['Registration Number'], '');
    assert.equal(row['Firm Name'], 'Sample & Co');
    assert.equal(row.Status, 'Success');
    assert.equal(row['Send Type'], 'First Send');
  } finally {
    await srv.close();
  }
});

test('duplicate detection survives a restart for both identifier methods', async () => {
  const dataDir = await makeTempDir();
  let { srv } = await server(dataDir);
  try {
    assert.equal((await send(srv, 2)).status, 200); // REG-001
    assert.equal((await send(srv, 5)).status, 200); // no registration number
  } finally {
    await srv.close();
  }

  // "Restart": a new app instance on the same data folder, with the workbook
  // re-uploaded in a different row order (so row numbers change).
  const reordered = [SAMPLE_ROWS[0], SAMPLE_ROWS[5], SAMPLE_ROWS[4], SAMPLE_ROWS[2], SAMPLE_ROWS[1]];
  ({ srv } = await server(dataDir, reordered));
  try {
    const records = (await srv.request('GET', '/api/excel/records')).data.data.records.rows;
    const byName = Object.fromEntries(records.map((r) => [r.attorneyName, r]));
    assert.equal(byName['Test Attorney One'].sentCount, 1);
    assert.equal(byName['Test Attorney Three'].sentCount, 1);
    assert.equal(byName['Test Attorney Two'].sentCount, 0);

    const regRow = byName['Test Attorney One'].rowNumber;
    const autoRow = byName['Test Attorney Three'].rowNumber;
    for (const row of [regRow, autoRow]) {
      const check = (await srv.request('POST', '/api/history/check', { json: { rowNumber: row } })).data.data;
      assert.equal(check.alreadySent, true);
      const blocked = await send(srv, row);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.error.code, 'ALREADY_SENT');
      const resend = await send(srv, row, { confirmResend: true });
      assert.equal(resend.status, 200);
      assert.equal(resend.data.data.entry.sendType, 'Resend');
    }
    const rows = await historyRows(dataDir);
    assert.deepEqual(rows.map((r) => r['Send Type']), ['First Send', 'First Send', 'Resend', 'Resend']);
  } finally {
    await srv.close();
  }
});

test('a changed record without a registration number triggers a possible-duplicate warning, not a silent first send', async () => {
  const dataDir = await makeTempDir();
  let { srv, smtp } = await server(dataDir);
  try {
    assert.equal((await send(srv, 5)).status, 200);
  } finally {
    await srv.close();
  }
  // Same attorney, firm name changed in the workbook -> different fallback ID.
  const changed = SAMPLE_ROWS.map((r, i) => (i === 4 ? [r[0], '', r[2], 'Renamed Firm LLP', '', '', ''] : r));
  ({ srv, smtp } = await server(dataDir, changed));
  try {
    const records = (await srv.request('GET', '/api/excel/records')).data.data.records.rows;
    assert.equal(records[2].sentCount, 0);
    assert.equal(records[2].possiblySent, true);

    const check = (await srv.request('POST', '/api/history/check', { json: { rowNumber: 5 } })).data.data;
    assert.equal(check.alreadySent, false);
    assert.equal(check.possibleDuplicate, true);
    assert.equal(check.possible[0].recipientEmail, 'three@example.com');

    const blocked = await send(srv, 5);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, 'POSSIBLE_DUPLICATE');
    assert.equal(smtp.state.sent.length, 0);

    const confirmed = await send(srv, 5, { confirmResend: true });
    assert.equal(confirmed.status, 200);
    assert.equal(smtp.state.sent.length, 1);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
test('records are returned 10 per page with workbook-wide search and a total count', async () => {
  const rows = [['Attorney Name', 'Registration Number', 'Email', 'City']];
  for (let i = 1; i <= 25; i += 1) rows.push([`Attorney ${String(i).padStart(2, '0')}`, i % 2 ? `R-${i}` : '', `a${i}@example.com`, i === 23 ? 'Gotham' : 'Metropolis']);
  const dataDir = await makeTempDir();
  const { srv } = await server(dataDir, rows);
  try {
    const get = async (qs) => (await srv.request('GET', `/api/excel/records${qs}`)).data.data;
    let d = await get('');
    assert.equal(d.totalRecords, 25);
    assert.deepEqual(d.records.rows.map((r) => r.recordNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual([d.records.page, d.records.pageCount, d.records.pageSize, d.records.matched, d.records.rows.length], [1, 3, 10, 25, 10]);
    d = await get('?page=3');
    assert.equal(d.records.rows.length, 5);
    assert.equal(d.records.rows[0].attorneyName, 'Attorney 21');
    assert.equal(d.records.rows[0].recordNumber, 21, 'record numbers count from 1, not from the Excel row');
    assert.equal(d.records.rows[0].rowNumber, 22);
    d = await get('?page=99');
    assert.equal(d.records.page, 3, 'out-of-range pages are clamped');

    // Search covers every row, not just the visible page.
    d = await get('?q=gotham');
    assert.equal(d.records.matched, 1);
    assert.equal(d.records.rows[0].attorneyName, 'Attorney 23');
    d = await get(`?q=${encodeURIComponent('a24@EXAMPLE')}`);
    assert.equal(d.records.rows[0].attorneyName, 'Attorney 24');
    d = await get('?q=R-1');
    assert.ok(d.records.matched >= 1 && d.records.rows.every((r) => r.registrationNumber.startsWith('R-1')));
    d = await get('?q=zzz');
    assert.equal(d.records.matched, 0);
    assert.equal(d.totalRecords, 25);

    // The upload response itself is paged too.
    const up = await srv.upload(makeWorkbookBuffer(rows));
    assert.equal(up.data.data.records.rows.length, 10);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
test('switching the sender mailbox needs only a configuration change', async () => {
  for (const mailbox of ['tester-one@zodiacpatent.example', 'tester-two@zodiacpatent.example']) {
    const dataDir = await makeTempDir();
    const config = testConfig({ SMTP_USER: mailbox, SMTP_FROM: mailbox, SMTP_PASS: `fake-pass-${mailbox}` });
    const { srv, smtp } = await server(dataDir, SAMPLE_ROWS, config);
    try {
      const status = (await srv.request('GET', '/api/smtp/status')).data.data;
      assert.equal(status.from, mailbox);
      assert.equal(status.user, mailbox);
      assert.ok(!JSON.stringify(status).includes('fake-pass'), 'password never reaches the frontend');

      const res = await send(srv, 2);
      assert.equal(res.status, 200);
      assert.equal(res.data.data.entry.senderEmail, mailbox);
      assert.equal(smtp.state.sent[0].from, mailbox);
      assert.equal(smtp.state.options[0].auth.user, mailbox);
      assert.equal((await historyRows(dataDir))[0]['Sender Email'], mailbox);
      assert.equal((await srv.request('GET', '/api/history')).data.data.sender, mailbox);
    } finally {
      await srv.close();
    }
  }
});

test('backend/.env values are read from the file and take precedence over Windows environment variables', async () => {
  const dir = await makeTempDir();
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, 'SMTP_HOST=smtp.hostinger.com\nSMTP_PORT=465\nSMTP_SECURE=true\nSMTP_USER=new-box@zodiacpatent.example\nSMTP_PASS=fake-app-password\nSMTP_FROM=new-box@zodiacpatent.example\n');
  const config = loadConfigFromEnvFile(envPath, { SMTP_USER: 'stale@zodiacpatent.example', SMTP_FROM: 'stale@zodiacpatent.example' });
  assert.equal(config.smtp.user, 'new-box@zodiacpatent.example');
  assert.equal(config.smtp.from, 'new-box@zodiacpatent.example');
  assert.equal(config.smtpConfigured, true);

  const missing = loadConfigFromEnvFile(path.join(dir, 'nope.env'), {});
  assert.equal(missing.smtpConfigured, false);
  assert.ok(missing.problems.some((p) => /SMTP_USER/.test(p)));

  // The shipped example contains no real mailbox and counts as "not configured".
  const example = loadConfigFromEnvFile(path.join(ROOT, 'backend', '.env.example'), {});
  assert.equal(example.smtp.user, '');
  assert.equal(example.smtpConfigured, false);
});

// ---------------------------------------------------------------------------
test('an older history workbook is upgraded in place without losing entries', async () => {
  const dir = await makeTempDir();
  const legacyHeader = ['Record ID', 'Attorney Name', 'Recipient Email', 'Subject', 'Sent At', 'Sender Email', 'Status', 'Send Type'];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([legacyHeader, ['REG-001', 'Old Attorney', 'old@example.com', 'Old subject', '2026-01-01 09:00:00', 'sender@example.com', 'Success', 'First Send']]), 'Sent Emails');
  await fs.writeFile(path.join(dir, 'sent-emails.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  const store = new HistoryStore(dir);
  const before = await store.readAll();
  assert.equal(before.length, 1);
  assert.equal(before[0].registrationNumber, 'REG-001', 'legacy Record ID doubles as the registration number');

  const saved = await store.append({ recordId: 'AUTO-ABCDEF0123456789', registrationNumber: '', attorneyName: 'New', recipientEmail: 'new@example.com', firmName: 'F', city: 'C', state: 'S', subject: 'New subject', sentAt: '2026-02-01 10:00:00', senderEmail: 'sender@example.com', status: 'Success', sendType: 'First Send' });
  assert.equal(saved.saved, true);
  const rows = await historyRows(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Attorney Name'], 'Old Attorney');
  assert.equal(rows[0].Subject, 'Old subject');
  assert.equal(rows[1]['Record ID'], 'AUTO-ABCDEF0123456789');
  assert.equal(rows[1]['Firm Name'], 'F');
  assert.equal(rows[1].Subject, 'New subject');
  assert.equal((await store.findByRecordId('reg-001')).length, 1);
});

// ---------------------------------------------------------------------------
test('no Sigvitas branding or hard-coded sender mailbox remains', async () => {
  const skip = new Set(['node_modules', 'dist', 'logs', 'data', '.git']);
  const exts = new Set(['.js', '.jsx', '.json', '.html', '.css', '.md', '.bat', '.ps1', '.example']);
  const offenders = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (exts.has(path.extname(ent.name)) || ent.name === '.env.example') {
        if (full.endsWith(`test${path.sep}identity.test.js`)) continue; // this file names the words it checks for
        const text = await fs.readFile(full, 'utf8');
        if (/sigvitas|zodiacpatet\b/i.test(text)) offenders.push(`${path.relative(ROOT, full)}: branding`);
        const isSource = /[\\/](src|scripts)[\\/]/.test(full) || full.endsWith('.env.example');
        if (isSource && /darshan@|vikram@/i.test(text)) offenders.push(`${path.relative(ROOT, full)}: hard-coded mailbox`);
      }
    }
  }
  await walk(ROOT);
  assert.deepEqual(offenders, []);
});
