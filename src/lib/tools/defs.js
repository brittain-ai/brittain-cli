// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js (TOOL_DEFS)
'use strict';

// Tool schemas for the v1 tool set (docs/PLAN.md §4.2), in the order the model
// sees them. Descriptions are shortened from the source to fit the token
// budget (docs/PLAN.md §4.1): each keeps its first sentence and any instruction
// that matters for safety, and drops references to tools that do not exist in
// v1. Add a tool here, to a handler map, and to policy.js together.

function tool(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    },
  };
}

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

const TOOL_DEFS = [
  tool('read_file', 'Read a text file. Returns the file contents.', {
    path: str('File path relative to the working directory'),
  }, ['path']),
  tool('get_file_lines', 'Get specific lines from a file (1-based, inclusive). Defaults to 10 lines if end is omitted.', {
    path: str('File path'),
    start: num('First line'),
    end: num('Last line'),
  }, ['path', 'start']),
  tool('browse_files', 'Browse a project directory as a tree, glob-filtered file list, or largest-files list. Skips .git and node_modules.', {
    path: str('Directory (default: working directory)'),
    depth: num('1-8 (default 1)'),
    glob: str('e.g. "src/**/*.ts"'),
    sort: { type: 'string', enum: ['name', 'size'], description: '"size" lists largest files' },
    max_results: num('1-500 (default 200)'),
  }),
  tool('search_files', 'Search one file or a project tree for text or a regular expression. Skips .git and node_modules.', {
    pattern: str('Text, or a regex when is_regex'),
    path: str('File or directory (default: working directory)'),
    file_pattern: str('Glob filter'),
    context_lines: num('0-10 (default 0)'),
    max_results: num('1-300 (default 100)'),
    is_regex: bool('Default false'),
    case_sensitive: bool('Default false'),
  }, ['pattern']),
  tool('project_outline', 'Outline the symbols in project source files: path, kind, name, line, signature.', {
    path: str('File or directory (default: working directory)'),
    max_files: num('1-500 (default 100)'),
    max_symbols: num('1-2000 (default 500)'),
  }),
  tool('find_symbol', 'Find symbol definitions by exact name. Returns kind, file, line, and signature.', {
    name: str('Exact symbol name'),
    path: str('File or directory (default: working directory)'),
    kind: str('e.g. class, function'),
  }, ['name']),
  tool('find_references', 'Find bounded lexical references to an identifier. This is not compiler-level type resolution.', {
    name: str('One identifier'),
    path: str('File or directory (default: project root)'),
    include_definitions: bool('Default true'),
    case_sensitive: bool('Default true'),
    max_files: num('1-2000 (default 500)'),
    max_results: num('1-500 (default 100)'),
  }, ['name']),
  tool('write_file', 'Create or overwrite a text file with the full content. Creates parent directories.', {
    path: str('File path'),
    content: str('Full file content'),
  }, ['path', 'content']),
  tool('edit_file', 'Replace text in an existing file. old_string must match exactly and appear once unless replace_all is set; is_regex matches a regular expression.', {
    path: str('File path'),
    old_string: str('Exact existing text, copied verbatim'),
    new_string: str('Replacement text'),
    replace_all: bool('Replace every occurrence'),
    is_regex: bool('Treat old_string as a regex'),
    flags: str('Regex flags'),
  }, ['path', 'old_string', 'new_string']),
  tool('apply_patch', 'Preview or atomically apply a unified diff across text files. Preview is the default; set dry_run to false to apply.', {
    patch: str('Unified diff with ---/+++ headers and @@ hunks'),
    dry_run: bool('Default true'),
  }, ['patch']),
  tool('delete_file', 'Delete a file.', {
    path: str('File path'),
  }, ['path']),
  tool('move_file', 'Move or rename a file.', {
    source: str('Source path'),
    destination: str('Destination path'),
  }, ['source', 'destination']),
  tool('run_command', 'Run a shell command in the working directory and return stdout/stderr. 60 second timeout.', {
    command: str('The shell command'),
  }, ['command']),
  tool('run_project_check', 'List or run checks declared by a project manifest. Returns an exit code; omit check to list choices.', {
    check: str('Exact discovered check name'),
    path: str('Project directory or manifest (default: root)'),
    timeout_seconds: num('1-600 (default 120)'),
  }),
  tool('check_port_usage', 'Check whether a local TCP port has a listening process.', {
    port: num('1-65535'),
  }, ['port']),
  tool('start_process', 'Start a managed background process without a shell. Pass arguments separately; use its id for status and stop.', {
    executable: str('Program name or path'),
    arguments: { type: 'array', items: { type: 'string' }, description: 'Program arguments' },
    path: str('Project directory (default: root)'),
  }, ['executable']),
  tool('process_status', 'Read status and recent output for a process started by start_process.', {
    id: str('Managed process id'),
  }, ['id']),
  tool('stop_process', 'Stop a process started by start_process. Sends SIGTERM, then SIGKILL after 3 seconds.', {
    id: str('Managed process id'),
  }, ['id']),
  tool('local_http_request', 'Send an HTTP request to a literal loopback host. Redirects are not followed.', {
    url: str('localhost, 127.0.0.1, or ::1 URL'),
    method: str('GET or HEAD (default GET); other methods need approval'),
    body: str('Optional request body'),
    content_type: str('Optional Content-Type'),
    timeout_seconds: num('1-30 (default 10)'),
  }, ['url']),
  tool('git_status', 'Show the branch and staged, unstaged, and untracked files.'),
  tool('read_git_diff', 'Show Git changes: unstaged by default, or "staged" or "all".', {
    mode: { type: 'string', enum: ['unstaged', 'staged', 'all'] },
    path: str('Limit to a file or directory'),
  }),
  tool('get_git_log', 'Show recent commits.', {
    limit: num('Default 20'),
  }),
  tool('ask_user', 'Ask the user 1-4 questions and wait for answers. Use only when blocked on a decision only the user can make. One question per entry, each with 2-4 short options.', {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
      },
    },
  }, ['questions']),
  tool('run_subagent', 'Delegate a read-only exploration to a subagent with its own context window: finding definitions and usages, surveying unfamiliar code, gathering evidence across many files. It cannot see this conversation, edit files, or run commands, so give complete instructions and say what its report must include. Returns only its findings.', {
    task: { type: 'string', description: 'Self-contained instructions: what to find, where to look, what the report must include' },
  }, ['task']),
  tool('remember', 'Save a short reusable lesson to persistent memory — a correction, a lasting preference or convention, or a mistake to avoid. One concise sentence.', {
    fact: str('The lesson'),
  }, ['fact']),
];

module.exports = { TOOL_DEFS };
