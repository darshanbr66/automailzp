import { SmtpMailer } from './email.js';
import { ResendMailer } from './resend.js';

/**
 * Create the mailer selected by EMAIL_PROVIDER, or null when it isn't fully
 * configured. Both mailers have the same interface: publicInfo(), verify(), send().
 * @param {object} config  result of loadConfig()
 * @param {{ createTransport?: Function, fetch?: Function }} [deps]  replaced in tests
 */
export function createMailer(config, deps = {}) {
  if (!config.smtpConfigured) return null;
  if (config.email?.provider === 'resend') {
    return new ResendMailer({ apiKey: config.email.resendApiKey, from: config.email.from }, deps.fetch ? { fetch: deps.fetch } : {});
  }
  return new SmtpMailer(config.smtp, deps.createTransport ? { createTransport: deps.createTransport } : {});
}

export function providerLabel(provider) {
  return provider === 'resend' ? 'Resend' : 'Hostinger';
}
