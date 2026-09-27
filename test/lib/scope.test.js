'use strict';

// docs/PLAN.md M1 acceptance: the library is Electron-free, dependency-free, and
// ships only the §4.2 tool set — plus what was added after v1 from the §10
// roadmap, listed separately so each addition is a deliberate edit here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { TOOL_DEFS } = require('../../src/lib/tools/defs');
const tools = require('../../src/lib/tools');

const V1_CODE_TOOLS = [
  'read_file', 'get_file_lines', 'browse_files', 'search_files', 'project_outline',
  'find_symbol', 'write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file',
  'run_command', 'git_status', 'read_git_diff', 'get_git_log', 'ask_user', 'remember',
];

// docs/PLAN.md §10 roadmap item 2.
const ADDED_AFTER_V1 = [
  'run_subagent', 'run_project_check', 'find_references', 'check_port_usage',
  'start_process', 'process_status', 'stop_process', 'local_http_request',
];
const CODE_TOOL_SET = [...V1_CODE_TOOLS, ...ADDED_AFTER_V1];

// Every tool the app defines that v1 leaves behind (brittain-code@fa01d50 tools.js).
const NOT_IN_V1 = [
  'calculate', 'pdf_info', 'pdf_render', 'pdf_fill_form', 'pdf_stamp', 'pdf_pages',
  'pdf_merge', 'edit_files', 'search_local_docs',
  'append_file', 'create_directory', 'file_metadata', 'copy_file',
  'get_environment_variables', 'browser_open', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_console', 'browser_screenshot', 'browser_close',
  'create_git_branch', 'revert_to_last_commit', 'get_git_graph', 'list_processes',
  'initiate_research_session', 'record_observation', 'finalize_research', 'web_search',
  'web_fetch', 'submit_implementation_plan',
];

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('defs.js defines exactly the v1 tool set and the tools added since', () => {
  assert.deepEqual(TOOL_DEFS.map((d) => d.function.name).sort(), [...CODE_TOOL_SET].sort());
  assert.deepEqual(tools.CODE_TOOLS.map((d) => d.function.name).sort(), [...CODE_TOOL_SET].sort());
  assert.equal(tools.CHAT_TOOLS, undefined, 'chat mode was removed');
  for (const definition of TOOL_DEFS) {
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.parameters.type, 'object', definition.function.name);
  }
});

test('no file under src/ names a tool outside the v1 set', () => {
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of NOT_IN_V1) {
      assert.equal(new RegExp(`['"\`]${name}['"\`]`).test(text), false, `${path.relative(ROOT, file)} names ${name}`);
    }
  }
});

test('nothing under src/ requires electron', () => {
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    assert.equal(/require\(\s*['"]electron['"]\s*\)/.test(fs.readFileSync(file, 'utf8')), false, file);
  }
});

test('package.json has no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('every ported file carries a provenance header', () => {
  // providers/ is new code for the CLI's provider modes, not a port.
  const ported = sourceFiles(path.join(ROOT, 'src', 'lib'))
    .filter((file) => !file.includes(`${path.sep}providers${path.sep}`));
  for (const file of ported) {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0];
    assert.match(first, /^\/\/ Ported from brittain-code@[0-9a-f]{40}:/, path.relative(ROOT, file));
  }
});
