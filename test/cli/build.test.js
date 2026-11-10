'use strict';

// `brittain build "<goal>"`: the /build pipeline without a terminal. Nobody is
// there to review the plan, so without --yes it plans and stops; with --yes it
// builds, and the exit status says whether every task passed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, tempHome } = require('../helpers/cli');
const { createFakeProvider } = require('../helpers/fake-provider');

const PLAN = `# Plan: One file

## Decisions
- Plain text

## Task 1: Make a.txt
Files: a.txt
Do: Create a.txt containing the word alpha.
Check: grep -q alpha a.txt
`;

const roleOf = (body) => {
  const first = String(body.messages?.[0]?.content || '');
  if (/^You are a planner/.test(first)) return 'planner';
  if (/^You are a coder/.test(first)) return 'coder';
  if (/^You are a verifier/.test(first)) return 'verifier';
  return 'other';
};

async function setup(t, coderContent) {
  const fake = await createFakeProvider({
    respond: (body) => {
      const role = roleOf(body);
      if (role === 'planner') return { text: PLAN };
      if (role === 'coder') {
        return body.messages.some((m) => m.role === 'tool')
          ? { text: 'Changed a.txt.' }
          : { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: coderContent } }] };
      }
      if (role === 'verifier') return { text: 'PASS: fine\nVERDICT: PASS' };
      return { text: 'T' };
    },
  }).start();
  t.after(() => fake.stop());
  const home = tempHome();
  await runCli(['config', 'set', 'providers.ollama.endpoint', fake.base], { home });
  await runCli(['config', 'set', 'providers.ollama.model', 'alpha-model'], { home });
  await runCli(['config', 'set', 'provider', 'ollama'], { home });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cli-build-')));
  return { fake, home, cwd };
}

test('build without --yes plans, writes the plan, and builds nothing', async (t) => {
  const { home, cwd } = await setup(t, 'alpha\n');
  const out = await runCli(['build', '--cwd', cwd, 'one text file'], { home });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Nobody is here to review the plan/);
  assert.equal(fs.existsSync(path.join(cwd, 'a.txt')), false);
  assert.match(fs.readFileSync(path.join(cwd, '.brittain', 'plan.md'), 'utf8'), /Status: pending/);
});

test('build --yes builds the plan and prints what was done', async (t) => {
  const { home, cwd } = await setup(t, 'alpha\n');
  const out = await runCli(['build', '--yes', '--cwd', cwd, 'one text file'], { home });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1\/1 tasks done/);
  assert.match(out.stdout, /✓ Task 1: Make a\.txt/);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\n');
  assert.match(out.stderr, /Task 1\/1: Make a\.txt/);
});

test('build exits 1 when a task fails its check, and says which', async (t) => {
  const { home, cwd } = await setup(t, 'wrong\n');
  const out = await runCli(['build', '--yes', '--cwd', cwd, 'one text file'], { home });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /0\/1 tasks done/);
  assert.match(out.stdout, /Task 1 did not pass its check/);
});

test('build with no goal and no plan says so', async (t) => {
  const { home, cwd } = await setup(t, 'alpha\n');
  const out = await runCli(['build', '--cwd', cwd], { home });
  assert.match(out.stdout, /There is no plan to resume/);
});
