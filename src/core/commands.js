// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js commandHandlers() and the ipcMain.handle handlers the CLI needs
'use strict';

// The core's API (docs/PLAN.md §6.4). One map; the REPL and print mode both go
// through it, so neither can reach something the other cannot. Handlers return
// { ok, … } or { ok: false, error } like the source.

const { buildLedger, renderLedger, isEmptyLedger } = require('../lib/ledger');
const { describeTotals: describeCostTotals } = require('../lib/cost');
const { estimateContextTokens } = require('../lib/context-estimator');
const { getSetting, setSetting } = require('../lib/settings');
const { MODES, isMode } = require('../lib/providers');
const { CODE_TOOLS, RISKY_TOOLS, SENSITIVE_TOOLS, DESTRUCTIVE_TOOLS, gitRun } = require('../lib/tools');
const { modelReadyMessages } = require('./context-hygiene');
const { pinFile, unpinFile, setMessagePinned } = require('../lib/context-controls');

function createCommands(rt) {
  const settings = () => rt.config.settings();

  function setProvider({ mode, model, persist = true } = {}) {
    if (mode && !isMode(mode)) return { ok: false, error: `Unknown provider "${mode}". Choose brittain, openai, or ollama.` };
    const current = settings();
    const target = mode || current.provider;
    const next = {
      ...current,
      provider: target,
      providers: model ? { ...current.providers, [target]: { ...current.providers[target], model } } : current.providers,
    };
    if (persist) rt.config.save(next);
    else rt.config.override({ provider: target, ...(model ? { model } : {}) });
    const resolved = rt.providers.resolve();
    rt.sink.emit('provider:changed', { mode: resolved.mode, model: resolved.model });
    return { ok: true, ...rt.providers.describe(resolved.mode) };
  }

  return {
    chat: (payload) => rt.chatJobs.submitChat(payload),

    // CLI addition: plan, then build task by task (core/pipeline.js). An empty
    // goal resumes the plan in .brittain/plan.md.
    build: ({ goal = '', ...payload } = {}) => rt.chatJobs.submitChat({
      ...payload,
      build: true,
      goal,
      text: goal.trim() ? `/build ${goal.trim()}` : '/build (resume the plan)',
    }),

    stop: () => {
      const stopping = !!rt.run.abort;
      if (stopping) {
        rt.run.stopRequested = true;
        rt.run.abort.abort();
      }
      return stopping ? { ok: true, stopping } : { ok: false, error: 'Nothing is running.' };
    },

    // A new, empty chat. The saved one stays in history.
    reset: () => {
      if (rt.run.abort) return { ok: false, error: 'A run is in progress. Stop it first.' };
      const had = rt.session.conversation.length;
      rt.chatId = '';
      rt.state.enterSession(`new-${Date.now()}`);
      rt.session.conversation = [];
      rt.state.newSessionId();
      return { ok: true, cleared: had };
    },

    approve: ({ id, approved }) => rt.approvalFlow.answerApproval(id, approved),
    answer: ({ id, answers }) => rt.questionFlow.answerQuestion(id, answers),

    usage: () => ({
      ok: true,
      messages: rt.session.conversation.length,
      approxTokens: estimateContextTokens(modelReadyMessages(rt.session.conversation)),
      context: { ...rt.session.usage.context },
      main: { ...rt.session.usage.main },
      metrics: { ...rt.session.usage.metrics },
    }),

    cost: () => ({
      ok: true,
      local: rt.providers.resolve().mode === 'ollama',
      totals: { ...rt.session.spend },
      text: describeCostTotals(rt.session.spend),
    }),

    ledger: () => {
      const built = buildLedger(rt.session.conversation);
      return { ok: true, empty: isEmptyLedger(built), rendered: renderLedger(built) };
    },

    'memory.get': ({ cwd } = {}) => rt.memory.get(cwd),

    compact: async ({ model } = {}) => {
      if (rt.run.abort) return { ok: false, error: 'A run is in progress. Stop it first.' };
      const controller = new AbortController();
      rt.run.abort = controller;
      rt.run.stopRequested = false;
      try {
        const result = await rt.compaction.compactConversation(model || rt.providers.resolve().model, controller.signal);
        if (result.ok) await rt.chatJobs.persistChat();
        return result;
      } catch (err) {
        if (err.name === 'AbortError') return { ok: false, error: 'Compaction stopped.' };
        return { ok: false, error: rt.providers.redact(String(err.message || err)) };
      } finally {
        if (rt.run.abort === controller) rt.run.abort = null;
      }
    },

    'context.inspect': (options = {}) => rt.inspector.inspect(options),

    export: (options) => rt.exporter.exportChat(options),

    // Pinned files are re-read into the system prompt every turn; pinned
    // messages survive compaction verbatim.
    'context.control': async ({ action, path: target, index, value = true, cwd = rt.config.cwd } = {}) => {
      try {
        if (action === 'pin-file') rt.session.contextState = pinFile(rt.session.contextState, cwd, target).state;
        else if (action === 'unpin-file') rt.session.contextState = unpinFile(rt.session.contextState, cwd, target).state;
        else if (action === 'pin-message') setMessagePinned(rt.session.conversation, Number(index), value !== false);
        else return { ok: false, error: `Unknown context control action "${action}".` };
        await rt.chatJobs.persistChat();
        return { ok: true, state: { ...rt.session.contextState } };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    'history.list': (options) => ({ ok: true, chats: rt.history.list(options) }),
    'history.load': ({ id }) => rt.history.load(id),
    'history.delete': ({ id }) => rt.history.remove(id),

    title: async ({ model } = {}) => {
      if (rt.run.abort) return { ok: false, error: 'Another model request is still running.' };
      const controller = new AbortController();
      rt.run.abort = controller;
      try {
        return await rt.titles.generate(rt.session.conversation, model || rt.providers.resolve().model, controller.signal);
      } finally {
        if (rt.run.abort === controller) rt.run.abort = null;
      }
    },

    'models.list': (options = {}) => rt.models.listModels(options.mode),

    'provider.get': () => {
      const active = rt.providers.resolve().mode;
      return {
        ok: true,
        active,
        providers: Object.keys(MODES).map((mode) => rt.providers.describe(mode)),
      };
    },
    'provider.set': setProvider,
    'provider.setKey': ({ mode = 'brittain', key } = {}) => {
      const keyName = MODES[mode]?.keyName;
      if (!keyName) return { ok: false, error: `${mode} does not take an API key.` };
      const saved = rt.host.secrets.set(keyName, key);
      return { ok: true, encrypted: !!saved.encrypted, ...(saved.warning ? { warning: saved.warning } : {}) };
    },
    'provider.test': async ({ mode } = {}) => {
      const listed = await rt.providers.listModels(mode);
      return listed.ok ? { ok: true, mode: listed.mode, models: listed.models.length } : listed;
    },

    'settings.get': ({ key } = {}) => {
      try { return { ok: true, value: getSetting(rt.config.stored(), key) }; } catch (error) { return { ok: false, error: error.message }; }
    },
    'settings.set': ({ key, value } = {}) => {
      try {
        const result = setSetting(rt.config.stored(), key, value);
        rt.config.save(result.settings);
        return { ok: true, value: result.value, adjusted: result.adjusted };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    'tools.list': () => ({
      ok: true,
      tools: CODE_TOOLS.map((t) => ({
        name: t.function.name,
        isRisky: RISKY_TOOLS.has(t.function.name),
        isSensitive: SENSITIVE_TOOLS.has(t.function.name),
        isDestructive: DESTRUCTIVE_TOOLS.has(t.function.name),
      })),
    }),

    'git.status': async ({ cwd = rt.config.cwd } = {}) => {
      // rev-parse fails on a freshly-initialized repo (no commits yet) —
      // symbolic-ref reports the unborn branch name, so try it as a fallback.
      let branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (!branch.ok) branch = await gitRun(['symbolic-ref', '--short', 'HEAD'], cwd);
      if (!branch.ok) return { ok: false, error: 'Not a Git repository.' };
      // '-- .' keeps the count about THIS folder.
      const status = await gitRun(['status', '--porcelain', '--', '.'], cwd);
      return { ok: true, branch: branch.out.trim(), changed: status.out.split('\n').filter(Boolean).length };
    },
    'git.diff': ({ cwd = rt.config.cwd } = {}) => rt.services.diffService.get(cwd),
    'git.commit': async ({ cwd = rt.config.cwd, message } = {}) => {
      if (!String(message || '').trim()) return { ok: false, error: 'A commit message is required.' };
      const add = await gitRun(['add', '-A'], cwd);
      if (!add.ok) return { ok: false, error: add.err || 'git add failed' };
      const commit = await gitRun(['commit', '-m', message], cwd);
      return commit.ok
        ? { ok: true, out: commit.out.trim().split('\n')[0] }
        : { ok: false, error: commit.err || commit.out.trim() || 'commit failed' };
    },

    'checkpoint.undo': ({ cwd = rt.config.cwd } = {}) => {
      if (rt.run.abort) return { ok: false, error: 'A run is in progress. Stop it first.' };
      return rt.services.checkpoints.undo(cwd);
    },
  };
}

module.exports = { createCommands };
