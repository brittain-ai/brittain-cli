// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/tools/policy.js
'use strict';

// The CLI tool set includes project checks and local server tools. The
// orchestrator and coder role sets and chat mode are not ported. Sensitive
// reads, destructive commands, and state-changing HTTP requests are caught
// when each call is classified (see core/approvals.js).

const SENSITIVE_TOOLS = new Set([]);
const DESTRUCTIVE_TOOLS = new Set([]);

const RISKY_TOOLS = new Set([
  'write_file',
  'run_command',
  'run_project_check',
  'start_process',
  'stop_process',
  'local_http_request',
  'delete_file',
  'move_file',
  'edit_file',
  'apply_patch',
]);

const CODE_TOOL_NAMES = new Set([
  'read_file', 'get_file_lines', 'browse_files', 'search_files',
  'project_outline', 'find_symbol', 'find_references',
  'write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file',
  'run_command', 'run_project_check', 'check_port_usage',
  'start_process', 'process_status', 'stop_process', 'local_http_request',
  'git_status', 'read_git_diff', 'get_git_log',
  'ask_user', 'run_subagent', 'remember',
]);

// What a subagent may call: reading and searching, never writing, running,
// asking, or delegating further. The source's set, less the tools v1 dropped.
const SUBAGENT_TOOL_NAMES = new Set([
  'read_file', 'browse_files', 'search_files',
  'project_outline', 'find_symbol', 'find_references',
  'get_file_lines',
  'git_status', 'get_git_log', 'read_git_diff',
]);

function selectTools(toolDefinitions, names) {
  return toolDefinitions.filter((definition) => names.has(definition.function.name));
}

function createToolPolicy(toolDefinitions) {
  return {
    SENSITIVE_TOOLS,
    DESTRUCTIVE_TOOLS,
    RISKY_TOOLS,
    CODE_TOOL_NAMES,
    CODE_TOOLS: selectTools(toolDefinitions, CODE_TOOL_NAMES),
    SUBAGENT_TOOL_NAMES,
    SUBAGENT_TOOLS: selectTools(toolDefinitions, SUBAGENT_TOOL_NAMES),
  };
}

module.exports = {
  CODE_TOOL_NAMES,
  DESTRUCTIVE_TOOLS,
  RISKY_TOOLS,
  SENSITIVE_TOOLS,
  SUBAGENT_TOOL_NAMES,
  createToolPolicy,
};
