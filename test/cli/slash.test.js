'use strict';

// docs/PLAN.md M7 acceptance: each command has a parse test; /help output matches
// the table.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createRuntime } = require('../../src/core/runtime');
const { CODE_TOOLS } = require('../../src/lib/tools');
const { createSlash, parseSlash, matchModels, onOff } = require('../../src/cli/slash');
const { createStyles } = require('../../src/cli/markdown');
const { createFakeProvider } = require('../helpers/fake-provider');
const { createTestHost, settingsFor } = require('../helpers/test-host');

// docs/PLAN.md M7, in order, plus /build (a CLI addition: docs/PLAN.md §10).
const PLAN_TABLE = [
  '/help', '/clear', '/provider [brittain|openai|ollama]', '/model [name]',
  '/auto on|off', '/think on|off', '/compact', '/context', '/usage', '/cost', '/ledger',
  '/memory', '/diff', '/commit <msg>', '/build [goal]', '/undo', '/history', '/export [path]', '/tools',
];

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-slash-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

async function setup(t, { turns = [{ text: 'ok' }], picks = [] } = {}) {
  const fake = await createFakeProvider({ turns, models: ['qwen3:8b', 'qwen3-coder:30b', 'llama3.2:3b'] }).start();
  t.after(() => fake.stop());
  const cwd = gitRepo();
  const host = createTestHost({ settings: settingsFor('ollama', fake, 'qwen3:8b') });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const lines = [];
  const built = [];
  const pickQueue = [...picks];
  const ui = {
    style: createStyles(false),
    color: false,
    state: { autoApprove: false },
    line: (text) => lines.push(String(text)),
    page: (text) => lines.push(String(text)),
    build: async (goal) => { built.push(goal); },
    pick: async (question, items) => {
      lines.push(question, ...items.map((item) => item.label));
      return pickQueue.length ? pickQueue.shift() : null;
    },
  };
  const slash = createSlash({ runtime, ui });
  const run = async (input) => {
    lines.length = 0;
    const handled = await slash.handle(input);
    assert.equal(handled, true);
    return lines.join('\n');
  };
  return { fake, cwd, host, runtime, ui, slash, run, built };
}

test('parseSlash splits the name and arguments', () => {
  assert.deepEqual(parseSlash('/commit fix the thing  '), { name: 'commit', rest: 'fix the thing', args: ['fix', 'the', 'thing'] });
  assert.deepEqual(parseSlash('/HELP'), { name: 'help', rest: '', args: [] });
  assert.equal(parseSlash('not a command'), null);
  assert.equal(onOff('on'), true);
  assert.equal(onOff('OFF'), false);
  assert.equal(onOff(undefined, true), false);
  assert.equal(onOff('maybe'), null);
  assert.deepEqual(matchModels(['qwen3:8b', 'qwen3-coder:30b', 'llama3.2:3b'], 'coder'), ['qwen3-coder:30b']);
  assert.deepEqual(matchModels(['qwen3:8b', 'llama3.2:3b'], 'l32'), ['llama3.2:3b']);
});

test('/help lists exactly the table, in order', async (t) => {
  const s = await setup(t);
  assert.deepEqual(s.slash.table.map((entry) => entry.usage), PLAN_TABLE);
  const out = await s.run('/help');
  assert.deepEqual(out.split('\n').map((line) => line.split(/\s{2,}/)[0]), PLAN_TABLE);
});

test('/build passes the goal on, or an empty goal to resume the plan', async (t) => {
  const s = await setup(t);
  await s.run('/build a todo app in Node');
  await s.run('/build');
  assert.deepEqual(s.built, ['a todo app in Node', '']);
});

test('/clear starts a new chat', async (t) => {
  const s = await setup(t);
  await s.runtime.commands.chat({ text: 'hi', cwd: s.cwd });
  assert.equal(s.runtime.rt.session.conversation.length, 2);
  assert.match(await s.run('/clear'), /Started a new chat/);
  assert.equal(s.runtime.rt.session.conversation.length, 0);
});

test('there is no /mode: chat mode was removed', async (t) => {
  const s = await setup(t);
  assert.match(await s.run('/mode chat'), /Unknown command \/mode/);
});

test('/provider shows a picker and switches directly', async (t) => {
  const s = await setup(t, { picks: [null] });
  const out = await s.run('/provider');
  assert.match(out, /brittain\s+Brittain/);
  assert.match(out, /ollama\s+Ollama · qwen3:8b/);
  assert.match(await s.run('/provider brittain'), /Provider: brittain \(Brittain\) · model: run4c-step-0116/);
  assert.equal(s.runtime.rt.config.stored().provider, 'brittain');
  assert.match(await s.run('/provider nope'), /Unknown provider/);
});

test('/model fuzzy-matches for the active provider', async (t) => {
  const s = await setup(t, { picks: ['llama3.2:3b'] });
  assert.match(await s.run('/model coder'), /Model: qwen3-coder:30b/);
  assert.equal(s.runtime.rt.providers.resolve().model, 'qwen3-coder:30b');
  const out = await s.run('/model');
  assert.match(out, /qwen3:8b/);
  assert.equal(s.runtime.rt.providers.resolve().model, 'llama3.2:3b');
  assert.match(await s.run('/model zzz'), /No model matches "zzz"/);
});

test('/auto toggles trusted and supervised', async (t) => {
  const s = await setup(t);
  assert.match(await s.run('/auto on'), /trusted/);
  assert.equal(s.ui.state.autoApprove, true);
  assert.match(await s.run('/auto off'), /supervised/);
  assert.match(await s.run('/auto sometimes'), /Usage/);
});

test('/think toggles model reasoning', async (t) => {
  const s = await setup(t);
  assert.match(await s.run('/think on'), /Thinking on\./);
  assert.equal(s.runtime.rt.config.stored().codeThink, true);
  assert.match(await s.run('/think off'), /Thinking off\./);
  assert.equal(s.runtime.rt.config.stored().codeThink, false);
  assert.match(await s.run('/think maybe'), /Usage/);
});

test('/compact, /context, /usage, /cost, /ledger report as the source does', async (t) => {
  const s = await setup(t, {
    turns: [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { text: 'It says one.' },
      { text: 'Title' },
      { text: 'Second.' },
      { text: ['GOAL: x', 'CONSTRAINTS: y', 'DECISIONS: z', 'STATE: a.txt read', 'NEXT: nothing'].join('\n') + '\n' + Array.from({ length: 150 }, (_, i) => `fact${i}`).join(' ') },
    ],
  });
  await s.runtime.commands.chat({ text: 'read a.txt', cwd: s.cwd });
  await s.runtime.commands.chat({ text: 'and?', cwd: s.cwd });
  assert.match(await s.run('/context'), new RegExp(`^Context: [\\d,]+ of [\\d,]+ tokens[\\s\\S]*tools \\(${CODE_TOOLS.length}\\)`));
  assert.match(await s.run('/usage'), /in · [\d,]+ out over \d+ model calls[\s\S]*tool calls 1/);
  assert.match(await s.run('/cost'), /Local model — there is no bill/);
  assert.match(await s.run('/ledger'), /SESSION LEDGER[\s\S]*a\.txt/);
  assert.match(await s.run('/compact'), /Compacted: .*tokens/);
});

test('/memory shows memory and its path', async (t) => {
  const s = await setup(t);
  await s.runtime.rt.tools.executeTool('remember', { fact: 'Prefer small commits.' }, s.cwd);
  const out = await s.run('/memory');
  assert.match(out, /Memory for this project: .*memory\/projects\/[0-9a-f]+\.md/);
  assert.match(out, /- Prefer small commits\./);
});

test('/diff shows the working-tree diff and untracked files', async (t) => {
  const s = await setup(t);
  assert.match(await s.run('/diff'), /No changes\./);
  fs.writeFileSync(path.join(s.cwd, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(s.cwd, 'new.txt'), 'n\n');
  const out = await s.run('/diff');
  assert.match(out, /-one\n\+two/);
  assert.match(out, /Untracked: new\.txt/);
});

test('/commit stages everything and commits', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.cwd, 'b.txt'), 'b\n');
  assert.match(await s.run('/commit'), /Usage/);
  assert.match(await s.run('/commit add b'), /add b/);
  const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: s.cwd, encoding: 'utf8' });
  assert.match(log, /add b/);
});

test('/undo restores the last checkpoint', async (t) => {
  const s = await setup(t, {
    turns: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'changed\n' } }] }, { text: 'done' }, { text: 'T' }],
  });
  s.host.approve = async () => true;
  await s.runtime.commands.chat({ text: 'change it', cwd: s.cwd });
  assert.equal(fs.readFileSync(path.join(s.cwd, 'a.txt'), 'utf8'), 'changed\n');
  assert.match(await s.run('/undo'), /Restored the working tree/);
  assert.equal(fs.readFileSync(path.join(s.cwd, 'a.txt'), 'utf8'), 'one\n');
});

test('/history lists, loads, and deletes saved chats', async (t) => {
  const s = await setup(t, { turns: [{ text: 'hello back' }, { text: 'Greeting chat' }] });
  const { chatId } = await s.runtime.commands.chat({ text: 'hello', cwd: s.cwd });
  s.runtime.commands.reset();
  const listed = await s.run('/history');
  assert.match(listed, /Greeting chat/);
  assert.match(await s.run(`/history load ${chatId}`), /Loaded "Greeting chat" \(2 messages\)/);
  s.runtime.commands.reset();
  assert.match(await s.run(`/history delete ${chatId}`), /Deleted/);
  assert.match(await s.run('/history'), /No saved chats yet/);
});

test('/export writes the chat as Markdown', async (t) => {
  const s = await setup(t, { turns: [{ text: 'An **answer**.' }, { text: 'T' }] });
  assert.match(await s.run('/export'), /Nothing to export/);
  await s.runtime.commands.chat({ text: 'a question', cwd: s.cwd });
  const out = await s.run('/export notes/chat.md');
  assert.match(out, /Exported to .*notes\/chat\.md/);
  const markdown = fs.readFileSync(path.join(s.cwd, 'notes', 'chat.md'), 'utf8');
  assert.equal(markdown, '## You\n\na question\n\n## Model\n\nAn **answer**.\n');
  assert.match(await s.run('/export notes/chat.md'), /already exists/);
});

test('/tools lists the tools with their flags', async (t) => {
  const s = await setup(t);
  const out = await s.run('/tools');
  assert.match(out, /^read_file\s*$/m);
  assert.match(out, /^run_command\s+risky$/m);
  assert.equal(out.split('\n').filter((line) => /^\w+/.test(line) && !/^Destructive/.test(line)).length, CODE_TOOLS.length);
});

test('an unknown command says so', async (t) => {
  const s = await setup(t);
  assert.match(await s.run('/frobnicate'), /Unknown command \/frobnicate/);
});
