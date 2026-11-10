'use strict';

// The interactive session: `brittain`.
//
// One readline interface owns the terminal. While a run is in progress it
// answers approvals and questions; between runs it reads messages and slash
// commands. Everything the run says arrives as events and goes through the
// renderer.
//
// Keys: Enter sends; a trailing \ (or a paste) continues onto the next line;
// Ctrl-C stops a run, and pressed twice at an idle prompt exits; Ctrl-D exits;
// ↑ recalls history, which persists to <dataDir>/repl_history.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { createRenderer } = require('./render');
const { createSlash } = require('./slash');

const HISTORY_LIMIT = 500;
const PASTE_WINDOW_MS = 12;
const EXIT_WINDOW_MS = 2000;

function loadHistory(file) {
  try {
    // Stored oldest-first like a shell's; readline wants newest-first.
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).reverse().slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(file, history) {
  try {
    fs.writeFileSync(file, [...history].slice(0, HISTORY_LIMIT).reverse().join('\n') + '\n', { mode: 0o600 });
  } catch {}
}

function tildify(dir) {
  const home = os.homedir();
  return dir === home ? '~' : dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
}

// Short, readable argument previews for the approval prompt; [v]iew shows all.
function describeRequest(request) {
  const { name, args = {}, target } = request;
  if (name === 'edit_file') return `${args.path}`;
  if (name === 'move_file') return `${args.source} → ${args.destination}`;
  if (name === 'apply_patch') return `(${String(args.patch || '').split('\n').filter((l) => l.startsWith('+++ ')).map((l) => l.slice(4).replace(/^b\//, '')).join(', ') || 'patch'})`;
  return target || '';
}

function createRepl({
  runtime,
  input = process.stdin,
  output = process.stdout,
  color = false,
  live = false,
  historyFile = '',
  autoApprove = false,
  setupProvider = null,
  pagerCommand = '',
  bridge,
  exit = () => {},
}) {
  const { commands, events, rt } = runtime;
  const terminal = !!(input.isTTY && output.isTTY);
  const renderer = createRenderer({ out: output, color, live, columns: () => output.columns || 80 });
  const style = renderer.style;
  const rl = readline.createInterface({
    input,
    output,
    terminal,
    history: historyFile ? loadHistory(historyFile) : [],
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });
  if (historyFile) rl.on('history', (history) => saveHistory(historyFile, history));
  // readline echoes typed characters through this method; muting it is how a
  // key is read without being shown.
  let muted = false;
  const echo = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (text) => { if (!muted && echo) echo(text); };

  const state = { autoApprove };
  let running = false;       // a model run is in progress
  let busy = false;          // a message or slash command is being handled
  let waiting = null;        // resolves the next line while something is asking
  const queue = [];          // lines that arrived before anything asked for them
  let inputEnded = false;
  let multiline = [];
  let pasteBuffer = [];
  let pasteTimer = null;
  let lastIdleInterrupt = 0;
  let closed = false;

  // Long output goes through $PAGER (less -R by default) when it would
  // scroll off a terminal. The pager reads keys from the terminal itself, so
  // readline steps aside while it runs.
  function page(text) {
    const rows = output.rows || 0;
    const lines = String(text).split('\n');
    if (!terminal || !rows || lines.length < rows - 2) {
      renderer.line(text);
      return;
    }
    const pager = pagerCommand || 'less -R';
    rl.pause();
    input.setRawMode?.(false);
    try {
      const result = spawnSync('sh', ['-c', pager], { input: String(text) + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
      if (result.error || result.status === 127) renderer.line(text);
    } finally {
      input.setRawMode?.(true);
      rl.resume();
    }
  }

  const ui = {
    style,
    state,
    color,
    page,
    line: (text) => renderer.line(text),
    // CLI addition: /build. An empty goal resumes the plan in .brittain/plan.md.
    build: (goal) => send(goal, () => commands.build({ goal, autoApprove: state.autoApprove })),
    // A numbered pick that reads its answer from this same interface.
    pick: async (question, items, { current } = {}) => {
      items.forEach((item, index) => {
        renderer.line(`${item.value === current ? '*' : ' '} ${String(index + 1).padStart(2)}. ${item.label}`);
      });
      const answer = (await readAnswer(`${question} `)).trim();
      if (!answer) return current ?? null;
      const number = Number(answer);
      if (Number.isInteger(number) && number >= 1 && number <= items.length) return items[number - 1].value;
      const exact = items.find((item) => String(item.value).toLowerCase() === answer.toLowerCase());
      if (exact) return exact.value;
      renderer.line(`No entry matches "${answer}".`);
      return null;
    },
  };
  // The shape first-run.js expects, answered on this same interface.
  ui.prompter = {
    line: async (question, { defaultValue = '' } = {}) => {
      const answer = await readAnswer(`${question}${defaultValue ? ` [${defaultValue}]` : ''} `);
      return answer.trim() || defaultValue;
    },
    hidden: async (question) => (await readAnswer(`${question} `, { hidden: true })).trim(),
    pick: (question, items, options) => ui.pick(question, items, options),
  };
  const slash = createSlash({ runtime, ui, setupProvider: setupProvider ? (mode) => setupProvider(mode, ui) : null });

  function statusLine() {
    const provider = rt.providers.resolve();
    const parts = [
      `${provider.mode}/${provider.model || '(no model)'}`,
      tildify(rt.config.cwd),
      `ctx ${renderer.contextPercent()}%`,
    ];
    if (state.autoApprove) parts.push('auto');
    return style.dim(parts.join(' · '));
  }

  function showPrompt() {
    if (closed) return;
    if (!renderer.atLineStart()) renderer.write('\n');
    renderer.line(statusLine());
    rl.setPrompt(style.bold('› '));
    rl.prompt();
  }

  // Asks on the shared interface and resolves with the next line. A line
  // that was typed (or piped) ahead of the question answers it.
  function readAnswer(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
      renderer.flush();
      if (queue.length) {
        const answer = queue.shift();
        renderer.line(`${question}${hidden ? '' : answer}`);
        return resolve(answer);
      }
      if (closed || inputEnded) return resolve('');
      // Answers are not history: recalling "y" is useless, and a key typed
      // at a hidden prompt must never be written to repl_history.
      const historySize = rl.historySize;
      rl.historySize = 0;
      waiting = (answer) => {
        rl.historySize = historySize;
        if (hidden) {
          muted = false;
          if (terminal) renderer.write('\n');
        }
        resolve(answer);
      };
      rl.setPrompt(question);
      rl.prompt();
      muted = hidden;
    });
  }

  // ---------- host callbacks ----------

  async function approve(request) {
    const kind = request.kind || {};
    // The core says what "always" would cover; it offers nothing for an
    // invariant or a command it cannot scope.
    const always = request.always && !(kind.destructive || kind.sensitive || kind.financial) ? request.always : null;
    const flags = [
      kind.financial ? style.red('SPENDS MONEY') : '',
      kind.destructive ? style.red('DESTRUCTIVE') : '',
      kind.sensitive ? style.yellow('SENSITIVE READ') : '',
    ].filter(Boolean).join(' ');
    const choices = always ? `[y]es / [n]o / [a]lways ${always} / [v]iew` : '[y]es / [n]o / [v]iew';
    for (;;) {
      if (flags) renderer.line(flags);
      const answer = (await readAnswer(`Allow ${style.bold(request.name)} ${describeRequest(request)}? ${style.dim(choices)} `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (always && (answer === 'a' || answer === 'always')) return 'always';
      if (answer === 'v' || answer === 'view') {
        renderer.line(style.dim(JSON.stringify(request.args, null, 2)));
        continue;
      }
      return false;
    }
  }

  async function ask(request) {
    const answers = [];
    for (const { question, options = [] } of request.questions || []) {
      renderer.line(style.bold(`? ${question}`));
      options.forEach((option, index) => renderer.line(`  ${index + 1}. ${option}`));
      const hint = options.length ? 'Number or your own answer: ' : 'Answer: ';
      const answer = (await readAnswer(hint)).trim();
      if (closed) return null;
      const number = Number(answer);
      answers.push(Number.isInteger(number) && number >= 1 && number <= options.length ? options[number - 1] : answer);
    }
    return answers;
  }

  if (bridge) {
    bridge.approve = approve;
    bridge.ask = ask;
  }

  // ---------- runs ----------

  const unsubscribe = events.subscribe((channel, payload) => renderer.handle(channel, payload));

  // `start` overrides how the run begins: /build starts the pipeline, not a chat turn.
  async function send(text, start = () => commands.chat({ text, autoApprove: state.autoApprove })) {
    running = true;
    const before = { ...rt.session.usage.main };
    let result;
    try {
      result = await start();
    } finally {
      running = false;
    }
    if (!result.ok && !result.stopped && result.error && !/^A request is already running/.test(result.error)) {
      // A refusal before the run started has no stream:done to report it.
      if (!result.runId) renderer.line(style.red(`✗ ${result.error}`));
    }
    const after = rt.session.usage.main;
    renderer.endTurn({ promptTokens: after.prompt - before.prompt, evalTokens: after.gen - before.gen });
    return result;
  }

  async function submit(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      if (trimmed.startsWith('/')) await slash.handle(trimmed);
      else await send(text);
    } catch (error) {
      renderer.line(style.red(`✗ ${rt.providers.redact(error?.message || String(error))}`));
    }
  }

  // Handles queued input one message at a time.
  async function pump() {
    if (busy || closed) return;
    while (queue.length && !closed) {
      let lineText = queue.shift();
      // A trailing backslash continues the message on the next line.
      if (/\\$/.test(lineText)) {
        multiline.push(lineText.slice(0, -1));
        if (!queue.length) {
          rl.setPrompt(style.dim('… '));
          rl.prompt();
          return;
        }
        continue;
      }
      lineText = [...multiline, lineText].join('\n');
      multiline = [];
      busy = true;
      try {
        await submit(lineText);
      } finally {
        busy = false;
      }
      if (!queue.length && !inputEnded) showPrompt();
    }
    if (inputEnded && !queue.length) close();
  }

  function enqueue(text) {
    queue.push(text);
    if (busy && running && terminal) renderer.line(style.dim('(queued until this run finishes)'));
    pump();
  }

  function onLine(lineText) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(lineText);
      return;
    }
    if (!terminal) return enqueue(lineText);
    // A paste arrives as several lines within a few milliseconds; typing
    // cannot. Gather them into one message.
    pasteBuffer.push(lineText);
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      const lines = pasteBuffer;
      pasteBuffer = [];
      enqueue(lines.length > 1 ? lines.join('\n') : lines[0]);
    }, PASTE_WINDOW_MS);
  }

  // Ctrl-C: stop a run; at an idle prompt, clear the line, and a second press
  // within two seconds exits.
  function interrupt() {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      renderer.write('\n');
      resolve('');
      return;
    }
    if (running) {
      commands.stop();
      renderer.line(style.yellow('Stopping…'));
      return;
    }
    const now = Date.now();
    if (multiline.length || rl.line) {
      multiline = [];
      rl.write(null, { ctrl: true, name: 'u' });
      lastIdleInterrupt = 0;
      renderer.write('\n');
      return showPrompt();
    }
    if (now - lastIdleInterrupt < EXIT_WINDOW_MS) return close();
    lastIdleInterrupt = now;
    renderer.write('\n');
    renderer.line(style.dim('(Press Ctrl-C again to exit)'));
    showPrompt();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (running) commands.stop();
    if (waiting) { const resolve = waiting; waiting = null; resolve(''); }
    unsubscribe();
    rl.close();
    exit();
  }

  rl.on('line', onLine);
  rl.on('SIGINT', interrupt);
  // Ctrl-D, or the end of piped input. Piped input can end while a run it
  // started is still going; let it and anything queued finish first.
  rl.on('close', () => {
    if (closed) return;
    inputEnded = true;
    if (waiting) { const resolve = waiting; waiting = null; resolve(''); }
    if (terminal) return close();
    if (!busy) pump();
  });

  return {
    start: () => showPrompt(),
    interrupt,
    close,
    state,
    renderer,
    slash,
    running: () => running,
  };
}

module.exports = { createRepl, describeRequest, loadHistory, saveHistory };
