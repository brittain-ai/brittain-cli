'use strict';

// `brittain` with no command: set up the host and runtime, make sure the
// active provider is usable, pick up a saved chat if asked, and hand the
// terminal to the REPL.
//
//   brittain              a new chat
//   brittain --continue   the latest chat started in this directory
//   brittain --resume     a picker of saved chats; --resume <id> loads one

const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const { createNodeHost } = require('../host/node-host');
const { createRuntime } = require('../core/runtime');
const { loadSettings } = require('../lib/settings');
const { createProviders } = require('../lib/providers');
const { ensureSettings, setupProvider } = require('./first-run');
const { createPrompter } = require('./prompts');
const { createRepl } = require('./repl');

// A mode needs the walk-through when it cannot send a message as configured.
function needsSetup(resolved) {
  if (resolved.mode === 'brittain') return false;
  if (resolved.mode === 'openai' && !resolved.endpoint) return true;
  return !resolved.model;
}

async function startRepl({ options, positionals, env, stdin, stdout, stderr, keychain, io }) {
  const bridge = { approve: async () => false, ask: async () => null };
  const host = createNodeHost({
    env,
    keychain,
    approve: (request) => bridge.approve(request),
    ask: (request) => bridge.ask(request),
    interactive: () => true,
  });
  ensureSettings(host.dataDir);

  let cwd = process.cwd();
  if (options.cwd) {
    cwd = path.resolve(options.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`--cwd is not a directory: ${options.cwd}`);
  }

  // First run of a mode that needs an endpoint or a model: walk through it
  // before the REPL takes the terminal. A --provider override is set up but
  // not made the saved default.
  const providers = createProviders({
    getSettings: () => {
      const stored = loadSettings(host.dataDir);
      return options.provider ? { ...stored, provider: options.provider } : stored;
    },
    secrets: host.secrets,
    env,
  });
  const initial = providers.resolve();
  if (needsSetup(initial) && !options.model) {
    const prompter = createPrompter({ input: stdin, output: stderr });
    try {
      io.err(`${initial.label} needs setting up first.`);
      const done = await setupProvider(initial.mode, {
        dataDir: host.dataDir, providers, secrets: host.secrets, prompter, out: io.err, persist: !options.provider,
      });
      if (!done) return 1;
    } finally {
      prompter.close();
    }
  }

  const runtime = createRuntime({
    host,
    env,
    overrides: { provider: options.provider, model: options.model, cwd },
  });
  const { rt, commands } = runtime;
  const settings = rt.config.settings();

  if (options.continue) {
    const latest = rt.history.latestFor(cwd);
    if (!latest) io.err('No saved chat for this directory yet; starting a new one.');
    else commands['history.load']({ id: latest.id });
  }

  const color = !env.NO_COLOR && !!stdout.isTTY;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const repl = createRepl({
    runtime,
    input: stdin,
    output: stdout,
    color,
    live: !!stdout.isTTY,
    historyFile: path.join(host.dataDir, 'repl_history'),
    autoApprove: !!options.yes || settings.autoApprove,
    bridge,
    pagerCommand: env.PAGER || '',
    exit: () => resolveExit(0),
    setupProvider: (target, ui) => setupProvider(target, {
      dataDir: host.dataDir, providers: rt.providers, secrets: host.secrets, prompter: ui.prompter, out: ui.line,
    }),
  });

  const style = repl.renderer.style;
  repl.renderer.line(`${style.bold('brittain')} ${style.dim(`${pkg.version} · /help for commands · Ctrl-D to exit`)}`);
  if (options.continue && rt.chatId) {
    const chat = rt.services.historyStore.load(rt.chatId);
    if (chat.ok) repl.renderer.line(style.dim(`Continuing "${chat.chat.title}" (${chat.chat.conversation.length} messages).`));
  }
  if (options.resume) {
    const id = positionals[0];
    if (id) {
      const loaded = commands['history.load']({ id });
      if (!loaded.ok) repl.renderer.line(style.red(`✗ ${loaded.error}`));
      else repl.renderer.line(style.dim(`Resumed "${loaded.chat.title}" (${loaded.chat.conversation.length} messages).`));
      repl.start();
    } else {
      // The picker is /history, answered on the REPL's own interface.
      repl.slash.handle('/history').then(() => repl.start());
    }
  } else {
    repl.start();
  }
  return exited.finally(() => rt.tools.stopAllManagedProcesses());
}

module.exports = { needsSetup, startRepl };
