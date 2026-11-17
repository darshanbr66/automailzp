// Email sending through the Resend HTTPS API (https://resend.com), used where
// outbound SMTP ports are blocked (e.g. Render Free). Same interface as
// SmtpMailer: publicInfo(), verify(), send(). Errors use the same codes as the
// SMTP mailer so the rest of the app (history statuses, duplicate handling,
// UI messages) behaves identically for both providers.
//
// The API key stays inside this object: it is never returned, logged or put in
// an error message.
import { AppError } from './utils.js';

export const RESEND_API_BASE = 'https://api.resend.com';
const MAX_IDEMPOTENCY_KEY = 256;

// Network failures that happen before the request can reach Resend: the email
// was certainly not sent.
const NOT_SENT_NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function networkCode(err) {
  return String(err?.cause?.code || err?.code || (err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'TIMEOUT' : '') || 'NETWORK');
}

export class ResendMailer {
  /**
   * @param {{ apiKey: string, from: string }} settings
   * @param {{ fetch?: Function, baseUrl?: string, timeoutMs?: number }} [options]  fetch is replaced in tests
   */
  constructor({ apiKey, from }, { fetch: fetchImpl = globalThis.fetch, baseUrl = RESEND_API_BASE, timeoutMs = 30000 } = {}) {
    // Private fields: not enumerable, so JSON.stringify/console.log never show the key.
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.from = from;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  #apiKey;
  #fetch;

  /** Settings that are safe to show in the UI (no API key). */
  publicInfo() {
    return { provider: 'resend', host: 'api.resend.com', port: 443, secure: true, user: null, from: this.from };
  }

  get #fromDomain() {
    return String(this.from).split('@').pop().trim().toLowerCase();
  }

  /** Remove anything that could echo the key, and keep server text short. */
  #safe(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (this.#apiKey) t = t.split(this.#apiKey).join('[hidden]');
    return t;
  }

  async #request(method, path, { body, headers = {}, timeoutMs = this.timeoutMs } = {}) {
    const res = await this.#fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': 'zodiacpatent-email-automation',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  }

  #authError(notSent) {
    return new AppError(
      401,
      'SMTP_AUTH_FAILED',
      `Resend rejected the API key.${notSent} Check that RESEND_API_KEY on the server is a current Resend API key (it starts with "re_") that has not been deleted or suspended, then restart the service.`,
    );
  }

  /**
   * Check the API key and that the sender's domain is verified in Resend, without
   * sending anything. Returns { ok: true, message }.
   */
  async verify() {
    let r;
    try {
      r = await this.#request('GET', '/domains', { timeoutMs: 15000 });
    } catch (err) {
      console.warn(`[email] Resend connection test failed (${networkCode(err)})`);
      throw new AppError(503, 'SMTP_CONNECTION_FAILED', 'Could not reach the Resend API (api.resend.com). Check the server\'s internet connection and try again.');
    }
    const name = r.data?.name;
    if (r.status === 401 && name === 'restricted_api_key') {
      // A "sending access" key is valid but may not list domains.
      return {
        ok: true,
        message: `The Resend API key is valid (sending-only key). The domain status of ${this.#fromDomain} can't be checked with this key; check that it shows "Verified" in the Resend dashboard.`,
      };
    }
    if ([400, 401, 403].includes(r.status)) {
      console.warn(`[email] Resend connection test: key rejected (${r.status} ${name || ''})`);
      throw this.#authError('');
    }
    if (r.status === 429) throw new AppError(503, 'SMTP_TEMPORARY', 'Resend is limiting requests right now. Please wait a moment and try again.');
    if (r.status < 200 || r.status >= 300 || !Array.isArray(r.data?.data)) {
      console.warn(`[email] Resend connection test: unexpected response (${r.status})`);
      throw new AppError(502, 'SMTP_ERROR', `Resend returned an unexpected response (HTTP ${r.status}). Try again later.`);
    }
    const domain = r.data.data.find((d) => String(d?.name || '').toLowerCase() === this.#fromDomain);
    if (!domain) {
      throw new AppError(400, 'SENDER_REJECTED', `The domain ${this.#fromDomain} has not been added in Resend. Add it under Domains in the Resend dashboard and add the DNS records it shows, so emails can be sent from ${this.from}.`);
    }
    if (domain.status !== 'verified') {
      throw new AppError(
        400,
        'SENDER_REJECTED',
        `The domain ${this.#fromDomain} is not verified in Resend yet (status: ${this.#safe(domain.status) || 'unknown'}). Check that its DNS records are in place, then click Verify in the Resend dashboard.`,
      );
    }
    return { ok: true, message: `Connected to Resend. The API key is valid and ${this.#fromDomain} is verified for sending as ${this.from}.` };
  }

  /**
   * Send one plain-text email. Resolves only when Resend has accepted it (HTTP
   * 2xx with an email id). That is acceptance, not proof of delivery.
   * @param {{ to: string, subject: string, body: string, idempotencyKey?: string }} message
   */
  async send({ to, subject, body, idempotencyKey }) {
    const headers = {};
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, MAX_IDEMPOTENCY_KEY);
    const notSent = ' The email was not sent.';

    let r;
    try {
      r = await this.#request('POST', '/emails', {
        headers,
        body: { from: this.from, to: [to.trim()], subject: subject.trim(), text: body },
      });
    } catch (err) {
      const code = networkCode(err);
      console.warn(`[email] Resend send failed (${code})`);
      if (NOT_SENT_NETWORK.has(code)) {
        throw new AppError(503, 'SMTP_CONNECTION_FAILED', `Could not reach the Resend API (api.resend.com).${notSent} Check the server's internet connection and try again.`);
      }
      // Timed out or the connection dropped after the request may have reached Resend.
      throw new AppError(
        503,
        'SMTP_UNCERTAIN',
        'The connection to Resend was interrupted while sending. The email may or may not have been sent; check the Resend dashboard (Emails) before trying again. It is recorded as "Uncertain" in the sending history, and counts as possibly sent for duplicate checks.',
      );
    }

    const { status, data } = r;
    const name = String(data?.name || '');
    const msg = this.#safe(data?.message);
    if (status >= 200 && status < 300) {
      if (typeof data?.id === 'string' && data.id) return { accepted: true, messageId: data.id };
      console.warn(`[email] Resend returned HTTP ${status} without an email id`);
      throw new AppError(
        502,
        'SMTP_UNCERTAIN',
        'Resend replied without confirming the email. It may or may not have been sent; check the Resend dashboard (Emails) before trying again. It is recorded as "Uncertain" in the sending history.',
      );
    }

    console.warn(`[email] Resend refused the email (${status} ${name})`);
    if (status === 401 || ['missing_api_key', 'restricted_api_key', 'suspended_api_key', 'invalid_permission'].includes(name)) throw this.#authError(notSent);
    if (status === 403 && name === 'validation_error') {
      if (/api key/i.test(msg)) throw this.#authError(notSent);
      if (/not verified|verify (a|your) domain|testing emails|own email address/i.test(msg)) {
        throw new AppError(
          400,
          'SENDER_REJECTED',
          `Resend does not allow sending as ${this.from} yet: the domain ${this.#fromDomain} is not verified.${notSent} Verify it under Domains in the Resend dashboard (DNS records), or change SMTP_FROM to an address on a verified domain.`,
        );
      }
      throw new AppError(400, 'SMTP_REJECTED', `Resend refused the email.${notSent}${msg ? ` Resend says: "${msg}"` : ''}`);
    }
    if (status === 429) {
      if (name === 'daily_quota_exceeded') throw new AppError(503, 'SMTP_TEMPORARY', `The Resend daily sending limit has been reached (100 emails a day on the free plan).${notSent} The limit resets at midnight UTC.`);
      if (name === 'monthly_quota_exceeded') throw new AppError(503, 'SMTP_TEMPORARY', `The Resend monthly sending limit has been reached (3,000 emails a month on the free plan).${notSent}`);
      throw new AppError(503, 'SMTP_TEMPORARY', `Resend is limiting requests right now (too many per second).${notSent} Please wait a few seconds and try again.`);
    }
    if (status === 409 && (name === 'invalid_idempotent_request' || name === 'concurrent_idempotent_requests')) {
      throw new AppError(
        409,
        'SMTP_UNCERTAIN',
        'Resend has already received this exact send request, so it was not sent a second time. The earlier attempt may have been delivered; check the Resend dashboard (Emails). It is recorded as "Uncertain" in the sending history.',
      );
    }
    if ((status === 400 || status === 422) && /\bto\b|recipient|email address/i.test(msg) && !/from/i.test(msg)) {
      throw new AppError(400, 'INVALID_RECIPIENT', `Resend rejected the recipient address.${notSent}${msg ? ` Resend says: "${msg}"` : ''}`);
    }
    if (status === 400 || status === 422) {
      throw new AppError(400, 'SMTP_REJECTED', `Resend refused the email.${notSent}${msg ? ` Resend says: "${msg}"` : ''}`);
    }
    if (status === 503) throw new AppError(503, 'SMTP_TEMPORARY', `Resend is temporarily unavailable.${notSent} Please try again in a few minutes.`);
    if (status >= 500) {
      throw new AppError(
        502,
        'SMTP_UNCERTAIN',
        'Resend reported an internal error while sending. The email may or may not have been sent; check the Resend dashboard (Emails) before trying again. It is recorded as "Uncertain" in the sending history.',
      );
    }
    throw new AppError(502, 'SMTP_ERROR', `Resend returned an unexpected response (HTTP ${status}).${notSent}`);
  }
}
