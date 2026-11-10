'use strict';

// CLI addition: /build. The orchestrator is code, not a model.
//
// A small model cannot hold an orchestrator prompt, choose between delegating
// and doing, and keep a plan consistent — the first run of this CLI on a todo
// app wandered through module systems for ten of its twenty-five steps and
// reported success over two real bugs. So the loop here is a state machine and
// the model is called for one narrow job at a time, each with a tiny prompt:
//
//   scout    read-only survey of an existing project        (skipped if empty)
//   plan     one call, no tools, thinking off               -> validated plan
//   review   the human reads the plan and can revise it
//   per task: checkpoint -> coder -> the HARNESS runs the Check -> verifier
//             -> mark done with evidence, or retry once, or stop
//
// What is deliberately not a model decision: which task is next, whether a
// task passed (its Check's exit status decides, the verifier can only veto),
// whether a task is marked done, and whether a destructive or sensitive call
// runs (a human, through the same approval gate as the lead's).

const fs = require('node:fs');
const path = require('node:path');
const { estimateContextTokens } = require('../lib/context-estimator');
const { isDestructiveCommand, runCommandStatus } = require('../lib/tools');
const { unapprovedResult } = require('./approvals');
const { markTask, nextPending, parsePlan, renderPlan, taskBrief } = require('./plan');
const { changesBetween, describeChanges, snapshot, unlisted } = require('./snapshot');

const PLAN_DIR = '.brittain';
const PLAN_FILE = 'plan.md';
const TASK_ATTEMPTS = 2;        // the first try, and one retry with the failure in the brief
const PLAN_ATTEMPTS = 2;        // the first plan, and one repair with the errors listed
const MAX_REVISIONS = 2;        // times the human may ask for a different plan
const MAX_HINTS = 2;            // times the human may hint a coder past a failed task
const SCOUT_CONTEXT_CHARS = 3000;
const BRIEF_CONTEXT_CHARS = 1500;
const FAILURE_CHARS = 1500;
const CHECK_TIMEOUT_MS = 120_000;

const PLANNER_PROMPT = `You are a planner. Turn the GOAL into a build plan. Output ONLY the plan in exactly this format. No text before or after.

Rules:
- 3 to 5 tasks. Each task is a working slice: when it is done, the project runs and the Check passes. Do NOT plan by layers ("models", "error handling", "final testing").
- Decisions: state each choice once, no contradictions. Pick the simplest option (no frameworks unless the goal needs one). Name the language, the module system, and every file.
- The first task creates any config file the decisions depend on (for example package.json for a Node project).
- Check must be ONE real shell command that RUNS the work and exits 0 only if it worked, e.g. \`node --test\`, \`node cli.js list | grep -q milk\`, \`python3 -m unittest\`. Never prose. Checking that a file exists is not enough.
- A pipe carries only stdout. To check an error message, redirect stderr into it: \`node cli.js remove 99 2>&1 | grep -q "not found"\`.
- Write the tests inside the task that builds the feature, using the language's real test runner, so a failing test makes the Check exit non-zero.

Example (goal: a command-line word counter in Node):

# Plan: Word counter

## Decisions
- Node.js, CommonJS (require), no dependencies
- Files: package.json, wc.js (logic, exports countWords), cli.js (reads a file path argument), test.js (node:test)

## Task 1: Counting logic with tests
Files: package.json, wc.js, test.js
Do: Create package.json with {"type":"commonjs"}. Export countWords(text) from wc.js returning the number of whitespace-separated words. Write node:test cases for empty string, one word, and multiple spaces.
Check: node --test

## Task 2: Command-line entry
Files: cli.js
Do: Read the file path from process.argv[2], print countWords of its contents, exit 1 with a message if the file is missing.
Check: printf 'a b c' > /tmp/wc-check.txt && node cli.js /tmp/wc-check.txt | grep -q 3

Now the real one.

`;

function isTransientNetworkError(err) {
  if (!err || err.name === 'AbortError' || err.name === 'PsychosisDetectedError') return false;
  return /terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|other side closed/i.test(`${err.message || ''} ${err.cause?.code || ''} ${err.cause?.message || ''}`);
}

const clip = (text, max) => {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}\n[… cut]` : value;
};
const tail = (text, max) => {
  const value = String(text || '').trim();
  return value.length > max ? `[… cut]\n${value.slice(-max)}` : value;
};

function createPipeline(rt) {
  const info = (text) => rt.sink.info(text);
  // The terminal draws an assistant message from its tokens; `stream:message`
  // only marks the end of one (core/agent-loop.js does the same pair).
  const say = (text) => {
    rt.sink.emit('stream:token', `${text}\n`);
    rt.sink.emit('stream:message', text);
  };

  function planPath(cwd) {
    return path.join(cwd, PLAN_DIR, PLAN_FILE);
  }

  function savePlan(cwd, plan) {
    fs.mkdirSync(path.join(cwd, PLAN_DIR), { recursive: true });
    fs.writeFileSync(planPath(cwd), renderPlan(plan));
  }

  function loadPlan(cwd) {
    try {
      const parsed = parsePlan(fs.readFileSync(planPath(cwd), 'utf8'));
      return parsed.ok ? parsed.plan : null;
    } catch {
      return null;
    }
  }

  function isEmptyProject(cwd) {
    try {
      return fs.readdirSync(cwd).filter((name) => name !== '.git' && name !== PLAN_DIR && name !== '.DS_Store').length === 0;
    } catch {
      return true;
    }
  }

  // One model call, no tools, thinking off. Thinking on made the same planner
  // trip the repeat guard on two of three goals; off, it took 6-7 seconds and
  // followed the format every time.
  async function callPlanner({ model, prompt, signal }) {
    const contextLength = await rt.models.effectiveContext(model);
    const think = await rt.models.thinkValue(model, false);
    const temperature = rt.config.settings().codeTemperature;
    const messages = [{ role: 'user', content: prompt }];
    if (estimateContextTokens(messages) > contextLength * 0.7) throw new Error('The goal and context are too large to plan in this model\'s window. Shorten the goal.');
    // A build is many calls; one dropped connection ("terminated") on the first
    // ended a real run. Retry a transient network error once, not a refusal.
    for (let attempt = 0; ; attempt++) {
      try {
        const { content, stats } = await rt.stream.streamChat(model, messages, signal, think, true, contextLength, null, { toolCallRetries: 0 }, temperature);
        if (stats) rt.state.recordUsage('main', stats);
        return content || '';
      } catch (err) {
        if (attempt >= 1 || signal.aborted || !isTransientNetworkError(err)) throw err;
        info('The connection dropped — trying the plan once more…');
      }
    }
  }

  // Ask for a plan; if it does not validate, ask once more with the errors.
  async function makePlan({ model, goal, context, feedback, previous, signal }) {
    let prompt = `${PLANNER_PROMPT}GOAL: ${goal}\n`;
    if (context) prompt += `\nWhat is already in this directory (from a read-only survey):\n${clip(context, SCOUT_CONTEXT_CHARS)}\n`;
    if (previous && feedback) prompt += `\nYour previous plan:\n${renderPlan(previous)}\nThe user asked for this change: ${feedback}\nOutput the revised plan.\n`;
    let last = null;
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      let text;
      try {
        text = await callPlanner({ model, prompt, signal });
      } catch (err) {
        if (err.name !== 'PsychosisDetectedError') throw err;
        text = '';
      }
      const parsed = parsePlan(text);
      if (parsed.ok) return { ok: true, plan: parsed.plan };
      last = parsed;
      prompt += `\nYour last answer was rejected:\n${(parsed.errors.length ? parsed.errors : ['It was empty or not in the plan format.']).map((e) => `- ${e}`).join('\n')}\nOutput the corrected plan, in the same format, nothing else.\n`;
    }
    return { ok: false, errors: last?.errors?.length ? last.errors : ['The model did not produce a plan.'] };
  }

  // The gate a model-authored command passes before the harness runs it. A
  // planner could write `rm -rf` as a Check; the same approval as the lead's
  // decides, so a plan is never a way around a human.
  async function runCheck({ command, cwd, autoApprove }) {
    const destructive = isDestructiveCommand(command);
    const decision = await rt.approvalFlow.resolveToolCall('run_command', { command }, { autoApprove, promptKind: destructive ? { destructive: true } : {} });
    if (!decision.approved) {
      return { ok: false, denied: true, code: -1, output: unapprovedResult(decision.verdict, 'The user denied running this check.') };
    }
    return runCommandStatus(command, cwd, CHECK_TIMEOUT_MS);
  }

  // A command that exits 0 while its own output says something failed is not
  // a check. The first real /build run wrote tests that caught every assertion
  // error and printed "✗", so `node --test` passed with a broken done().
  function reportedFailure(output) {
    const lines = String(output || '').split('\n');
    const hit = lines.find((line) => /^\s*(#\s*)?(✗|✖|×|FAIL\b|FAILED\b|not ok\b|AssertionError\b|Traceback \(most recent call last\))/.test(line)
      || /^\s*#?\s*fail\s+[1-9]\d*\b/i.test(line)
      || /\b[1-9]\d*\s+(failed|failing)\b/i.test(line));
    return hit ? hit.trim().slice(0, 160) : '';
  }

  // Tolerant of how a small model dresses the line: "## VERDICT: PASS",
  // "**VERDICT: FAIL**", "- FAIL: …".
  function verdictOf(report) {
    const text = String(report || '');
    const matches = [...text.matchAll(/^[\s#>*_`-]*VERDICT\s*[:\-]?[\s*_`]*(PASS|FAIL)/gim)];
    const fails = (text.match(/^[\s#>*_`-]*FAIL\s*:.*$/gim) || []).map((line) => line.replace(/^[\s#>*_`-]+/, '').trim());
    let verdict = matches.length ? matches[matches.length - 1][1].toUpperCase() : 'NONE';
    // The closing line is the part a small model most often drops. Its FAIL and
    // PASS lines still say what it found, so read the verdict from them.
    if (verdict === 'NONE' && fails.length) verdict = 'FAIL';
    else if (verdict === 'NONE' && /^[\s#>*_`-]*PASS\s*:/im.test(text)) verdict = 'PASS';
    return { verdict, fails };
  }

  async function runTask({ plan, task, model, cwd, autoApprove, context, failure: carried = '' }) {
    let failure = carried;
    let lastOutput = '';
    for (let attempt = 1; attempt <= TASK_ATTEMPTS; attempt++) {
      if (rt.run.stopRequested) return { ok: false, stopped: true, reason: 'Stopped.' };
      info(`Task ${task.n}/${plan.tasks.length}: ${task.title}${attempt > 1 ? ' — retrying with the failure in the brief' : ''}`);
      rt.approvalFlow.beginTurn();

      const before = snapshot(cwd);
      const brief = taskBrief(plan, task, { context: clip(context, BRIEF_CONTEXT_CHARS), failure });
      await rt.agentLoop.runSubagent({ task: brief, leadModel: model, cwd, autoApprove, role: 'coder' });
      if (rt.run.stopRequested) return { ok: false, stopped: true, reason: 'Stopped.' };

      // Evidence comes from the harness, not from the coder's own report: what
      // changed on disk, taken before the check runs (a check may write files
      // of its own), and the check's real exit status.
      const changes = changesBetween(before, snapshot(cwd));
      const stray = unlisted(changes, task.files);
      const changed = describeChanges(changes);
      info(`  running the check: ${task.check}`);
      const check = await runCheck({ command: task.check, cwd, autoApprove });
      lastOutput = check.output;
      if (!check.ok) {
        if (check.denied) return { ok: false, denied: true, reason: 'You declined to run the check, so the task cannot be confirmed.', output: check.output };
        failure = `The check \`${task.check}\` ${check.timedOut ? 'timed out' : `exited ${check.code}`}. Its output:\n${tail(check.output, FAILURE_CHARS)}`;
        info(`  check failed (${check.timedOut ? 'timed out' : `exit ${check.code}`})`);
        continue;
      }
      const lie = reportedFailure(check.output);
      if (lie) {
        failure = `The check \`${task.check}\` exited 0, but its output reports a failure: "${lie}". A check that exits 0 while tests fail is not a check. Make failures make the command exit non-zero (write tests with the framework's own runner and never catch assertion errors), then fix the failing behaviour. Its output:\n${tail(check.output, FAILURE_CHARS)}`;
        info(`  check exited 0 but reports a failure: ${lie.slice(0, 100)}`);
        continue;
      }

      const judged = await rt.agentLoop.runSubagent({
        role: 'verifier',
        leadModel: model,
        cwd,
        autoApprove,
        task: [
          `Task: ${task.title}`,
          `Files it should touch: ${task.files.join(', ')}`,
          `What it had to do: ${task.do}`,
          `What changed on disk: ${changed}.${stray.length ? ` NOT in the task's file list: ${stray.join(', ')}.` : ''}`,
          `The acceptance command \`${task.check}\` exited 0. Its output:`,
          clip(check.output, 1200),
          'Exit 0 only means the command ran. Read the code and judge whether each behaviour really works.',
        ].join('\n'),
      });
      const { verdict, fails } = verdictOf(judged.report);
      if (verdict === 'FAIL') {
        failure = `The check passed, but a reviewer found defects:\n${fails.join('\n') || clip(judged.report, FAILURE_CHARS)}`;
        info(`  reviewer found a defect: ${(fails[0] || '').slice(0, 140)}`);
        continue;
      }
      const evidence = `\`${task.check}\` exited 0; reviewer ${verdict === 'PASS' ? 'PASS' : 'gave no verdict'}; ${changed}${stray.length ? ` (outside the task's files: ${stray.join(', ')})` : ''}`;
      return { ok: true, evidence };
    }
    return { ok: false, reason: failure || 'The task did not pass its check.', output: lastOutput };
  }

  function summarize(plan, { note = '', undoable }) {
    if (!plan.tasks.length) return note;
    const lines = [`**${plan.title}** — ${plan.tasks.filter((t) => t.status === 'done').length}/${plan.tasks.length} tasks done`, ''];
    for (const t of plan.tasks) {
      const mark = t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '·';
      lines.push(`${mark} Task ${t.n}: ${t.title}${t.evidence ? ` — ${t.evidence}` : ''}`);
    }
    if (note) lines.push('', note);
    lines.push('', 'The plan is in `.brittain/plan.md`.');
    if (undoable) lines.push('`/undo` reverts everything this build changed.');
    return lines.join('\n');
  }

  // incomplete: the loop ran and a task failed or the user stopped it, so a
  // script driving `brittain build` should see a non-zero exit.
  function finish(plan, opts) {
    const text = summarize(plan, opts);
    rt.session.conversation.push({ role: 'assistant', content: text });
    say(text);
    return { lastContent: text, lastStats: null, deniedCalls: 0, incomplete: !!opts.incomplete };
  }

  // goal empty: resume the plan already in .brittain/plan.md.
  async function build({ goal, model, cwd, autoApprove }) {
    const signal = rt.run.abort.signal;
    const start = rt.services.checkpoints.current();
    const attended = !!rt.host.interactive();
    let plan = null;
    let context = '';
    goal = String(goal || '').trim();

    if (!goal) {
      plan = loadPlan(cwd);
      if (!plan) return finish({ title: 'Build', tasks: [] }, { note: 'There is no plan to resume. Run `/build <what to build>`.' });
      info(`Resuming the plan in .brittain/plan.md (${plan.tasks.filter((t) => t.status === 'done').length}/${plan.tasks.length} done).`);
    } else {
      if (!isEmptyProject(cwd)) {
        info('Surveying the project…');
        const scouted = await rt.agentLoop.runSubagent({
          role: 'scout',
          leadModel: model,
          cwd,
          autoApprove,
          task: `Survey this directory for someone about to build this: ${goal}\nReport: the files that exist, the language and libraries in use, the module system and code style, and how tests are run. Quote the small facts that matter (package.json scripts, entry points). If it is unrelated to the goal, say so.`,
        });
        context = scouted.report;
      }

      info('Planning…');
      let feedback = '';
      let made = await makePlan({ model, goal, context, signal });
      for (let revision = 0; ; revision++) {
        if (!made.ok) return finish({ title: 'Build', tasks: [] }, { note: `The planner did not produce a usable plan:\n${made.errors.map((e) => `- ${e}`).join('\n')}\nTry a shorter, more concrete goal.` });
        plan = made.plan;
        savePlan(cwd, plan);
        say(renderPlan(plan));

        if (!attended) {
          if (!autoApprove) return finish(plan, { note: 'Nobody is here to review the plan, so nothing was built. Run it interactively, or pass --yes to build without review.' });
          break;
        }
        const answers = await rt.questionFlow.requestAnswer({
          questions: [{ question: 'Build this plan? (Enter your own text to change it)', options: ['Yes, build it', 'No, stop here'] }],
        });
        const answer = String(answers?.[0] ?? '').trim();
        if (!answer || /^no\b/i.test(answer)) return finish(plan, { note: 'Stopped before building. Edit `.brittain/plan.md`, then run `/build` with no goal to build from it.' });
        if (/^yes\b/i.test(answer)) break;
        if (revision >= MAX_REVISIONS) return finish(plan, { note: `Revised ${MAX_REVISIONS} times already. Edit \`.brittain/plan.md\` yourself, then run \`/build\` with no goal.` });
        feedback = answer;
        info('Revising the plan…');
        made = await makePlan({ model, goal, context, feedback, previous: plan, signal });
      }
    }

    // ---- the loop: no model decides what happens next ----
    let stoppedNote = '';
    for (let task = nextPending(plan); task; task = nextPending(plan)) {
      let outcome = await runTask({ plan, task, model, cwd, autoApprove, context });
      // A small model that is stuck is often one sentence from unstuck, and a
      // human is the cheapest way to say it. Offer a hint instead of giving up.
      for (let hints = 0; !outcome.ok && !outcome.stopped && !outcome.denied && attended && hints < MAX_HINTS; hints++) {
        const answers = await rt.questionFlow.requestAnswer({
          questions: [{ question: `Task ${task.n} failed:\n${clip(outcome.reason, 500)}\nType a hint for the coder to try again, or stop.`, options: ['Stop here'] }],
        });
        const hint = String(answers?.[0] ?? '').trim();
        if (!hint || /^stop\b/i.test(hint)) break;
        info('  retrying with your hint…');
        outcome = await runTask({ plan, task, model, cwd, autoApprove, context, failure: `${outcome.reason}\nThe user says: ${hint}` });
      }
      if (outcome.stopped) { stoppedNote = 'Stopped. Run `/build` with no goal to continue from the plan.'; break; }
      if (outcome.ok) {
        plan = markTask(plan, task.n, 'done', outcome.evidence);
        savePlan(cwd, plan);
        info(`  ✓ done — ${outcome.evidence}`);
      } else {
        plan = markTask(plan, task.n, 'failed', '');
        savePlan(cwd, plan);
        stoppedNote = `Task ${task.n} did not pass its check:\n${clip(outcome.reason, 600)}\nFix it by hand or edit the plan, then run \`/build\` with no goal to continue.`;
        break;
      }
    }

    return finish(plan, { note: stoppedNote, undoable: !!start, incomplete: plan.tasks.some((t) => t.status !== 'done') });
  }

  return { build, loadPlan, planPath };
}

module.exports = { PLAN_DIR, PLAN_FILE, TASK_ATTEMPTS, createPipeline };
