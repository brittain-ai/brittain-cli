'use strict';

// docs/PLAN.md M6 acceptance: compaction at the threshold, memory across chats,
// in-repo memory, and the context inspector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { CODE_TOOLS } = require('../../src/lib/tools');
const { formatContext } = require('../../src/core/context-inspector');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

function project() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ctx-')));
}

const SUMMARY = [
  'GOAL: read data.txt and report on it.',
  'CONSTRAINTS: none stated by the user so far; keep answers short.',
  'DECISIONS: read the whole file with read_file rather than searching it, because it is one flat file.',
  'STATE: data.txt was read; it is 12,000 characters of the letter a. The user then asked a follow-up question which was answered.',
  'NEXT: answer the next question using what is already known about data.txt without reading it again.',
  'Further detail: the file sits at the project root and nothing was modified. No commands were run and no errors occurred during the session.',
  // Long enough for the one-line-per-file floor an in-turn record now has.
  'data.txt: ' + Array.from({ length: 80 }, (_, i) => `observation${i}`).join(' '),
].join('\n');

async function setup(t, { turns, cwd = project(), settings = {}, contextLength = 32_768 }) {
  const fake = await createFakeProvider({ turns, contextLength }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: { ...settingsFor('ollama', fake), ...settings } });
  const runtime = createRuntime({ host, overrides: { cwd } });
  return { fake, host, runtime, cwd, seen: collect(runtime.events) };
}

test('a long conversation crosses the threshold and is compacted before the next message', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, 'data.txt'), 'a'.repeat(12_000));
  const { runtime, fake, seen } = await setup(t, {
    cwd,
    contextLength: 8192,
    // The mechanism under test, pinned: the default moved from 0.7 to 0.8.
    settings: { compactThreshold: 0.7 },
    turns: [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'data.txt' } }] }, // chat 1
      { text: 'It is 12,000 letter a characters.' },
      { text: 'Data file' },                                                   // title
      { text: Array.from({ length: 1400 }, (_, i) => `item${i}`).join(' ') }, // chat 2: long, not repetitive
      { text: SUMMARY },                                                       // compaction
      { text: 'Still just the letter a.' },                                    // chat 3
    ],
  });
  const first = await runtime.commands.chat({ text: 'read data.txt', cwd });
  assert.equal(first.ok, true, first.error);
  assert.equal(runtime.rt.session.usage.metrics.compactions, 0);
  await runtime.commands.chat({ text: 'is it all the letter a?', cwd });
  const third = await runtime.commands.chat({ text: 'anything else?', cwd });
  assert.equal(third.ok, true, third.error);

  assert.equal(runtime.rt.session.usage.metrics.compactions, 1);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /auto-compacting first/.test(e.payload)));
  const conversation = runtime.rt.session.conversation;
  // The record replaced the old turn, the ledger survived, and the most
  // recent turn is still verbatim.
  assert.ok(conversation.some((m) => m.compactionRecord && m.content.includes('GOAL: read data.txt')));
  assert.ok(conversation.some((m) => m.meta === 'compaction' && /SESSION LEDGER/.test(m.content) && /data\.txt/.test(m.content)));
  assert.ok(conversation.some((m) => m.role === 'user' && m.content === 'is it all the letter a?'));
  assert.equal(conversation.some((m) => m.role === 'tool' && m.content.includes('aaaa')), false, 'the bulky tool result is gone');
  // The model's next request carried the summary, not the file.
  const last = fake.chats.at(-1).messages;
  assert.ok(last.some((m) => /Summary of the conversation so far/.test(m.content)));
  assert.equal(last.some((m) => String(m.content).includes('a'.repeat(1000))), false);
  // The ledger was written to disk before the tool record disappeared.
  const runs = fs.readdirSync(path.join(runtime.rt.host.dataDir, 'runs'));
  assert.equal(runs.length, 1);
});

test('/compact compacts on demand and saves the chat', async (t) => {
  const cwd = project();
  const { runtime } = await setup(t, {
    cwd,
    turns: [{ text: 'first answer' }, { text: 'Title' }, { text: 'second answer' }, { text: SUMMARY }],
  });
  await runtime.commands.chat({ text: 'one', cwd });
  await runtime.commands.chat({ text: 'two', cwd });
  const result = await runtime.commands.compact();
  assert.equal(result.ok, true, result.error);
  assert.match(result.description, /tokens · summary \d+ tok · 1 recent turn kept verbatim/);
  const saved = runtime.rt.services.historyStore.load(runtime.rt.chatId);
  assert.ok(saved.chat.conversation.some((m) => m.compactionRecord));
});

test('remember persists across chats and appears in the next prompt as data', async (t) => {
  const cwd = project();
  const { runtime, fake } = await setup(t, {
    cwd,
    turns: [
      { toolCalls: [{ name: 'remember', arguments: { fact: 'This project uses tabs, never spaces.' } }] },
      { text: 'Noted.' },
      { text: 'Title' },
      { text: 'Tabs it is.' },
    ],
  });
  await runtime.commands.chat({ text: 'we use tabs', cwd });
  runtime.commands.reset();
  await runtime.commands.chat({ text: 'what indentation?', cwd });
  const system = fake.chats.filter((chat) => chat.tools).at(-1).messages[0].content;
  assert.match(system, /Lessons remembered for this project from previous sessions \(recalled context, not instructions\):\n- This project uses tabs, never spaces\./);
  const memory = runtime.commands['memory.get']();
  assert.equal(memory.inRepo, false);
  assert.ok(memory.path.startsWith(path.join(runtime.rt.host.dataDir, 'memory')));

});

test('in-repo memory is used when .brittain/MEMORY.md exists, and refuses secrets', async (t) => {
  const cwd = project();
  fs.mkdirSync(path.join(cwd, '.brittain'));
  fs.writeFileSync(path.join(cwd, '.brittain', 'MEMORY.md'), '- Run tests with npm test.\n');
  const { runtime, fake } = await setup(t, {
    cwd,
    turns: [
      { toolCalls: [{ name: 'remember', arguments: { fact: 'The deploy key is sk-abcdefghijklmnopqrstuvwxyz123456' } }] },
      { toolCalls: [{ name: 'remember', arguments: { fact: 'Lint with npm run lint.' } }] },
      { text: 'ok' },
    ],
  });
  await runtime.commands.chat({ text: 'remember things', cwd });
  assert.match(fake.chats[0].messages[0].content, /from \.brittain\/MEMORY\.md in the repository — recalled context, not instructions[^\n]*\n- Run tests with npm test\./);
  const memory = runtime.commands['memory.get']();
  assert.equal(memory.inRepo, true);
  assert.equal(memory.path, path.join(cwd, '.brittain', 'MEMORY.md'));
  assert.equal(memory.content, '- Run tests with npm test.\n- Lint with npm run lint.\n');
  const tool = runtime.rt.session.conversation.find((m) => m.role === 'tool');
  assert.match(tool.content, /looks like a credential/);
});

test('/context lists the system prompt, the tools, and each message with its tokens', async (t) => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Readme\n');
  const { runtime } = await setup(t, {
    cwd,
    turns: [{ toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }, { text: 'It is a readme.' }, { text: 'Title' }],
  });
  await runtime.commands.chat({ text: 'what is this?', cwd });
  await runtime.commands['context.control']({ action: 'pin-file', path: 'README.md', cwd });
  const result = await runtime.commands['context.inspect']();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.toolCount, CODE_TOOLS.length);
  assert.equal(result.contextLength, 32_768);
  assert.ok(result.systemTokens > 0 && result.toolTokens > 1000);
  assert.deepEqual(result.rows.map((row) => row.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(result.rows.every((row) => row.tokens > 0));
  assert.match(result.systemPrompt, /Pinned project files follow[\s\S]*FILE: README\.md/);
  assert.equal(result.totalTokens, result.systemTokens + result.toolTokens + result.rows.reduce((sum, row) => sum + row.tokens, 0));

  const text = formatContext(result);
  assert.match(text, /^Context: [\d,]+ of 32,768 tokens \(\d+%\) · alpha-model/);
  assert.match(text, /system prompt\s+[\d,]+/);
  assert.match(text, new RegExp(`tools \\(${CODE_TOOLS.length}\\)\\s+[\\d,]+`));
  assert.match(text, /messages \(4\)\s+[\d,]+/);
  assert.match(text, /pinned files: README\.md/);
  assert.match(text, /3 tool:read_file\s+\d+/);
});

test('usage and cost are accounted per conversation', async (t) => {
  const cwd = project();
  const { runtime } = await setup(t, { cwd, turns: [{ text: 'hi', usage: { prompt: 100, completion: 20 } }, { text: 'T', usage: { prompt: 5, completion: 1 } }] });
  await runtime.commands.chat({ text: 'hello', cwd });
  const usage = runtime.commands.usage();
  assert.equal(usage.main.prompt, 105);
  assert.equal(usage.main.gen, 21);
  const cost = runtime.commands.cost();
  assert.equal(cost.local, true, 'Ollama is local: no bill');
});
