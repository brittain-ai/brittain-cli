// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js (managed process and local HTTP tools)
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { resolveInside, truncate } = require('./files');

const MAX_LOG = 100_000;

function appendLog(entry, stream, chunk) {
  entry[stream] += String(chunk);
  if (entry[stream].length > MAX_LOG) entry[stream] = '[...older output discarded...]\n' + entry[stream].slice(-MAX_LOG);
}

function processResult(id, entry) {
  return {
    id,
    running: entry.exitCode === null && entry.signal === null,
    pid: entry.child.pid || null,
    command: [entry.executable, ...entry.args].join(' '),
    cwd: entry.cwd,
    started_at: entry.startedAt,
    exit_code: entry.exitCode,
    signal: entry.signal,
    stdout: entry.stdout.slice(-20_000),
    stderr: entry.stderr.slice(-20_000),
  };
}

function checkPortUsage(args, cwd) {
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `Error: invalid port "${args.port}"`;
  const [command, commandArgs] = process.platform === 'win32'
    ? ['netstat', ['-ano']]
    : ['lsof', ['-i', `:${port}`, '-sTCP:LISTEN']];
  return new Promise((resolve) => {
    execFile(command, commandArgs, { cwd, timeout: 10_000 }, (err, stdout, stderr) => {
      if (process.platform === 'win32') {
        const lines = stdout.split('\n').filter((line) => line.includes(`:${port} `) || line.includes(`:${port}\r`));
        resolve(lines.length ? truncate(lines.join('\n')) : 'Port is not in use.');
      } else if (err && !stdout && !stderr && err.code === 1) {
        resolve('Port is not in use.');
      } else if (err && !stdout) {
        resolve(`Error checking port: ${stderr || err.message}`);
      } else {
        resolve(truncate(stdout || stderr || '(no output)'));
      }
    });
  });
}

async function localHttpRequest(args) {
  let url;
  try { url = new URL(String(args.url || '')); } catch { return 'Error: invalid URL.'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'Error: only HTTP and HTTPS URLs are allowed.';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    return 'Error: local_http_request only permits literal loopback hosts (localhost, 127.0.0.1, ::1).';
  }
  if (url.username || url.password) return 'Error: URL credentials are not allowed.';
  const method = String(args.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return `Error: unsupported HTTP method "${method}".`;
  const body = args.body === undefined ? undefined : String(args.body);
  if (body && body.length > 100_000) return 'Error: request body exceeds 100,000 characters.';
  const timeoutArg = Number(args.timeout_seconds);
  const seconds = Number.isFinite(timeoutArg) ? Math.min(Math.max(Math.round(timeoutArg), 1), 30) : 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    const response = await fetch(url, {
      method, redirect: 'manual', signal: controller.signal,
      headers: body ? { 'Content-Type': String(args.content_type || 'application/json') } : undefined,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    });
    const chunks = [];
    let size = 0;
    let responseTruncated = false;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { responseTruncated = true; await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    return truncate(JSON.stringify({
      url: url.toString(), status: response.status, status_text: response.statusText,
      content_type: response.headers.get('content-type') || '',
      location: response.headers.get('location') || '', truncated: responseTruncated,
      body: new TextDecoder().decode(Buffer.concat(chunks)),
    }, null, 2));
  } catch (err) {
    return err.name === 'AbortError' ? `Error: local request timed out after ${seconds}s.` : `Error: ${err.message}`;
  } finally { clearTimeout(timer); }
}

function createManagedTools() {
  const managed = new Map();

  async function startProcess(args, cwd) {
    const executable = String(args.executable || '').trim();
    if (!executable || executable.includes('\0')) return 'Error: executable is required and must not contain null bytes.';
    const processArgs = args.arguments === undefined ? [] : args.arguments;
    if (!Array.isArray(processArgs) || processArgs.length > 100 || processArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      return 'Error: arguments must be an array of at most 100 strings without null bytes.';
    }
    let processCwd;
    try { processCwd = resolveInside(cwd, args.path); } catch (err) { return `Error: ${err.message}`; }
    if (!fs.statSync(processCwd).isDirectory()) return `Error: process path is not a directory: ${args.path}`;
    for (const [id, entry] of managed) if (entry.exitCode !== null || entry.signal !== null) managed.delete(id);
    if (managed.size >= 20) return 'Error: managed-process limit reached (20). Stop an existing process first.';
    const id = crypto.randomBytes(8).toString('hex');
    let child;
    try { child = spawn(executable, processArgs, { cwd: processCwd, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (err) { return `Error starting process: ${err.message}`; }
    const entry = { child, executable, args: processArgs, cwd: processCwd, startedAt: new Date().toISOString(), stdout: '', stderr: '', exitCode: null, signal: null };
    managed.set(id, entry);
    child.stdout.on('data', (chunk) => appendLog(entry, 'stdout', chunk));
    child.stderr.on('data', (chunk) => appendLog(entry, 'stderr', chunk));
    child.on('exit', (code, signal) => { entry.exitCode = code; entry.signal = signal; });
    return new Promise((resolve) => {
      let started = false;
      child.once('spawn', () => { started = true; resolve(JSON.stringify(processResult(id, entry), null, 2)); });
      child.once('error', (err) => {
        if (started) appendLog(entry, 'stderr', `\nProcess error: ${err.message}`);
        else { managed.delete(id); resolve(`Error starting process: ${err.message}`); }
      });
    });
  }

  function processStatus(args) {
    const id = String(args.id || '');
    const entry = managed.get(id);
    return entry ? truncate(JSON.stringify(processResult(id, entry), null, 2)) : `Error: unknown managed process id "${id}".`;
  }

  async function stopProcess(args) {
    const id = String(args.id || '');
    const entry = managed.get(id);
    if (!entry) return `Error: unknown managed process id "${id}".`;
    if (entry.exitCode === null && entry.signal === null) {
      await new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        entry.child.once('exit', finish);
        timer = setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch {} setTimeout(finish, 250); }, 3000);
        try { entry.child.kill('SIGTERM'); } catch { finish(); }
      });
    }
    const result = processResult(id, entry);
    managed.delete(id);
    return JSON.stringify(result, null, 2);
  }

  async function stopAll() {
    await Promise.all([...managed.keys()].map((id) => stopProcess({ id })));
  }

  return { handlers: {
    check_port_usage: checkPortUsage,
    start_process: startProcess,
    process_status: processStatus,
    stop_process: stopProcess,
    local_http_request: localHttpRequest,
  }, stopAll };
}

module.exports = { createManagedTools };
