import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TEMPLATE, TemplateStore, composeBody, renderEmail, renderString, tidySubject, validateTemplate } from '../src/template.js';
import { makeTempDir } from './helpers.js';

const values = new Map([
  ['attorneyName', 'Test Attorney One'],
  ['registrationNumber', 'REG-001'],
  ['firmName', ''],
]);

test('replaces placeholders, tolerating spaces inside braces', () => {
  const r = renderString('Hi {{attorneyName}} / {{ registrationNumber }}', values);
  assert.equal(r.text, 'Hi Test Attorney One / REG-001');
  assert.deepEqual(r.empty, []);
  assert.deepEqual(r.unknown, []);
});

test('reports empty and unknown placeholders', () => {
  const r = renderString('{{firmName}} {{nope}}', values);
  assert.equal(r.text, ' {{nope}}');
  assert.deepEqual(r.empty, ['firmName']);
  assert.deepEqual(r.unknown, ['nope']);
});

test('does not resolve prototype properties as placeholders', () => {
  const r = renderString('{{constructor}} {{toString}}', values);
  assert.equal(r.text, '{{constructor}} {{toString}}');
});

test('renders the default template into subject and body', () => {
  const email = renderEmail(DEFAULT_TEMPLATE, values);
  assert.equal(email.subject, 'Regarding Attorney Registration – REG-001');
  assert.equal(
    email.body,
    'Dear Test Attorney One,\n\nWe are writing regarding your attorney registration number REG-001.\n\nPlease review the information and let us know if any changes are required.\n\nBest regards,\nZodiacPatent Team',
  );
  assert.deepEqual(email.warnings, []);
});

test('a missing registration number renders as empty without a warning or dangling separator', () => {
  const noReg = new Map([...values, ['registrationNumber', '']]);
  const email = renderEmail(DEFAULT_TEMPLATE, noReg);
  assert.equal(email.subject, 'Regarding Attorney Registration');
  assert.match(email.body, /registration number\.\n/);
  assert.ok(!email.body.includes('{{registrationNumber}}'));
  assert.deepEqual(email.warnings, []);
  // Other empty placeholders still warn, and keep their spacing.
  const other = renderEmail({ ...DEFAULT_TEMPLATE, mainMessage: 'Firm: {{firmName}}.' }, noReg);
  assert.match(other.body, /Firm: \./);
  assert.equal(other.warnings.length, 1);
  assert.match(other.warnings[0], /firmName/);
});

test('subject tidying removes separators and brackets left by empty placeholders', () => {
  assert.equal(tidySubject('Re: Registration ( ) – '), 'Re: Registration');
  assert.equal(tidySubject(' – ZodiacPatent'), 'ZodiacPatent');
  assert.equal(tidySubject('Plain subject'), 'Plain subject');
});

test('default signature uses the ZodiacPatent brand', () => {
  assert.equal(DEFAULT_TEMPLATE.signature, 'ZodiacPatent Team');
});

test('composeBody skips empty parts', () => {
  assert.equal(composeBody({ greeting: 'Hi,', mainMessage: 'Text', closing: '', signature: 'Team' }), 'Hi,\n\nText\n\nTeam');
});

test('validateTemplate rejects bad input', () => {
  assert.throws(() => validateTemplate(null), { code: 'INVALID_TEMPLATE' });
  assert.throws(() => validateTemplate({ ...DEFAULT_TEMPLATE, subject: '  ' }), { code: 'INVALID_TEMPLATE' });
  assert.throws(() => validateTemplate({ ...DEFAULT_TEMPLATE, greeting: '', mainMessage: '' }), { code: 'INVALID_TEMPLATE' });
  assert.throws(() => validateTemplate({ ...DEFAULT_TEMPLATE, signature: 42 }), { code: 'INVALID_TEMPLATE' });
  assert.equal(validateTemplate({ ...DEFAULT_TEMPLATE, subject: 'a\nb' }).subject, 'a b');
});

test('saves and loads the template from a JSON file', async () => {
  const dir = await makeTempDir();
  const store = new TemplateStore(dir);
  assert.deepEqual((await store.load()).template, DEFAULT_TEMPLATE);
  const custom = { subject: 'Hello {{city}}', greeting: 'Hi {{attorneyName}},', mainMessage: 'Body', closing: 'Thanks,', signature: 'Me' };
  await store.save(custom);
  assert.deepEqual((await store.load()).template, custom);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'template.json'), 'utf8')), custom);
});

test('a damaged template file falls back to the default with a warning', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'template.json'), '{ not json');
  const { template, warning } = await new TemplateStore(dir).load();
  assert.deepEqual(template, DEFAULT_TEMPLATE);
  assert.match(warning, /damaged/);
});
