'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createToolExecutor, CODE_TOOLS } = require('../../../src/lib/tools');
const { indexToolDefs, missingRequired, schemaReveal } = require('../../../src/lib/tools/tool-index');
const { classifyToolCall } = require('../../../src/core/approvals');
const { outcomeOf } = require('../../../src/lib/ledger');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-added-'));
  const tools = createToolExecutor({ dataDir: cwd });
  t.after(async () => { await tools.stopAllManagedProcesses(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, tools };
}

test('project checks list declared commands and report test failure', async (t) => {
  const { cwd, tools } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"', serve: 'node server.js' } }));
  const listed = JSON.parse(await tools.executeTool('run_project_check', {}, cwd));
  assert.deepEqual(listed.checks.map((check) => check.name), ['test']);
  const run = await tools.executeTool('run_project_check', { check: 'test' }, cwd);
  assert.equal(JSON.parse(run).exit_code, 7);
  assert.equal(outcomeOf(run, 'run_project_check'), 'error');
  assert.match(await tools.executeTool('run_project_check', { check: 'serve' }, cwd), /not an allowed/);
});

test('cold tool schemas reveal required fields and are promoted after use', () => {
  const full = CODE_TOOLS.find((tool) => tool.function.name === 'start_process');
  const initial = indexToolDefs([full], { hot: new Set() });
  assert.deepEqual(missingRequired(full, {}), ['executable']);
  assert.match(schemaReveal(full), /nothing has run yet/);
  assert.equal(initial[0].function.parameters.additionalProperties, true);
  assert.deepEqual(indexToolDefs([full], { revealed: new Set(['start_process']) }), [full]);
});

test('managed processes are scoped to one executor and can be stopped', async (t) => {
  const { cwd, tools } = fixture(t);
  const other = createToolExecutor({ dataDir: cwd });
  const started = JSON.parse(await tools.executeTool('start_process', {
    executable: process.execPath, arguments: ['-e', 'setInterval(() => {}, 1000)'],
  }, cwd));
  assert.equal(started.running, true);
  assert.match(await other.executeTool('process_status', { id: started.id }, cwd), /unknown managed process/);
  assert.equal(JSON.parse(await tools.executeTool('process_status', { id: started.id }, cwd)).running, true);
  const stopped = JSON.parse(await tools.executeTool('stop_process', { id: started.id }, cwd));
  assert.equal(stopped.running, false);
  assert.match(await tools.executeTool('process_status', { id: started.id }, cwd), /unknown managed process/);
});

test('local HTTP requests only reach loopback and do not follow redirects', async (t) => {
  const { cwd, tools } = fixture(t);
  const server = http.createServer((_request, response) => { response.writeHead(302, { Location: 'https://example.com/' }); response.end('local'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const result = JSON.parse(await tools.executeTool('local_http_request', { url }, cwd));
  assert.equal(result.status, 302);
  assert.equal(result.location, 'https://example.com/');
  assert.equal(result.body, 'local');
  assert.match(await tools.executeTool('local_http_request', { url: 'https://example.com/' }, cwd), /loopback hosts/);
  assert.equal(classifyToolCall('local_http_request', { url, method: 'POST' }).destructive, true);
  assert.equal(classifyToolCall('local_http_request', { url }).destructive, false);
});
