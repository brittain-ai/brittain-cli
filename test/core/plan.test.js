'use strict';

// The build plan: parsing what a small model emits, refusing what cannot gate
// a task, and only ever marking a task done with evidence.

const test = require('node:test');
const assert = require('node:assert/strict');

const { greppsErrorFromPipe, looksLikeCommand, markTask, nextPending, parsePlan, renderPlan, taskBrief } = require('../../src/core/plan');

const GOOD = `# Plan: Todo CLI

## Decisions
- Node.js, CommonJS, no dependencies
- Files: todos.js, cli.js

## Task 1: Data layer
Files: todos.js
Do: Implement add, list, done and remove over todos.json.
Check: node --test

## Task 2: CLI
Files: cli.js
Do: Parse argv and call todos.js.
  Print one line per todo.
Check: node cli.js list | grep -q milk
`;

test('parses a well-formed plan', () => {
  const { ok, plan, errors } = parsePlan(GOOD);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(plan.title, 'Todo CLI');
  assert.equal(plan.decisions.length, 2);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[0].files, ['todos.js']);
  assert.equal(plan.tasks[1].do, 'Parse argv and call todos.js. Print one line per todo.');
  assert.equal(plan.tasks[1].check, 'node cli.js list | grep -q milk');
  assert.equal(plan.tasks[0].status, 'pending');
});

test('reads a plan wrapped in a code fence', () => {
  const { ok, plan } = parsePlan(`\`\`\`markdown\n${GOOD}\`\`\``);
  assert.equal(ok, true);
  assert.equal(plan.tasks.length, 2);
});

test('rejects a Check that is a sentence, not a command', () => {
  const bad = GOOD.replace('Check: node --test', 'Check: Run a test to verify Todo objects are created correctly.');
  const { ok, errors } = parsePlan(bad);
  assert.equal(ok, false);
  assert.match(errors[0], /Task 1's Check is not a shell command/);
});

test('looksLikeCommand tells prose from commands', () => {
  for (const good of ['node --test', 'npm test', 'test -f index.html && grep -q h1 index.html', 'python3 -m py_compile app.py', '`node cli.js list`', 'grep -q "<nav>" index.html',
    'make test', 'go test ./...', 'CI=1 npm test', 'NODE_ENV=test node --test', 'PORT=3000 node server.js']) {
    assert.equal(looksLikeCommand(good), true, good);
  }
  for (const bad of ['', 'Run the tests', 'Verify data.json is created', 'Test the CLI with various commands', 'npm install runs successfully', 'ls /path/to/dir', 'the app starts', 'Check the output',
    'make sure the tests pass', 'CI=1', 'node cli.js ...']) {
    assert.equal(looksLikeCommand(bad), false, bad);
  }
});

test('reports missing pieces', () => {
  const { ok, errors } = parsePlan('## Task 1: Thing\nFiles: a.js\n');
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /no "# Plan:/.test(e)));
  assert.ok(errors.some((e) => /Task 1 has no "Do:"/.test(e)));
  assert.ok(errors.some((e) => /Task 1 has no "Check:"/.test(e)));
});

test('refuses no tasks and too many tasks', () => {
  assert.equal(parsePlan('# Plan: Empty\n\n## Decisions\n- x\n').ok, false);
  const many = ['# Plan: Big', '## Decisions', '- x']
    .concat(Array.from({ length: 9 }, (_, i) => `## Task ${i + 1}: t\nFiles: a\nDo: d\nCheck: node a.js`))
    .join('\n');
  const { ok, errors } = parsePlan(many);
  assert.equal(ok, false);
  assert.match(errors[0], /at most 8/);
});

test('render then parse round-trips, keeping status and evidence', () => {
  const { plan } = parsePlan(GOOD);
  const marked = markTask(plan, 1, 'done', 'node --test exited 0');
  const again = parsePlan(renderPlan(marked));
  assert.equal(again.ok, true);
  assert.equal(again.plan.tasks[0].status, 'done');
  assert.equal(again.plan.tasks[0].evidence, 'node --test exited 0');
  assert.equal(again.plan.tasks[1].status, 'pending');
});

test('a task cannot be marked done without evidence', () => {
  const { plan } = parsePlan(GOOD);
  assert.throws(() => markTask(plan, 1, 'done', ''), /without evidence/);
  assert.throws(() => markTask(plan, 1, 'done', '   '), /without evidence/);
  assert.throws(() => markTask(plan, 1, 'finished', 'x'), /Unknown task status/);
  assert.equal(markTask(plan, 1, 'failed', '').tasks[0].status, 'failed');
});

test('markTask does not mutate the plan it was given', () => {
  const { plan } = parsePlan(GOOD);
  markTask(plan, 1, 'done', 'ok');
  assert.equal(plan.tasks[0].status, 'pending');
});

test('nextPending walks the plan in order', () => {
  const { plan } = parsePlan(GOOD);
  assert.equal(nextPending(plan).n, 1);
  const one = markTask(plan, 1, 'done', 'ok');
  assert.equal(nextPending(one).n, 2);
  assert.equal(nextPending(markTask(one, 2, 'done', 'ok')), null);
});

test('a coder brief carries decisions, finished work and its own task only', () => {
  const { plan } = parsePlan(GOOD);
  const one = markTask(plan, 1, 'done', 'ok');
  const brief = taskBrief(one, one.tasks[1], { context: 'todos.json lives next to cli.js' });
  assert.match(brief, /Node\.js, CommonJS/);
  assert.match(brief, /Already built by earlier tasks:\n- Data layer \(todos\.js\)/);
  assert.match(brief, /todos\.json lives next to cli\.js/);
  assert.match(brief, /YOUR TASK \(2 of 2\): CLI/);
  assert.match(brief, /exits 0: node cli\.js list \| grep -q milk/);
  assert.doesNotMatch(brief, /Implement add, list, done/);
  assert.doesNotMatch(brief, /PREVIOUS ATTEMPT/);
  assert.match(taskBrief(one, one.tasks[1], { failure: 'exit 1: no output' }), /PREVIOUS ATTEMPT FAILED[\s\S]*exit 1: no output/);
});

test('a Check that greps an error message through a pipe is refused: stderr does not cross it', () => {
  const bad = GOOD.replace('Check: node --test', 'Check: node cli.js remove 999 | grep -q "Todo with id 999 not found"');
  const { ok, errors } = parsePlan(bad);
  assert.equal(ok, false);
  assert.match(errors[0], /Task 1's Check looks for an error message through a pipe[\s\S]*2>&1/);
  assert.equal(greppsErrorFromPipe('node cli.js remove 999 2>&1 | grep -q "not found"'), false);
  assert.equal(greppsErrorFromPipe('node cli.js remove 999 |& grep -q "not found"'), false);
  assert.equal(greppsErrorFromPipe('node cli.js list | grep -q milk'), false);
  assert.equal(greppsErrorFromPipe('node cli.js add x | grep -q "Added"'), false);
  assert.equal(greppsErrorFromPipe('node cli.js bogus | grep -qi "unknown command"'), true);
});

