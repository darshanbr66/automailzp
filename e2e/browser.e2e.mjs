#!/usr/bin/env node
// Browser end-to-end tests of the MongoDB version, driven through headless
// Chrome (DevTools protocol, no extra packages).
//
//   npm run test:e2e            (builds the frontend first)
//
// Safe to run anywhere: an in-memory MongoDB (mongodb-memory-server), a mocked
// email transport, and no .env file. Atlas, Render, Vercel and real mailboxes
// are never contacted. Ports are picked by the OS; the Chrome profile and the
// test workbook live in a fresh temporary folder that is deleted afterwards.
//
// Environment: CHROME_PATH (optional) - Chrome/Chromium executable.
//              E2E_HEADED=1 (optional) - show the browser window.
// Exit code: 0 when every check passes, 1 otherwise.
import { spawn, spawnSync } from 'node:child_process';

// Node 20 has WebSocket only behind a flag: re-run this file with it.
if (typeof globalThis.WebSocket !== 'function' && !process.env.ZP_E2E_RELAUNCHED) {
  const r = spawnSync(process.execPath, ['--experimental-websocket', '--no-warnings', fileURLToPathEarly(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ZP_E2E_RELAUNCHED: '1' },
  });
  process.exit(r.status ?? 1);
}
function fileURLToPathEarly(u) {
  return decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1');
}
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const OVERALL_TIMEOUT_MS = 240000;
const TEAM = ['Vikram', 'Darshan'];

// ---- Output and results ---------------------------------------------------------
const results = [];
const out = (s) => process.stdout.write(`${s}\n`);
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  out(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  (${JSON.stringify(detail).slice(0, 300)})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Preconditions ----------------------------------------------------------------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

function fatal(message) {
  out(`ERROR ${message}`);
  process.exit(1);
}

const chromePath = findChrome();
if (!chromePath) fatal('Chrome (or Edge/Chromium) was not found. Set CHROME_PATH to its executable.');
if (typeof globalThis.WebSocket !== 'function') fatal('This Node.js has no built-in WebSocket. Use Node 22+, or run with --experimental-websocket (npm run test:e2e does).');
if (!existsSync(path.join(DIST, 'index.html'))) fatal('frontend/dist is missing. Run "npm run build" first (npm run test:e2e does this).');

// Backend dependencies are resolved from backend/node_modules.
const backendRequire = createRequire(path.join(ROOT, 'backend', 'package.json'));
const importBackendDep = (name) => import(pathToFileURL(backendRequire.resolve(name)).href);
const importRepo = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const express = (await importBackendDep('express')).default;
const { MongoMemoryServer } = await importBackendDep('mongodb-memory-server');
const { createApp } = await importRepo('backend/src/app.js');
const { createMongoStorage } = await importRepo('backend/src/storage/mongo.js');
const { fakeTransport, makeMailer, makeWorkbookBuffer, testConfig } = await importRepo('backend/test/helpers.js');

// ---- Test environment ---------------------------------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-e2e-'));
const dataDir = path.join(tmp, 'data');
const profileDir = path.join(tmp, 'chrome-profile');
await fs.mkdir(dataDir);
const workbookPath = path.join(tmp, 'attorneys.xlsx');
await fs.writeFile(
  workbookPath,
  makeWorkbookBuffer([
    ['Full Name', 'Reg No', 'E-mail', 'Firm'],
    ['Attorney A', 'R-A', 'a@example.com', 'Firm A'],
    ['Attorney B', 'R-B', 'b@example.com', 'Firm B'],
    ['Attorney C', '', 'c@example.com', 'Firm C'],
  ]),
);

let mongod;
let storage;
let server;
let chrome;
let ws;

// Fault injection for the operator-prompt scenarios (off unless a scenario turns it on).
const faults = { configFailOnce: false, configFailAlways: false, operatorRejectOnce: false };
const configRequests = [];

async function startServer() {
  mongod = await MongoMemoryServer.create();
  const outer = express();
  let inner = null;
  outer.use((req, res, next) => {
    if (req.path === '/api/app/config') {
      configRequests.push(Date.now());
      if (faults.configFailAlways || faults.configFailOnce) {
        faults.configFailOnce = false;
        return res.status(502).send('Bad gateway'); // like the proxy while Render wakes up
      }
    }
    if (faults.operatorRejectOnce && req.method !== 'GET' && req.path.startsWith('/api/')) {
      faults.operatorRejectOnce = false;
      return res.status(400).json({ ok: false, error: { code: 'OPERATOR_REQUIRED', message: 'Please choose who is using this browser.' } });
    }
    return inner(req, res, next);
  });
  outer.use(express.static(DIST));
  server = await new Promise((resolve) => {
    const s = outer.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const config = testConfig({ FRONTEND_URL: base, TEAM_MEMBERS: TEAM.join(',') });
  storage = createMongoStorage({ uri: mongod.getUri(), dbName: 'e2e', dataDir });
  const smtp = fakeTransport();
  inner = createApp({ config, dataDir, mailer: makeMailer(smtp, config), storage });
  return { base, smtp };
}

// ---- Minimal DevTools protocol client -----------------------------------------
let msgId = 0;
const pending = new Map();
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    msgId += 1;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function startChrome() {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ];
  if (process.env.E2E_HEADED !== '1') args.unshift('--headless=new');
  chrome = spawn(chromePath, args, { stdio: 'ignore' });
  // Chrome writes the chosen port to DevToolsActivePort in the profile.
  let port;
  let wsPath;
  for (let i = 0; i < 100 && !port; i += 1) {
    try {
      [port, wsPath] = (await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
    } catch {
      await sleep(150);
    }
  }
  if (!port) throw new Error('Chrome did not start (no DevToolsActivePort).');
  ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (!d.id || !pending.has(d.id)) return;
    const p = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) p.reject(new Error(`${d.error.message}`));
    else p.resolve(d.result);
  });
}

/** A separate browser profile (own cookies and sessionStorage): one team member. */
async function openUser(base) {
  const ctx = (await call('Target.createBrowserContext')).browserContextId;
  for (const name of ['clipboard-write', 'clipboard-read']) {
    await call('Browser.setPermission', { browserContextId: ctx, origin: base, permission: { name, allowWithoutSanitization: true }, setting: 'granted' });
  }
  const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => call(m, p, sessionId);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('DOM.enable');
  const js = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await js(`return Boolean(${expr})`)) return true;
      } catch {
        /* page is navigating */
      }
      await sleep(120);
    }
    return false;
  };
  const click = (sel, text) =>
    js(`const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)})); if(!el) throw new Error('not found: ' + ${JSON.stringify(`${sel} "${text}"`)}); el.click(); return true`);
  const tab = (t) => click('.tab', t);
  const open = async () => {
    await cdp('Page.navigate', { url: base });
    await waitFor(`document.querySelectorAll('.tab').length === 5`);
  };
  const chooseOperator = async (name) => {
    await waitFor(`document.querySelector('#operator-title')`);
    await click('.operator-choice', name);
    await click('.modal button', 'Continue');
  };
  const uploadFile = async (file) => {
    const doc = (await cdp('DOM.getDocument')).root.nodeId;
    const input = (await cdp('DOM.querySelector', { nodeId: doc, selector: 'input[type=file]' })).nodeId;
    await cdp('DOM.setFileInputFiles', { nodeId: input, files: [path.resolve(file)] });
  };
  const typeInto = (selector, value) =>
    js(`const i=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)}); i.dispatchEvent(new Event('input',{bubbles:true})); return true`);
  const close = () => call('Target.disposeBrowserContext', { browserContextId: ctx });
  return { cdp, js, waitFor, click, tab, open, chooseOperator, uploadFile, typeInto, close };
}

// Rows of the visible page only (pages stay mounted in hidden containers).
const VISIBLE = 'main > div:not([hidden])';

// ---- Scenarios ------------------------------------------------------------------------
/** The team workflow: two members, upload, send, manual marking, correction, activity, export. */
async function teamWorkflow(base, smtp) {
  out('\n# Team workflow (two team members, shared MongoDB)');
  const alice = await openUser(base);
  await alice.open();
  const promptShown = await alice.waitFor(`document.querySelector('#operator-title')`);
  check('1. operator prompt appears (shared database in use)', promptShown && (await alice.js(`return document.querySelector('#operator-title').textContent`)) === 'Who is using this browser?');
  check('2. prompt says the name is self-declared', await alice.js(`return document.querySelector('.modal')?.textContent.includes('self-declared') ?? false`));
  await alice.click('.operator-choice', 'Vikram');
  await alice.click('.modal button', 'Continue');
  check('3. chosen name shown in the top bar', await alice.waitFor(`document.querySelector('.operator-select select')?.value === 'Vikram'`));
  const tabs = await alice.js(`return [...document.querySelectorAll('.tab')].map(t=>t.textContent).join('|')`);
  check('4. five tabs in the requested order', tabs === 'Compose Email|Sent Emails|All Attorneys|Template Settings|Sent History', tabs);

  await alice.uploadFile(workbookPath);
  const uploaded = await alice.waitFor(`document.querySelectorAll('.records-table-wrap tbody tr').length === 3`, 20000);
  check('5. upload through the page stores the workbook', uploaded, uploaded ? undefined : await alice.js(`return [...document.querySelectorAll('.alert')].map(a=>a.textContent).join(' | ') || 'no message'`));
  await alice.js(`document.querySelector('.records-table-wrap tbody tr').click(); return true`);
  await alice.waitFor(`document.querySelector('.email-card textarea')?.value.includes('Attorney A')`);
  await alice.click('.email-card .btn-primary', 'Send Email');
  check('6. Alice sends: success and the clipboard toast', await alice.waitFor(`document.querySelector('.toast')?.textContent.includes('1 email sent – Attorney A copied')`));

  const bob = await openUser(base);
  await bob.open();
  await bob.chooseOperator('Darshan');
  await bob.tab('Sent Emails');
  check(
    "7. Bob sees Alice's send in Sent Emails (method and operator)",
    await bob.waitFor(`[...document.querySelectorAll('${VISIBLE} .table tbody tr')].some(tr => tr.textContent.includes('Attorney A') && tr.textContent.includes('SMTP') && tr.textContent.includes('Vikram'))`),
  );
  check('8. statistics: 1 sent', await bob.js(`return document.querySelector('${VISIBLE} .stat-value')?.textContent === '1'`));

  await bob.tab('All Attorneys');
  await bob.waitFor(`[...document.querySelectorAll('${VISIBLE} button')].some(b => b.textContent === 'Mark as sent')`);
  check(
    '9. All Attorneys: A shown as sent, Mark-as-sent offered for the others',
    await bob.js(`const rows=[...document.querySelectorAll('${VISIBLE} .records-table-wrap tbody tr')]; return rows.length === 3 && rows[0].textContent.includes('Sent') && !rows[0].textContent.includes('Mark as sent') && rows[1].textContent.includes('Mark as sent')`),
  );
  await bob.js(`[...document.querySelectorAll('${VISIBLE} .records-table-wrap tbody tr')][1].querySelector('button').click(); return true`);
  check('10. confirmation dialog before marking', await bob.waitFor(`document.querySelector('.modal h3')?.textContent.includes('Mark as sent')`));
  await bob.typeInto('.modal input[type=text]', 'Phoned the office');
  await bob.click('.modal button', 'Yes, mark as sent');
  check('11. marked: status "Sent (manual)"', await bob.waitFor(`[...document.querySelectorAll('${VISIBLE} .records-table-wrap tbody tr')][1]?.textContent.includes('Sent (manual)')`));

  await alice.tab('Sent Emails');
  check(
    "12. Alice sees Bob's manual mark",
    await alice.waitFor(`[...document.querySelectorAll('${VISIBLE} .table tbody tr')].some(tr => tr.textContent.includes('Attorney B') && tr.textContent.includes('Manual') && tr.textContent.includes('Darshan'))`),
  );
  await alice.tab('Compose Email');
  await alice.js(`[...document.querySelectorAll('${VISIBLE} .records-table-wrap tbody tr')][1].click(); return true`);
  await alice.waitFor(`document.querySelector('.email-card textarea')?.value.includes('Attorney B')`);
  await alice.click('.email-card .btn-primary', 'Send Email');
  check('13. Compose warns before emailing a manually contacted attorney', await alice.waitFor(`document.querySelector('.modal')?.textContent.includes('Marked as sent manually by Darshan')`));
  await alice.click('.modal button', 'Cancel');

  await alice.tab('Sent History');
  await alice.click(`${VISIBLE} .segmented button`, 'All send attempts');
  await alice.waitFor(`[...document.querySelectorAll('${VISIBLE} button')].some(b => b.textContent === 'Correct…')`);
  await alice.js(`[...document.querySelectorAll('${VISIBLE} tr')].find(tr => tr.textContent.includes('Attorney B') && tr.querySelector('button')).querySelector('button').click(); return true`);
  await alice.waitFor(`document.querySelector('.modal h3')?.textContent.includes('Correct')`);
  await alice.typeInto('.modal input[type=text]', 'Wrong attorney marked');
  await alice.click('.modal button', 'Save correction');
  check('14. correction: record kept and shown as Voided', await alice.waitFor(`[...document.querySelectorAll('tr.voided-row')].some(tr => tr.textContent.includes('Attorney B') && tr.textContent.includes('Wrong attorney marked'))`));

  await alice.click(`${VISIBLE} .segmented button`, 'Team activity');
  await alice.waitFor(`document.querySelectorAll('${VISIBLE} .table tbody tr').length >= 4`);
  const acts = await alice.js(`return [...document.querySelectorAll('${VISIBLE} .table tbody tr')].map(tr => tr.textContent)`);
  check(
    '15. team activity: every action with operator, device, IP and location status',
    ['Workbook uploaded', 'Email sent', 'Marked as sent (manual)', 'History corrected'].every((a) => acts.some((t) => t.includes(a))) &&
      acts.some((t) => t.includes('Vikram') && t.includes('self-declared')) &&
      acts.some((t) => t.includes('Darshan')) &&
      acts.every((t) => t.includes('Unavailable')),
    acts.slice(0, 3),
  );

  await alice.click(`${VISIBLE} .segmented button`, 'Attorneys');
  const exp = await alice.js(`const r = await fetch('/api/history/export', { credentials: 'include' }); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]`);
  check('16. Export to Excel works', exp[0] === 200 && /spreadsheetml/.test(exp[1]) && exp[2] > 1000, exp);

  await alice.tab('Sent Emails');
  await alice.waitFor(`document.querySelector('${VISIBLE} .stat')`);
  const overflow = await alice.js(`return document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check('17. no horizontal page scroll (desktop)', overflow <= 0, overflow);
  const recipients = smtp.state.sent.map((m) => m.to);
  check('18. only Attorney A was emailed (manual mark and duplicate warning held)', recipients.length === 1 && recipients[0] === 'a@example.com', recipients);

  await alice.close();
  await bob.close();
}

/** The operator prompt must come back whenever the server would refuse actions. */
async function operatorPromptResilience(base) {
  out('\n# Operator prompt resilience');
  const promptShown = (u, ms = 6000) => u.waitFor(`document.querySelector('#operator-title')`, ms);

  {
    const u = await openUser(base);
    faults.configFailOnce = true;
    await u.open();
    check('O1. one failed settings request (502): prompt still appears', await promptShown(u));
    await u.close();
  }
  {
    const u = await openUser(base);
    await u.open();
    await promptShown(u);
    await u.js(`sessionStorage.setItem('zp-operator', 'Old Name'); location.reload(); return true`);
    await sleep(300);
    await u.waitFor(`document.querySelectorAll('.tab').length === 5`);
    check('O2. a stored name that is not a team member: prompt asks again', (await promptShown(u, 4000)) && (await u.js(`return sessionStorage.getItem('zp-operator')`)) === null);
    await u.close();
  }
  {
    const u = await openUser(base);
    faults.configFailAlways = true;
    const before = configRequests.length;
    await u.cdp('Page.navigate', { url: base });
    const err = await u.waitFor(`[...document.querySelectorAll('.alert')].some(a => a.textContent.includes('application settings could not be loaded'))`, 15000);
    faults.configFailAlways = false;
    check('O3a. settings keep failing: a visible error with Retry (after retries)', err && configRequests.length - before >= 4, { attempts: configRequests.length - before });
    await u.js(`[...document.querySelectorAll('.alert')].find(a => a.textContent.includes('application settings')).querySelector('.link-button').click(); return true`);
    check('O3b. Retry recovers and the prompt appears', await promptShown(u));
    await u.close();
  }
  {
    const u = await openUser(base);
    await u.open();
    await u.chooseOperator('Vikram');
    const closed = await u.waitFor(`!document.querySelector('#operator-title')`, 3000);
    faults.operatorRejectOnce = true;
    await u.uploadFile(workbookPath); // the server answers OPERATOR_REQUIRED
    check('O4. server refuses the operator: the prompt asks again', closed && (await promptShown(u)) && !faults.operatorRejectOnce);
    faults.operatorRejectOnce = false;
    await u.close();
  }
}

// ---- Run ---------------------------------------------------------------------------------
const watchdog = setTimeout(() => {
  out(`ERROR timed out after ${OVERALL_TIMEOUT_MS / 1000}s`);
  cleanup().finally(() => process.exit(1));
}, OVERALL_TIMEOUT_MS);

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  await new Promise((r) => (server ? server.close(() => r()) : r()));
  await storage?.close().catch(() => {});
  await mongod?.stop().catch(() => {});
  // Chrome can hold profile files briefly after exit (Windows).
  for (let i = 0; i < 10; i += 1) {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}

const quiet = { log: console.log, error: console.error, warn: console.warn };
let crashed = false;
try {
  // The app's own [send]/[db] logging would drown the results.
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const { base, smtp } = await startServer();
  await startChrome();
  for (const scenario of [teamWorkflow, operatorPromptResilience]) {
    try {
      await scenario(base, smtp);
    } catch (err) {
      crashed = true;
      out(`ERROR in ${scenario.name}: ${err.stack || err.message}`);
    }
  }
} catch (err) {
  crashed = true;
  out(`ERROR ${err.stack || err.message}`);
} finally {
  await cleanup();
  clearTimeout(watchdog);
  Object.assign(console, quiet);
}

const failed = results.filter((r) => !r.ok).length;
out(`\n# checks ${results.length}\n# pass ${results.length - failed}\n# fail ${failed}${crashed ? '\n# a scenario stopped early (see ERROR above)' : ''}`);
process.exit(failed || crashed ? 1 : 0);
