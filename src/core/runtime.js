'use strict';

// The core, assembled. Everything main.js kept as module state lives on `rt`
// (docs/PLAN.md §6.3), so a process can hold more than one runtime and a test can
// build one against a fake provider without touching global state.
//
// The core never writes to stdout: everything it has to say goes through
// rt.sink, and whoever holds the runtime subscribes to it.

const pkg = require('../../package.json');
const { assertHost } = require('./host');
const { loadSettings, saveSettings } = require('../lib/settings');
const { createRunSink } = require('../lib/run-sink');
const { createProviders, isMode } = require('../lib/providers');
const { createHistoryStore } = require('../lib/history-store');
const { createLedgerStore } = require('../lib/ledger-store');
const { createDiffService } = require('../lib/diff-service');
const { createToolExecutor, gitRun } = require('../lib/tools');
const { createModels } = require('./models');
const { createState } = require('./state');
const { createStream } = require('./stream');
const { createPrompts } = require('./prompts');
const { createApprovals } = require('./approvals');
const { createQuestions } = require('./questions');
const { createAgentLoop } = require('./agent-loop');
const { createChatJobs } = require('./chat-jobs');
const { createHistory } = require('./history');
const { createTitles } = require('./title');
const { createCheckpoints } = require('./checkpoints');
const { createCommands } = require('./commands');
const { createPipeline } = require('./pipeline');
const { createCompactionRunner } = require('./compaction-runner');
const { createContextInspector } = require('./context-inspector');
const { createMemory } = require('./memory');
const { createExport } = require('./export');

// overrides: per-invocation choices that must not persist (--provider,
// --model, --cwd).
function createRuntime({ host, env = process.env, overrides = {} } = {}) {
  assertHost(host);
  if (overrides.provider && !isMode(overrides.provider)) {
    throw new Error(`Unknown provider "${overrides.provider}". Choose brittain, openai, or ollama.`);
  }

  const rt = {
    version: pkg.version,
    host,
    env,
    chatId: '',
    run: { id: '', abort: null, stopRequested: false },
  };

  const live = { provider: overrides.provider || '', model: overrides.model || '' };
  rt.config = {
    dataDir: host.dataDir,
    // What is on disk, without per-invocation overrides.
    stored: () => loadSettings(host.dataDir),
    // Read fresh each time so a change saved by another command is seen, then
    // the per-invocation overrides applied on top.
    settings() {
      const stored = loadSettings(host.dataDir);
      if (!live.provider && !live.model) return stored;
      const provider = live.provider || stored.provider;
      const providers = live.model
        ? { ...stored.providers, [provider]: { ...stored.providers[provider], model: live.model } }
        : stored.providers;
      return { ...stored, provider, providers };
    },
    save(next) {
      // A saved choice replaces an override for the same thing.
      if (next.provider) live.provider = '';
      live.model = '';
      return saveSettings(host.dataDir, next);
    },
    override({ provider, model } = {}) {
      if (provider !== undefined) live.provider = provider;
      if (model !== undefined) live.model = model;
    },
    cwd: overrides.cwd || process.cwd(),
  };

  rt.sink = createRunSink({ meta: () => ({ chatId: rt.chatId, runId: rt.run.id }) });
  rt.providers = createProviders({ getSettings: () => rt.config.settings(), secrets: host.secrets, env });
  rt.tools = createToolExecutor({ dataDir: host.dataDir });
  rt.services = {
    historyStore: createHistoryStore({ userDataDir: () => host.dataDir, runtimeMetadata: (model) => rt.models.runtimeMetadata(model) }),
    ledgerStore: createLedgerStore({ userDataDir: () => host.dataDir }),
    diffService: createDiffService({ gitRun }),
  };
  rt.models = createModels(rt);
  rt.state = createState(rt);
  rt.stream = createStream(rt);
  rt.prompts = createPrompts(rt);
  rt.approvalFlow = createApprovals(rt);
  rt.questionFlow = createQuestions(rt);
  rt.agentLoop = createAgentLoop(rt);
  rt.compaction = createCompactionRunner(rt);
  rt.inspector = createContextInspector(rt);
  rt.memory = createMemory(rt);
  rt.exporter = createExport(rt);
  rt.titles = createTitles(rt);
  rt.history = createHistory(rt);
  rt.services.checkpoints = createCheckpoints(rt);
  rt.pipeline = createPipeline(rt);
  const chatJobs = createChatJobs(rt);
  rt.chatJobs.persistActive = chatJobs.persistActive;
  rt.chatJobs.submitChat = chatJobs.submitChat;
  rt.chatJobs.persistChat = chatJobs.persistChat;

  // One call, no tools: the whole of `brittain ask`.
  async function ask({ prompt, think } = {}) {
    if (rt.run.abort) return { ok: false, error: 'A request is already running.' };
    const provider = rt.providers.resolve();
    const model = provider.model;
    if (!model) return { ok: false, error: `No model selected for ${provider.label}. Run \`brittain provider ${provider.mode}\` to pick one.` };
    const settings = rt.config.settings();
    rt.run.id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    rt.run.stopRequested = false;
    const controller = new AbortController();
    rt.run.abort = controller;
    const startedAt = Date.now();
    try {
      const numCtx = await rt.models.effectiveContext(model);
      const thinkParam = await rt.models.thinkValue(model, think === undefined ? settings.codeThink : !!think);
      const result = await rt.stream.streamChat(
        model,
        [{ role: 'user', content: String(prompt || '') }],
        controller.signal,
        thinkParam,
        false,
        numCtx,
        null,
        { toolCallRetries: 0 },
        settings.codeTemperature,
      );
      rt.state.recordUsage('main', result.stats);
      if (result.stats) rt.state.publishContextStats(result.stats, numCtx);
      rt.state.finishRunMetrics(startedAt);
      rt.sink.done({ ok: true, stats: result.stats });
      return { ok: true, content: result.content, thinking: result.thinking, stats: result.stats };
    } catch (err) {
      const stopped = err?.name === 'AbortError';
      rt.state.finishRunMetrics(startedAt, stopped ? 'stopped' : 'failed');
      const error = stopped ? 'Stopped.' : rt.providers.redact(err?.message || String(err));
      rt.sink.done({ ok: false, error, stopped });
      return { ok: false, error, stopped };
    } finally {
      rt.run.abort = null;
    }
  }

  const commands = { ...createCommands(rt), ask };
  rt.commands = commands;

  return {
    rt,
    commands,
    events: { subscribe: (listener) => rt.sink.subscribe(listener) },
    shutdown() {
      commands.stop();
    },
  };
}

module.exports = { createRuntime };
