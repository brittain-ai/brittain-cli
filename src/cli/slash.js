'use strict';

// Slash commands (docs/PLAN.md M7). Each entry is { usage, summary, run }. /help
// prints exactly this table, so a command cannot exist without being listed.
//
// Every handler goes through runtime.commands — the same map print mode uses —
// and reports through `ui`, which the REPL provides:
//   ui.line(text), ui.style, ui.pick(question, items, opts), ui.state,
//   ui.page(text) — print, through a pager when taller than the terminal
//   ui.color — whether output is colored
//   ui.build(goal) — run /build (an empty goal resumes the saved plan)

const { MODE_IDS } = require('../lib/providers');
const { gitRun } = require('../lib/tools');
const { formatContext } = require('../core/context-inspector');

function parseSlash(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) return null;
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  const rest = match[2].trim();
  return { name: match[1].toLowerCase(), rest, args: rest ? rest.split(/\s+/) : [] };
}

function onOff(value, current) {
  if (value === undefined || value === '') return !current;
  if (/^(on|true|yes|1)$/i.test(value)) return true;
  if (/^(off|false|no|0)$/i.test(value)) return false;
  return null;
}

// Fuzzy enough for model ids: exact, then prefix, then substring, then every
// typed character in order.
function matchModels(models, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return models;
  const exact = models.filter((id) => id.toLowerCase() === q);
  if (exact.length) return exact;
  const prefix = models.filter((id) => id.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  const substring = models.filter((id) => id.toLowerCase().includes(q));
  if (substring.length) return substring;
  return models.filter((id) => {
    let at = 0;
    for (const ch of id.toLowerCase()) if (ch === q[at]) at += 1;
    return at === q.length;
  });
}

function createSlash({ runtime, ui, setupProvider }) {
  const { commands, rt } = runtime;

  const table = [
    {
      name: 'help',
      usage: '/help',
      summary: 'Everything below, nothing more',
      run: () => {
        const width = Math.max(...table.map((entry) => entry.usage.length));
        for (const entry of table) ui.line(`${entry.usage.padEnd(width)}  ${ui.style.dim(entry.summary)}`);
      },
    },
    {
      name: 'clear',
      usage: '/clear',
      summary: 'New chat',
      run: () => {
        const result = commands.reset();
        ui.line(result.ok ? 'Started a new chat.' : result.error);
      },
    },
    {
      name: 'provider',
      usage: '/provider [brittain|openai|ollama]',
      summary: 'Show or switch the provider',
      run: async ({ args }) => {
        const info = commands['provider.get']();
        let mode = args[0];
        if (!mode) {
          mode = await ui.pick('Provider (number or name, Enter to keep):',
            info.providers.map((entry) => ({ label: `${entry.mode.padEnd(8)} ${entry.label} · ${entry.model || '(no model)'}`, value: entry.mode })),
            { current: info.active });
          if (!mode || mode === info.active) return;
        }
        if (!MODE_IDS.includes(mode)) return ui.line(`Unknown provider "${mode}". Choose ${MODE_IDS.join(', ')}.`);
        if (setupProvider) {
          const ok = await setupProvider(mode);
          if (!ok) return;
        }
        const result = commands['provider.set']({ mode });
        ui.line(result.ok ? `Provider: ${result.mode} (${result.label}) · model: ${result.model || '(none)'}` : result.error);
      },
    },
    {
      name: 'model',
      usage: '/model [name]',
      summary: 'Fuzzy match / picker for the active provider',
      run: async ({ rest }) => {
        const listed = await commands['models.list']();
        if (!listed.ok) return ui.line(listed.error);
        const current = rt.providers.resolve().model;
        const matches = matchModels(listed.models, rest);
        let model = matches.length === 1 && rest ? matches[0] : null;
        if (!model) {
          if (!matches.length) return ui.line(`No model matches "${rest}".`);
          model = await ui.pick('Model (number or name, Enter to keep):', matches.map((id) => ({ label: id, value: id })), { current });
        }
        if (!model || model === current) return;
        const result = commands['provider.set']({ model });
        ui.line(result.ok ? `Model: ${result.model}` : result.error);
      },
    },
    {
      name: 'auto',
      usage: '/auto on|off',
      summary: 'Trusted vs supervised',
      run: ({ args }) => {
        const value = onOff(args[0], ui.state.autoApprove);
        if (value === null) return ui.line('Usage: /auto on|off');
        ui.state.autoApprove = value;
        ui.line(value
          ? 'Auto-approve on (trusted): edits and commands run without asking. Destructive, sensitive, and payment actions still ask.'
          : 'Auto-approve off (supervised): every risky tool asks.');
      },
    },
    {
      name: 'think',
      usage: '/think on|off',
      summary: 'Model reasoning on or off',
      run: ({ args }) => {
        const value = onOff(args[0], rt.config.stored().codeThink);
        if (value === null) return ui.line('Usage: /think on|off');
        commands['settings.set']({ key: 'codeThink', value: String(value) });
        ui.line(`Thinking ${value ? 'on' : 'off'}.`);
      },
    },
    {
      name: 'compact',
      usage: '/compact',
      summary: 'Summarize older turns to free context',
      run: async () => {
        ui.line(ui.style.dim('· compacting…'));
        const result = await commands.compact();
        ui.line(result.ok ? `Compacted: ${result.description}` : result.error);
      },
    },
    {
      name: 'context',
      usage: '/context',
      summary: 'What the next request will send, with token counts',
      run: async () => {
        const result = await commands['context.inspect']();
        ui.page(formatContext(result, { style: ui.style }));
      },
    },
    {
      name: 'usage',
      usage: '/usage',
      summary: 'Tokens and tool calls in this chat',
      run: () => {
        const usage = commands.usage();
        const m = usage.metrics;
        const n = (value) => Number(value || 0).toLocaleString();
        ui.line(`${n(usage.main.prompt)} in · ${n(usage.main.gen)} out over ${n(usage.main.calls)} model calls`);
        ui.line(`${n(usage.messages)} messages (~${n(usage.approxTokens)} tokens) · context ${n(usage.context.tokens)} of ${n(usage.context.limit)}`);
        ui.line(ui.style.dim(`tool calls ${n(m.toolCalls)} · errors ${n(m.toolErrors)} · denied ${n(m.deniedTools)} · compactions ${n(m.compactions)} · peak context ${n(m.peakContextTokens)}`));
      },
    },
    {
      name: 'cost',
      usage: '/cost',
      summary: 'What this chat has cost',
      run: () => {
        const cost = commands.cost();
        ui.line(cost.local ? 'Local model — there is no bill.' : cost.text);
      },
    },
    {
      name: 'ledger',
      usage: '/ledger',
      summary: 'Files changed, commands run, and errors, read off the tool record',
      run: () => {
        const ledger = commands.ledger();
        ui.page(ledger.empty ? 'Nothing recorded in this chat yet.' : ledger.rendered);
      },
    },
    {
      name: 'memory',
      usage: '/memory',
      summary: 'Show memory and its path',
      run: () => {
        const memory = commands['memory.get']();
        const where = memory.inRepo ? 'this project (in the repository)' : 'this project';
        ui.line(ui.style.dim(`Memory for ${where}: ${memory.path}`));
        ui.page(memory.content.trim() || '(nothing remembered yet)');
      },
    },
    {
      name: 'diff',
      usage: '/diff',
      summary: 'Colored git diff of the working tree',
      run: async () => {
        const cwd = rt.config.cwd;
        const color = `--color=${ui.color ? 'always' : 'never'}`;
        let diff = await gitRun(['diff', 'HEAD', color], cwd);
        // A repository with no commits yet has no HEAD to compare against.
        if (!diff.ok) diff = await gitRun(['diff', color], cwd);
        if (!diff.ok) return ui.line(diff.err || 'Not a Git repository.');
        const untracked = await gitRun(['ls-files', '--others', '--exclude-standard'], cwd);
        const newFiles = untracked.ok ? untracked.out.split('\n').filter(Boolean) : [];
        const text = [diff.out.trimEnd(), newFiles.length ? `Untracked: ${newFiles.join(', ')}` : ''].filter(Boolean).join('\n\n');
        ui.page(text || 'No changes.');
      },
    },
    {
      name: 'commit',
      usage: '/commit <msg>',
      summary: 'Stage all and commit',
      run: async ({ rest }) => {
        if (!rest) return ui.line('Usage: /commit <message>');
        const result = await commands['git.commit']({ message: rest });
        ui.line(result.ok ? result.out : result.error);
      },
    },
    {
      name: 'build',
      usage: '/build [goal]',
      summary: 'Plan, then build task by task (no goal: resume the plan)',
      run: async ({ rest }) => { await ui.build(rest); },
    },
    {
      name: 'undo',
      usage: '/undo',
      summary: 'Restore the last checkpoint',
      run: async () => {
        const result = await commands['checkpoint.undo']();
        ui.line(result.ok ? `Restored the working tree to the checkpoint from ${result.restoredFrom} (${result.changes}).` : result.error);
      },
    },
    {
      name: 'history',
      usage: '/history',
      summary: 'List/load/delete saved chats',
      run: async ({ args }) => {
        const { chats } = commands['history.list']();
        if (!chats.length) return ui.line('No saved chats yet.');
        if (args[0] === 'delete' && args[1]) {
          const result = commands['history.delete']({ id: args[1] });
          return ui.line(result.ok ? 'Deleted.' : result.error);
        }
        const id = args[0] === 'load' ? args[1] : await ui.pick('Load which chat (number, Enter to cancel):',
          chats.slice(0, 20).map((chat) => ({ label: `${chat.title} ${ui.style.dim(`· ${chat.id}`)}`, value: chat.id })));
        if (!id) return;
        const result = commands['history.load']({ id });
        if (!result.ok) return ui.line(result.error);
        ui.line(`Loaded "${result.chat.title}" (${result.chat.conversation.length} messages).`);
      },
    },
    {
      name: 'export',
      usage: '/export [path]',
      summary: 'Markdown export',
      run: ({ rest }) => {
        const result = commands.export({ path: rest || undefined });
        ui.line(result.ok ? `Exported to ${result.path}` : result.error);
      },
    },
    {
      name: 'tools',
      usage: '/tools',
      summary: 'Tools with risky/sensitive/destructive flags',
      run: () => {
        const { tools } = commands['tools.list']();
        for (const tool of tools) {
          const flags = [tool.isRisky && 'risky', tool.isSensitive && 'sensitive', tool.isDestructive && 'destructive'].filter(Boolean);
          ui.line(`${tool.name.padEnd(16)} ${ui.style.dim(flags.join(', '))}`.trimEnd());
        }
        ui.line(ui.style.dim('Destructive commands, sensitive reads, and payments are caught per call and always ask.'));
      },
    },
  ];

  const byName = new Map(table.map((entry) => [entry.name, entry]));

  async function handle(input) {
    const parsed = parseSlash(input);
    if (!parsed) return false;
    const entry = byName.get(parsed.name);
    if (!entry) {
      ui.line(`Unknown command /${parsed.name}. Try /help.`);
      return true;
    }
    await entry.run(parsed);
    return true;
  }

  return { handle, table, names: () => table.map((entry) => `/${entry.name}`) };
}

module.exports = { createSlash, matchModels, onOff, parseSlash };
