// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- agent loop ----------" (saveChatJob, executeChatJob, drainChatRuns, and the chat:send handler)
'use strict';

// A chat message, start to finish: into the conversation, through the agent
// loop, onto disk, and named.
//
// CLI addition: a job with `build` set runs the /build pipeline (core/pipeline.js)
// instead of the agent loop; everything around it — the session, the checkpoint,
// the saved chat, the stop button — is the same.
//
// Pruned: attachments, auto-branch, the end-of-run report card, chat mode
// (brittain.app covers chat; every run works in a directory), and the
// renderer's background queue. The source staged every message into history
// before a queue picked it up, so a chat could keep running while the window
// showed another; the CLI runs one chat at a time, so submitChat runs the job
// directly and a second submit while one is running is refused.

const { safeChatId } = require('../lib/history-store');

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createChatJobs(rt) {
  rt.chatJobs = { active: null };

  async function saveChatJob(job, { autoTitlePending } = {}) {
    const { historyStore } = rt.services;
    const loaded = historyStore.load(job.chatId);
    const existing = loaded.ok ? loaded.chat : {};
    return historyStore.save({
      ...existing,
      id: job.chatId,
      // A stored title is final or is marked for the title resolver. Never
      // infer that the literal title "Chat" is temporary and rename it later.
      title: loaded.ok ? existing.title || 'Chat' : rt.titles.fallbackChatTitle(job.text),
      model: job.model || existing.model || '',
      provider: job.provider || existing.provider || '',
      cwd: job.cwd || '',
      think: !!job.think,
      autoApprove: !!job.autoApprove,
      runMetrics: rt.session.usage,
      spend: rt.session.spend,
      contextState: rt.session.contextState,
      autoTitlePending: typeof autoTitlePending === 'boolean' ? autoTitlePending : (loaded.ok ? !!existing.autoTitlePending : true),
      autoTitleAttempts: existing.autoTitleAttempts || 0,
      timestamp: new Date().toISOString(),
    }, rt.session.conversation);
  }

  async function persistActive() {
    const job = rt.chatJobs.active;
    if (!job) return;
    try { await saveChatJob(job); } catch {}
  }

  // Outside a run — after /compact or a pin — save the chat that is loaded,
  // if it has been saved before.
  async function persistChat() {
    if (!rt.chatId || rt.chatJobs.active) return;
    const { historyStore } = rt.services;
    const loaded = historyStore.load(rt.chatId);
    if (!loaded.ok) return;
    try {
      await historyStore.save({
        ...loaded.chat,
        runMetrics: rt.session.usage,
        spend: rt.session.spend,
        contextState: rt.session.contextState,
        timestamp: new Date().toISOString(),
      }, rt.session.conversation);
    } catch {}
  }

  async function executeChatJob(job) {
    const { model, text, cwd, autoApprove, think } = job;
    if (!cwd) return { ok: false, error: 'Pick a working directory first.' };

    rt.chatId = job.chatId;
    rt.state.enterSession(job.chatId);
    // Installed after the session switch: enterSession refuses to swap
    // conversations while a run holds an abort controller.
    rt.run.abort = new AbortController();
    rt.state.rememberConversationView({ model, cwd });
    await rt.compaction.maybePrecompact(model);
    const contextLength = await rt.models.effectiveContext(model);

    await rt.services.checkpoints.create(cwd); // silent; enables /undo
    rt.session.conversation.push({
      role: 'user',
      content: String(text || '').trim(),
      displayContent: String(text || '').trim(),
    });
    await persistActive();
    rt.state.emitPersistedConversationContext(model, contextLength);

    const startedAt = Date.now();
    let outcome = 'ok';
    try {
      const turn = job.build
        ? await rt.pipeline.build({ goal: job.goal, model, cwd, autoApprove })
        : await rt.agentLoop.runAgentTurn({ model, cwd, autoApprove, think });
      return { ok: true, content: turn.lastContent, deniedCalls: turn.deniedCalls, stats: turn.lastStats, ...(turn.incomplete ? { incomplete: true } : {}) };
    } catch (err) {
      if (err.name === 'AbortError') { outcome = 'stopped'; return { ok: true, stopped: true }; }
      outcome = 'failed';
      return { ok: false, error: rt.providers.redact(String(err.message || err)) };
    } finally {
      rt.state.finishRunMetrics(startedAt, rt.run.stopRequested ? 'stopped' : outcome);
      try { await rt.state.publishPersistedConversationContext(model); } catch {}
      await persistActive();
    }
  }

  // payload: { text, chatId?, model?, cwd?, autoApprove?, think? }.
  // Resolves when the run is over, with { ok, chatId, runId, … }.
  async function submitChat(payload = {}) {
    if (rt.chatJobs.active || rt.run.abort) {
      return { ok: false, error: 'A request is already running. Stop it first.' };
    }
    const text = String(payload.text || '').trim();
    if (!text) return { ok: false, error: 'Nothing to send.' };
    const provider = rt.providers.resolve();
    const model = payload.model || provider.model;
    if (!model) return { ok: false, error: `No model selected for ${provider.label}. Run \`brittain provider ${provider.mode}\` or /model to pick one.` };
    const settings = rt.config.settings();
    const chatId = safeChatId(payload.chatId || rt.chatId || newId('chat')) || newId('chat');
    const job = {
      text,
      chatId,
      runId: newId('run'),
      model,
      provider: provider.mode,
      cwd: payload.cwd || rt.config.cwd,
      autoApprove: payload.autoApprove ?? settings.autoApprove,
      think: payload.think ?? settings.codeThink,
      ...(payload.build ? { build: true, goal: String(payload.goal || '').trim() } : {}),
    };

    rt.chatJobs.active = job;
    rt.chatId = chatId;
    rt.run.id = job.runId;
    rt.run.stopRequested = false;
    rt.sink.state('starting');
    let result;
    try {
      result = await executeChatJob(job);
      // Name a new chat while this job still owns the runtime. A stopped or
      // failed answer must not start another model request that stop cannot
      // end.
      if (result.ok && !result.stopped) {
        try { await rt.titles.resolvePendingChatTitle({ chatId, model, signal: rt.run.abort?.signal }); } catch {}
      }
    } catch (error) {
      result = { ok: false, error: rt.providers.redact(String(error.message || error)) };
    } finally {
      rt.chatJobs.active = null;
      rt.run.abort = null;
    }
    const final = { ...result, chatId, runId: job.runId };
    rt.sink.done(final);
    return final;
  }

  return { persistActive, persistChat, saveChatJob, submitChat };
}

module.exports = { createChatJobs };
