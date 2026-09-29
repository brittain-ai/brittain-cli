// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/ledger.js
'use strict';

// A mechanically extracted record of what a session actually did.
//
// Which files were written, which commands ran, and what failed is all
// recoverable exactly by walking the tool calls and their results — no model
// required and nothing to hallucinate. Compaction used to leave those facts to
// the summarizer's discretion, which is why the file list was the first thing
// to disappear from a long session.

// Tools whose arguments name a file the model changed.
const MUTATION_PATH_ARG = {
  write_file: 'path',
  edit_file: 'path',
  delete_file: 'path',
};

// Tools that move content from one path to another.
const MUTATION_MOVE = new Set(['move_file']);

// Tools that only look at a file.
const READ_PATH_ARG = {
  read_file: 'path',
  get_file_lines: 'path',
};

const VERB = {
  write_file: 'written',
  edit_file: 'edited',
  delete_file: 'deleted',
  move_file: 'moved',
  apply_patch: 'patched',
};

function outcomeOf(result, name = '') {
  const text = String(result || '');
  if (name === 'run_project_check' && text.trimStart().startsWith('{')) {
    try {
      const check = JSON.parse(text);
      if (check.timed_out || check.signal || (check.exit_code !== undefined && check.exit_code !== 0)) return 'error';
    } catch {}
  }
  // Denial strings are authored in main.js and all open the same way. Matching
  // the sentence rather than a UI label keeps this accurate.
  if (/^\s*The user (denied|cancelled|reviewed)\b/i.test(text)) return 'denied';
  if (/^\s*Cancelled by user\b/i.test(text)) return 'denied';
  // A call refused without asking (print mode without --yes) did NOT run.
  // Grouped with denied so a held write is never ledgered as a mutation.
  if (/^\s*This call needs the user's approval\b/i.test(text)) return 'denied';
  if (/^\s*This tool call was not permitted\b/i.test(text)) return 'denied';
  if (/^\s*Error:/i.test(text)) return 'error';
  return 'ok';
}

function firstLine(value, max = 200) {
  const line = String(value || '').split('\n').find((entry) => entry.trim()) || '';
  return line.length > max ? line.slice(0, max) + '…' : line.trim();
}

// apply_patch carries its targets inside the diff rather than in an argument.
function pathsFromPatch(patch) {
  const paths = [];
  for (const line of String(patch || '').split('\n')) {
    const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (!match) continue;
    const target = match[1].trim();
    if (target && target !== '/dev/null') paths.push(target);
  }
  return paths;
}

function parseArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Pair each assistant tool_call with the tool result that follows it. Results
// arrive in call order, so a queue is enough and no ids are needed.
function pairCalls(messages) {
  const pairs = [];
  const pending = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        pending.push({
          name: call?.function?.name || '',
          args: parseArguments(call?.function?.arguments),
        });
      }
      continue;
    }
    if (message?.role !== 'tool') continue;
    const index = message.tool_name
      ? pending.findIndex((entry) => entry.name === message.tool_name)
      : 0;
    const call = index >= 0 ? pending.splice(index, 1)[0] : null;
    pairs.push({
      name: message.tool_name || call?.name || 'unknown',
      args: call?.args || {},
      result: String(message.content || ''),
    });
  }
  return pairs;
}

function touchFile(files, filePath, verb, outcome) {
  const key = String(filePath || '').trim();
  if (!key) return;
  const entry = files.get(key) || { path: key, verbs: new Map(), reads: 0, failures: 0 };
  if (verb === 'read') {
    entry.reads += 1;
  } else if (outcome === 'ok') {
    entry.verbs.set(verb, (entry.verbs.get(verb) || 0) + 1);
  } else {
    entry.failures += 1;
  }
  files.set(key, entry);
}

function buildLedger(messages) {
  const files = new Map();
  const commands = [];
  const denied = [];
  const errors = [];
  let toolCalls = 0;

  for (const { name, args, result } of pairCalls(messages)) {
    toolCalls += 1;
    const outcome = outcomeOf(result, name);

    if (outcome === 'denied') denied.push({ tool: name, target: describeTarget(name, args) });
    if (outcome === 'error') {
      errors.push({ tool: name, target: describeTarget(name, args), message: firstLine(result) });
    }

    if (name === 'run_command' || name === 'run_project_check') {
      commands.push({ command: name === 'run_command' ? firstLine(args.command, 120) : `project check: ${firstLine(args.check || 'list', 100)}`, outcome });
    } else if (MUTATION_PATH_ARG[name]) {
      touchFile(files, args[MUTATION_PATH_ARG[name]], VERB[name], outcome);
    } else if (MUTATION_MOVE.has(name)) {
      touchFile(files, args.destination || args.path, VERB[name], outcome);
    } else if (name === 'apply_patch' && args.dry_run === false) {
      for (const target of pathsFromPatch(args.patch)) touchFile(files, target, VERB.apply_patch, outcome);
    } else if (READ_PATH_ARG[name]) {
      touchFile(files, args[READ_PATH_ARG[name]], 'read', outcome);
    }
  }

  const all = [...files.values()];
  return {
    changed: all.filter((entry) => entry.verbs.size > 0),
    read: all.filter((entry) => entry.verbs.size === 0 && entry.reads > 0),
    commands,
    denied,
    errors,
    totals: {
      toolCalls,
      changed: all.filter((entry) => entry.verbs.size > 0).length,
      failures: errors.length,
    },
  };
}

function describeTarget(name, args) {
  if (name === 'run_command') return firstLine(args?.command, 80);
  return String(args?.path || args?.destination || '');
}

function describeFile(entry) {
  const verbs = [...entry.verbs.entries()]
    .map(([verb, count]) => (count > 1 ? `${verb} ×${count}` : verb))
    .join(', ');
  const failed = entry.failures ? `, ${entry.failures} failed` : '';
  return `${entry.path} (${verbs}${failed})`;
}

function capped(list, limit, render) {
  const shown = list.slice(0, limit).map(render);
  const hidden = list.length - shown.length;
  return hidden > 0 ? [...shown, `…and ${hidden} more`] : shown;
}

function isEmptyLedger(ledger) {
  return !ledger
    || (!ledger.changed.length && !ledger.read.length && !ledger.commands.length
      && !ledger.denied.length && !ledger.errors.length);
}

// Rendered for the model, so it is terse and states its own provenance: these
// are facts read off the transcript, not a summarizer's recollection.
function renderLedger(ledger, { readLimit = 20, changedLimit = 30 } = {}) {
  if (isEmptyLedger(ledger)) return '';
  const lines = ['SESSION LEDGER (read directly from the tool record — these facts are exact):'];

  if (ledger.changed.length) {
    lines.push('', 'Files changed:');
    for (const line of capped(ledger.changed, changedLimit, describeFile)) lines.push(`- ${line}`);
  }
  if (ledger.read.length) {
    lines.push('', 'Files read but not changed: '
      + capped(ledger.read, readLimit, (entry) => entry.path).join(', '));
  }
  if (ledger.commands.length) {
    lines.push('', 'Commands run:');
    for (const line of capped(ledger.commands, 20, (entry) => `\`${entry.command}\` → ${entry.outcome}`)) {
      lines.push(`- ${line}`);
    }
  }
  if (ledger.errors.length) {
    lines.push('', 'Errors not yet resolved:');
    for (const line of capped(ledger.errors, 12, (entry) => `${entry.tool}${entry.target ? ` on ${entry.target}` : ''} — ${entry.message}`)) {
      lines.push(`- ${line}`);
    }
  }
  if (ledger.denied.length) {
    lines.push('', 'Denied by the user (do not retry without being asked):');
    for (const line of capped(ledger.denied, 12, (entry) => `${entry.tool}${entry.target ? ` on ${entry.target}` : ''}`)) {
      lines.push(`- ${line}`);
    }
  }
  return lines.join('\n');
}

module.exports = { buildLedger, renderLedger, isEmptyLedger, outcomeOf, pairCalls, pathsFromPatch };
