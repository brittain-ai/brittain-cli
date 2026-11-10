// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- subagents ----------"
'use strict';

// run_subagent: a read-only scout with a context of its own. It gets one task,
// explores with read-only tools, and hands back a findings report — the only
// part of its work the lead agent ever sees.
//
// On a 32k model this is mostly about context, not speed: file contents a
// subagent reads never enter the lead conversation, so the lead can survey a
// codebase without compacting away what it already knew.
//
// Deviations from the source:
//   - The subagent runs on the lead's provider, with the `subagentModel`
//     setting or else the lead's own model (the source defaulted to a local
//     qwen3:8b scout, which brittain mode does not have).
//   - Its window is the model's effective context, not a 24k cap: the cap
//     spared a local machine's memory, and a hosted model has no such cost.
//   - At 85% of that window (or sooner, if a request could not fit the
//     reply) it stops exploring and goes straight to the report, with the
//     oldest results cut down to fit.
//   - Sensitive reads still ask the human, exactly as they do for the lead.
//   - The repeat and failure guards run on its calls as well.
//
// CLI addition (/build): a subagent has a role. `scout` is the source's
// read-only researcher. `verifier` is read-only too, but judges a diff against
// acceptance criteria. `coder` may edit and run commands, and every such call
// goes through the same approval gate as the lead's, so a coder is never a way
// around a human decision. Roles differ in tools, prompt, step budget and
// deadline; the loop, the guards, and the report are shared.

const { estimateContextTokens } = require('../lib/context-estimator');
const { boundToolResult, toolResultLimit } = require('../lib/tool-result');
const { createRepeatTracker, createToolFailureTracker } = require('../lib/tool-failure');
const { SUBAGENT_TOOL_NAMES, CODER_TOOL_NAMES, RISKY_TOOLS, DESTRUCTIVE_TOOLS, isDestructiveCommand } = require('../lib/tools');
const { isSensitiveToolCall, unapprovedResult } = require('./approvals');
const { parseRawToolCalls } = require('./tool-call-parser');

const SUBAGENT_MAX_STEPS = 12;
const SUBAGENT_REPORT_CAP = 6000;   // chars of findings returned to the main agent
const SUBAGENT_TIMEOUT_MS = 240_000; // wall-clock cap — model swapping makes steps slow, but not infinite
const WRAP_UP_TIMEOUT_MS = 60_000;
// Past this share of its window the subagent stops exploring and reports, so
// the report is written with room to spare rather than squeezed in at the end.
const SUBAGENT_REPORT_AT = 0.85;

function subagentSystemPrompt(cwd) {
  return [
    'You are a fast research subagent inside Brittain Code, working for a lead agent.',
    `Working directory: ${cwd} — use paths relative to it.`,
    'You have read-only exploration tools. You cannot edit code, run shell commands, or ask the user questions.',
    '',
    'Strategy — follow this order:',
    '1. browse_files first to see what files exist.',
    '2. search_files with SHORT single-word patterns: search "history", never "chat history persistence logic". Multi-word phrases almost never match code.',
    '3. read_file the promising files and base your answer on what you actually read.',
    'If a search finds nothing, do not retry it with similar words — switch tactics (list the directory, read the most likely file).',
    `You have a budget of roughly ${SUBAGENT_MAX_STEPS} tool calls. Spend a few exploring, then STOP calling tools and write your report.`,
    '',
    'Your FINAL message is the only thing returned to the lead agent, so make it a complete findings report: cite file paths and line numbers, quote the relevant code, and answer every part of the task. If you cannot find something, say so explicitly rather than guessing.',
  ].join('\n');
}

function verifierSystemPrompt(cwd) {
  return [
    'You are a verifier inside Brittain Code. You judge whether ONE task was done correctly. You do not fix anything.',
    `Working directory: ${cwd} — use paths relative to it.`,
    'You have read-only tools. You are given the task, what it had to achieve, and the real output of its acceptance command.',
    '',
    'Read the files the task touched. For each behaviour the task lists, find the code that does it and trace ONE concrete input through it, step by step, checking what type each value really is (a string cannot be given a property; an index may be off by one). Also try an edge case (empty input, last item, missing file).',
    'An exit code of 0 only proves the command ran. It does not prove the behaviour. Be suspicious of: tests that catch and swallow errors, tests that do not use the required test framework, tests with no assertions, code that silently does nothing.',
    'Do not trust the coder\'s own summary. Base your verdict on what you read and the output you were given.',
    '',
    'Reply in exactly this shape:',
    'PASS: <one behaviour that is correct>  (one line each)',
    'FAIL: <one behaviour that is wrong or missing> — <what is wrong, with file:line>  (one line each)',
    'VERDICT: PASS   (or VERDICT: FAIL — use FAIL only if at least one FAIL line above is a real defect)',
  ].join('\n');
}

function coderSystemPrompt(cwd) {
  return [
    'You are a coder inside Brittain Code. You are given ONE task, with fixed decisions. Build exactly that task.',
    `Working directory: ${cwd} — use paths relative to it.`,
    '',
    'How to work:',
    '1. If the task edits existing files, read them first. If it creates new files, just write them.',
    '2. Write COMPLETE files with write_file (never TODO, never placeholders). Use edit_file for small changes to a file that exists.',
    '3. Follow the fixed decisions exactly (language, module system, file names). Do not change them and do not add files the task does not list, unless it cannot work without one.',
    '   You cannot delete files: rm and similar are refused. To reset a data file, overwrite it with write_file. Write error messages to stderr and exit non-zero.',
    '4. Tests must FAIL LOUDLY: use the language\'s real test runner (Node: `const test = require(\'node:test\')` and `test(\'name\', () => { assert… })`; Python: unittest) so a failing test makes the command exit non-zero. Never wrap assertions in try/catch and never print a pass/fail line yourself.',
    '5. Then run the "Done means" command with run_command. If it fails, or its output shows any failure, read the error, fix the cause, and run it again.',
    '6. The Done command is the real requirement, even where the task text is looser: make the program do whatever that command needs (for example, if it runs a file with an argument and expects output, the file must do that). If it fails the same way twice, do NOT run it again with small variations — change the code.',
    '7. Stop when the command exits 0 and its output shows no failures. Do not add extras.',
    '',
    'Your FINAL message is returned to the lead: list the files you changed, and say what your last run of the Done command printed. If it still fails, say so and why.',
  ].join('\n');
}

// `think`: whether the role reasons before acting, when the user's thinking
// setting (/think) is on. Scouts stay fast. Coders and verifiers think: they
// make the judgement calls a small model gets wrong without it.
const ROLES = {
  scout: { think: false, tools: SUBAGENT_TOOL_NAMES, prompt: subagentSystemPrompt, maxSteps: SUBAGENT_MAX_STEPS, timeoutMs: SUBAGENT_TIMEOUT_MS },
  verifier: { think: true, tools: SUBAGENT_TOOL_NAMES, prompt: verifierSystemPrompt, maxSteps: 8, timeoutMs: SUBAGENT_TIMEOUT_MS },
  coder: { think: true, tools: CODER_TOOL_NAMES, prompt: coderSystemPrompt, maxSteps: 30, timeoutMs: 600_000 },
};

const WRAP_UP = 'Your tool budget is exhausted. Write your complete findings report NOW, using only what you have already seen. Cite file paths and line numbers. If parts of the task are unanswered, say which.';

// Cut the oldest tool results down until the request fits. The newest results
// are what the report is most likely to rest on.
function shrinkToFit(msgs, budget) {
  const fitted = msgs.map((message) => ({ ...message }));
  for (const message of fitted) {
    if (estimateContextTokens(fitted) <= budget) break;
    if (message.role !== 'tool' || message.content.length <= 400) continue;
    message.content = `${message.content.slice(0, 300)}\n[… cut to fit the context window; ${message.content.length.toLocaleString()} characters in full]`;
  }
  return fitted;
}

function createSubagentRunner(rt, { safeExecute, hardInputFor }) {
  const sink = () => rt.sink;

  // Resolves with { result, stats } — stats summed over every model call, so
  // the lead's turn can count what the subagent cost.
  async function runSubagent({ task, leadModel, cwd, autoApprove, role = 'scout' }) {
    const spec = ROLES[role];
    if (!spec) throw new Error(`Unknown subagent role "${role}".`);
    const maxSteps = spec.maxSteps;
    const model = rt.config.settings().subagentModel || leadModel;
    const contextLength = await rt.models.effectiveContext(model);
    const hardInput = hardInputFor(contextLength);
    // Whichever comes first: 85% of the window, or the most a request may
    // carry (on a 32k window that is already ~81%).
    const reportAt = Math.min(Math.floor(contextLength * SUBAGENT_REPORT_AT), hardInput);
    const resultLimit = toolResultLimit(contextLength);
    const tools = rt.prompts.subagentToolDefs(role);
    const toolTokens = estimateContextTokens(tools);
    const msgs = [
      { role: 'system', content: spec.prompt(cwd) },
      { role: 'user', content: task },
    ];
    // scouts should be fast: disable thinking where the model supports the flag
    const settings = rt.config.settings();
    const useThink = await rt.models.thinkValue(model, spec.think && !!settings.codeThink);
    const temperature = settings.codeTemperature;
    const toolFailures = createToolFailureTracker(2);
    const repeats = createRepeatTracker();
    const totals = { promptTokens: 0, evalTokens: 0 };
    const record = (stats) => {
      if (!stats) return;
      rt.state.recordUsage('main', stats);
      totals.promptTokens += stats.promptTokens || 0;
      totals.evalTokens += stats.evalTokens || 0;
    };
    let finalContent = '';
    let steps = 0;
    let note = '';
    // deadline for the whole subagent: aborts on user STOP or on timeout
    const signal = AbortSignal.any([rt.run.abort.signal, AbortSignal.timeout(spec.timeoutMs)]);

    sink().emit('stream:subagent', { phase: 'start', task, model, role });
    rt.session.usage.metrics.subagentRuns = (rt.session.usage.metrics.subagentRuns || 0) + 1;
    try {
      for (let step = 0; step < maxSteps; step++) {
        if (rt.run.stopRequested || signal.aborted) break;
        const used = estimateContextTokens(msgs) + toolTokens;
        if (used > reportAt) {
          note = `its context reached ${Math.round((used / contextLength) * 100)}% of the window`;
          break;
        }
        let { content, toolCalls, stats } = await rt.stream.streamChat(model, msgs, signal, useThink, true, contextLength, tools, { toolCallRetries: 0 }, temperature);
        record(stats);

        if (!toolCalls.length) {
          const recovered = parseRawToolCalls(content);
          if (recovered) {
            rt.session.usage.metrics.recoveredToolCalls += recovered.calls.length;
            toolCalls = recovered.calls;
            content = recovered.cleaned;
          }
        }
        if (content) finalContent = content;

        const assistantMsg = { role: 'assistant', content };
        if (toolCalls.length) {
          assistantMsg.tool_calls = toolCalls.map((call, index) => ({ ...call, id: call.id || `sub_${step}_${index}` }));
        }
        msgs.push(assistantMsg);
        if (!toolCalls.length) break;

        for (const tc of assistantMsg.tool_calls) {
          const name = tc.function?.name;
          let args = tc.function?.arguments || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          if (!args || typeof args !== 'object') args = {};
          steps++;
          sink().emit('stream:subagent', { phase: 'tool', name, args });
          const result = await runTool(name, args, { cwd, autoApprove, toolFailures, repeats, role });
          rt.state.recordToolTelemetry(result, false);
          const bounded = boundToolResult(result, { toolName: name || 'tool', maxChars: resultLimit });
          msgs.push({ role: 'tool', tool_name: name, tool_call_id: tc.id, content: bounded.content });
        }
        // A report written alongside more tool calls is not the final one.
        finalContent = '';
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        if (rt.run.stopRequested) throw err; // user hit STOP — unwind the whole run
        note = 'it ran out of time';
        // timeout: fall through and salvage a report from what it saw
      } else if (err.name === 'PsychosisDetectedError') {
        note = `the live guard stopped it (${err.message})`;
      } else {
        finalContent = finalContent || `Subagent failed: ${rt.providers.redact(err.message || String(err))}`;
      }
    }

    // scout ran out of steps/time while still exploring — force a report from what it saw
    if (!finalContent && !rt.run.stopRequested) {
      try {
        const wrapUp = shrinkToFit([...msgs, { role: 'user', content: WRAP_UP }], hardInput);
        // fresh signal for the wrap-up: the main deadline may already be spent
        const wrapSignal = AbortSignal.any([rt.run.abort.signal, AbortSignal.timeout(WRAP_UP_TIMEOUT_MS)]);
        const wrap = await rt.stream.streamChat(model, wrapUp, wrapSignal, useThink, true, contextLength, null, { toolCallRetries: 0 }, temperature);
        record(wrap.stats);
        finalContent = wrap.content || '';
      } catch (err) {
        if (err.name === 'AbortError' && rt.run.stopRequested) throw err;
        finalContent = finalContent || '(subagent timed out before writing a report)';
      }
    }

    const report = (finalContent || '(subagent finished without producing findings)').slice(0, SUBAGENT_REPORT_CAP);
    sink().emit('stream:subagent', { phase: 'done', steps, ...(note ? { note } : {}) });
    const header = `Subagent report (${steps} tool ${steps === 1 ? 'call' : 'calls'}${note ? `; stopped early: ${note}` : ''}):`;
    return { result: `${header}\n${report}`, stats: totals, report, steps, note, role };
  }

  async function runTool(name, args, { cwd, autoApprove, toolFailures, repeats, role }) {
    if (!ROLES[role].tools.has(name)) {
      return `Error: tool "${name}" is not available to ${role === 'coder' ? 'a coder' : 'subagents'}. ${role === 'coder' ? 'Use your editing and running tools.' : 'Use your read-only exploration tools.'}`;
    }
    if (toolFailures.shouldBlock(name, args)) {
      return `Error: This exact ${name} call already failed twice. Use a different approach.`;
    }
    if (repeats.shouldBlock(name, args)) {
      return `Error: You already made this exact ${name} call twice and got the same result. Use what you have, or write your report.`;
    }
    const approve = async (promptKind, deniedText) => {
      const decision = await rt.approvalFlow.resolveToolCall(name, args, { autoApprove, promptKind });
      return decision.approved
        ? safeExecute(name, args, cwd)
        : unapprovedResult(decision.verdict, deniedText);
    };
    // The same gate as the lead's (agent-loop resolveCall): destructive and
    // sensitive calls always ask, and so does anything risky the policy asks about.
    let result;
    if (DESTRUCTIVE_TOOLS.has(name) || (name === 'run_command' && isDestructiveCommand(args.command))) {
      result = await approve({ destructive: true }, 'The user denied this destructive operation. Do not retry it or any variation of it.');
    } else if (isSensitiveToolCall(name, args)) {
      // A secret read by a subagent is still a secret read: the human decides.
      result = await approve({ sensitive: true }, 'The user denied this sensitive read. Do not retry it.');
    } else if (name === 'apply_patch' && args.dry_run !== false) {
      result = await safeExecute(name, args, cwd);
    } else if (RISKY_TOOLS.has(name)) {
      result = await approve({}, 'The user denied this tool call. Try another approach, or say in your report what could not be done.');
    } else {
      result = await safeExecute(name, args, cwd);
    }
    toolFailures.record(name, args, result);
    repeats.record(name, args, result);
    return result;
  }

  return { runSubagent };
}

module.exports = {
  ROLES,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_REPORT_AT,
  SUBAGENT_REPORT_CAP,
  createSubagentRunner,
  subagentSystemPrompt,
};
