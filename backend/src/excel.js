import * as XLSX from 'xlsx';
import path from 'node:path';
import { AppError, isPlainObject } from './utils.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 200;

/** Fields the user maps to Excel columns. `key` is also the placeholder name. */
export const MAPPING_FIELDS = [
  { key: 'attorneyName', label: 'Attorney Name', required: true, hints: ['attorney name', 'attorney', 'name', 'full name', 'advocate name'] },
  { key: 'registrationNumber', label: 'Registration Number', required: false, hints: ['registration number', 'registration no', 'reg no', 'registration', 'enrollment number', 'enrolment number', 'bar number', 'record id', 'unique id', 'id'] },
  { key: 'recipientEmail', label: 'Recipient Email', required: true, hints: ['email', 'email address', 'e-mail', 'recipient email', 'mail'] },
  { key: 'firmName', label: 'Firm Name', required: false, hints: ['firm name', 'firm', 'law firm', 'company', 'organization', 'organisation'] },
  { key: 'city', label: 'City', required: false, hints: ['city', 'town'] },
  { key: 'state', label: 'State', required: false, hints: ['state', 'province', 'region'] },
];
const FIELD_KEYS = new Set(MAPPING_FIELDS.map((f) => f.key));

/** Check extension and file signature before handing bytes to the parser. */
export function validateExcelFile(originalName, buffer) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    throw new AppError(400, 'INVALID_FILE_TYPE', 'Please upload an Excel workbook (.xlsx or .xls).');
  }
  if (!buffer || buffer.length === 0) throw new AppError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const isOle = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ((ext === '.xlsx' && !isZip) || (ext === '.xls' && !isOle && !isZip)) {
    throw new AppError(400, 'INVALID_EXCEL', 'This file is not a valid Excel workbook. Open it in Excel and save it again as .xlsx.');
  }
}

/** Turn a column heading into a placeholder key, e.g. "Firm Name" -> "firmName". */
export function headerToKey(header) {
  const words = String(header).normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  key = key.replace(/[^A-Za-z0-9_]/g, '');
  if (!key) return '';
  if (/^[0-9]/.test(key)) key = `col${key}`;
  return key;
}

/**
 * Parse the first worksheet. The first row holds the column headings.
 * Returns { sheetName, headers: [{ name, key }], rows: [{ rowNumber, cells: [] }] }.
 */
export function parseWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: false, cellHTML: false });
  } catch (err) {
    if (/password|encrypt/i.test(err?.message || '')) {
      throw new AppError(400, 'INVALID_EXCEL', 'This workbook is password-protected. Remove the password in Excel and upload it again.');
    }
    throw new AppError(400, 'INVALID_EXCEL', 'The Excel file could not be read. It may be damaged or not a real Excel workbook.');
  }

  const sheetName = workbook.SheetNames?.[0];
  const sheet = sheetName && workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) throw new AppError(400, 'EMPTY_WORKSHEET', 'The first worksheet in this workbook is empty.');

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
  if (!matrix.length) throw new AppError(400, 'EMPTY_WORKSHEET', 'The first worksheet in this workbook is empty.');

  const headerRow = matrix[0].map((v) => String(v ?? '').trim());
  // Trim trailing empty heading cells.
  while (headerRow.length && !headerRow[headerRow.length - 1]) headerRow.pop();
  if (!headerRow.some(Boolean)) {
    throw new AppError(400, 'MISSING_HEADERS', 'The first row of the worksheet must contain column headings (for example "Attorney Name", "Registration Number", "Email").');
  }
  if (headerRow.length > MAX_COLUMNS) throw new AppError(400, 'TOO_MANY_COLUMNS', `The worksheet has more than ${MAX_COLUMNS} columns.`);

  const seenNames = new Map();
  const seenKeys = new Set();
  const headers = headerRow.map((raw, i) => {
    let name = raw || `Column ${i + 1}`;
    const count = (seenNames.get(name.toLowerCase()) || 0) + 1;
    seenNames.set(name.toLowerCase(), count);
    if (count > 1) name = `${name} (${count})`;
    let key = headerToKey(name) || `column${i + 1}`;
    while (seenKeys.has(key)) key = `${key}_${i + 1}`;
    seenKeys.add(key);
    return { name, key };
  });

  const rows = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const cells = headers.map((_, c) => String(matrix[i][c] ?? '').trim());
    if (!cells.some(Boolean)) continue; // skip blank rows
    rows.push({ rowNumber: range.s.r + i + 1, cells });
    if (rows.length > MAX_ROWS) throw new AppError(400, 'TOO_MANY_ROWS', `The worksheet has more than ${MAX_ROWS} rows.`);
  }
  if (!rows.length) throw new AppError(400, 'NO_DATA_ROWS', 'The worksheet has headings but no attorney rows.');

  return { sheetName, headers, rows };
}

/** Suggest a mapping by matching common heading names. */
export function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const field of MAPPING_FIELDS) {
    let match = null;
    for (const hint of field.hints) {
      match = headers.find((h) => !used.has(h.name) && norm(h.name) === hint);
      if (match) break;
    }
    if (!match) {
      for (const hint of field.hints.filter((h) => h.length > 3)) {
        match = headers.find((h) => !used.has(h.name) && norm(h.name).includes(hint));
        if (match) break;
      }
    }
    mapping[field.key] = match ? match.name : '';
    if (match) used.add(match.name);
  }
  return mapping;
}

/** Keep only known field keys whose value is a string. */
export function sanitizeMapping(input) {
  if (!isPlainObject(input)) throw new AppError(400, 'INVALID_MAPPING', 'The column mapping is invalid.');
  const mapping = {};
  for (const field of MAPPING_FIELDS) {
    const v = input[field.key];
    if (v !== undefined && v !== null && typeof v !== 'string') throw new AppError(400, 'INVALID_MAPPING', `Invalid column for ${field.label}.`);
    mapping[field.key] = (v || '').slice(0, 300);
  }
  return mapping;
}

/** Returns a list of human-readable problems ([] when valid). */
export function validateMapping(mapping, headers) {
  const errors = [];
  const names = new Set(headers.map((h) => h.name));
  for (const field of MAPPING_FIELDS) {
    const col = mapping?.[field.key];
    if (!col) {
      if (field.required) errors.push(`Please choose the column for "${field.label}".`);
    } else if (!names.has(col)) {
      errors.push(`The column "${col}" selected for "${field.label}" is not in this workbook.`);
    }
  }
  const identifying = ['attorneyName', 'registrationNumber', 'recipientEmail'].map((k) => mapping?.[k]).filter(Boolean);
  if (new Set(identifying).size !== identifying.length) errors.push('Attorney Name, Registration Number and Recipient Email must each use a different column.');
  return errors;
}

/** If a saved mapping fits this workbook use it, otherwise fill gaps with guesses. */
export function resolveMapping(saved, headers) {
  const guessed = guessMapping(headers);
  if (!saved) return guessed;
  const names = new Set(headers.map((h) => h.name));
  const result = {};
  for (const field of MAPPING_FIELDS) {
    result[field.key] = saved[field.key] && names.has(saved[field.key]) ? saved[field.key] : guessed[field.key];
  }
  return result;
}

/** Placeholders shown by default in Template Settings, in this order. */
export const COMMON_PLACEHOLDERS = ['attorneyName', 'firstName', 'lastName', 'recipientEmail', 'firmName', 'registrationNumber', 'city', 'state'];
const NAME_PARTS = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
];
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'adv', 'advocate', 'shri', 'smt', 'sri', 'prof', 'er']);

/**
 * Split an attorney name into first and last name, ignoring titles such as
 * "Mr." or "Adv." and anything after a comma (e.g. ", Esq."). A single-word
 * name is the first name only.
 */
export function splitName(fullName) {
  const words = String(fullName ?? '').split(',')[0].trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0].toLowerCase().replace(/\.$/, ''))) words.shift();
  if (!words.length) return { firstName: '', lastName: '' };
  return { firstName: words[0], lastName: words.length > 1 ? words[words.length - 1] : '' };
}

/**
 * Build the placeholder values for one row: every column by its key, then the
 * mapped standard fields (which take precedence). {{firstName}} and
 * {{lastName}} come from "First Name"/"Last Name" columns when the workbook has
 * them, otherwise from the attorney name.
 */
export function getRecordValues(row, headers, mapping) {
  const values = new Map();
  headers.forEach((h, i) => {
    if (!FIELD_KEYS.has(h.key)) values.set(h.key, row.cells[i] ?? '');
  });
  for (const field of MAPPING_FIELDS) {
    const idx = mapping?.[field.key] ? headers.findIndex((h) => h.name === mapping[field.key]) : -1;
    values.set(field.key, idx >= 0 ? row.cells[idx] ?? '' : '');
  }
  const parts = splitName(values.get('attorneyName'));
  for (const { key } of NAME_PARTS) {
    if (!String(values.get(key) ?? '').trim()) values.set(key, parts[key]);
  }
  return values;
}

/**
 * All placeholders available for templates, given the current workbook (if any).
 * The common ones come first, flagged `common: true`; the rest are the other
 * Excel columns.
 */
export function listPlaceholders(headers = []) {
  const byKey = new Map();
  for (const f of MAPPING_FIELDS) byKey.set(f.key, { key: f.key, label: f.label, source: 'mapped' });
  for (const h of headers) {
    if (!FIELD_KEYS.has(h.key)) byKey.set(h.key, { key: h.key, label: h.name, source: 'column' });
  }
  for (const p of NAME_PARTS) {
    if (!byKey.has(p.key)) byKey.set(p.key, { ...p, source: 'derived' });
  }
  const common = COMMON_PLACEHOLDERS.map((k) => ({ ...byKey.get(k), common: true }));
  const rest = [...byKey.values()].filter((p) => !COMMON_PLACEHOLDERS.includes(p.key)).map((p) => ({ ...p, common: false }));
  return [...common, ...rest];
}
