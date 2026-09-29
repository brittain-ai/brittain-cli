'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../../src/core/runtime');
const { createFakeProvider } = require('../helpers/fake-provider');
const { createTestHost, settingsFor } = require('../helpers/test-host');

test('a cold tool reveals its schema before execution, then uses the full schema', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-index-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fake = await createFakeProvider({ turns: [
    { toolCalls: [{ name: 'start_process', arguments: {} }] },
    { text: 'Done.' },
  ] }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake) });
  const { commands, rt } = createRuntime({ host, overrides: { cwd } });
  const result = await commands.chat({ text: 'start a server', cwd });
  assert.equal(result.ok, true);
  assert.equal(host.asked.approvals.length, 0);
  const toolResult = rt.session.conversation.find((message) => message.role === 'tool');
  assert.match(toolResult.content, /nothing has run yet/);
  const first = fake.chats[0].tools.find((tool) => tool.function.name === 'start_process');
  const second = fake.chats[1].tools.find((tool) => tool.function.name === 'start_process');
  assert.equal(first.function.parameters.additionalProperties, true);
  assert.equal(second.function.parameters.properties.arguments.type, 'array');
});
