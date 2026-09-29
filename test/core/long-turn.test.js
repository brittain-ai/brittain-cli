'use strict';

// A replay of a real session: on a 32k model, "give me a quick report" read
// file after file in one turn. Compaction could not keep anything (a turn was
// the smallest unit it would keep), and the request that finally went out was
// over the window and came back as a provider 400.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

const WINDOW = 32_768;
// contextLength − response reserve − safety margin, as the agent loop computes it.
const HARD_INPUT = WINDOW - 4096 - 2048;
const REQUEST = 'Look into this repo and give me a quick report';
const FILES = 10;

const estimate = (body) => Math.round(JSON.stringify([...(body.messages || []), ...(body.tools || [])]).length / 4);

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-long-')));
  for (let i = 0; i < FILES; i++) {
    const lines = Array.from({ length: 900 }, (_, n) => `// file ${i} line ${n}: const value${n} = compute(${n}, "${i}");`);
    fs.writeFileSync(path.join(dir, `module${i}.js`), lines.join('\n'));
  }
  return dir;
}

function summaryText(index) {
  return [
    `GOAL: ${REQUEST}.`,
    'CONSTRAINTS: none stated.',
    `DECISIONS: read each module in turn (pass ${index}).`,
    'STATE: several modules were read; each defines computed constants.',
    'NEXT: read the remaining modules, then write the report.',
    Array.from({ length: 120 }, (_, n) => `note${index}_${n}`).join(' '),
  ].join('\n');
}

test('one long turn on a 32k model compacts inside the turn and never overruns the window', async (t) => {
  const cwd = repo();
  let reads = 0;
  let missing = 0;
  let summaries = 0;
  const agentRequests = [];
  const fake = await createFakeProvider({
    contextLength: WINDOW,
    respond: (body) => {
      if (!body.tools) {
        const system = String(body.messages?.[0]?.content || '');
        if (/Create a clear title/.test(system)) return { text: 'Repo report' };
        summaries += 1;
        return { text: summaryText(summaries) };
      }
      agentRequests.push(body);
      // Guess a missing file twice mid-turn, as a real model did: the loop
      // then adds a failure note to the conversation as a user-role message.
      if (reads === 3 && missing < 2) {
        missing += 1;
        return { toolCalls: [{ name: 'read_file', arguments: { path: 'missing.js' } }] };
      }
      if (reads < FILES) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'Ten modules, each defining computed constants. Report done.' };
    },
  }).start();
  t.after(() => fake.stop());

  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: REQUEST, cwd });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.content, 'Ten modules, each defining computed constants. Report done.');
  assert.equal(reads, FILES, 'every file was read');

  // Compaction happened, inside the turn, and was reported as such.
  const compactions = runtime.rt.session.usage.metrics.compactions;
  assert.ok(compactions >= 1, `compactions: ${compactions}`);
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /current request (and \d+ recent steps? )?kept verbatim/.test(e.payload)));
  assert.equal(seen.some((e) => e.channel === 'stream:info' && /Auto-compact failed/.test(e.payload)), false);

  // No request the model received was larger than it can take.
  for (const body of agentRequests) {
    assert.ok(estimate(body) <= HARD_INPUT, `a request of ~${estimate(body)} tokens exceeded ${HARD_INPUT}`);
  }

  // Each file read was capped to an eighth of the window.
  for (const body of agentRequests) {
    for (const message of body.messages.filter((m) => m.role === 'tool')) {
      assert.ok(message.content.length <= 16_384, `tool result of ${message.content.length} chars`);
    }
  }

  // The failure note really was in the conversation mid-turn.
  assert.ok(agentRequests.some((body) => body.messages.some((m) => /failed twice, or were blocked/.test(m.content))));
  // The request survived verbatim, with the summary of what came before it.
  const last = agentRequests.at(-1).messages;
  assert.ok(last.some((m) => m.role === 'user' && m.content === REQUEST));
  assert.ok(last.some((m) => /Summary of the conversation so far/.test(m.content)));
  // Each compaction's ledger covers the reads since the one before; older
  // ones are carried by the summary (as in the source).
  assert.ok(last.some((m) => /SESSION LEDGER/.test(m.content) && /module\d\.js/.test(m.content)), 'the ledger lists earlier reads');
});

test('/compact works partway through a long turn', async (t) => {
  const cwd = repo();
  let reads = 0;
  const fake = await createFakeProvider({
    contextLength: 65_536,
    respond: (body) => {
      if (!body.tools) return { text: /Create a clear title/.test(String(body.messages?.[0]?.content)) ? 'T' : summaryText(1) };
      if (reads < 4) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'done' };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  await runtime.commands.chat({ text: REQUEST, cwd });
  // One turn only: before, this was refused as "the most recent turn is too large".
  const result = await runtime.commands.compact();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inTurn, true);
  assert.ok(result.after < result.before);
  assert.equal(runtime.rt.session.conversation.filter((m) => m.role === 'user' && m.content === REQUEST).length, 1);
});

test('a request that cannot fit even after compacting is refused with a clear message, not sent', async (t) => {
  const cwd = repo();
  const fake = await createFakeProvider({ contextLength: 4096, turns: [{ text: 'should never be asked' }] }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const result = await runtime.commands.chat({ text: 'x '.repeat(3000), cwd });
  assert.equal(result.ok, false);
  assert.match(result.error, /4,096-token window leaves room for [\d,]+\. .*Start a new chat with \/clear, or switch to a model with a larger window\./);
  assert.equal(fake.chats.length, 0, 'nothing was sent to the model');
});

test('at the step cap the model is warned first, then asked to answer with tools off', async (t) => {
  const cwd = repo();
  const bodies = [];
  const fake = await createFakeProvider({
    respond: (body) => {
      bodies.push(body);
      const first = String(body.messages?.[0]?.content || '');
      if (!body.tools && /Create a clear title/.test(first)) return { text: 'T' };
      if (!body.tools) return { text: 'Final overview: ten modules of computed constants.' };
      // A model that never stops exploring.
      return { toolCalls: [{ name: 'read_file', arguments: { path: `module${bodies.length % FILES}.js` } }] };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: { ...settingsFor('ollama', fake), maxAgentSteps: 5 } });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  const result = await runtime.commands.chat({ text: REQUEST, cwd });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.content, 'Final overview: ten modules of computed constants.');
  const agent = bodies.filter((body) => body.tools);
  assert.equal(agent.length, 5, 'the cap still holds');
  assert.ok(agent.at(-1).messages.some((m) => /You have 1 model call left for this request\. Stop exploring/.test(m.content)));
  const final = bodies.find((body) => !body.tools && /used all 5 steps/.test(String(body.messages.at(-1)?.content)));
  assert.ok(final, 'a tools-off final request was made');
  assert.ok(seen.some((e) => e.channel === 'stream:info' && /asking for a final answer without tools/.test(e.payload)));
  assert.ok(seen.some((e) => e.channel === 'stream:message' && /Final overview/.test(e.payload)));
  const saved = runtime.rt.services.historyStore.load(result.chatId).chat.conversation;
  assert.equal(saved.at(-1).content, 'Final overview: ten modules of computed constants.');
});

test('a 50-step one-shot run gets a progress check halfway through', async (t) => {
  const cwd = repo();
  let calls = 0;
  const fake = await createFakeProvider({
    respond: (body) => {
      if (!body.tools) return { text: 'Done.' };
      calls += 1;
      if (calls === 26) return { text: 'Done.' };
      return { toolCalls: [{ name: 'get_file_lines', arguments: { path: `module${calls % FILES}.js`, start: calls } }] };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: { ...settingsFor('ollama', fake), maxAgentSteps: 50 } });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const result = await runtime.commands.chat({ text: REQUEST, cwd });
  assert.equal(result.content, 'Done.');
  const agent = fake.chats.filter((body) => body.tools);
  assert.equal(agent.length, 26);
  assert.equal(agent[24].messages.some((m) => /Half the model calls/.test(String(m.content))), false);
  assert.equal(agent[25].messages.some((m) => /Half the model calls/.test(String(m.content))), true);
});

test('the summarizer is asked for a line per file and sees more of each result', async (t) => {
  const cwd = repo();
  let reads = 0;
  const summarizerBodies = [];
  const fake = await createFakeProvider({
    contextLength: 65_536,
    respond: (body) => {
      if (!body.tools) {
        if (/Create a clear title/.test(String(body.messages?.[0]?.content))) return { text: 'T' };
        summarizerBodies.push(body);
        // Structured and past the ordinary floor, but short of one line per file.
        return { text: ['GOAL: report.', 'CONSTRAINTS: none.', 'DECISIONS: read modules.', 'STATE: modules read.', 'NEXT: answer.',
          Array.from({ length: 50 }, (_, n) => `brief${summarizerBodies.length}_${n}`).join(' ')].join('\n') };
      }
      if (reads < 4) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'done' };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const runtime = createRuntime({ host, overrides: { cwd } });
  await runtime.commands.chat({ text: REQUEST, cwd });
  const result = await runtime.commands.compact();
  assert.equal(result.ok, true, result.error);
  const first = summarizerBodies[0].messages;
  assert.match(first.at(-1).content, /give every file that was read or listed its own line/);
  const toolContents = first.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(toolContents.some((content) => content.length > 1500 && content.length <= 3000 + 20), 'results up to 3,000 characters');
  // The scripted record is shorter than the per-file floor: one corrective
  // retry, then the shorter record is kept rather than thrown away.
  assert.equal(summarizerBodies.length, 2);
  assert.match(summarizerBodies[1].messages.at(-1).content, /too thin to resume work from/);
  assert.equal(result.degraded, false);
  assert.ok(runtime.rt.session.conversation.some((m) => m.compactionRecord));
});

async function compactWith(t, summarizerTurn) {
  const cwd = repo();
  let reads = 0;
  const fake = await createFakeProvider({
    contextLength: 65_536,
    respond: (body) => {
      if (!body.tools) {
        if (/Create a clear title/.test(String(body.messages?.[0]?.content))) return { text: 'T' };
        return summarizerTurn;
      }
      if (reads < 4) return { toolCalls: [{ name: 'read_file', arguments: { path: `module${reads++}.js` } }] };
      return { text: 'done' };
    },
  }).start();
  t.after(() => fake.stop());
  const runtime = createRuntime({ host: createTestHost({ settings: settingsFor('ollama', fake) }), overrides: { cwd } });
  await runtime.commands.chat({ text: REQUEST, cwd });
  return runtime.commands.compact();
}

test('a summary written only into the thinking trace is reported as such', async (t) => {
  const thinking = Array.from({ length: 200 }, (_, n) => `t${String(n).padStart(3, '0')} `).join('');
  const result = await compactWith(t, { text: '', thinking });
  assert.equal(result.degraded, true);
  assert.match(result.description, /no usable summary \(empty, 1,000 chars of thinking\)/);
});

test('an unusable summary says why, and the rejected attempts are kept in the run ledger', async (t) => {
  const result = await compactWith(t, { text: 'Read some modules.' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.degraded, true);
  assert.match(result.description, /no usable summary \(too short, \d+ of [\d,]+ tokens\)/);
  const stored = JSON.parse(fs.readFileSync(result.ledgerPath, 'utf8'));
  const attempts = stored.snapshots.at(-1).rejectedSummaries;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].text, 'Read some modules.');
  assert.equal(attempts[0].reason, 'too short');
});
