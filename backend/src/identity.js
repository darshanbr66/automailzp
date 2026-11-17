import crypto from 'node:crypto';
import { normalizeId } from './utils.js';

/** Prefix of identifiers derived from other fields when there is no registration number. */
export const FALLBACK_PREFIX = 'AUTO-';

/** Lower-case, trim, collapse inner whitespace and strip accents so cosmetic edits don't change the ID. */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Work out the identifier used for duplicate detection for one workbook record.
 *
 * - With a registration number, the registration number itself is the identifier
 *   (unchanged from earlier versions, so existing history keeps matching).
 * - Without one, a deterministic identifier is derived from the normalized
 *   attorney name, recipient email, firm, city and state. The same record always
 *   produces the same identifier, including after a restart or a re-upload.
 *
 * `reliable` is false when the fallback has too little to go on (no name or no
 * email); the app then also looks for possible matches by email before sending.
 *
 * @param {Map<string,string>} values  result of getRecordValues()
 * @returns {{ recordId: string, idType: 'registration'|'fallback', reliable: boolean }}
 */
export function recordIdentity(values) {
  const registration = String(values.get('registrationNumber') ?? '').trim();
  if (registration) return { recordId: registration, idType: 'registration', reliable: true };

  const name = normalizeText(values.get('attorneyName'));
  const email = normalizeEmail(values.get('recipientEmail'));
  const parts = [name, email, ...['firmName', 'city', 'state'].map((k) => normalizeText(values.get(k)))];
  const hash = crypto.createHash('sha256').update(`v1|${parts.join('|')}`).digest('hex').slice(0, 16).toUpperCase();
  return { recordId: `${FALLBACK_PREFIX}${hash}`, idType: 'fallback', reliable: Boolean(name && email) };
}

export function isFallbackId(recordId) {
  return String(recordId ?? '').toUpperCase().startsWith(FALLBACK_PREFIX);
}

/** Statuses that mean the attorney may already have received the email. */
export function countsAsSent(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return s === 'success' || s === 'uncertain';
}

/**
 * Split history entries into exact matches (same identifier) and possible
 * matches. Possible matches are only looked for when the record has no
 * registration number: other sends to the same recipient email, or (when the
 * identifier is unreliable) to an attorney with the same name and no
 * registration number. Failed sends are ignored.
 */
export function matchHistory(entries, identity, values) {
  const id = normalizeId(identity.recordId);
  const exact = [];
  const possible = [];
  const email = normalizeEmail(values.get('recipientEmail'));
  const name = normalizeText(values.get('attorneyName'));
  for (const e of entries) {
    if (!countsAsSent(e.status)) continue;
    if (normalizeId(e.recordId) === id) {
      exact.push(e);
      continue;
    }
    if (identity.idType !== 'fallback') continue;
    const sameEmail = email && normalizeEmail(e.recipientEmail) === email;
    const sameName = !identity.reliable && name && !String(e.registrationNumber || '').trim() && normalizeText(e.attorneyName) === name;
    if (sameEmail || sameName) possible.push(e);
  }
  return { exact, possible };
}
