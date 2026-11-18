import path from 'node:path';
import * as XLSX from 'xlsx';
import { isFallbackId } from './identity.js';
import { AppError, Mutex, atomicWriteFile, normalizeId, readFileIfExists, readJsonFile, writeJsonFile } from './utils.js';

export const HISTORY_COLUMNS = [
  'Record ID', 'Registration Number', 'Attorney Name', 'Recipient Email', 'Firm Name', 'City', 'State',
  'Subject', 'Sent At', 'Sender Email', 'Status', 'Send Type', 'Sent At UTC', 'Send Method', 'Operator',
];
/** Columns every history workbook must have (the original layout). Newer columns are added automatically. */
const CORE_COLUMNS = ['Record ID', 'Attorney Name', 'Recipient Email', 'Subject', 'Sent At', 'Sender Email', 'Status', 'Send Type'];
const COLUMN_WIDTHS = [22, 20, 28, 32, 28, 16, 14, 50, 20, 32, 11, 12, 24, 12, 18];
const FIELD_BY_COLUMN = {
  'Record ID': 'recordId',
  'Registration Number': 'registrationNumber',
  'Attorney Name': 'attorneyName',
  'Recipient Email': 'recipientEmail',
  'Firm Name': 'firmName',
  City: 'city',
  State: 'state',
  Subject: 'subject',
  'Sent At': 'sentAt',
  'Sender Email': 'senderEmail',
  Status: 'status',
  'Send Type': 'sendType',
  'Sent At UTC': 'sentAtUtc',
  'Send Method': 'sendMethod',
  Operator: 'operator',
};
const SHEET_NAME = 'Sent Emails';

const CORRUPT_MESSAGE =
  'The sending history workbook (backend/data/sent-emails.xlsx) is damaged or has unexpected columns. ' +
  'Sending is paused so duplicates cannot slip through. Restore a backup of the file, or rename it so a new one is created.';

/** Lay out an entry according to the workbook's own header order. */
const toRow = (entry, header) => header.map((col) => (FIELD_BY_COLUMN[col] ? String(entry[FIELD_BY_COLUMN[col]] ?? '') : ''));

/**
 * Send attempts (Success, Failed or Uncertain) are recorded in an Excel workbook. All writes go through one
 * mutex so concurrent requests never interleave. Each write replaces the file
 * atomically. If the workbook cannot be written (for example it is open in
 * Excel, which locks it), the entry is kept in a small pending JSON file, still
 * counts for duplicate detection, and is written to Excel on the next attempt.
 */
export class HistoryStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'sent-emails.xlsx');
    this.pendingPath = path.join(dataDir, 'sent-emails-pending.json');
    this.mutex = new Mutex();
  }

  async #readWorkbookEntries() {
    let buffer;
    try {
      buffer = await readFileIfExists(this.filePath);
    } catch (err) {
      throw new AppError(500, 'HISTORY_UNREADABLE', `The sending history workbook (backend/data/sent-emails.xlsx) could not be opened (${err.code || 'read error'}). If it is open in another program, close it and try again.`);
    }
    if (buffer === null) return []; // missing workbook: no history yet
    let rows;
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const ws = wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('no sheet');
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    } catch {
      throw new AppError(500, 'HISTORY_CORRUPT', CORRUPT_MESSAGE);
    }
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h).trim());
    const index = {};
    for (const col of HISTORY_COLUMNS) index[col] = header.indexOf(col);
    if (CORE_COLUMNS.some((col) => index[col] < 0)) throw new AppError(500, 'HISTORY_CORRUPT', CORRUPT_MESSAGE);
    const hasRegistrationColumn = index['Registration Number'] >= 0;
    const entries = [];
    for (const row of rows.slice(1)) {
      if (!row.some((c) => String(c).trim())) continue;
      const entry = {};
      for (const col of HISTORY_COLUMNS) entry[FIELD_BY_COLUMN[col]] = index[col] >= 0 ? String(row[index[col]] ?? '').trim() : '';
      // Rows written before the Registration Number column existed used it as the Record ID.
      if (!hasRegistrationColumn && !isFallbackId(entry.recordId)) entry.registrationNumber = entry.recordId;
      entries.push(entry);
    }
    return entries;
  }

  async #readPending() {
    try {
      const data = await readJsonFile(this.pendingPath);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Write the given entries (appended to the existing ones) to the workbook. */
  async #appendToWorkbook(entries) {
    const buffer = await readFileIfExists(this.filePath);
    let wb;
    let ws;
    if (buffer === null) {
      wb = XLSX.utils.book_new();
      ws = XLSX.utils.aoa_to_sheet([HISTORY_COLUMNS]);
      ws['!cols'] = COLUMN_WIDTHS.map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    } else {
      await this.#readWorkbookEntries(); // validates structure, throws HISTORY_CORRUPT
      wb = XLSX.read(buffer, { type: 'buffer' });
      ws = wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
    }
    // Older workbooks: add any missing newer columns at the end of the header row.
    // Existing rows are left untouched.
    const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })[0] || [];
    const header = firstRow.map((h) => String(h).trim());
    while (header.length && !header[header.length - 1]) header.pop();
    const missing = HISTORY_COLUMNS.filter((col) => !header.includes(col));
    if (missing.length) {
      XLSX.utils.sheet_add_aoa(ws, [missing], { origin: { r: 0, c: header.length } });
      header.push(...missing);
    }
    // Store every value as text so nothing is interpreted as a formula.
    XLSX.utils.sheet_add_aoa(ws, entries.map((e) => toRow(e, header)), { origin: -1, cellDates: false });
    const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await atomicWriteFile(this.filePath, out);
  }

  /** All entries, newest first. Pending entries are included and flagged. */
  async readAll() {
    return this.mutex.run(async () => {
      await this.#flushPendingUnlocked();
      const saved = await this.#readWorkbookEntries();
      const pending = (await this.#readPending()).map((e) => ({ ...e, pendingSave: true }));
      return [...saved, ...pending].reverse();
    });
  }

  /** All entries in the order they were written (pending ones last). */
  async entriesInOrder() {
    return this.mutex.run(async () => [...(await this.#readWorkbookEntries()), ...(await this.#readPending())]);
  }

  /** Entries for one identifier, newest first. Includes Failed entries; callers filter with countsAsSent(). */
  async findByRecordId(recordId) {
    const id = normalizeId(recordId);
    if (!id) return [];
    const all = await this.mutex.run(async () => [...(await this.#readWorkbookEntries()), ...(await this.#readPending())]);
    return all.filter((e) => normalizeId(e.recordId) === id).reverse();
  }

  async #flushPendingUnlocked() {
    const pending = await this.#readPending();
    if (!pending.length) return;
    try {
      await this.#appendToWorkbook(pending);
      await writeJsonFile(this.pendingPath, []);
    } catch {
      // Still locked or damaged; keep pending entries for later.
    }
  }

  /**
   * Record a send attempt. Never throws for write failures: returns
   * { saved: true } or { saved: false, warning } so the caller can report that
   * the email was accepted even though history could not be written.
   */
  async append(entry) {
    return this.mutex.run(async () => {
      const pending = await this.#readPending();
      try {
        await this.#appendToWorkbook([...pending, entry]);
        if (pending.length) await writeJsonFile(this.pendingPath, []);
        return { saved: true };
      } catch (err) {
        const locked = ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code);
        let keptPending = false;
        try {
          await writeJsonFile(this.pendingPath, [...pending, entry]);
          keptPending = true;
        } catch {
          /* nothing more we can do */
        }
        console.error(`[history] Could not write sent-emails.xlsx: ${err?.code || err?.message}`);
        const reason = locked
          ? 'sent-emails.xlsx is open in another program (such as Excel). Close it'
          : err?.code === 'HISTORY_CORRUPT'
            ? 'sent-emails.xlsx is damaged. Restore or rename it'
            : 'the history file could not be written. Check the backend/data folder';
        return {
          saved: false,
          keptPending,
          warning: keptPending
            ? `The email was accepted by the mail server, but the history workbook could not be updated because ${reason}. The record was kept temporarily and will be added to the workbook automatically next time.`
            : `The email was accepted by the mail server, but the sending history could NOT be saved because ${reason}. Please note this send manually.`,
        };
      }
    });
  }
}

/**
 * Build an Excel export of history entries (both storage modes). Values are
 * written as text so nothing is interpreted as a formula.
 */
export function buildHistoryWorkbookBuffer(entries) {
  const extra = ['Voided', 'Void Reason', 'Voided By', 'Voided At UTC'];
  const header = [...HISTORY_COLUMNS, ...extra];
  const rows = entries.map((e) => [
    ...HISTORY_COLUMNS.map((col) => String(e[FIELD_BY_COLUMN[col]] ?? '')),
    e.voided ? 'Yes' : '',
    String(e.void?.reason ?? ''),
    String(e.void?.operator ?? ''),
    String(e.void?.atUtc ?? ''),
  ]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [...COLUMN_WIDTHS, 8, 30, 18, 24].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
