#!/usr/bin/env node
// Generate APP_PASSWORD_HASH (and optionally a SESSION_SECRET) locally.
//
//   cd backend
//   npm run hash-password            # prompts twice, input hidden
//   npm run hash-password -- --secret   # also prints a new SESSION_SECRET
//
// The password is never accepted as a command-line argument (it would end up in
// shell history). It can also be piped:  <password-file node scripts/hash-password.js
import crypto from 'node:crypto';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../src/auth.js';

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          return reject(new Error('Cancelled.'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

try {
  let password;
  if (process.stdin.isTTY) {
    password = await readHidden(`Shared team password (min ${MIN_PASSWORD_LENGTH} characters): `);
    const again = await readHidden('Repeat the password: ');
    if (password !== again) throw new Error('The passwords do not match.');
  } else {
    password = await readPiped();
  }
  const hash = await hashPassword(password);
  if (!(await verifyPassword(password, hash))) throw new Error('Self-check failed.');
  console.log('\nAdd this to the Render environment (or backend/.env for local use):\n');
  console.log(`APP_PASSWORD_HASH=${hash}`);
  if (process.argv.includes('--secret')) console.log(`SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
  console.log('\nShare the password itself with the team through a password manager, not by email or chat.');
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
