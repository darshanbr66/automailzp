import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_PLACEHOLDERS, getRecordValues, guessMapping, headerToKey, listPlaceholders, parseWorkbook, resolveMapping, splitName, validateExcelFile, validateMapping,
} from '../src/excel.js';
import { SAMPLE_ROWS, makeWorkbookBuffer } from './helpers.js';

test('parses the first worksheet, skips blank rows and keeps Excel row numbers', () => {
  const parsed = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  assert.equal(parsed.sheetName, 'Attorneys');
  assert.deepEqual(parsed.headers.map((h) => h.name), SAMPLE_ROWS[0]);
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(parsed.rows.map((r) => r.rowNumber), [2, 3, 5, 6]);
  assert.equal(parsed.rows[1].cells[3], ''); // empty cell handled
});

test('reads legacy .xls workbooks too', () => {
  const buf = makeWorkbookBuffer(SAMPLE_ROWS, 'biff8');
  validateExcelFile('attorneys.xls', buf);
  assert.equal(parseWorkbook(buf).rows.length, 4);
});

test('rejects wrong file types, fake Excel files and empty worksheets', () => {
  assert.throws(() => validateExcelFile('notes.csv', Buffer.from('a,b')), { code: 'INVALID_FILE_TYPE' });
  assert.throws(() => validateExcelFile('fake.xlsx', Buffer.from('not really excel')), { code: 'INVALID_EXCEL' });
  assert.throws(() => validateExcelFile('empty.xlsx', Buffer.alloc(0)), { code: 'EMPTY_FILE' });
  assert.throws(() => parseWorkbook(Buffer.from('PK\x03\x04garbage')), { code: 'INVALID_EXCEL' });
  assert.throws(() => parseWorkbook(makeWorkbookBuffer([])), { code: 'EMPTY_WORKSHEET' });
  assert.throws(() => parseWorkbook(makeWorkbookBuffer([['Name', 'Email']])), { code: 'NO_DATA_ROWS' });
});

test('handles duplicate and blank headings', () => {
  const parsed = parseWorkbook(makeWorkbookBuffer([['Name', 'Name', '', 'Email'], ['a', 'b', 'c', 'd']]));
  assert.deepEqual(parsed.headers.map((h) => h.name), ['Name', 'Name (2)', 'Column 3', 'Email']);
  assert.equal(new Set(parsed.headers.map((h) => h.key)).size, 4);
});

test('headerToKey makes camelCase placeholder keys', () => {
  assert.equal(headerToKey('Firm Name'), 'firmName');
  assert.equal(headerToKey('  practice-area '), 'practiceArea');
  assert.equal(headerToKey('2024 Fee'), 'col2024Fee');
  assert.equal(headerToKey('__proto__'), 'proto');
});

test('guesses a column mapping and validates required fields', () => {
  const { headers } = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  const mapping = guessMapping(headers);
  assert.deepEqual(mapping, {
    attorneyName: 'Full Name', registrationNumber: 'Reg No', recipientEmail: 'E-mail', firmName: 'Firm', city: 'City', state: 'State',
  });
  assert.deepEqual(validateMapping(mapping, headers), []);
  // Registration number is optional.
  assert.deepEqual(validateMapping({ ...mapping, registrationNumber: '' }, headers), []);
  const errors = validateMapping({ ...mapping, attorneyName: '' }, headers);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Attorney Name/);
  assert.match(validateMapping({ ...mapping, registrationNumber: 'E-mail' }, headers).join(' '), /different column/);
  assert.match(validateMapping({ ...mapping, recipientEmail: 'Missing Column' }, headers)[0], /not in this workbook/);
  assert.match(validateMapping({ ...mapping, recipientEmail: 'Full Name' }, headers).join(' '), /different column/);
});

test('saved mapping is reused when its columns exist', () => {
  const { headers } = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  const resolved = resolveMapping({ attorneyName: 'Firm', registrationNumber: 'Reg No', recipientEmail: 'Gone' }, headers);
  assert.equal(resolved.attorneyName, 'Firm');
  assert.equal(resolved.recipientEmail, 'E-mail'); // fell back to the guess
});

test('record values expose mapped fields and every other column', () => {
  const { headers, rows } = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  const values = getRecordValues(rows[0], headers, guessMapping(headers));
  assert.equal(values.get('attorneyName'), 'Test Attorney One');
  assert.equal(values.get('registrationNumber'), 'REG-001');
  assert.equal(values.get('recipientEmail'), 'one@example.com');
  assert.equal(values.get('firmName'), 'Example Law LLP');
  assert.equal(values.get('practiceArea'), 'Patents');
  assert.equal(values.get('fullName'), 'Test Attorney One');
});

test('firstName/lastName come from the attorney name, or from First/Last Name columns when present', () => {
  assert.deepEqual(splitName('Test Attorney One'), { firstName: 'Test', lastName: 'One' });
  assert.deepEqual(splitName('Adv. Priya Sharma, Esq.'), { firstName: 'Priya', lastName: 'Sharma' });
  assert.deepEqual(splitName('Madonna'), { firstName: 'Madonna', lastName: '' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });

  const { headers, rows } = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  const values = getRecordValues(rows[0], headers, guessMapping(headers));
  assert.equal(values.get('firstName'), 'Test');
  assert.equal(values.get('lastName'), 'One');

  const own = parseWorkbook(makeWorkbookBuffer([['Name', 'First Name', 'Last Name', 'Email'], ['Dr. A B C', 'Alpha', 'Charlie', 'a@example.com']]));
  const v2 = getRecordValues(own.rows[0], own.headers, guessMapping(own.headers));
  assert.equal(v2.get('firstName'), 'Alpha');
  assert.equal(v2.get('lastName'), 'Charlie');
});

test('the 8 common placeholders come first; every other column is still available', () => {
  const { headers } = parseWorkbook(makeWorkbookBuffer(SAMPLE_ROWS));
  const list = listPlaceholders(headers);
  assert.deepEqual(list.filter((p) => p.common).map((p) => p.key), COMMON_PLACEHOLDERS);
  assert.deepEqual(COMMON_PLACEHOLDERS, ['attorneyName', 'firstName', 'lastName', 'recipientEmail', 'firmName', 'registrationNumber', 'city', 'state']);
  const others = list.filter((p) => !p.common).map((p) => p.key);
  assert.ok(others.includes('practiceArea'));
  assert.ok(others.includes('fullName'));
  assert.equal(new Set(list.map((p) => p.key)).size, list.length, 'no duplicates');
  // Without a workbook only the common ones exist.
  assert.deepEqual(listPlaceholders().map((p) => p.key), COMMON_PLACEHOLDERS);
});
