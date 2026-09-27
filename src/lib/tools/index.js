// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js (executeTool)
'use strict';

// Brittain CLI — agent tools.
// Tool schemas live in defs.js, implementations in the area modules, and
// role and approval policy in policy.js. Add a new tool to all three together.
//
// ask_user is answered by the agent loop, not executed here (see interact.js).
//
// The source kept the data directory and the rewrite tracker in module state;
// here both belong to an executor, so each runtime has its own.

const { TOOL_DEFS } = require('./defs');
const { createToolPolicy } = require('./policy');
const files = require('./files');
const search = require('./search');
const git = require('./git');
const shell = require('./shell');
const memory = require('./memory');
const projectCheck = require('./project-check');
const processes = require('./processes');

const HANDLERS = {
  ...files.handlers,
  ...search.handlers,
  ...git.handlers,
  ...shell.handlers,
  ...projectCheck.handlers,
};

function createToolExecutor({ dataDir }) {
  const dir = () => (typeof dataDir === 'function' ? dataDir() : dataDir);
  const trackRewrite = files.createRewriteTracker();
  const managed = processes.createManagedTools();

  async function executeTool(name, args, cwd) {
    // futility tracking must see every call so any non-write action resets it
    const futilityNote = trackRewrite(name, name === 'write_file' && args?.path ? files.resolveInside(cwd, args.path) : '');
    if (name === 'remember') return memory.remember(dir(), args || {}, cwd);
    const handler = managed.handlers[name] || HANDLERS[name];
    if (!handler) return `Error: unknown tool "${name}"`;
    return name === 'write_file'
      ? handler(args || {}, cwd, futilityNote)
      : handler(args || {}, cwd);
  }

  return {
    executeTool,
    stopAllManagedProcesses: managed.stopAll,
    memoryPath: (cwd) => memory.memoryPath(dir(), cwd),
    readMemory: (cwd) => memory.readMemory(dir(), cwd),
    legacyMemoryPath: () => memory.legacyMemoryPath(dir()),
    readLegacyMemory: () => memory.readLegacyMemory(dir()),
  };
}

const {
  SENSITIVE_TOOLS,
  DESTRUCTIVE_TOOLS,
  RISKY_TOOLS,
  CODE_TOOLS,
  CODE_TOOL_NAMES,
  SUBAGENT_TOOLS,
  SUBAGENT_TOOL_NAMES,
} = createToolPolicy(TOOL_DEFS);

module.exports = {
  TOOL_DEFS,
  RISKY_TOOLS,
  SENSITIVE_TOOLS,
  DESTRUCTIVE_TOOLS,
  CODE_TOOLS,
  CODE_TOOL_NAMES,
  SUBAGENT_TOOLS,
  SUBAGENT_TOOL_NAMES,
  createToolExecutor,
  isDestructiveCommand: shell.isDestructiveCommand,
  resolveForWrite: files.resolveForWrite,
  gitRun: git.gitRun,
  SELF_TALK: files.SELF_TALK,
};
