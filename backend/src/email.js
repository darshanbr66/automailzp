import nodemailer from 'nodemailer';
import { AppError } from './utils.js';

const MAX_SUBJECT = 255;
const MAX_BODY = 100000;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  const v = String(value ?? '').trim();
  return v.length <= 254 && EMAIL_RE.test(v) && !v.includes('..');
}

/** Validate a message before sending. Throws AppError(400) with a clear message. */
export function validateMessage({ to, subject, body }) {
  if (!String(to ?? '').trim()) throw new AppError(400, 'MISSING_RECIPIENT', 'This attorney has no recipient email address in the workbook.');
  if (!isValidEmail(to)) throw new AppError(400, 'INVALID_RECIPIENT', `"${String(to).slice(0, 100)}" is not a valid email address. Please correct it in the Excel workbook.`);
  if (typeof subject !== 'string' || !subject.trim()) throw new AppError(400, 'MISSING_SUBJECT', 'Please enter an email subject.');
  if (subject.length > MAX_SUBJECT) throw new AppError(400, 'SUBJECT_TOO_LONG', `The subject is too long (maximum ${MAX_SUBJECT} characters).`);
  if (/[\r\n]/.test(subject)) throw new AppError(400, 'INVALID_SUBJECT', 'The subject must be a single line.');
  if (typeof body !== 'string' || !body.trim()) throw new AppError(400, 'MISSING_BODY', 'Please enter the email body.');
  if (body.length > MAX_BODY) throw new AppError(400, 'BODY_TOO_LONG', 'The email body is too long.');
}

/** Short, single-line copy of the server's reply that is safe to show (never contains our password). */
function serverReply(err) {
  const text = String(err?.response || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return text ? ` Server reply: "${text}"` : '';
}

// SMTP commands that happen before the message itself is transmitted. A failure
// during one of these means the email was certainly not sent.
const PRE_DATA_COMMAND = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|API|MAIL FROM|RCPT TO)/i;

/**
 * Translate a Nodemailer/SMTP error into a user-friendly AppError.
 * @param {Error} err
 * @param {'verify'|'send'} phase
 * @param {{host:string, user:string, from:string}} smtp
 */
export function mapSmtpError(err, phase, smtp) {
  const code = String(err?.code || '');
  const responseCode = Number(err?.responseCode) || 0;
  const command = String(err?.command || '');
  const notSent = phase === 'send' ? ' The email was not sent.' : '';

  if (code === 'EAUTH' || code === 'ENOAUTH' || ([534, 535].includes(responseCode) && /^AUTH/i.test(command))) {
    return new AppError(
      401,
      'SMTP_AUTH_FAILED',
      `Hostinger rejected the login for ${smtp.user}.${notSent} Check that SMTP_PASS (backend/.env locally, or the Render environment when hosted) is the App Password generated for this mailbox ` +
        '(not your hPanel or mailbox password), that it was pasted without extra spaces, and that it has not been deleted in hPanel. Restart the app after changing it.',
    );
  }

  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(String(err?.message || ''))) {
    return new AppError(503, 'SMTP_CONNECTION_FAILED', `Could not find the mail server "${smtp.host}". Check your internet connection and the SMTP_HOST setting.${notSent}`);
  }

  if (code === 'EENVELOPE' || (responseCode >= 500 && /^RCPT TO/i.test(command))) {
    if (/^MAIL FROM/i.test(command)) {
      return new AppError(400, 'SENDER_REJECTED', `Hostinger does not allow sending as ${smtp.from}. SMTP_FROM must be the same mailbox as SMTP_USER.${notSent}${serverReply(err)}`);
    }
    return new AppError(400, 'INVALID_RECIPIENT', `Hostinger rejected the recipient address.${notSent}${serverReply(err)}`);
  }

  const isNetwork = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ETLS', 'EPROTOCOL', 'EHLO', 'ESTREAM'].includes(code);
  if (isNetwork) {
    if (phase === 'send' && !PRE_DATA_COMMAND.test(command)) {
      // The connection broke while or after the message was transmitted.
      return new AppError(
        503,
        'SMTP_UNCERTAIN',
        'The connection to Hostinger was interrupted while sending. The email may or may not have been sent — check the Sent folder in Hostinger Webmail (or ask the recipient) before trying again. It is recorded as "Uncertain" in the sending history, and counts as possibly sent for duplicate checks.',
      );
    }
    const tls = code === 'ETLS' || /certificate|ssl|tls/i.test(String(err?.message || ''));
    return new AppError(
      503,
      'SMTP_CONNECTION_FAILED',
      tls
        ? `A secure (SSL/TLS) connection to ${smtp.host} could not be established. Use SMTP_PORT=465 with SMTP_SECURE=true (or 587 with false).${notSent}`
        : `Could not connect to ${smtp.host}. Check your internet connection, and that a firewall or antivirus is not blocking the SMTP port.${notSent}`,
    );
  }

  if (responseCode >= 400 && responseCode < 500) {
    return new AppError(503, 'SMTP_TEMPORARY', `Hostinger temporarily refused the request (for example a sending limit). Please wait a few minutes and try again.${notSent}${serverReply(err)}`);
  }
  if (responseCode >= 500) {
    return new AppError(502, 'SMTP_REJECTED', `Hostinger refused the email.${notSent}${serverReply(err)}`);
  }
  return new AppError(502, 'SMTP_ERROR', `The email server returned an unexpected error.${notSent}`);
}

/**
 * Sends email through an SMTP server (Hostinger) with Nodemailer.
 * The password stays inside this object; it is never returned or logged.
 */
export class SmtpMailer {
  /**
   * @param {{host:string, port:number, secure:boolean, user:string, pass:string, from:string}} smtp
   * @param {{createTransport?: Function, timeouts?: object}} [options]  createTransport is replaced in tests
   */
  constructor(smtp, { createTransport = nodemailer.createTransport, timeouts = {} } = {}) {
    this.smtp = smtp;
    this.createTransport = createTransport;
    this.timeouts = { connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000, ...timeouts };
  }

  /** Settings that are safe to show in the UI (no password). */
  publicInfo() {
    const { host, port, secure, user, from } = this.smtp;
    return { host, port, secure, user, from };
  }

  transport() {
    const { host, port, secure, user, pass } = this.smtp;
    return this.createTransport({
      host,
      port,
      secure, // true = SSL from the first byte (port 465)
      requireTLS: !secure, // port 587: refuse to continue without STARTTLS
      auth: { user, pass },
      tls: { minVersion: 'TLSv1.2', servername: host },
      disableFileAccess: true,
      disableUrlAccess: true,
      ...this.timeouts,
    });
  }

  /** Connect and log in without sending anything. */
  async verify() {
    const t = this.transport();
    try {
      await t.verify();
      return { ok: true };
    } catch (err) {
      console.warn(`[smtp] Connection test failed (${err?.code || 'unknown'}${err?.responseCode ? ` ${err.responseCode}` : ''})`);
      throw mapSmtpError(err, 'verify', this.smtp);
    } finally {
      t.close?.();
    }
  }

  /**
   * Send one plain-text email. Resolves only when the SMTP server accepted the
   * message for the recipient (a 250 reply). That is acceptance, not proof of delivery.
   */
  async send({ to, subject, body }) {
    const recipient = to.trim();
    const t = this.transport();
    let info;
    try {
      info = await t.sendMail({
        from: this.smtp.from,
        to: recipient,
        subject: subject.trim(),
        text: body,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (err) {
      console.warn(`[smtp] Send failed (${err?.code || 'unknown'}${err?.responseCode ? ` ${err.responseCode}` : ''}${err?.command ? ` at ${err.command}` : ''})`);
      throw mapSmtpError(err, 'send', this.smtp);
    } finally {
      t.close?.();
    }
    const accepted = (info?.accepted || []).map((a) => String(a?.address ?? a).toLowerCase());
    const rejected = info?.rejected || [];
    if (rejected.length || (Array.isArray(info?.accepted) && !accepted.includes(recipient.toLowerCase()))) {
      throw new AppError(400, 'INVALID_RECIPIENT', `Hostinger did not accept the recipient address. The email was not sent.${serverReply({ response: info?.rejectedErrors?.[0]?.response })}`);
    }
    return { accepted: true, messageId: info?.messageId || null };
  }
}
