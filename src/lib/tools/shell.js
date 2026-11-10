// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js
'use strict';

// run_command and the destructive-command classifier.
// Pruned: the command sandbox wrapper (sandboxing is not in v1), run_project_check,
// and the process-management tools.

const { exec } = require('child_process');
const { truncate } = require('./files');

// ---------- destructive-command classifier (Tier 2) ----------
// Commands matching these patterns ALWAYS require user approval, even when
// AUTO-APPROVE is on. File tools are fenced to the project directory, but the
// shell is not — this is the gate on the one unfenced door.
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\b[^|;&]*\s-\w*[rf]/,                    // rm with -r or -f anywhere
  /\bsudo\b/,
  /\bgit\s+push\b.*(--force|-f\b)/,             // force push
  /\bgit\s+push\b/,                              // any push touches a remote
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+\.\B/,                     // discard all working changes
  /\bchmod\b\s+-\w*R/,
  /\bchown\b/,
  /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b/,   // pipe a download into a shell
  /\bmkfs\b|\bdiskutil\b|\bdd\s+if=/,
  /\b(shutdown|reboot|halt)\b/,
  // CLI addition: a --yes replay used lsof | xargs kill on port 3000 and
  // stopped a process outside its project. Every process stop needs a human.
  /\b(?:kill|killall|pkill)\b/,
  /\bfuser\b[^|;&]*\s-k\b/,
  /\bkill(all)?\b\s+-9\s+-1\b/,
  /\blaunchctl\b|\bcrontab\b/,
  /\bnpm\s+(publish|unpublish)\b/,
  />\s*\/(?:etc|usr|bin|sbin|System|Library)\//,  // redirect into system paths
  // /dev is a system path, but the standard sinks are how ordinary read-only
  // commands silence noise (`2>/dev/null`) — flagging those made every such
  // command look destructive. Real device writes (`> /dev/disk0`) still match.
  />\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|fd\/)/,
  /\b(?:mv|cp|rm|rmdir|touch|tee)\b[^|;&]*\s(?:\/(?!tmp\/)|~\/(?!$))/, // mutate absolute/home paths outside the project
];

// Windows-native equivalents — cmd.exe and PowerShell spell all of the above
// differently, and a classifier tuned only for Unix syntax would give a false
// sense of safety on win32 (the one platform where run_command uses these).
const DESTRUCTIVE_COMMAND_PATTERNS_WIN = [
  /\bdel\b[^&|]*\/[sf]/i,                          // del /s or /f (recursive/force)
  /\bRemove-Item\b[^&|]*-Recurse/i,
  /\brd\b[^&|]*\/s/i,                                // rmdir /s
  /\bFormat-Volume\b|\bformat\b\s+[a-z]:/i,
  /\bDiskpart\b/i,
  /\bStop-Computer\b|\bRestart-Computer\b|\bshutdown\b\s+\/[rs]/i,
  /\bStop-Process\b[^&|]*-Force|\btaskkill\b[^&|]*\/f/i,
  /\b(?:Stop-Process|taskkill)\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bnet\s+user\b|\bnet\s+localgroup\b/i,
  /\bicacls\b[^&|]*\/grant/i,
  /\bReg\s+(delete|add)\b/i,
  /\bSchtasks\b[^&|]*\/(create|delete)/i,
  /(?:iwr|Invoke-WebRequest|curl)\b[^&|]*\|\s*(?:iex|Invoke-Expression)/i, // pipe a download into execution
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
];

function isDestructiveCommand(command) {
  const c = String(command || '');
  const patterns = process.platform === 'win32' ? DESTRUCTIVE_COMMAND_PATTERNS_WIN : DESTRUCTIVE_COMMAND_PATTERNS;
  return patterns.some((re) => re.test(c));
}

const COMMAND_TIMEOUT_MS = 60_000;

async function runCommand(args, cwd) {
  return new Promise((resolve) => {
    exec(args.command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
      if (err && !err.killed) out += `\n(exit code ${err.code ?? 'signal ' + err.signal})`;
      if (err && err.killed) out += '\n(command timed out after 60s)';
      resolve(truncate(out || '(no output)'));
    });
  });
}

// CLI addition (/build): the same shell, but the exit status comes back as a
// number instead of a line appended to the output, so a task's Check is judged
// by what the process did, not by parsing text a program could print itself.
function runCommandStatus(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n--- stderr ---\n' : '') + stderr;
      const timedOut = !!(err && err.killed);
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ ok: !err, code, timedOut, output: truncate(out || '(no output)') });
    });
  });
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  runCommandStatus,
  isDestructiveCommand,
  handlers: {
    run_command: runCommand,
  },
};
