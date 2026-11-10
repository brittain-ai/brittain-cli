'use strict';

// /build: the orchestrator is code. These tests script every model call (planner,
// scout, coder, verifier) and check what the harness does around them — that a
// task is judged by its Check's exit status and not by anyone's report, that a
// done task carries evidence, that a coder sees only its own brief, and that
// no plan or coder is a way around a human decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntime } = require('../../src/core/runtime');
const { parsePlan } = require('../../src/core/plan');
const { createFakeProvider } = require('../helpers/fake-provider');
const { collect, createTestHost, settingsFor } = require('../helpers/test-host');

const PLAN = `# Plan: Two files

## Decisions
- Plain text files, no tools

## Task 1: Make a.txt
Files: a.txt
Do: Create a.txt containing the word alpha.
Check: grep -q alpha a.txt

## Task 2: Make b.txt
Files: b.txt
Do: Create b.txt containing the word beta.
Check: grep -q beta b.txt
`;

const roleOf = (body) => {
  const first = String(body.messages?.[0]?.content || '');
  if (/Create a clear title/.test(first)) return 'title';
  if (/^You are a planner/.test(first)) return 'planner';
  if (/^You are a coder/.test(first)) return 'coder';
  if (/^You are a verifier/.test(first)) return 'verifier';
  if (/research subagent/.test(first)) return 'scout';
  return 'other';
};

const write = (file, content) => ({ toolCalls: [{ name: 'write_file', arguments: { path: file, content } }] });
const PASS = { text: 'PASS: it does what the task asked\nVERDICT: PASS' };

// A coder that writes `file` with `content` and then reports; or per-attempt
// behaviour when `content` is a function of the brief.
function coderWriting(file, content) {
  return (body) => {
    const sawResult = body.messages.some((m) => m.role === 'tool');
    if (sawResult) return { text: `Changed ${file}.` };
    const brief = String(body.messages[1].content);
    return write(file, typeof content === 'function' ? content(brief) : content);
  };
}

async function run(t, { planner = [PLAN], coder, verifier = [PASS], scout, goal = 'two text files', settings = {}, approvals = [], answers = ['Yes, build it'], interactive = true, autoApprove = true, files = {}, patch }) {
  const seq = (turns) => (typeof turns === 'function' ? turns : (() => { let i = 0; return () => turns[Math.min(i++, turns.length - 1)]; })());
  const next = { planner: seq(planner), coder: seq(coder || (() => ({ text: 'nothing' }))), verifier: seq(verifier), scout: seq(scout || [{ text: 'empty project' }]) };
  const bodies = { planner: [], coder: [], verifier: [], scout: [] };
  const fake = await createFakeProvider({
    capabilities: ['completion', 'tools', 'thinking'],
    respond: (body) => {
      const role = roleOf(body);
      if (role === 'title' || role === 'other') return { text: 'T' };
      bodies[role].push(body);
      const turn = next[role](body);
      return typeof turn === 'string' ? { text: turn } : turn;
    },
  }).start();
  t.after(() => fake.stop());
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-build-')));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content);
  const host = createTestHost({ settings: { ...settingsFor('ollama', fake), ...settings }, approvals, answers: answers.map((a) => [a]), interactive });
  const runtime = createRuntime({ host, overrides: { cwd } });
  const seen = collect(runtime.events);
  if (patch) patch(runtime.rt);
  const result = await runtime.commands.build({ goal, cwd, ...(autoApprove ? { autoApprove: true } : {}) });
  const planFile = path.join(cwd, '.brittain', 'plan.md');
  const plan = fs.existsSync(planFile) ? parsePlan(fs.readFileSync(planFile, 'utf8')).plan : null;
  const infos = seen.filter((e) => e.channel === 'stream:info').map((e) => e.payload);
  return { result, runtime, seen, bodies, host, cwd, plan, infos, final: runtime.rt.session.conversation.at(-1)?.content || '' };
}

test('plans, reviews, builds each task, and marks it done with evidence', async (t) => {
  const { result, bodies, cwd, plan, final, host } = await run(t, {
    coder: (body) => {
      if (body.messages.some((m) => m.role === 'tool')) return { text: 'ok' };
      return /YOUR TASK \(1 of/.test(body.messages[1].content) ? write('a.txt', 'alpha\n') : write('b.txt', 'beta\n');
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'beta\n');
  assert.deepEqual(plan.tasks.map((task) => task.status), ['done', 'done']);
  assert.match(plan.tasks[0].evidence, /`grep -q alpha a\.txt` exited 0; reviewer PASS/);
  assert.match(final, /2\/2 tasks done/);
  assert.match(final, /✓ Task 1: Make a\.txt/);
  // The human was asked once, about the plan.
  assert.equal(host.asked.questions.length, 1);
  assert.match(host.asked.questions[0].questions[0].question, /Build this plan\?/);
  // Planning is one call with no tools and thinking off.
  assert.equal(bodies.planner.length, 1);
  assert.equal(bodies.planner[0].tools, undefined);
  assert.notEqual(bodies.planner[0].think, true); // off, or omitted where the model has no switch
  // Nothing was scouted: the directory was empty.
  assert.equal(bodies.scout.length, 0);
});

test('a coder is briefed with the decisions and its own task, never the other tasks', async (t) => {
  const { bodies } = await run(t, { coder: (body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'ok' } : write(/YOUR TASK \(1 of/.test(body.messages[1].content) ? 'a.txt' : 'b.txt', /YOUR TASK \(1 of/.test(body.messages[1].content) ? 'alpha' : 'beta')) });
  const [first, second] = bodies.coder.filter((b) => !b.messages.some((m) => m.role === 'tool'));
  const one = first.messages[1].content;
  assert.match(one, /Plain text files, no tools/);
  assert.match(one, /YOUR TASK \(1 of 2\): Make a\.txt/);
  assert.doesNotMatch(one, /beta/);
  assert.equal(first.messages.length, 2); // system + brief: nothing of the planner or the user's chat
  const two = second.messages[1].content;
  assert.match(two, /Already built by earlier tasks:\n- Make a\.txt \(a\.txt\)/);
  assert.match(two, /YOUR TASK \(2 of 2\): Make b\.txt/);
  assert.ok(first.tools.some((tool) => tool.function.name === 'write_file'));
  assert.ok(first.tools.every((tool) => !['ask_user', 'run_subagent', 'delete_file', 'move_file'].includes(tool.function.name)));
});

test('a task is judged by its Check, not by the coder saying it worked', async (t) => {
  const { plan, final, bodies, cwd } = await run(t, {
    // The coder claims success every time and writes the wrong thing.
    coder: (body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'All done, the check passes!' } : write('a.txt', 'wrong\n')),
  });
  assert.equal(plan.tasks[0].status, 'failed');
  assert.equal(plan.tasks[1].status, 'pending');
  assert.equal(bodies.verifier.length, 0); // the verifier never sees work that failed its Check
  assert.equal(fs.existsSync(path.join(cwd, 'b.txt')), false);
  assert.match(final, /Task 1 did not pass its check/);
  assert.match(final, /exited 1/);
  assert.match(final, /0\/2 tasks done/);
});

test('a failed Check is retried once, with the failure in the brief', async (t) => {
  const { plan, bodies } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', (brief) => (/PREVIOUS ATTEMPT FAILED/.test(brief) ? 'alpha\n' : 'nope\n')),
  });
  assert.equal(plan.tasks[0].status, 'done');
  const briefs = bodies.coder.filter((b) => !b.messages.some((m) => m.role === 'tool')).map((b) => b.messages[1].content);
  assert.equal(briefs.length, 2);
  assert.doesNotMatch(briefs[0], /PREVIOUS ATTEMPT/);
  assert.match(briefs[1], /PREVIOUS ATTEMPT FAILED[\s\S]*`grep -q alpha a\.txt` exited 1/);
});

test('the verifier can veto a task whose Check passed', async (t) => {
  const { plan, bodies, final } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
    verifier: [{ text: 'FAIL: it ignores the second requirement — a.txt:1\nVERDICT: FAIL' }, PASS],
  });
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(bodies.verifier.length, 2);
  const retry = bodies.coder.filter((b) => !b.messages.some((m) => m.role === 'tool')).at(-1).messages[1].content;
  assert.match(retry, /a reviewer found defects:\nFAIL: it ignores the second requirement/);
  assert.match(final, /1\/1 tasks done/);
});

test('the verifier gets the real command output and is read-only', async (t) => {
  const { bodies } = await run(t, { planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n') });
  const brief = bodies.verifier[0].messages[1].content;
  assert.match(brief, /`grep -q alpha a\.txt` exited 0/);
  assert.match(brief, /Task: Make a\.txt/);
  assert.ok(bodies.verifier[0].tools.every((tool) => !['write_file', 'edit_file', 'run_command'].includes(tool.function.name)));
});

test('a plan that does not validate is sent back once with its errors', async (t) => {
  const bad = PLAN.replace('Check: grep -q alpha a.txt', 'Check: Verify that a.txt has alpha in it.');
  const { plan, bodies } = await run(t, { planner: [bad, PLAN], coder: coderWriting('a.txt', 'alpha\nbeta\n') });
  assert.equal(bodies.planner.length, 2);
  assert.match(bodies.planner[1].messages[0].content, /Your last answer was rejected:\n- Task 1's Check is not a shell command/);
  assert.equal(plan.tasks.length, 2);
});

test('a planner that never produces a plan builds nothing', async (t) => {
  const { final, bodies, plan } = await run(t, { planner: ['I will now think about the plan.'] });
  assert.equal(bodies.planner.length, 2);
  assert.equal(bodies.coder.length, 0);
  assert.equal(plan, null);
  assert.match(final, /did not produce a usable plan/);
});

test('free text at the review asks the planner for a revised plan', async (t) => {
  const one = PLAN.split('## Task 2')[0];
  const revised = one.replace('alpha', 'gamma').replace('alpha', 'gamma');
  const { bodies, host, plan } = await run(t, {
    planner: [one, revised],
    answers: ['Use the word gamma instead', 'Yes, build it'],
    coder: coderWriting('a.txt', 'gamma\n'),
  });
  assert.equal(host.asked.questions.length, 2);
  assert.equal(bodies.planner.length, 2);
  assert.match(bodies.planner[1].messages[0].content, /The user asked for this change: Use the word gamma instead/);
  assert.match(bodies.planner[1].messages[0].content, /Your previous plan:\n# Plan: Two files/);
  assert.equal(plan.tasks[0].check, 'grep -q gamma a.txt');
});

test('saying no at the review builds nothing and keeps the plan for editing', async (t) => {
  const { bodies, final, plan } = await run(t, { answers: ['No, stop here'] });
  assert.equal(bodies.coder.length, 0);
  assert.equal(plan.tasks.length, 2);
  assert.match(final, /Stopped before building/);
});

test('with nobody to review the plan, nothing is built unless --yes', async (t) => {
  const stopped = await run(t, { interactive: false, autoApprove: false });
  assert.equal(stopped.bodies.coder.length, 0);
  assert.match(stopped.final, /Nobody is here to review the plan/);
  assert.equal(stopped.host.asked.questions.length, 0);
  const built = await run(t, { interactive: false, autoApprove: true, planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n') });
  assert.equal(built.plan.tasks[0].status, 'done');
  assert.equal(built.host.asked.questions.length, 0);
});

test('a planner-written destructive Check asks the human, and is not run if refused', async (t) => {
  const evil = PLAN.replace('Check: grep -q alpha a.txt', 'Check: rm -rf precious && test -f a.txt');
  const { plan, host, cwd } = await run(t, {
    planner: [evil.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
    files: { precious: 'keep me' },
    approvals: [false],
  });
  assert.equal(host.asked.approvals.length, 1);
  assert.equal(host.asked.approvals[0].kind.destructive, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'precious'), 'utf8'), 'keep me');
  assert.equal(plan.tasks[0].status, 'failed');
});

test('a coder asks the human for the same things the lead would', async (t) => {
  const { host, bodies } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    autoApprove: true,
    files: { '.env': 'API_KEY=hunter2\n' },
    coder: (body) => {
      if (body.messages.some((m) => m.role === 'tool')) return { text: 'stopped' };
      return { toolCalls: [{ name: 'read_file', arguments: { path: '.env' } }, { name: 'run_command', arguments: { command: 'rm -rf node_modules' } }] };
    },
    approvals: [false, false, false, false],
  });
  const kinds = host.asked.approvals.map((a) => Object.keys(a.kind).find((k) => a.kind[k]));
  assert.ok(kinds.includes('sensitive'), 'the .env read asks');
  assert.ok(kinds.includes('destructive'), 'the rm -rf asks');
  assert.equal(JSON.stringify(bodies.coder).includes('hunter2'), false);
});

test('without auto-approve a coder needs approval to write', async (t) => {
  const { host, cwd } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    autoApprove: false,
    coder: coderWriting('a.txt', 'alpha\n'),
    approvals: [false, false, false, false, false, false],
  });
  assert.ok(host.asked.approvals.some((a) => a.name === 'write_file'));
  assert.equal(fs.existsSync(path.join(cwd, 'a.txt')), false);
});

test('an existing project is scouted first and the planner is told what is there', async (t) => {
  const { bodies } = await run(t, {
    scout: [{ text: 'A Node project using CommonJS; tests run with node --test.' }],
    files: { 'package.json': '{"type":"commonjs"}' },
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
  });
  assert.equal(bodies.scout.length, 1);
  assert.match(bodies.planner[0].messages[0].content, /A Node project using CommonJS/);
  assert.match(bodies.coder[0].messages[1].content, /Context from the codebase scout:\nA Node project using CommonJS/);
});

test('/build with no goal resumes the plan and skips tasks already done', async (t) => {
  const first = await run(t, { planner: [PLAN], coder: coderWriting('a.txt', 'nope\n') });
  assert.equal(first.plan.tasks[0].status, 'failed');
  // Fix the file by hand, then resume in the same directory.
  fs.writeFileSync(path.join(first.cwd, 'a.txt'), 'alpha\n');
  const fake = await createFakeProvider({
    respond: (body) => {
      const role = roleOf(body);
      if (role === 'coder') return body.messages.some((m) => m.role === 'tool') ? { text: 'ok' } : write('b.txt', 'beta\n');
      if (role === 'verifier') return PASS;
      return { text: 'T' };
    },
  }).start();
  t.after(() => fake.stop());
  const host = createTestHost({ settings: settingsFor('ollama', fake), answers: [] });
  const runtime = createRuntime({ host, overrides: { cwd: first.cwd } });
  const result = await runtime.commands.build({ goal: '', cwd: first.cwd, autoApprove: true });
  assert.equal(result.ok, true, result.error);
  const plan = parsePlan(fs.readFileSync(path.join(first.cwd, '.brittain', 'plan.md'), 'utf8')).plan;
  assert.deepEqual(plan.tasks.map((task) => task.status), ['done', 'done']);
  assert.equal(host.asked.questions.length, 0); // a resumed plan is not reviewed again
});

test('resuming with no plan says so', async (t) => {
  const { final, bodies } = await run(t, { goal: '' });
  assert.match(final, /There is no plan to resume/);
  assert.equal(bodies.planner.length, 0);
});

test('a build reports progress and counts every model call', async (t) => {
  const { infos, runtime } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
  });
  assert.ok(infos.includes('Planning…'));
  assert.ok(infos.some((line) => /Task 1\/1: Make a\.txt/.test(line)));
  assert.ok(infos.some((line) => /running the check: grep -q alpha a\.txt/.test(line)));
  assert.ok(runtime.rt.session.usage.main.calls >= 4); // planner, coder x2, verifier
});

test('a Check that exits 0 while its output reports a failure is not a pass', async (t) => {
  // The first real run: tests that print "✗" and never fail the process.
  const lying = PLAN.replace('Check: grep -q alpha a.txt', "Check: cat a.txt");
  const { plan, bodies, infos } = await run(t, {
    planner: [lying.split('## Task 2')[0]],
    coder: coderWriting('a.txt', (brief) => (/PREVIOUS ATTEMPT FAILED/.test(brief) ? 'alpha\n' : '✗ marks item as done: 2 !== 1\n')),
  });
  assert.equal(plan.tasks[0].status, 'done');
  const briefs = bodies.coder.filter((b) => !b.messages.some((m) => m.role === 'tool')).map((b) => b.messages[1].content);
  assert.equal(briefs.length, 2);
  assert.match(briefs[1], /exited 0, but its output reports a failure: "✗ marks item as done: 2 !== 1"/);
  assert.match(briefs[1], /never catch assertion errors/);
  assert.equal(bodies.verifier.length, 1); // only the attempt that really passed reached the reviewer
  assert.ok(infos.some((line) => /exited 0 but reports a failure/.test(line)));
});

test('reads a verdict however the model dresses it', async (t) => {
  for (const dressed of ['## VERDICT: FAIL', '**VERDICT: FAIL**', '- VERDICT - FAIL']) {
    const { plan, bodies } = await run(t, {
      planner: [PLAN.split('## Task 2')[0]],
      coder: coderWriting('a.txt', 'alpha\n'),
      verifier: [{ text: `FAIL: wrong — a.txt:1\n${dressed}` }, PASS],
    });
    assert.equal(bodies.verifier.length, 2, dressed); // vetoed once, then passed
    assert.equal(plan.tasks[0].status, 'done');
  }
});

test('the verifier is told what changed on disk and which files were not in the task', async (t) => {
  const { bodies, plan } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: (body) => (body.messages.some((m) => m.role === 'tool')
      ? { text: 'ok' }
      : { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'alpha\n' } }, { name: 'write_file', arguments: { path: 'extra.txt', content: 'x' } }] }),
  });
  const brief = bodies.verifier[0].messages[1].content;
  assert.match(brief, /What changed on disk: added a\.txt, extra\.txt\./);
  assert.match(brief, /NOT in the task's file list: extra\.txt\./);
  assert.match(brief, /Exit 0 only means the command ran/);
  assert.match(plan.tasks[0].evidence, /added a\.txt, extra\.txt \(outside the task's files: extra\.txt\)/);
});

test('a verdict missing its closing line is read from the PASS and FAIL lines', async (t) => {
  const failing = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
    verifier: [{ text: 'PASS: it writes alpha\nFAIL: it never handles a missing file — a.txt:1' }, { text: 'PASS: fine' }],
  });
  assert.equal(failing.bodies.verifier.length, 2); // the first was read as a FAIL and vetoed
  const passing = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
    verifier: [{ text: 'PASS: it writes alpha' }],
  });
  assert.match(passing.plan.tasks[0].evidence, /reviewer PASS/);
  const silent = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'alpha\n'),
    verifier: [{ text: 'I looked at it.' }],
  });
  assert.match(silent.plan.tasks[0].evidence, /reviewer gave no verdict/);
});

test('when a task fails and someone is there, they can hint the coder past it', async (t) => {
  const { plan, bodies, host } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    // Wrong twice; right once the user's hint is in the brief.
    coder: coderWriting('a.txt', (brief) => (/The user says: write alpha/.test(brief) ? 'alpha\n' : 'nope\n')),
    answers: ['Yes, build it', 'write alpha'],
  });
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(host.asked.questions.length, 2);
  assert.match(host.asked.questions[1].questions[0].question, /Task 1 failed:[\s\S]*Type a hint/);
  const last = bodies.coder.filter((b) => !b.messages.some((m) => m.role === 'tool')).at(-1).messages[1].content;
  assert.match(last, /PREVIOUS ATTEMPT FAILED[\s\S]*The user says: write alpha/);
});

test('answering stop, or nobody being there, ends the build at the failed task', async (t) => {
  const stopped = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'nope\n'),
    answers: ['Yes, build it', 'Stop here'],
  });
  assert.equal(stopped.plan.tasks[0].status, 'failed');
  assert.equal(stopped.host.asked.questions.length, 2);
  const unattended = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'nope\n'),
    interactive: false,
  });
  assert.equal(unattended.plan.tasks[0].status, 'failed');
  assert.equal(unattended.host.asked.questions.length, 0);
});

test('hints are limited, so a stuck build still ends', async (t) => {
  const { plan, host } = await run(t, {
    planner: [PLAN.split('## Task 2')[0]],
    coder: coderWriting('a.txt', 'nope\n'),
    answers: ['Yes, build it', 'try harder', 'try even harder', 'and again'],
  });
  assert.equal(plan.tasks[0].status, 'failed');
  assert.equal(host.asked.questions.length, 3); // the review, then two hints
});

test('a dropped connection while planning is retried once; a second drop ends the build', async (t) => {
  const drops = (n) => (rt) => {
    const real = rt.stream.streamChat;
    let left = n;
    rt.stream.streamChat = (...args) => {
      // Only the planner call has no tools and is the first to run.
      if (left > 0 && args[6] === null) { left--; return Promise.reject(new TypeError('terminated')); }
      return real(...args);
    };
  };
  const once = await run(t, { planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n'), patch: drops(1) });
  assert.equal(once.plan.tasks[0].status, 'done');
  assert.ok(once.infos.some((line) => /connection dropped/.test(line)));
  const twice = await run(t, { planner: [PLAN.split('## Task 2')[0]], patch: drops(2) });
  assert.equal(twice.result.ok, false);
  assert.match(twice.result.error, /terminated/);
  assert.equal(twice.bodies.coder.length, 0);
});

test('the plan and the summary are drawn as tokens, so a terminal shows them', async (t) => {
  const { seen } = await run(t, { planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n') });
  const tokens = seen.filter((e) => e.channel === 'stream:token').map((e) => e.payload).join('');
  assert.match(tokens, /# Plan: Two files[\s\S]*Check: grep -q alpha a\.txt/);
  assert.match(tokens, /1\/1 tasks done/);
  const messages = seen.filter((e) => e.channel === 'stream:message');
  assert.equal(messages.length, 2); // the plan, then the summary
});

test('coders and verifiers think, the planner and scouts do not, and /think off silences them all', async (t) => {
  const on = await run(t, { settings: { codeThink: true }, files: { 'package.json': '{}' }, planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n') });
  assert.equal(on.bodies.coder[0].think, true);
  assert.equal(on.bodies.verifier[0].think, true);
  assert.equal(on.bodies.planner[0].think, false);
  assert.equal(on.bodies.scout[0].think, false);
  const off = await run(t, { settings: { codeThink: false }, planner: [PLAN.split('## Task 2')[0]], coder: coderWriting('a.txt', 'alpha\n') });
  assert.equal(off.bodies.coder[0].think, false);
  assert.equal(off.bodies.verifier[0].think, false);
});

