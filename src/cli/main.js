'use strict';

const { parseArgs } = require('node:util');
const pkg = require('../../package.json');
const { createNodeHost } = require('../host/node-host');
const { loadSettings, saveSettings, getSetting, setSetting } = require('../lib/settings');
const { createProviders, MODES, MODE_IDS, isMode } = require('../lib/providers');
const { redactEndpoint } = require('../lib/providers/brittain');
const { createPrompter } = require('./prompts');
const { ensureSettings, setupProvider } = require('./first-run');
const { createRuntime } = require('../core/runtime');
const { runPrintMode } = require('./print-mode');
const { startRepl } = require('./session');

const HELP = `brittain ${pkg.version} — a lightweight terminal coding agent

Usage:
  brittain [options]              Start an interactive session in this directory
  brittain --continue             Continue the latest chat in this directory
  brittain --resume [id]          Pick a saved chat to continue (or name one)
  brittain -p "<prompt>"          Run one prompt non-interactively

Commands:
  brittain ask "<prompt>"         One model call, no tools; streams the answer
  brittain build "<goal>"         Plan, then build task by task (no goal: resume the plan)
  brittain provider [mode]        Show or switch the provider: brittain, openai, ollama
  brittain models                 List models for the active provider
  brittain login [--provider m]   Save an API key (brittain or openai) in the keychain
  brittain logout [--provider m]  Remove a saved API key
  brittain config get [key]       Show settings, or one setting
  brittain config set <key> <v>   Change a setting

Options:
  --provider <mode>               Use this provider for one invocation (not saved)
  --model <name>                  Use this model for one invocation (not saved)
  --cwd <dir>                     Working directory (default: current directory)
  --yes                           Allow edits and commands without asking
                                  (destructive, sensitive, and payment actions
                                  are never automatic)
  --output-format <f>             With -p: text (default), json, or stream-json
  --verbose                       With -p: show tool calls on stderr
  --show-thinking                 With ask: print the model's reasoning (stderr)
  -h, --help                      Show this help
  -v, --version                   Print the version
`;

const SUBCOMMANDS = new Set(['ask', 'build', 'config', 'login', 'logout', 'provider', 'models']);

function createIO({ stdout, stderr, env }) {
  // Last line of defence for docs/PLAN.md §5.2: nothing the CLI prints can carry
  // the Brittain endpoint, whichever code path produced the text.
  const clean = (text) => {
    const value = redactEndpoint(String(text), env);
    return value.endsWith('\n') ? value : `${value}\n`;
  };
  return {
    out: (text) => stdout.write(clean(text)),
    err: (text) => stderr.write(clean(text)),
  };
}

function formatValue(value) {
  return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function context({ env, stdin, stderr, keychain }) {
  const host = createNodeHost({ env, keychain });
  ensureSettings(host.dataDir);
  const providers = createProviders({ getSettings: () => loadSettings(host.dataDir), secrets: host.secrets, env });
  let prompter = null;
  return {
    host,
    providers,
    prompter: () => (prompter ||= createPrompter({ input: stdin, output: stderr })),
    close: () => prompter?.close(),
  };
}

async function configCommand(args, ctx, io) {
  const [action, key, ...rest] = args;
  const settings = loadSettings(ctx.host.dataDir);
  if (action === 'get') {
    io.out(formatValue(getSetting(settings, key)));
    return 0;
  }
  if (action === 'set') {
    if (!key || !rest.length) throw new Error('Usage: brittain config set <key> <value>');
    const result = setSetting(settings, key, rest.join(' '));
    saveSettings(ctx.host.dataDir, result.settings);
    io.out(`${key} = ${formatValue(result.value)}${result.adjusted ? ' (adjusted to the allowed range)' : ''}`);
    return 0;
  }
  throw new Error('Usage: brittain config get [key] | brittain config set <key> <value>');
}

function keyMode(requested, ctx) {
  if (requested) {
    if (!MODES[requested]?.keyName) throw new Error('--provider must be brittain or openai.');
    return requested;
  }
  const active = loadSettings(ctx.host.dataDir).provider;
  return MODES[active].keyName ? active : 'brittain';
}

async function loginCommand(options, ctx, io) {
  const mode = keyMode(options.provider, ctx);
  const key = await ctx.prompter().hidden(`${MODES[mode].label} API key (input hidden):`);
  if (!key) {
    io.err('No key entered; nothing saved.');
    return 1;
  }
  const saved = ctx.host.secrets.set(MODES[mode].keyName, key);
  if (saved.warning) io.err(saved.warning);
  io.out(`Saved the ${MODES[mode].label} key${saved.encrypted ? ` in the ${saved.backend}` : ''}.`);
  return 0;
}

async function logoutCommand(options, ctx, io) {
  const mode = keyMode(options.provider, ctx);
  ctx.host.secrets.remove(MODES[mode].keyName);
  io.out(`Removed the saved ${MODES[mode].label} key.`);
  const override = mode === 'brittain' ? 'BRITTAIN_API_KEY' : 'OPENAI_API_KEY';
  if (ctx.host.secrets.has(MODES[mode].keyName)) io.err(`$${override} is still set in this environment and will keep being used.`);
  return 0;
}

function describeMode(ctx, mode, active) {
  const info = ctx.providers.describe(mode);
  const parts = [info.model || '(no model selected)'];
  if (info.endpoint !== undefined) parts.push(info.endpoint || '(no endpoint)');
  if (info.keySet !== undefined) parts.push(info.keySet ? 'key saved' : 'no key');
  return `${mode === active ? '*' : ' '} ${mode.padEnd(8)} ${info.label.padEnd(18)} ${parts.join(' · ')}`;
}

async function providerCommand(args, ctx, io, { stdin }) {
  const active = loadSettings(ctx.host.dataDir).provider;
  let mode = args[0];
  if (!mode) {
    io.out(`Active provider: ${active}`);
    for (const id of MODE_IDS) io.out(describeMode(ctx, id, active));
    if (!stdin.isTTY) return 0;
    mode = await ctx.prompter().pick('Switch to (number or name, Enter to keep):',
      MODE_IDS.map((id) => ({ label: `${id} — ${MODES[id].label}`, value: id })), { current: active });
    if (!mode || mode === active) return 0;
  }
  if (!isMode(mode)) throw new Error(`Unknown provider "${mode}". Choose one of: ${MODE_IDS.join(', ')}.`);
  const settings = await setupProvider(mode, {
    dataDir: ctx.host.dataDir,
    providers: ctx.providers,
    secrets: ctx.host.secrets,
    prompter: ctx.prompter(),
    out: io.err,
  });
  if (!settings) return 1;
  const info = ctx.providers.describe(mode);
  io.out(`Provider: ${mode} (${info.label}) · model: ${info.model || '(none)'}`);
  return 0;
}

async function modelsCommand(_args, ctx, io) {
  const resolved = ctx.providers.resolve();
  const listed = await ctx.providers.listModels(resolved.mode);
  if (!listed.ok) {
    io.err(listed.error);
    return 1;
  }
  if (!listed.models.length) io.out(`No models available for ${resolved.label}.`);
  for (const id of listed.models) io.out(`${id === resolved.model ? '*' : ' '} ${id}`);
  return 0;
}

async function askCommand(positionals, options, ctx, io, { stdout, stderr, env }) {
  const prompt = positionals.join(' ').trim();
  if (!prompt) throw new Error('Usage: brittain ask "<prompt>"');
  const { commands, events } = createRuntime({
    host: ctx.host,
    env,
    overrides: { provider: options.provider, model: options.model },
  });
  const color = !env.NO_COLOR && stderr.isTTY;
  const dim = (text) => (color ? `\x1b[2m${text}\x1b[22m` : text);
  let wroteThinking = false;
  let wroteText = false;
  const unsubscribe = events.subscribe((channel, payload) => {
    if (channel === 'stream:token') {
      if (wroteThinking && !wroteText) stderr.write('\n');
      wroteText = true;
      stdout.write(payload);
    } else if (channel === 'stream:thinking' && options['show-thinking']) {
      wroteThinking = true;
      stderr.write(dim(payload));
    } else if (channel === 'stream:info') {
      io.err(payload);
    }
  });
  const onSigint = () => commands.stop();
  process.once('SIGINT', onSigint);
  try {
    const result = await commands.ask({ prompt });
    if (wroteText) stdout.write('\n');
    if (!result.ok) {
      io.err(result.error);
      return 1;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    unsubscribe();
  }
}

async function main(argv, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  keychain,
} = {}) {
  const io = createIO({ stdout, stderr, env });
  const subcommand = SUBCOMMANDS.has(argv[0]) ? argv[0] : '';
  let parsed;
  try {
    parsed = parseArgs({
      args: subcommand ? argv.slice(1) : argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        ...(!subcommand ? {
          print: { type: 'string', short: 'p' },
          provider: { type: 'string' },
          model: { type: 'string' },
          cwd: { type: 'string' },
          yes: { type: 'boolean' },
          'output-format': { type: 'string' },
          verbose: { type: 'boolean' },
          continue: { type: 'boolean', short: 'c' },
          resume: { type: 'boolean', short: 'r' },
        } : {}),
        ...(subcommand === 'login' || subcommand === 'logout' ? { provider: { type: 'string' } } : {}),
        ...(subcommand === 'ask' ? {
          provider: { type: 'string' },
          model: { type: 'string' },
          'show-thinking': { type: 'boolean' },
        } : {}),
        ...(subcommand === 'build' ? {
          provider: { type: 'string' },
          model: { type: 'string' },
          cwd: { type: 'string' },
          yes: { type: 'boolean' },
          'output-format': { type: 'string' },
          verbose: { type: 'boolean' },
        } : {}),
      },
    });
  } catch (error) {
    io.err(`brittain: ${error.message}\nRun 'brittain --help' for usage.`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.out(pkg.version);
    return 0;
  }
  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (!subcommand && values.print === undefined) {
    return startRepl({ options: values, positionals, env, stdin, stdout, stderr, keychain, io });
  }

  const ctx = context({ env, stdin, stderr, keychain });
  try {
    if (!subcommand) {
      const prompt = [values.print, ...positionals].filter(Boolean).join(' ');
      return await runPrintMode({ prompt, options: values, host: ctx.host, env, stdout, stderr, io });
    }
    if (subcommand === 'config') return await configCommand(positionals, ctx, io);
    if (subcommand === 'login') return await loginCommand(values, ctx, io);
    if (subcommand === 'logout') return await logoutCommand(values, ctx, io);
    if (subcommand === 'provider') return await providerCommand(positionals, ctx, io, { stdin });
    if (subcommand === 'models') return await modelsCommand(positionals, ctx, io);
    if (subcommand === 'build') return await runPrintMode({ prompt: positionals.join(' '), options: values, host: ctx.host, env, stdout, stderr, io, build: true });
    if (subcommand === 'ask') return await askCommand(positionals, values, ctx, io, { stdout, stderr, env });
    return 0;
  } catch (error) {
    io.err(`brittain: ${error?.message || error}`);
    return 1;
  } finally {
    ctx.close();
  }
}

module.exports = { main, HELP };
