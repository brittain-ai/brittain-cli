// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:test/main/tool-failure.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callSignature, createRepeatTracker, createToolFailureTracker, isToolErrorResult } = require('../../src/lib/tool-failure');

test('tool call signatures are stable when object key order changes', () => {
  assert.equal(
    callSignature('click', { selector: '#save', exact: true }),
    callSignature('click', { exact: true, selector: '#save' }),
  );
});

test('the third identical failed tool call is blocked', () => {
  const tracker = createToolFailureTracker(2);
  const args = { selector: 'a[href="bad"]' };
  assert.equal(tracker.shouldBlock('browser_click', args), false);
  assert.deepEqual(tracker.record('browser_click', args, 'Error: not found'), { count: 1, reachedLimit: false });
  assert.equal(tracker.shouldBlock('browser_click', args), false);
  assert.deepEqual(tracker.record('browser_click', args, 'Error: not found'), { count: 2, reachedLimit: true });
  assert.equal(tracker.shouldBlock('browser_click', args), true);
  assert.equal(tracker.shouldBlock('browser_click', { selector: 'button[name="Save"]' }), false);
});

test('success clears a call failure count', () => {
  assert.equal(isToolErrorResult('Error: no such file'), true);
  assert.equal(isToolErrorResult('Wrote 3 chars'), false);
  const tracker = createToolFailureTracker(2);
  const args = { path: 'a.txt' };
  tracker.record('read_file', args, 'Error: ENOENT');
  tracker.record('read_file', args, 'hello');
  tracker.record('read_file', args, 'Error: ENOENT');
  assert.equal(tracker.shouldBlock('read_file', args), false);
});

test('a file read is blocked until its version changes or an edit succeeds', () => {
  const tracker = createRepeatTracker();
  const args = { path: 'plan.md' };
  tracker.record('read_file', args, 'first version', 'v1');
  assert.equal(tracker.shouldBlock('read_file', args, 'v1'), true);
  assert.equal(tracker.shouldBlock('read_file', args, 'v2'), false);
  tracker.record('read_file', args, 'second version', 'v2');
  assert.equal(tracker.shouldBlock('read_file', args, 'v2'), true);
  tracker.record('edit_file', { path: 'plan.md' }, 'Edited plan.md');
  assert.equal(tracker.shouldBlock('read_file', args, 'v2'), false);
});
