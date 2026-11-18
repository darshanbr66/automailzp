// Unit tests for the self-declared operator helpers (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOperator, knownOperator, onOperatorChange, setOperator } from '../src/operator.js';

const TEAM = ['Vikram', 'Darshan'];

test('knownOperator accepts only configured names, matching like the server', () => {
  assert.equal(knownOperator('Vikram', TEAM), 'Vikram');
  assert.equal(knownOperator('  darshan ', TEAM), 'Darshan', 'case and spaces do not matter; the configured spelling is returned');
  assert.equal(knownOperator('Old Name', TEAM), null, 'a name that is not (or no longer) configured is not an operator');
  assert.equal(knownOperator('', TEAM), null);
  assert.equal(knownOperator(null, TEAM), null);
  assert.equal(knownOperator('Vikram', undefined), null, 'without the team list nothing is accepted');
});

test('setOperator notifies listeners and works without sessionStorage (in memory)', () => {
  const seen = [];
  const off = onOperatorChange((v) => seen.push(v));
  setOperator('Vikram');
  assert.equal(getOperator(), 'Vikram');
  setOperator(null);
  assert.equal(getOperator(), null);
  off();
  setOperator('Darshan');
  assert.deepEqual(seen, ['Vikram', null], 'unsubscribed listeners are not called');
  setOperator(null);
});
