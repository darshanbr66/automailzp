// Shared test helpers (no tests in this file). All data here is fictional.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createApp } from '../src/app.js';
import { SmtpMailer } from '../src/email.js';
import { loadConfig } from '../src/config.js';

export async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oea-test-'));
}

export function makeWorkbookBuffer(rows, bookType = 'xlsx') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Attorneys');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

export const SAMPLE_ROWS = [
  ['Full Name', 'Reg No', 'E-mail', 'Firm', 'City', 'State', 'Practice Area'],
  ['Test Attorney One', 'REG-001', 'one@example.com', 'Example Law LLP', 'Springfield', 'IL', 'Patents'],
  ['Test Attorney Two', 'REG-002', 'two@example.com', '', 'Shelbyville', 'IL', ''],
  ['', '', '', '', '', '', ''],
  ['Test Attorney Three', '', 'three@example.com', 'Sample & Co', '', '', ''],
  ['Test Attorney Four', 'REG-004', 'not-an-email', '', '', '', ''],
];

export const TEST_SENDER = 'sender@example.com';

export function testConfig(overrides = {}) {
  return loadConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: TEST_SENDER,
    SMTP_PASS: 'fake-app-password-for-tests',
    SMTP_FROM: TEST_SENDER,
    ...overrides,
  });
}

/** Make an SMTP-style error like the ones Nodemailer produces. */
export function smtpError(code, { responseCode, command, response, message = 'smtp error' } = {}) {
  return Object.assign(new Error(message), { code, responseCode, command, response });
}

/**
 * Stand-in for nodemailer.createTransport. Records the options and messages;
 * nothing is ever sent over the network.
 * Queue items: { verifyError } for verify(), { error, delayMs, info } for sendMail().
 */
export function fakeTransport() {
  const state = { options: [], sent: [], verifies: 0, sendQueue: [], verifyQueue: [], closed: 0 };
  const createTransport = (options) => {
    state.options.push(options);
    return {
      verify: async () => {
        state.verifies += 1;
        const next = state.verifyQueue.shift() || {};
        if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
        if (next.verifyError) throw next.verifyError;
        return true;
      },
      sendMail: async (message) => {
        const next = state.sendQueue.shift() || {};
        if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
        if (next.error) throw next.error;
        state.sent.push(message);
        return next.info || { accepted: [message.to], rejected: [], messageId: '<test-message@example.com>', response: '250 OK' };
      },
      close: () => {
        state.closed += 1;
      },
    };
  };
  return { createTransport, state };
}

export function makeMailer(fake, config = testConfig()) {
  return new SmtpMailer(config.smtp, { createTransport: fake.createTransport });
}

/** Start the app on a random port and return a small client with a cookie jar. */
export async function startTestServer({ dataDir, mailer, config = testConfig() }) {
  const app = createApp({ config, dataDir, mailer });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(method, urlPath, { json, form, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (csrf && method !== 'GET') h['x-oea-request'] = '1';
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await fetch(base + urlPath, { method, headers: h, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function upload(buffer, fileName = 'attorneys.xlsx') {
    const form = new FormData();
    form.append('file', new Blob([buffer]), fileName);
    return request('POST', '/api/excel/upload', { form });
  }

  return {
    base,
    request,
    upload,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
