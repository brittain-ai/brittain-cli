'use strict';

// What a coder changed, read from the files: works without git, skips what is
// not the project's, and says which files a task did not list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { changesBetween, describeChanges, snapshot, unlisted } = require('../../src/core/snapshot');

function dir(files = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-snap-')));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  return cwd;
}

test('finds added, modified and deleted files', () => {
  const cwd = dir({ 'keep.js': 'k', 'edit.js': 'one', 'gone.js': 'g' });
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'edit.js'), 'two two');
  fs.rmSync(path.join(cwd, 'gone.js'));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'n');
  const changes = changesBetween(before, snapshot(cwd));
  assert.deepEqual(changes, { added: ['src/new.js'], modified: ['edit.js'], deleted: ['gone.js'] });
  assert.equal(describeChanges(changes), 'added src/new.js; modified edit.js; deleted gone.js');
});

test('reports no change when nothing changed', () => {
  const cwd = dir({ 'a.js': 'a' });
  const before = snapshot(cwd);
  assert.equal(describeChanges(changesBetween(before, snapshot(cwd))), 'no files changed');
});

test('ignores git, the plan directory, node_modules and .DS_Store', () => {
  const cwd = dir({ 'a.js': 'a', '.git/HEAD': 'x', '.brittain/plan.md': 'p', 'node_modules/x/i.js': 'i', '.DS_Store': 'd' });
  assert.deepEqual(Object.keys(snapshot(cwd)), ['a.js']);
});

test('a missing directory is an empty snapshot, not a crash', () => {
  assert.deepEqual(snapshot(path.join(os.tmpdir(), 'bc-snap-does-not-exist')), {});
});

test('unlisted names files outside the task, counting a listed directory', () => {
  const changes = { added: ['a.js', 'src/b.js', 'todos.json'], modified: [], deleted: [] };
  assert.deepEqual(unlisted(changes, ['a.js', 'src/']), ['todos.json']);
  assert.deepEqual(unlisted({ added: ['a.js'], modified: [], deleted: [] }, ['./a.js']), []);
  assert.deepEqual(unlisted({ added: ['ab.js'], modified: [], deleted: [] }, ['a']), ['ab.js']);
});
