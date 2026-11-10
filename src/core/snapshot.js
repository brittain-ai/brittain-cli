'use strict';

// CLI addition (/build): what a coder actually changed, from the files
// themselves. A before/after listing of the working tree, so it works in a
// directory that is not a git repository and never depends on a report the
// coder wrote about its own work. (checkpoint-service diffStat was tried first
// and reports nothing for files git has not seen.)

const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', '.brittain', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const SKIP_FILES = new Set(['.DS_Store']);
const MAX_ENTRIES = 5000;

// { 'src/a.js': '1204:1790000000000', … } — size and mtime are enough to see a
// rewrite; a coder that rewrites a file with identical bytes changed nothing.
function snapshot(cwd) {
  const files = {};
  let count = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= MAX_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
        try {
          const stat = fs.statSync(full);
          files[path.relative(cwd, full).split(path.sep).join('/')] = `${stat.size}:${Math.round(stat.mtimeMs)}`;
          count++;
        } catch {}
      }
    }
  };
  walk(cwd);
  return files;
}

function changesBetween(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const file of Object.keys(after)) {
    if (!(file in before)) added.push(file);
    else if (before[file] !== after[file]) modified.push(file);
  }
  for (const file of Object.keys(before)) if (!(file in after)) deleted.push(file);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

const normalize = (file) => String(file).trim().replace(/^\.\//, '').replace(/\/+$/, '');

// Files the coder touched that the task did not list. A task may list a
// directory ("src/"); anything under it counts as listed.
function unlisted(changes, listed) {
  const allowed = listed.map(normalize).filter(Boolean);
  const isListed = (file) => allowed.some((entry) => file === entry || file.startsWith(`${entry}/`));
  return [...changes.added, ...changes.modified, ...changes.deleted].filter((file) => !isListed(file));
}

function describeChanges(changes) {
  const parts = [];
  if (changes.added.length) parts.push(`added ${changes.added.join(', ')}`);
  if (changes.modified.length) parts.push(`modified ${changes.modified.join(', ')}`);
  if (changes.deleted.length) parts.push(`deleted ${changes.deleted.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no files changed';
}

module.exports = { changesBetween, describeChanges, snapshot, unlisted };
