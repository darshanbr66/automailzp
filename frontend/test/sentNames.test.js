// Unit tests for the cumulative sent-names clipboard list (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, addName, clipboardText, copiedMessage, copyToClipboard, createCopyQueue, createSentNamesStore, labelFor, manualCopyMessage,
} from '../src/sentNames.js';

/** Minimal sessionStorage stand-in. */
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}

test('messages and clipboard text match the requested format', () => {
  assert.equal(clipboardText(['Attorney A']), 'Attorney A');
  assert.equal(copiedMessage(['Attorney A']), '1 email sent – Attorney A copied to clipboard. Please check.');
  assert.equal(clipboardText(['Attorney A', 'Attorney B']), 'Attorney A\nAttorney B');
  assert.equal(copiedMessage(['Attorney A', 'Attorney B']), '2 emails sent – Attorney A, Attorney B copied to clipboard. Please check.');
  assert.equal(copiedMessage(['Attorney A', 'Attorney B', 'Attorney C']), '3 emails sent – Attorney A, Attorney B, Attorney C copied to clipboard. Please check.');
  assert.match(manualCopyMessage(['Attorney A']), /^1 email sent – Attorney A\. The names could not be copied automatically/);
});

test('names are added cumulatively, without duplicates or blanks', () => {
  let list = [];
  list = addName(list, 'Attorney A');
  list = addName(list, '  Attorney   B ');
  list = addName(list, 'attorney a'); // same person, different case
  list = addName(list, '');
  list = addName(list, null);
  assert.deepEqual(list, ['Attorney A', 'Attorney B']);
  const before = list;
  assert.equal(addName(before, 'ATTORNEY B'), before, 'unchanged list is returned as-is');
  assert.equal(labelFor({ attorneyName: ' Jane  Doe ', recipientEmail: 'j@example.com' }), 'Jane Doe');
  assert.equal(labelFor({ attorneyName: '', recipientEmail: 'j@example.com' }), 'j@example.com', 'a row without a name uses its email');
});

test('the store keeps the list in session storage, survives a reload, and is cleared on sign-out', () => {
  const storage = memoryStorage();
  const store = createSentNamesStore(storage);
  assert.deepEqual(store.add('Attorney A'), ['Attorney A']);
  assert.deepEqual(store.add('Attorney B'), ['Attorney A', 'Attorney B']);
  assert.deepEqual(store.add('Attorney A'), ['Attorney A', 'Attorney B']);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), ['Attorney A', 'Attorney B']);
  // "Reload": a new store on the same tab's storage continues the list.
  const afterReload = createSentNamesStore(storage);
  assert.deepEqual(afterReload.add('Attorney C'), ['Attorney A', 'Attorney B', 'Attorney C']);
  afterReload.clear();
  assert.deepEqual(createSentNamesStore(storage).list(), []);
});

test('two team members (separate browsers) keep separate lists', () => {
  const alice = createSentNamesStore(memoryStorage());
  const bob = createSentNamesStore(memoryStorage());
  alice.add('Attorney A');
  bob.add('Attorney B');
  alice.add('Attorney C');
  assert.deepEqual(alice.list(), ['Attorney A', 'Attorney C']);
  assert.deepEqual(bob.list(), ['Attorney B']);
});

test('blocked or damaged storage falls back to memory without errors', () => {
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const s1 = createSentNamesStore(throwing);
  assert.deepEqual(s1.add('Attorney A'), ['Attorney A']);
  assert.deepEqual(s1.add('Attorney B'), ['Attorney A', 'Attorney B']);
  s1.clear();
  assert.deepEqual(s1.list(), []);
  const damaged = memoryStorage();
  damaged.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(createSentNamesStore(damaged).add('Attorney A'), ['Attorney A']);
  assert.deepEqual(createSentNamesStore(null).add('Attorney A'), ['Attorney A']);
});

test('copyToClipboard reports success, refusal and the legacy fallback', async () => {
  const written = [];
  assert.equal(await copyToClipboard('x', { clipboard: { writeText: async (t) => written.push(t) }, doc: null }), true);
  assert.deepEqual(written, ['x']);
  const refused = { writeText: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
  assert.equal(await copyToClipboard('x', { clipboard: refused, doc: null }), false, 'no permission and no fallback');
  // Legacy execCommand fallback.
  const body = { appendChild() {}, removeChild() {} };
  const doc = { body, createElement: () => ({ setAttribute() {}, select() {}, style: {} }), execCommand: (cmd) => cmd === 'copy' };
  assert.equal(await copyToClipboard('x', { clipboard: refused, doc }), true);
  assert.equal(await copyToClipboard('x', { clipboard: undefined, doc: { ...doc, execCommand: () => false } }), false);
});

test('copies run in order, so a slow copy never overwrites a newer list', async () => {
  const clipboard = [];
  const delays = [60, 0, 0];
  let i = 0;
  const copy = async (text) => {
    await new Promise((r) => setTimeout(r, delays[i++] || 0));
    clipboard.push(text);
    return true;
  };
  const queued = createCopyQueue(copy);
  await Promise.all([queued('A'), queued('A\nB'), queued('A\nB\nC')]);
  assert.deepEqual(clipboard, ['A', 'A\nB', 'A\nB\nC']);
  assert.equal(clipboard.at(-1), 'A\nB\nC');
  // A failing copy does not block later ones.
  const q2 = createCopyQueue(async (t) => { if (t === 'bad') throw new Error('x'); return true; });
  await assert.rejects(q2('bad'));
  assert.equal(await q2('good'), true);
});
