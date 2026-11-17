import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { HISTORY_COLUMNS, HistoryStore } from '../src/history.js';
import { makeTempDir } from './helpers.js';

const entry = (over = {}) => ({
  recordId: 'REG-001', attorneyName: 'Test Attorney One', recipientEmail: 'one@example.com', subject: 'Hello',
  sentAt: '2026-01-01 10:00:00', senderEmail: 'sender@example.com', status: 'Success', sendType: 'First Send', ...over,
});

test('missing history workbook means no history', async () => {
  const store = new HistoryStore(await makeTempDir());
  assert.deepEqual(await store.readAll(), []);
  assert.deepEqual(await store.findByRecordId('REG-001'), []);
});

test('appends rows with the required columns and finds them case-insensitively', async () => {
  const dir = await makeTempDir();
  const store = new HistoryStore(dir);
  assert.deepEqual(await store.append(entry()), { saved: true });
  assert.deepEqual(await store.append(entry({ sendType: 'Resend', sentAt: '2026-01-02 10:00:00' })), { saved: true });
  await store.append(entry({ recordId: 'REG-002' }));

  const wb = XLSX.read(await fs.readFile(path.join(dir, 'sent-emails.xlsx')));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sent Emails'], { header: 1 });
  assert.deepEqual(rows[0], HISTORY_COLUMNS);
  assert.equal(rows.length, 4);

  const found = await store.findByRecordId('  reg-001 ');
  assert.equal(found.length, 2);
  assert.equal(found[0].sendType, 'Resend'); // newest first
});

test('formula-like values are stored as plain text', async () => {
  const dir = await makeTempDir();
  const store = new HistoryStore(dir);
  await store.append(entry({ subject: '=HYPERLINK("http://bad")' }));
  const wb = XLSX.read(await fs.readFile(path.join(dir, 'sent-emails.xlsx')));
  const cell = wb.Sheets['Sent Emails'].H2; // Subject column
  assert.equal(cell.t, 's');
  assert.equal(cell.f, undefined);
});

test('concurrent appends are serialized and none are lost', async () => {
  const store = new HistoryStore(await makeTempDir());
  await Promise.all(Array.from({ length: 15 }, (_, i) => store.append(entry({ recordId: `REG-${i}` }))));
  assert.equal((await store.readAll()).length, 15);
});

test('a corrupted history workbook is reported, not silently overwritten', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'sent-emails.xlsx');
  await fs.writeFile(file, 'this is not a workbook');
  const store = new HistoryStore(dir);
  await assert.rejects(store.findByRecordId('REG-001'), { code: 'HISTORY_CORRUPT' });
  const result = await store.append(entry());
  assert.equal(result.saved, false);
  assert.match(result.warning, /accepted by the mail server/);
  assert.equal(await fs.readFile(file, 'utf8'), 'this is not a workbook');
});

test('unexpected columns are treated as corruption', async () => {
  const dir = await makeTempDir();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Something', 'Else']]), 'Sent Emails');
  await fs.writeFile(path.join(dir, 'sent-emails.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(new HistoryStore(dir).readAll(), { code: 'HISTORY_CORRUPT' });
});

test('if the workbook cannot be written the entry is kept pending and flushed later', { skip: process.platform !== 'win32' && 'read-only file lock simulation is Windows-specific' }, async () => {
  const dir = await makeTempDir();
  const store = new HistoryStore(dir);
  const file = path.join(dir, 'sent-emails.xlsx');
  await store.append(entry({ recordId: 'REG-000' }));
  // Simulate Excel holding the file: a read-only target cannot be replaced (EPERM).
  await fs.chmod(file, 0o444);
  const result = await store.append(entry());
  assert.equal(result.saved, false);
  assert.equal(result.keptPending, true);
  assert.match(result.warning, /open in another program/);
  // Still counts for duplicate detection.
  assert.equal((await store.findByRecordId('REG-001')).length, 1);

  await fs.chmod(file, 0o666);
  const all = await store.readAll(); // flushes pending into the workbook
  assert.equal(all.length, 2);
  assert.equal(all[0].pendingSave, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'sent-emails-pending.json'), 'utf8')), []);
});
