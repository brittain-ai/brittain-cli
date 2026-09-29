'use strict';

// brittain -p "<prompt>": one message, no questions asked, scriptable.
//
// Nobody is at the keyboard, so the host answers every approval with "no" and
// every question with nothing. A call that needs approval without --yes is
// denied — the run carries on without it and never hangs. Destructive,
// sensitive, and financial calls are denied even with --yes: there is no one
// to ask, and --yes does not stand in for that person.
//
// Exit codes: 0 ok, 1 error, 2 finished with denied calls.

const fs = require('fs');
const path = require('path');
const { createRuntime } = require('../core/runtime');
const { TRANSCRIPT_CHANNELS } = require('../lib/run-sink');

const OUTPUT_FORMATS = ['text', 'json', 'stream-json'];

async function runPrintMode({ prompt, options, host, env, stdout, stderr, io }) {
  const format = options['output-format'] || 'text';
  if (!OUTPUT_FORMATS.includes(format)) throw new Error(`--output-format must be one of: ${OUTPUT_FORMATS.join(', ')}.`);
  let cwd = process.cwd();
  if (options.cwd) {
    cwd = path.resolve(options.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`--cwd is not a directory: ${options.cwd}`);
  }
  if (!String(prompt || '').trim()) throw new Error('Usage: brittain -p "<prompt>"');

  const { commands, events, rt } = createRuntime({
    host,
    env,
    overrides: { provider: options.provider, model: options.model, cwd },
  });

  let denied = 0;
  const unsubscribe = events.subscribe((channel, payload, meta) => {
    if (channel === 'stream:toolresult' && payload?.denied) denied += 1;
    if (format === 'stream-json') {
      stdout.write(rt.providers.redact(JSON.stringify({ channel, payload, ...meta })) + '\n');
      return;
    }
    // text and json keep stdout for the answer; progress goes to stderr.
    if (channel === 'stream:info' || (channel === 'stream:toolresult' && payload?.denied)) {
      io.err(TRANSCRIPT_CHANNELS.get(channel)(payload));
    } else if (options.verbose && TRANSCRIPT_CHANNELS.has(channel) && channel !== 'stream:message') {
      io.err(TRANSCRIPT_CHANNELS.get(channel)(payload));
    }
  });

  const onSigint = () => commands.stop();
  process.once('SIGINT', onSigint);
  let result;
  try {
    result = await commands.chat({
      text: prompt,
      cwd,
      ...(options.yes ? { autoApprove: true } : {}),
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
    unsubscribe();
    await rt.tools.stopAllManagedProcesses();
  }

  const deniedCalls = Math.max(denied, result.deniedCalls || 0);
  const code = !result.ok || result.stopped ? 1 : deniedCalls ? 2 : 0;
  if (format === 'json') {
    const provider = rt.providers.resolve();
    stdout.write(rt.providers.redact(JSON.stringify({
      ok: !!result.ok && !result.stopped,
      result: result.content || '',
      ...(result.error ? { error: result.error } : {}),
      ...(result.stopped ? { stopped: true } : {}),
      chatId: result.chatId,
      runId: result.runId,
      provider: provider.mode,
      model: provider.model,
      deniedCalls,
      usage: { ...rt.session.usage.main },
      cost: { ...rt.session.spend },
    })) + '\n');
  } else if (format === 'text') {
    if (result.ok && result.content) io.out(result.content.trim());
    if (!result.ok) io.err(result.error);
    if (result.stopped) io.err('Stopped.');
    if (deniedCalls && result.ok) io.err(`${deniedCalls} tool call${deniedCalls === 1 ? ' was' : 's were'} denied — nobody was here to approve ${deniedCalls === 1 ? 'it' : 'them'}. Re-run with --yes to allow ordinary edits and commands.`);
  }
  return code;
}

module.exports = { OUTPUT_FORMATS, runPrintMode };
