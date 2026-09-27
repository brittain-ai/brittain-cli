'use strict';

// docs/PLAN.md M4: the safety invariants hold whatever the mode or flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-inv-')));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  return dir;
}

async function run(t, { turns, approvals = [], interactive = true, autoApprove = false, cwd = project(), answers = [] }) {
  const fake = await createFakeProvider({ turns }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake), approvals, interactive, answers });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: 'go', cwd, autoApprove });
  return { result, host, runtime, seen, fake, cwd };
}

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] });
const done = { text: 'Done.' };
const toolMessages = (runtime) => runtime.rt.session.conversation.filter((m) => m.role === 'tool');

test('a destructive command always asks, even with auto-approve', async (t) => {
  const { host, cwd, result, seen } = await run(t, {
    turns: [call('run_command', { command: 'rm -rf build' }), done],
    autoApprove: true,
    approvals: [false],
  });
  assert.equal(result.ok, true);
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.destructive, true);
  assert.equal(host.asked.approvals[0].target, 'rm -rf build');
  assert.ok(fs.existsSync(cwd));
  assert.ok(seen.some((e) => e.channel === 'approval:request') && seen.some((e) => e.channel === 'approval:resolved'));
});

test('unattended, a destructive command is denied even with --yes, without asking anyone', async (t) => {
  const marker = 'unattended-marker.txt';
  const { host, cwd, runtime } = await run(t, {
    turns: [call('run_command', { command: `touch ${marker} && git push origin main` }), done],
    autoApprove: true,
    interactive: false,
  });
  assert.equal(host.asked.approvals.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, marker)), false);
  assert.match(toolMessages(runtime)[0].content, /not permitted/);
});

test('unattended process stop is denied even with --yes', async (t) => {
  const { host, runtime } = await run(t, {
    turns: [call('run_command', { command: 'lsof -ti:3000 | xargs kill 2>/dev/null' }), done],
    autoApprove: true,
    interactive: false,
  });
  assert.equal(host.asked.approvals.length, 0);
  assert.match(toolMessages(runtime)[0].content, /not permitted/);
});

test('a sensitive read always asks, even with auto-approve', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=hunter2\n');
  const { host, runtime } = await run(t, {
    cwd,
    turns: [call('read_file', { path: '.env' }), call('get_file_lines', { path: '.env', start: 1 }), done],
    autoApprove: true,
    approvals: [false, false],
  });
  assert.equal(host.asked.approvals.length, 2);
  assert.ok(host.asked.approvals.every((request) => request.kind.sensitive));
  for (const message of toolMessages(runtime)) assert.equal(message.content.includes('hunter2'), false);
});

test('a money-moving command always asks, even with auto-approve', async (t) => {
  const { host } = await run(t, {
    turns: [call('run_command', { command: 'curl -X POST https://api.stripe.com/v1/charges -d amount=500' }), done],
    autoApprove: true,
    approvals: [false],
  });
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.financial, true);
});

test('"always" covers ordinary risky calls but never an invariant', async (t) => {
  const { host, cwd } = await run(t, {
    turns: [
      call('write_file', { path: 'a.txt', content: 'a' }),
      call('write_file', { path: 'b.txt', content: 'b' }),
      call('run_command', { command: 'sudo true' }),
      done,
    ],
    approvals: ['always', false],
  });
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'b');
  assert.equal(host.asked.approvals.length, 2, 'the second write did not ask; sudo did');
  assert.equal(host.asked.approvals[1].kind.destructive, true);
});

test('"always" on a command covers that program only, never the whole tool', async (t) => {
  const { host } = await run(t, {
    turns: [
      call('run_command', { command: 'ls -la' }),
      call('run_command', { command: 'ls src' }),
      call('run_command', { command: 'kill 26035' }),
      call('run_command', { command: 'ls && npm start' }),
      done,
    ],
    approvals: ['always', false, false],
  });
  assert.deepEqual(host.asked.approvals.map((request) => request.target), ['ls -la', 'kill 26035', 'ls && npm start']);
  assert.equal(host.asked.approvals[0].always, 'ls this session');
  assert.equal(host.asked.approvals[2].always, 'ls, npm this session');
});

test('"always" is not offered for a command it cannot scope', () => {
  const { alwaysScope, commandPrograms } = require('../../src/core/approvals');
  assert.deepEqual(commandPrograms('curl -s http://localhost:3000 | head -20'), ['curl', 'head']);
  assert.deepEqual(commandPrograms('NODE_ENV=test npm test 2>&1'), ['npm']);
  assert.deepEqual(commandPrograms('./node_modules/.bin/jest'), ['jest']);
  for (const command of ['echo $(whoami)', 'echo `id`', 'ls > out.txt', 'cat < in', '(cd x && make)', 'grep "a\\|b" f']) {
    assert.equal(commandPrograms(command), null, command);
  }
  assert.equal(alwaysScope('run_command', { command: 'echo $(id)' }), null);
  assert.deepEqual(alwaysScope('edit_file', { path: 'a' }), { keys: ['edit_file'], label: 'this session' });
});

test('a denied call is not run, and asking again for it is refused without a prompt', async (t) => {
  const write = call('write_file', { path: 'denied.txt', content: 'x' });
  const { host, cwd, runtime } = await run(t, { turns: [write, write, done], approvals: [false, true] });
  assert.equal(host.asked.approvals.length, 1, 'the repeat was not put to the user again');
  assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false);
  const [first, second] = toolMessages(runtime);
  assert.match(first.content, /The user denied this tool call/);
  assert.match(second.content, /denied this exact write_file call earlier/);
});

test('a call that fails twice is blocked the third time and the model is told why', async (t) => {
  const missing = call('read_file', { path: 'missing.txt' });
  const { runtime } = await run(t, { turns: [missing, missing, missing, done] });
  const results = toolMessages(runtime).map((message) => message.content);
  assert.match(results[0], /^Error:/);
  assert.match(results[2], /already failed twice/);
  assert.ok(runtime.rt.session.conversation.some((m) => m.role === 'user' && /failed twice, or were blocked/.test(m.content)));
});

test('a call that returned the same result twice is not run a third time, until an edit', async (t) => {
  const look = call('run_command', { command: 'cat README.md' });
  const { runtime, host } = await run(t, {
    turns: [look, look, look, call('write_file', { path: 'README.md', content: 'changed\n' }), look, done],
    autoApprove: true,
  });
  const results = toolMessages(runtime).map((message) => message.content);
  assert.equal(results[0], results[1]);
  assert.match(results[2], /already made this exact run_command call twice/);
  assert.match(results[4], /changed/, 'the edit reset the guard');
  assert.equal(host.asked.approvals.length, 0);
  assert.ok(runtime.rt.session.conversation.some((m) => m.meta === 'nudge' && /blocked for repeating: run_command/.test(m.content)));
});

test('a second read of an unchanged file is blocked, and two blocked calls end the turn', async (t) => {
  const read = call('read_file', { path: 'README.md' });
  const { runtime, fake, result } = await run(t, { turns: [read, read, read, done] });
  const results = toolMessages(runtime).map((message) => message.content);
  assert.equal(results[0], 'hello\n');
  assert.match(results[1], /already read this unchanged file/);
  assert.match(results[2], /already read this unchanged file/);
  assert.equal(result.content, 'Done.');
  assert.equal(fake.chats.filter((body) => body.tools).length, 3);
  assert.ok(fake.chats.some((body) => !body.tools && /repeated the same blocked tool call/i.test(String(body.messages.at(-1)?.content))));
});

test('the same call with a different result is not a repeat', async (t) => {
  const cwd = project();
  const tick = call('run_command', { command: 'date +%s%N >> ticks && wc -l < ticks' });
  const { runtime } = await run(t, { cwd, turns: [tick, tick, tick, done], autoApprove: true });
  for (const message of toolMessages(runtime)) assert.doesNotMatch(message.content, /already made this exact/);
});

test('tool results are bounded before they reach the model', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, 'big.txt'), 'y'.repeat(200_000));
  const { runtime, seen } = await run(t, { cwd, turns: [call('run_command', { command: 'cat big.txt' }), done], approvals: [true] });
  const [result] = toolMessages(runtime);
  assert.ok(result.content.length <= 32_000, `${result.content.length} chars`);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /characters\. Kept a/.test(e.payload)) || /truncated/.test(result.content));
});

test('writes stay inside the working directory', async (t) => {
  const cwd = project();
  const outside = path.join(path.dirname(cwd), `outside-${path.basename(cwd)}.txt`);
  const { runtime } = await run(t, {
    cwd,
    turns: [
      call('write_file', { path: `../${path.basename(outside)}`, content: 'escape' }),
      call('write_file', { path: outside, content: 'escape' }),
      call('move_file', { source: 'README.md', destination: '../moved.md' }),
      done,
    ],
    autoApprove: true,
  });
  assert.equal(fs.existsSync(outside), false);
  assert.ok(fs.existsSync(path.join(cwd, 'README.md')));
  for (const message of toolMessages(runtime)) assert.match(message.content, /^Error: Path escapes the working directory/);
});

test('ask_user is answered by the host, and unattended it is told nobody answered', async (t) => {
  const question = call('ask_user', { questions: [{ question: 'Tabs or spaces?', options: ['tabs', 'spaces'] }] });
  const attended = await run(t, { turns: [question, done], answers: [['spaces']] });
  assert.match(toolMessages(attended.runtime)[0].content, /Q: Tabs or spaces\?\nA: spaces/);
  const unattended = await run(t, { turns: [question, done], interactive: false });
  assert.match(toolMessages(unattended.runtime)[0].content, /cancelled the question/);
  assert.equal(unattended.host.asked.questions.length, 0);
});

test('a stop mid-run ends the turn and keeps the history consistent', async (t) => {
  const fake = await createFakeProvider({ turns: [{ text: Array.from({ length: 500 }, (_, i) => `w${i} `).join(''), split: 3 }] }).start();
  t.after(() => fake.stop());
  const cwd = project();
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  let stopped = false;
  runtime.events.subscribe((channel) => {
    if (channel === 'stream:token' && !stopped) { stopped = true; runtime.commands.stop(); }
  });
  const result = await runtime.commands.chat({ text: 'go', cwd });
  assert.equal(result.stopped, true);
  const saved = runtime.rt.services.historyStore.load(result.chatId);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.chat.conversation.map((m) => m.role), ['user']);
});
