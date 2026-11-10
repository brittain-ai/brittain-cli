'use strict';

// CLI addition: the build plan (/build). The planner model emits it once, in a
// fixed shape; everything after that — validating it, marking tasks done,
// briefing a coder — is code, so no model can tick a task off or lose the plan.
//
//   # Plan: <title>
//   ## Decisions
//   - <one line each>
//   ## Task 1: <title>
//   Files: a.js, b.js
//   Do: <what to build>
//   Check: <one shell command that exits 0 only if the task worked>
//
// After a task runs the harness adds `Status:` and `Evidence:` lines.

const MIN_TASKS = 1;
const MAX_TASKS = 8;
const STATUSES = new Set(['pending', 'done', 'failed']);

// A Check is a shell command. The planner sometimes writes a sentence instead
// ("Run a test to verify…"), which cannot gate anything.
const PROSE_LEADS = new Set([
  'run', 'verify', 'ensure', 'check', 'confirm', 'execute', 'manually', 'open',
  'make', 'see', 'view', 'observe', 'inspect', 'try', 'validate', 'the', 'all',
]);

function looksLikeCommand(text) {
  const command = String(text || '').trim().replace(/^`+|`+$/g, '').trim();
  if (!command) return false;
  const words = command.split(/\s+/);
  const first = words[0];
  if (/^[A-Z]/.test(first)) return false;
  const lead = first.toLowerCase();
  if (PROSE_LEADS.has(lead)) return false;
  // `test` is a real command, but only with an operator; "Test the CLI" is prose.
  if (lead === 'test' && !/^(-|\[|!)/.test(words[1] || '')) return false;
  if (/\/path\/to\b|\.\.\.$/.test(command)) return false;
  // "npm install runs successfully": a command name followed by a sentence.
  // Real commands with arguments almost always carry a flag, path, quote or
  // operator; a bare run of words with a prose verb in it does not.
  if (!/[-|&;<>$"'=/.\\]/.test(words.slice(1).join(' ')) && /\b(runs?|works?|succe\w+|without|is|are|should|properly|correctly|creates?d?)\b/i.test(words.slice(1).join(' '))) return false;
  return true;
}

// `cmd | grep -q "not found"` never sees what cmd wrote to stderr, and error
// messages are written there. The first three-task /build failed its last task
// on exactly this, over a program that behaved correctly.
function greppsErrorFromPipe(check) {
  const command = String(check || '');
  if (/2>&1|&>|\|&/.test(command)) return false;
  return /\|\s*grep\b[^|]*\b(not found|error|invalid|usage|unknown|fail(ed|ure)?|no such|cannot|can't|missing|denied)\b/i.test(command);
}

function stripFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1] : trimmed;
}

// Returns { ok, plan, errors }. `plan` is present whenever the text could be
// read at all, so a caller can show what was understood next to the errors.
function parsePlan(text) {
  const errors = [];
  const lines = stripFence(text).split('\n');
  const plan = { title: '', decisions: [], tasks: [] };
  let section = '';
  let task = null;
  let field = '';

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^#\s+Plan:\s*(.*)$/i))) {
      plan.title = m[1].trim();
      section = 'head';
      task = null;
    } else if (/^##\s+Decisions\s*$/i.test(line)) {
      section = 'decisions';
      task = null;
    } else if ((m = line.match(/^##\s+Task\s+(\d+)\s*:\s*(.*?)(?:\s*\[(pending|done|failed)\])?$/i))) {
      task = { n: plan.tasks.length + 1, title: m[2].trim(), files: [], do: '', check: '', status: (m[3] || 'pending').toLowerCase(), evidence: '' };
      plan.tasks.push(task);
      section = 'task';
      field = '';
    } else if (section === 'decisions') {
      const item = line.match(/^\s*[-*]\s+(.*)$/);
      if (item) plan.decisions.push(item[1].trim());
    } else if (section === 'task' && task) {
      if ((m = line.match(/^Files:\s*(.*)$/i))) {
        task.files = m[1].split(',').map((f) => f.trim().replace(/^`|`$/g, '')).filter(Boolean);
        field = '';
      } else if ((m = line.match(/^Do:\s*(.*)$/i))) {
        task.do = m[1].trim();
        field = 'do';
      } else if ((m = line.match(/^Check:\s*(.*)$/i))) {
        task.check = m[1].trim().replace(/^`+|`+$/g, '').trim();
        field = '';
      } else if ((m = line.match(/^Status:\s*(\w+)/i))) {
        const status = m[1].toLowerCase();
        if (STATUSES.has(status)) task.status = status;
        field = '';
      } else if ((m = line.match(/^Evidence:\s*(.*)$/i))) {
        task.evidence = m[1].trim();
        field = 'evidence';
      } else if (line.trim() && field === 'do') {
        task.do += ` ${line.trim()}`;
      } else if (line.trim() && field === 'evidence') {
        task.evidence += ` ${line.trim()}`;
      }
    }
  }

  if (!plan.title) errors.push('The plan has no "# Plan: <title>" line.');
  if (plan.tasks.length < MIN_TASKS) errors.push('The plan has no "## Task N: <title>" sections.');
  if (plan.tasks.length > MAX_TASKS) errors.push(`The plan has ${plan.tasks.length} tasks; at most ${MAX_TASKS} — merge some.`);
  for (const t of plan.tasks) {
    const label = `Task ${t.n}`;
    if (!t.title) errors.push(`${label} has no title.`);
    if (!t.do) errors.push(`${label} has no "Do:" line.`);
    if (!t.check) errors.push(`${label} has no "Check:" line.`);
    else if (!looksLikeCommand(t.check)) errors.push(`${label}'s Check is not a shell command: "${t.check.slice(0, 80)}". It must be one command that exits 0 only if the task worked.`);
    else if (greppsErrorFromPipe(t.check)) errors.push(`${label}'s Check looks for an error message through a pipe, but errors go to stderr and a pipe carries only stdout. Put \`2>&1\` after the command, for example: node cli.js remove 99 2>&1 | grep -q "not found".`);
    if (!t.files.length) errors.push(`${label} has no "Files:" line.`);
  }
  return { ok: errors.length === 0, plan, errors };
}

function renderPlan(plan) {
  const out = [`# Plan: ${plan.title}`, '', '## Decisions'];
  for (const d of plan.decisions) out.push(`- ${d}`);
  for (const t of plan.tasks) {
    out.push('', `## Task ${t.n}: ${t.title}`);
    out.push(`Files: ${t.files.join(', ')}`);
    out.push(`Do: ${t.do}`);
    out.push(`Check: ${t.check}`);
    out.push(`Status: ${t.status}`);
    if (t.evidence) out.push(`Evidence: ${t.evidence}`);
  }
  return `${out.join('\n')}\n`;
}

// A done task must say how it was shown to be done.
function markTask(plan, n, status, evidence = '') {
  if (!STATUSES.has(status)) throw new Error(`Unknown task status "${status}".`);
  if (status === 'done' && !String(evidence).trim()) throw new Error('A task cannot be marked done without evidence.');
  return {
    ...plan,
    tasks: plan.tasks.map((t) => (t.n === n ? { ...t, status, evidence: String(evidence).trim() } : t)),
  };
}

function nextPending(plan) {
  return plan.tasks.find((t) => t.status !== 'done') || null;
}

// What a coder is told: the fixed decisions, what earlier tasks already built,
// and its own task. Never the whole plan, never the conversation.
function taskBrief(plan, task, { context = '', failure = '' } = {}) {
  const done = plan.tasks.filter((t) => t.status === 'done' && t.n < task.n);
  const out = [
    `Project: ${plan.title}`,
    '',
    'Fixed decisions (do not change them):',
    ...plan.decisions.map((d) => `- ${d}`),
  ];
  if (done.length) {
    out.push('', 'Already built by earlier tasks:');
    for (const t of done) out.push(`- ${t.title} (${t.files.join(', ')})`);
  }
  if (context) out.push('', 'Context from the codebase scout:', context);
  out.push(
    '',
    `YOUR TASK (${task.n} of ${plan.tasks.length}): ${task.title}`,
    `Files: ${task.files.join(', ')}`,
    `Do: ${task.do}`,
    `Done means this command exits 0: ${task.check}`,
    'Touch only the files listed unless the task cannot work without another.',
  );
  if (failure) out.push('', 'YOUR PREVIOUS ATTEMPT FAILED. Fix this:', failure);
  return out.join('\n');
}

module.exports = { MAX_TASKS, greppsErrorFromPipe, looksLikeCommand, markTask, nextPending, parsePlan, renderPlan, taskBrief };
