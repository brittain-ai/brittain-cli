'use strict';

// docs/PLAN.md §4.1: system prompt + tool schemas for an empty conversation with no
// memory, built exactly as the agent loop sends them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { estimateContextTokens } = require('../../src/lib/context-estimator');
const { createTestHost } = require('../helpers/test-host');

const BUDGET = 3000;

test(`the system prompt and tools fit the token budget (${BUDGET})`, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-budget-'));
  const { rt } = createRuntime({ host: createTestHost(), overrides: { cwd } });
  const system = { role: 'system', content: rt.prompts.systemPrompt(cwd, '') };
  const tokens = estimateContextTokens(system) + estimateContextTokens(rt.prompts.activeToolDefs());
  assert.ok(tokens <= BUDGET, `${tokens} tokens > ${BUDGET}`);
  // The inspector's number is the same one the loop sends.
  assert.equal(rt.prompts.fixedOverheadTokens(cwd, ''), tokens);
});
