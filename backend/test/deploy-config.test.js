// Production configuration for the Render deployment of the MongoDB version:
// no silent fallback to file storage, no assumed database name or team.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { isProductionTarget, describeTarget } from '../src/dbops.js';
import { hashPassword } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The variables render.yaml sets, plus placeholders for the dashboard secrets.
const RENDER = {
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://automailzp.vercel.app',
  ALLOWED_HOSTS: 'automailzp.onrender.com,automailzp.vercel.app',
  TRUST_PROXY: '1',
  APP_USERNAME: 'zodiac-team',
  APP_PASSWORD_HASH: await hashPassword('a-long-test-password-only'),
  SESSION_SECRET: 'x'.repeat(48),
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test1234567890abcdef',
  SMTP_FROM: 'sender@example.com',
  REQUIRE_MONGODB: 'true',
  MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/?retryWrites=true&w=majority',
  MONGODB_DB: 'automail',
  TEAM_MEMBERS: 'Vikram, Vikram2',
  AUDIT_CLIENT_IP_HOPS: '2',
};

test('the Render variables give a complete production configuration in MongoDB mode', () => {
  const c = loadConfig(RENDER);
  assert.deepEqual(c.fatal, []);
  assert.deepEqual(c.problems, []);
  assert.equal(c.auth.enabled, true);
  assert.equal(c.mongodb.dbName, 'automail');
  assert.deepEqual(c.teamMembers, ['Vikram', 'Vikram2']);
  assert.equal(c.storageWarning, null, 'no "temporary storage" warning with MongoDB');
  assert.equal(c.host, '0.0.0.0');
  assert.deepEqual(c.allowedOrigins, ['https://automailzp.vercel.app']);
  assert.equal(c.email.provider, 'resend');
  assert.equal(c.clientIpHops, 2);
});

test('production refuses to start without the database, database name or team', () => {
  const without = (k) => {
    const env = { ...RENDER };
    delete env[k];
    return loadConfig(env).fatal.join(' | ');
  };
  assert.match(without('MONGODB_URI'), /MONGODB_URI is not set, but REQUIRE_MONGODB=true/);
  assert.match(without('MONGODB_DB'), /MONGODB_DB must be set/);
  assert.match(without('TEAM_MEMBERS'), /TEAM_MEMBERS must list/);
  // Locally (no NODE_ENV, no REQUIRE_MONGODB) the defaults still apply.
  const local = loadConfig({ MONGODB_URI: RENDER.MONGODB_URI });
  assert.equal(local.mongodb.dbName, 'zodiacpatent');
  assert.ok(!local.fatal.some((f) => /MONGODB|TEAM_MEMBERS/.test(f)));
  assert.ok(!JSON.stringify(loadConfig({ ...RENDER, MONGODB_DB: '' }).fatal).includes('pass@'), 'messages never contain the URI');
});

test('render.yaml sets the MongoDB variables and keeps the secret ones out of the file', () => {
  const y = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const block = (key) => y.match(new RegExp(`- key: ${key}\\n\\s+(value|sync|generateValue): ?(.*)`))?.slice(1, 3);
  assert.deepEqual(block('REQUIRE_MONGODB'), ['value', '"true"']);
  assert.deepEqual(block('MONGODB_DB'), ['value', 'automail']);
  assert.deepEqual(block('TEAM_MEMBERS'), ['value', 'Vikram, Vikram2']);
  for (const secret of ['MONGODB_URI', 'RESEND_API_KEY', 'APP_PASSWORD_HASH', 'APP_USERNAME']) assert.equal(block(secret)?.[0], 'sync', `${secret} must be set in the dashboard`);
  assert.ok(!/mongodb(\+srv)?:\/\/[^<\s]+@/.test(y), 'no connection string in the file');
  assert.match(y, /startCommand: node src\/server\.js/);
  assert.match(y, /healthCheckPath: \/healthz/);
  assert.match(y, /plan: free/);
});

test('vercel.json forwards /api to the Render service and serves the SPA', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'vercel.json'), 'utf8'));
  const api = v.rewrites.find((r) => r.source === '/api/:path*');
  const host = new URL(api.destination.replace(':path*', 'x')).host;
  assert.equal(host, 'automailzp.onrender.com');
  assert.ok(RENDER.ALLOWED_HOSTS.split(',').includes(host), 'the Render host is allowed by the backend');
  assert.equal(new URL(RENDER.FRONTEND_URL).host, 'automailzp.vercel.app');
  assert.equal(v.outputDirectory, 'dist');
});

test('automail is treated as a production database by the scripts', () => {
  assert.equal(isProductionTarget(describeTarget(RENDER.MONGODB_URI, 'automail')), true);
  assert.equal(isProductionTarget(describeTarget(RENDER.MONGODB_URI, 'automail_smoketest')), false);
});
