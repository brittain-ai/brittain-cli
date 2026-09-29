// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js (project checks)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveInside, truncate } = require('./files');

const PROJECT_CHECK_NAME = /^(?:test|lint|typecheck|type-check|check|build|verify|ci)(?::|$)|^format:check$/i;

function packageRunner(dir, pkg) {
  const declared = String(pkg.packageManager || '').split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function projectCheckInfo(cwd, requestedPath) {
  const target = resolveInside(cwd, requestedPath);
  const stat = fs.statSync(target);
  const dir = stat.isDirectory() ? target : path.dirname(target);
  const requestedManifest = stat.isFile() ? path.basename(target) : null;
  const wants = (...names) => !requestedManifest || names.includes(requestedManifest);
  const packagePath = path.join(dir, 'package.json');
  if (wants('package.json') && fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const runner = packageRunner(dir, pkg);
    const checks = Object.keys(scripts)
      .filter((name) => PROJECT_CHECK_NAME.test(name))
      .sort()
      .map((name) => ({ name, steps: [{ executable: runner, args: ['run', name] }], description: String(scripts[name]) }));
    if (checks.length || requestedManifest === 'package.json') {
      return { dir, projectType: 'package', manifest: 'package.json', runner, checks };
    }
  }

  const cmakePath = path.join(dir, 'CMakeLists.txt');
  if (wants('CMakeLists.txt') && fs.existsSync(cmakePath)) {
    const source = fs.readFileSync(cmakePath, 'utf8');
    const configure = { executable: 'cmake', args: ['-S', '.', '-B', 'build'] };
    const build = { executable: 'cmake', args: ['--build', 'build'] };
    const checks = [
      { name: 'configure', steps: [configure], description: 'Configure CMake into build/' },
      { name: 'build', steps: [configure, build], description: 'Configure and compile the CMake project' },
      { name: 'check', steps: [configure, build], description: 'Configure and compile the CMake project' },
    ];
    if (/\b(?:enable_testing|add_test|include\s*\(\s*CTest\b)/i.test(source)) {
      checks.push({
        name: 'test',
        steps: [configure, build, { executable: 'ctest', args: ['--test-dir', 'build', '--output-on-failure'] }],
        description: 'Configure, compile, and run declared CTest tests',
      });
    }
    return { dir, projectType: 'cmake', manifest: 'CMakeLists.txt', runner: 'cmake', checks };
  }

  if (wants('Cargo.toml') && fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    return {
      dir, projectType: 'cargo', manifest: 'Cargo.toml', runner: 'cargo',
      checks: [
        { name: 'check', steps: [{ executable: 'cargo', args: ['check'] }], description: 'Compile-check the Rust project' },
        { name: 'test', steps: [{ executable: 'cargo', args: ['test'] }], description: 'Run Rust tests' },
        { name: 'build', steps: [{ executable: 'cargo', args: ['build'] }], description: 'Build the Rust project' },
      ],
    };
  }

  if (wants('go.mod') && fs.existsSync(path.join(dir, 'go.mod'))) {
    return {
      dir, projectType: 'go', manifest: 'go.mod', runner: 'go',
      checks: [
        { name: 'check', steps: [{ executable: 'go', args: ['test', './...'] }], description: 'Compile and test all Go packages' },
        { name: 'test', steps: [{ executable: 'go', args: ['test', './...'] }], description: 'Test all Go packages' },
        { name: 'build', steps: [{ executable: 'go', args: ['build', './...'] }], description: 'Build all Go packages' },
        { name: 'lint', steps: [{ executable: 'go', args: ['vet', './...'] }], description: 'Vet all Go packages' },
      ],
    };
  }

  const pythonNames = ['pyproject.toml', 'pytest.ini', 'setup.cfg'];
  const pythonManifest = requestedManifest && pythonNames.includes(requestedManifest)
    ? requestedManifest
    : pythonNames.find((name) => fs.existsSync(path.join(dir, name)));
  if (pythonManifest && wants('pyproject.toml', 'pytest.ini', 'setup.cfg')) {
    const manifestText = fs.readFileSync(path.join(dir, pythonManifest), 'utf8');
    const hasPytest = pythonManifest === 'pytest.ini' || /\bpytest\b/i.test(manifestText) || fs.existsSync(path.join(dir, 'tests'));
    const checks = [
      { name: 'check', steps: [{ executable: 'python3', args: ['-m', 'compileall', '-q', '.'] }], description: 'Compile-check Python source files' },
    ];
    if (hasPytest) checks.push({ name: 'test', steps: [{ executable: 'python3', args: ['-m', 'pytest'] }], description: 'Run pytest' });
    return { dir, projectType: 'python', manifest: pythonManifest, runner: 'python3', checks };
  }

  const makeNames = ['Makefile', 'makefile', 'GNUmakefile'];
  const makeName = requestedManifest && makeNames.includes(requestedManifest)
    ? requestedManifest
    : makeNames.find((name) => fs.existsSync(path.join(dir, name)));
  if (makeName && wants('Makefile', 'makefile', 'GNUmakefile')) {
    const source = fs.readFileSync(path.join(dir, makeName), 'utf8');
    const targets = [...new Set([...source.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((match) => match[1]))]
      .filter((name) => PROJECT_CHECK_NAME.test(name))
      .sort();
    const checks = targets.map((name) => ({ name, steps: [{ executable: 'make', args: [name] }], description: `Run declared Make target ${name}` }));
    return { dir, projectType: 'make', manifest: makeName, runner: 'make', checks };
  }

  throw new Error(`No supported project manifest found in ${dir}. Supported: package.json, CMakeLists.txt, Cargo.toml, go.mod, pyproject.toml/pytest.ini/setup.cfg, and Makefile.`);
}

function checkCommand(step) {
  return [step.executable, ...step.args].join(' ');
}

function runCheckStep(step, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(step.executable, step.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4_000_000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        command: checkCommand(step),
        exit_code: err ? (err.code ?? null) : 0,
        signal: err?.signal || null,
        timed_out: !!err?.killed,
        duration_ms: Date.now() - started,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

async function runProjectCheck(args, cwd) {
  let info;
  try {
    info = projectCheckInfo(cwd, args.path);
  } catch (err) {
    if (/^No supported project manifest/.test(err.message)) {
      return `Project checks unavailable: ${err.message} This is not evidence that the project failed to compile or test; inspect the project and use an appropriate approved verification method.`;
    }
    return `Error: ${err.message}`;
  }
  if (!args.check) {
    if (!info.checks.length) return `No allowed verification checks found in ${info.manifest}.`;
    return JSON.stringify({
      project_directory: path.relative(fs.realpathSync(cwd), info.dir) || '.',
      project_type: info.projectType,
      manifest: info.manifest,
      runner: info.runner,
      checks: info.checks.map((check) => ({
        name: check.name,
        command: check.steps.map(checkCommand).join(' && '),
        description: check.description,
      })),
    }, null, 2);
  }
  const checkName = String(args.check);
  const check = info.checks.find((entry) => entry.name === checkName);
  if (!check) {
    return `Error: "${checkName}" is not an allowed discovered verification check. Available checks: ${info.checks.map((entry) => entry.name).join(', ') || '(none)'}.`;
  }
  const timeoutArg = Number(args.timeout_seconds);
  const timeoutSeconds = Number.isFinite(timeoutArg) ? Math.min(Math.max(Math.round(timeoutArg), 1), 600) : 120;
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  const steps = [];
  for (const step of check.steps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      steps.push({ command: checkCommand(step), exit_code: null, signal: null, timed_out: true, duration_ms: 0, stdout: '', stderr: 'Overall project-check timeout reached before this step.' });
      break;
    }
    const result = await runCheckStep(step, info.dir, remaining);
    steps.push(result);
    if (result.exit_code !== 0 || result.signal || result.timed_out) break;
  }
  const failed = steps.find((step) => step.exit_code !== 0 || step.signal || step.timed_out);
  return truncate(JSON.stringify({
    check: checkName,
    project_type: info.projectType,
    manifest: info.manifest,
    command: check.steps.map(checkCommand).join(' && '),
    exit_code: failed ? failed.exit_code : 0,
    signal: failed?.signal || null,
    timed_out: !!failed?.timed_out,
    duration_ms: Date.now() - started,
    stdout: steps.map((step) => step.stdout).filter(Boolean).join('\n'),
    stderr: steps.map((step) => step.stderr).filter(Boolean).join('\n'),
    steps,
  }, null, 2));
}

module.exports = { handlers: { run_project_check: runProjectCheck } };
