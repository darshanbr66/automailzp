import path from 'node:path';
import { AppError, isPlainObject, readJsonFile, writeJsonFile } from './utils.js';

export const TEMPLATE_FIELDS = ['subject', 'greeting', 'mainMessage', 'closing', 'signature'];
const LIMITS = { subject: 255, greeting: 1000, mainMessage: 20000, closing: 1000, signature: 2000 };

/** Starting template. Users edit and save their own from Template Settings. */
export const DEFAULT_TEMPLATE = Object.freeze({
  subject: 'Regarding Attorney Registration – {{registrationNumber}}',
  greeting: 'Dear {{attorneyName}},',
  mainMessage:
    'We are writing regarding your attorney registration number {{registrationNumber}}.\n\nPlease review the information and let us know if any changes are required.',
  closing: 'Best regards,',
  signature: 'ZodiacPatent Team',
});

/** Placeholders that may legitimately be empty without a warning. */
const OPTIONAL_PLACEHOLDERS = new Set(['registrationNumber']);

const SPACED_PLACEHOLDER_RE = /([ \t]?)\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Validate and normalize a template object received from the client. */
export function validateTemplate(input) {
  if (!isPlainObject(input)) throw new AppError(400, 'INVALID_TEMPLATE', 'The template is invalid.');
  const tpl = {};
  for (const field of TEMPLATE_FIELDS) {
    const value = input[field] ?? '';
    if (typeof value !== 'string') throw new AppError(400, 'INVALID_TEMPLATE', `Template field "${field}" must be text.`);
    if (value.length > LIMITS[field]) throw new AppError(400, 'INVALID_TEMPLATE', `Template field "${field}" is too long (maximum ${LIMITS[field]} characters).`);
    tpl[field] = value.replace(/\r\n/g, '\n');
  }
  tpl.subject = tpl.subject.replace(/\s*\n\s*/g, ' ').trim();
  if (!tpl.subject) throw new AppError(400, 'INVALID_TEMPLATE', 'The subject template cannot be empty.');
  if (!tpl.greeting.trim() && !tpl.mainMessage.trim()) {
    throw new AppError(400, 'INVALID_TEMPLATE', 'The email body cannot be empty. Enter a greeting or a main message.');
  }
  return tpl;
}

/** Join the template parts into the email body. */
export function composeBody(tpl) {
  const blocks = [];
  if (tpl.greeting?.trim()) blocks.push(tpl.greeting.trim());
  if (tpl.mainMessage?.trim()) blocks.push(tpl.mainMessage.trim());
  const signOff = [tpl.closing?.trim(), tpl.signature?.trim()].filter(Boolean).join('\n');
  if (signOff) blocks.push(signOff);
  return blocks.join('\n\n');
}

/**
 * Replace {{placeholders}} using a Map of values.
 * Unknown placeholders are left as-is so they are visible in the preview.
 */
export function renderString(text, values) {
  const empty = new Set();
  const unknown = new Set();
  const source = String(text ?? '');
  const output = source.replace(SPACED_PLACEHOLDER_RE, (match, space, key, offset) => {
    if (!values.has(key)) {
      unknown.add(key);
      return match;
    }
    const v = String(values.get(key) ?? '');
    if (!v) {
      empty.add(key);
      // "number {{registrationNumber}}." with no value becomes "number." rather than "number ."
      const next = source[offset + match.length] ?? '';
      return OPTIONAL_PLACEHOLDERS.has(key) && /^[.,;:!?)]$/.test(next) ? '' : space;
    }
    return space + v;
  });
  return { text: output, empty: [...empty], unknown: [...unknown] };
}

/**
 * Single line, collapsed spaces, and no separator left dangling at either end
 * by an empty placeholder (e.g. "Regarding Registration – " when there is no
 * registration number). Empty brackets such as "()" are removed too.
 */
export function tidySubject(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s\-–—:|,#]+|[\s\-–—:|,#]+$/g, '')
    .trim();
}

/** Render subject and body; returns user-facing warnings for empty/unknown placeholders. */
export function renderEmail(tpl, values) {
  const subject = renderString(tpl.subject, values);
  const body = renderString(composeBody(tpl), values);
  const empty = [...new Set([...subject.empty, ...body.empty])].filter((k) => !OPTIONAL_PLACEHOLDERS.has(k));
  const unknown = [...new Set([...subject.unknown, ...body.unknown])];
  const warnings = [];
  if (empty.length) warnings.push(`These placeholders have no value for this attorney: ${empty.map((k) => `{{${k}}}`).join(', ')}.`);
  if (unknown.length) warnings.push(`These placeholders are not recognised and were left unchanged: ${unknown.map((k) => `{{${k}}}`).join(', ')}.`);
  return { subject: tidySubject(subject.text), body: body.text, warnings };
}

export class TemplateStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'template.json');
  }

  /** Returns { template, warning? }. Falls back to the default if the file is missing or damaged. */
  async load() {
    let stored;
    try {
      stored = await readJsonFile(this.filePath);
    } catch {
      return { template: { ...DEFAULT_TEMPLATE }, warning: 'The saved template file was damaged, so the default template is shown. Save to replace it.' };
    }
    if (!stored) return { template: { ...DEFAULT_TEMPLATE } };
    try {
      return { template: validateTemplate(stored) };
    } catch {
      return { template: { ...DEFAULT_TEMPLATE }, warning: 'The saved template was invalid, so the default template is shown. Save to replace it.' };
    }
  }

  async save(input) {
    const tpl = validateTemplate(input);
    await writeJsonFile(this.filePath, tpl);
    return tpl;
  }
}
